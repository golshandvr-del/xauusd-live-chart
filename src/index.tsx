import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

app.use('/api/*', cors())

/* ================================================================== *
 *  Types
 * ================================================================== */
type Candle = { time: number; open: number; high: number; low: number; close: number }
type Series = { candles: Candle[]; source: string; proxy: boolean }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'

/* Timeframe -> seconds per bar */
const TF_SEC: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800
}

/* ================================================================== *
 *  SPOT price — real interbank XAU/USD
 * ================================================================== */
async function fromSwissquote() {
  const r = await fetch(
    'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
    { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } as any }
  )
  if (!r.ok) throw new Error('swissquote ' + r.status)
  const arr: any = await r.json()
  let best: { bid: number; ask: number; ts: number } | null = null
  for (const item of arr) {
    const ts = Number(item?.ts) || Date.now()
    for (const p of item?.spreadProfilePrices ?? []) {
      const bid = Number(p?.bid)
      const ask = Number(p?.ask)
      if (!bid || !ask) continue
      if (!best || ask - bid < best.ask - best.bid) best = { bid, ask, ts }
    }
  }
  if (!best) throw new Error('swissquote empty')
  return {
    bid: +best.bid.toFixed(3),
    ask: +best.ask.toFixed(3),
    price: +((best.bid + best.ask) / 2).toFixed(3),
    ts: best.ts,
    source: 'Swissquote (Spot XAU/USD)',
    spot: true
  }
}

/* TradingView scanner — real broker spot quote (OANDA / FOREX.com) */
async function fromTradingView() {
  const r = await fetch(
    'https://scanner.tradingview.com/symbol?symbol=OANDA%3AXAUUSD&fields=close,open,high,low&no_404=true',
    { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } as any }
  )
  if (!r.ok) throw new Error('tv ' + r.status)
  const j: any = await r.json()
  const price = Number(j?.close)
  if (!price) throw new Error('tv empty')
  return {
    bid: +(price - 0.15).toFixed(3),
    ask: +(price + 0.15).toFixed(3),
    price: +price.toFixed(3),
    ts: Date.now(),
    source: 'TradingView OANDA (Spot XAU/USD)',
    spot: true
  }
}

async function fromGoldApi() {
  const r = await fetch('https://api.gold-api.com/price/XAU', {
    headers: { 'User-Agent': UA }
  })
  if (!r.ok) throw new Error('gold-api ' + r.status)
  const j: any = await r.json()
  const price = Number(j?.price)
  if (!price) throw new Error('gold-api empty')
  return {
    bid: price,
    ask: price,
    price,
    ts: Date.parse(j?.updatedAt ?? '') || Date.now(),
    source: 'gold-api (Spot XAU)',
    spot: true
  }
}

async function fromBitgetTicker() {
  const r = await fetch(
    'https://api.bitget.com/api/v2/spot/market/tickers?symbol=XAUTUSDT',
    { headers: { 'User-Agent': UA } }
  )
  if (!r.ok) throw new Error('bitget ' + r.status)
  const j: any = await r.json()
  const d = j?.data?.[0]
  const price = Number(d?.lastPr)
  if (!price) throw new Error('bitget empty')
  return {
    bid: Number(d?.bidPr) || price,
    ask: Number(d?.askPr) || price,
    price,
    ts: Number(d?.ts) || Date.now(),
    source: 'Bitget XAUT (proxy)',
    spot: false
  }
}

async function fromOkxTicker() {
  const r = await fetch(
    'https://www.okx.com/api/v5/market/ticker?instId=XAUT-USDT',
    { headers: { 'User-Agent': UA } }
  )
  if (!r.ok) throw new Error('okx ' + r.status)
  const j: any = await r.json()
  const d = j?.data?.[0]
  const price = Number(d?.last)
  if (!price) throw new Error('okx empty')
  return {
    bid: Number(d?.bidPx) || price,
    ask: Number(d?.askPx) || price,
    price,
    ts: Number(d?.ts) || Date.now(),
    source: 'OKX XAUT (proxy)',
    spot: false
  }
}

const PRICE_SOURCES = [
  fromSwissquote,
  fromTradingView,
  fromGoldApi,
  fromBitgetTicker,
  fromOkxTicker
]

async function getSpot() {
  for (const fn of PRICE_SOURCES) {
    try {
      return await fn()
    } catch {
      /* next */
    }
  }
  return null
}

app.get('/api/price', async (c) => {
  const errors: string[] = []
  for (const fn of PRICE_SOURCES) {
    try {
      const q = await fn()
      return c.json({ ok: true, symbol: 'XAUUSD', ...q }, 200, {
        'Cache-Control': 'no-store'
      })
    } catch (e: any) {
      errors.push(String(e?.message ?? e))
    }
  }
  return c.json({ ok: false, error: 'all sources failed', errors }, 502)
})

/* ================================================================== *
 *  CANDLES
 *  Priority: real SPOT XAU/USD OHLC  ->  tokenized-gold proxy
 * ================================================================== */

/* ---- FXOpen public quote history: REAL broker spot XAU/USD OHLC ----
   This is the accuracy fix. Previously the chart was drawn from tokenized
   gold (XAUT-USDT) and shifted by an additive offset, which distorted every
   historical bar. FXOpen publishes genuine XAU/USD bid/ask bars, correctly
   aligned to UTC, for every timeframe the UI offers. */
const FXO_MAP: Record<string, string> = {
  '1m': 'M1',
  '5m': 'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1h': 'H1',
  '4h': 'H4',
  '1d': 'D1',
  '1w': 'W1'
}

const FXO_HOSTS = [
  'https://marginalttdemowebapi.fxopen.net',
  'https://marginalttlivewebapi.fxopen.net'
]

async function fxopenBars(tf: string, limit: number, side: 'bid' | 'ask') {
  const p = FXO_MAP[tf]
  if (!p) throw new Error('fxopen bad tf')
  const n = Math.min(Math.max(limit, 50), 1000)
  const ts = Date.now()
  let lastErr: any = null
  for (const host of FXO_HOSTS) {
    try {
      const r = await fetch(
        `${host}/api/v1/public/quotehistory/XAUUSD/${p}/bars/${side}?count=-${n}&timestamp=${ts}`,
        {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
          cf: { cacheTtl: 15, cacheEverything: true } as any
        }
      )
      if (!r.ok) throw new Error('fxopen ' + r.status)
      const j: any = await r.json()
      const bars: any[] = j?.Bars ?? []
      if (!bars.length) throw new Error('fxopen empty')
      return bars
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('fxopen failed')
}

/** Mid-price bars: average the bid and ask books, exactly like a broker chart. */
async function fxopenCandles(tf: string, limit: number): Promise<Series> {
  const bid = await fxopenBars(tf, limit, 'bid')

  let ask: any[] | null = null
  try {
    ask = await fxopenBars(tf, limit, 'ask')
  } catch {
    /* mid is optional — bid-only is still a genuine spot series */
  }

  const askByTs = new Map<number, any>()
  if (ask) for (const b of ask) askByTs.set(Number(b.Timestamp), b)

  const candles: Candle[] = []
  for (const b of bid) {
    const t = Number(b.Timestamp)
    const a = askByTs.get(t)
    const mid = (x: number, y: number | undefined) =>
      Number.isFinite(y as number) ? (x + (y as number)) / 2 : x
    const o = mid(Number(b.Open), a ? Number(a.Open) : undefined)
    const h = mid(Number(b.High), a ? Number(a.High) : undefined)
    const l = mid(Number(b.Low), a ? Number(a.Low) : undefined)
    const cl = mid(Number(b.Close), a ? Number(a.Close) : undefined)
    if (![o, h, l, cl].every(Number.isFinite)) continue
    candles.push({
      time: Math.floor(t / 1000),
      open: +o.toFixed(2),
      high: +h.toFixed(2),
      low: +l.toFixed(2),
      close: +cl.toFixed(2)
    })
  }
  if (!candles.length) throw new Error('fxopen no valid bars')
  return {
    candles,
    source: ask
      ? 'FXOpen Spot XAU/USD (mid)'
      : 'FXOpen Spot XAU/USD (bid)',
    proxy: false
  }
}

/* ---- Yahoo Finance: genuine spot XAU/USD (XAUUSD=X) ---- */
const YF_MAP: Record<string, { interval: string; range: string; agg?: number }> = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '3mo' },
  '4h': { interval: '60m', range: '6mo', agg: 4 }, // aggregated from 1h
  '1d': { interval: '1d', range: '2y' },
  '1w': { interval: '1wk', range: '10y' }
}

async function yahooCandles(tf: string, symbol: string, label: string, spot: boolean): Promise<Series> {
  const m = YF_MAP[tf]
  if (!m) throw new Error('yf bad tf')
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${m.interval}&range=${m.range}&includePrePost=false`
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    cf: { cacheTtl: 20, cacheEverything: true } as any
  })
  if (!r.ok) throw new Error('yf ' + r.status)
  const j: any = await r.json()
  const res = j?.chart?.result?.[0]
  const ts: number[] = res?.timestamp ?? []
  const q = res?.indicators?.quote?.[0]
  if (!ts.length || !q) throw new Error('yf empty')

  let candles: Candle[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = Number(q.open?.[i])
    const h = Number(q.high?.[i])
    const l = Number(q.low?.[i])
    const cl = Number(q.close?.[i])
    if (![o, h, l, cl].every(Number.isFinite)) continue
    if (cl <= 0) continue
    candles.push({
      time: Number(ts[i]),
      open: o,
      high: Math.max(o, h, l, cl),
      low: Math.min(o, h, l, cl),
      close: cl
    })
  }
  if (!candles.length) throw new Error('yf no valid bars')
  if (m.agg && m.agg > 1) candles = aggregate(candles, TF_SEC[tf])
  return { candles, source: label, proxy: !spot }
}

/* ---- Bitget: tokenized gold XAUT-USDT (proxy) ---- */
const BG_MAP: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week'
}

async function bitgetCandles(tf: string, limit: number): Promise<Series> {
  const g = BG_MAP[tf]
  if (!g) throw new Error('bitget bad tf')
  const r = await fetch(
    `https://api.bitget.com/api/v2/spot/market/candles?symbol=XAUTUSDT&granularity=${g}&limit=${Math.min(
      limit,
      1000
    )}`,
    { headers: { 'User-Agent': UA }, cf: { cacheTtl: 20 } as any }
  )
  if (!r.ok) throw new Error('bitget candles ' + r.status)
  const j: any = await r.json()
  const rows: any[] = j?.data ?? []
  if (!rows.length) throw new Error('bitget no data')
  const candles = normalize(rows.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4])
  })))
  return { candles, source: 'Bitget XAUT-USDT (proxy)', proxy: true }
}

/* ---- OKX: tokenized gold XAUT-USDT (proxy) ---- */
const OKX_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1Dutc',
  '1w': '1Wutc'
}

async function okxCandles(tf: string, limit: number): Promise<Series> {
  const bar = OKX_MAP[tf]
  if (!bar) throw new Error('okx bad tf')
  const r = await fetch(
    `https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT&bar=${bar}&limit=${Math.min(
      limit,
      300
    )}`,
    { headers: { 'User-Agent': UA }, cf: { cacheTtl: 20 } as any }
  )
  if (!r.ok) throw new Error('okx candles ' + r.status)
  const j: any = await r.json()
  const rows: any[] = j?.data ?? []
  if (!rows.length) throw new Error('okx no data')
  const candles = normalize(rows.map((row) => ({
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4])
  })))
  return { candles, source: 'OKX XAUT-USDT (proxy)', proxy: true }
}

/* ================================================================== *
 *  Helpers: normalize / aggregate / calibrate
 * ================================================================== */

/** de-dupe, drop broken bars, enforce OHLC sanity, sort ascending */
function normalize(list: Candle[]): Candle[] {
  const map = new Map<number, Candle>()
  for (const k of list) {
    if (![k.open, k.high, k.low, k.close].every(Number.isFinite)) continue
    if (k.close <= 0 || !Number.isFinite(k.time)) continue
    map.set(k.time, {
      time: k.time,
      open: k.open,
      high: Math.max(k.open, k.high, k.low, k.close),
      low: Math.min(k.open, k.high, k.low, k.close),
      close: k.close
    })
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time)
}

/** roll smaller bars up into `sec`-second buckets (true OHLC aggregation) */
function aggregate(list: Candle[], sec: number): Candle[] {
  const out: Candle[] = []
  let cur: Candle | null = null
  let bucket = -1
  for (const k of list) {
    const b = Math.floor(k.time / sec) * sec
    if (b !== bucket) {
      if (cur) out.push(cur)
      bucket = b
      cur = { time: b, open: k.open, high: k.high, low: k.low, close: k.close }
    } else if (cur) {
      cur.high = Math.max(cur.high, k.high)
      cur.low = Math.min(cur.low, k.low)
      cur.close = k.close
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * Align a proxy series (tokenized gold) onto real spot.
 * Uses a MULTIPLICATIVE ratio, not an additive offset, so every historical
 * bar keeps its real percentage move — an additive shift silently distorts
 * older bars and is exactly what made the old chart disagree with reality.
 */
function calibrate(candles: Candle[], spot: number | null) {
  if (!spot || !candles.length) return { candles, ratio: 1 }
  const last = candles[candles.length - 1].close
  if (!last) return { candles, ratio: 1 }
  const ratio = spot / last
  // ignore nonsense (feed mismatch / stale proxy)
  if (!Number.isFinite(ratio) || ratio < 0.97 || ratio > 1.03) {
    return { candles, ratio: 1 }
  }
  return {
    candles: candles.map((k) => ({
      time: k.time,
      open: +(k.open * ratio).toFixed(2),
      high: +(k.high * ratio).toFixed(2),
      low: +(k.low * ratio).toFixed(2),
      close: +(k.close * ratio).toFixed(2)
    })),
    ratio: +ratio.toFixed(6)
  }
}

/** Make sure the forming bar actually contains the live spot price. */
function syncForming(candles: Candle[], spot: number | null, sec: number) {
  if (!spot || !candles.length) return candles
  const nowBucket = Math.floor(Date.now() / 1000 / sec) * sec
  const last = candles[candles.length - 1]
  if (last.time === nowBucket) {
    last.close = +spot.toFixed(2)
    last.high = +Math.max(last.high, spot).toFixed(2)
    last.low = +Math.min(last.low, spot).toFixed(2)
  } else if (nowBucket > last.time) {
    // a fresh bar opened but the feed hasn't published it yet
    candles.push({
      time: nowBucket,
      open: last.close,
      high: +Math.max(last.close, spot).toFixed(2),
      low: +Math.min(last.close, spot).toFixed(2),
      close: +spot.toFixed(2)
    })
  }
  return candles
}

/* ================================================================== *
 *  /api/candles
 * ================================================================== */
app.get('/api/candles', async (c) => {
  const tf = String(c.req.query('tf') ?? '1h')
  const sec = TF_SEC[tf]
  if (!sec) return c.json({ ok: false, error: 'bad timeframe' }, 400)

  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 500) || 500, 50), 1000)

  // real spot price first — used both for calibration and the forming bar
  const q = await getSpot()
  const spot = q && q.spot ? q.price : q ? q.price : null

  const attempts: Array<() => Promise<Series>> = [
    () => fxopenCandles(tf, limit),                                      // real spot XAU/USD
    () => yahooCandles(tf, 'XAUUSD=X', 'Yahoo Spot XAU/USD', true),      // real spot XAU/USD
    () => yahooCandles(tf, 'GC=F', 'COMEX Gold Futures (GC)', true),     // real gold futures
    () => bitgetCandles(tf, limit),                                      // proxy, calibrated
    () => okxCandles(tf, limit)                                          // proxy, calibrated
  ]

  const errors: string[] = []
  for (const attempt of attempts) {
    try {
      const s = await attempt()
      let candles = normalize(s.candles).slice(-limit)
      let ratio = 1

      if (s.proxy) {
        // tokenized gold: rescale onto true spot (shape preserved)
        const cal = calibrate(candles, spot)
        candles = cal.candles
        ratio = cal.ratio
      }
      // real spot OHLC is used exactly as published — no history distortion

      candles = syncForming(candles, spot, sec)

      return c.json(
        {
          ok: true,
          tf,
          barSeconds: sec,
          spot,
          source: s.source,
          proxy: s.proxy,
          calibration: ratio,
          spotSource: q?.source ?? null,
          count: candles.length,
          candles
        },
        200,
        { 'Cache-Control': 'no-store' }
      )
    } catch (e: any) {
      errors.push(String(e?.message ?? e))
    }
  }

  return c.json({ ok: false, error: 'all candle sources failed', errors }, 502)
})

/* ================================================================== *
 *  /api/diag — which upstream feeds are actually reachable
 * ================================================================== */
app.get('/api/diag', async (c) => {
  const out: any = { price: [], candles: [] }
  for (const fn of PRICE_SOURCES) {
    try {
      const q = await fn()
      out.price.push({ source: q.source, ok: true, price: q.price, spot: q.spot })
    } catch (e: any) {
      out.price.push({ source: fn.name, ok: false, error: String(e?.message ?? e) })
    }
  }
  const cs: Array<[string, () => Promise<Series>]> = [
    ['FXOpen XAUUSD (spot)', () => fxopenCandles('1h', 50)],
    ['Yahoo XAUUSD=X', () => yahooCandles('1h', 'XAUUSD=X', 'yf spot', true)],
    ['Yahoo GC=F', () => yahooCandles('1h', 'GC=F', 'yf futures', true)],
    ['Bitget XAUT', () => bitgetCandles('1h', 50)],
    ['OKX XAUT', () => okxCandles('1h', 50)]
  ]
  for (const [name, fn] of cs) {
    try {
      const s = await fn()
      const last = s.candles[s.candles.length - 1]
      out.candles.push({ source: name, ok: true, bars: s.candles.length, lastClose: last?.close })
    } catch (e: any) {
      out.candles.push({ source: name, ok: false, error: String(e?.message ?? e) })
    }
  }
  return c.json(out, 200, { 'Cache-Control': 'no-store' })
})

/* ================================================================== *
 *  Page
 * ================================================================== */
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0b0e11">
<title>XAUUSD | قیمت لحظه‌ای طلا</title>
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
<script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
</head>
<body>
  <header id="price-header">
    <div class="sym-row">
      <span class="sym">XAU/USD</span>
      <span class="badge" id="live-badge"><i class="dot"></i> SPOT</span>
    </div>
    <div class="price-big" id="price-big">----.--</div>
    <div class="price-meta">
      <span id="price-change" class="chg">—</span>
      <span class="sep">|</span>
      <span>Bid <b id="price-bid">—</b></span>
      <span class="sep">|</span>
      <span>Ask <b id="price-ask">—</b></span>
    </div>
    <div class="src-row"><span id="price-src">در حال دریافت…</span> · <span id="price-time">—</span></div>
  </header>

  <nav id="tf-bar">
    <button class="tf" data-tf="1m">۱د</button>
    <button class="tf" data-tf="5m">۵د</button>
    <button class="tf" data-tf="15m">۱۵د</button>
    <button class="tf" data-tf="30m">۳۰د</button>
    <button class="tf active" data-tf="1h">۱س</button>
    <button class="tf" data-tf="4h">۴س</button>
    <button class="tf" data-tf="1d">۱ر</button>
    <button class="tf" data-tf="1w">۱ه</button>
  </nav>

  <main>
    <section id="chart-section">
      <div id="chart"></div>
      <div id="chart-loading">در حال بارگذاری نمودار…</div>
      <div id="chart-tools">
        <button id="btn-autoscale" class="tool-btn" title="مقیاس خودکار عمودی (دابل‌کلیک روی نوار قیمت هم همین کار را می‌کند)">اتو</button>
        <button id="btn-fit" class="tool-btn" title="نمایش کل داده‌ها">تنظیم</button>
        <button id="btn-zoom-in" class="tool-btn" title="زوم عمودی به داخل">＋</button>
        <button id="btn-zoom-out" class="tool-btn" title="زوم عمودی به بیرون">－</button>
      </div>
      <div id="chart-hint" class="chart-hint">برای زوم عمودی، روی نوار قیمت (سمت راست) بکشید · دابل‌کلیک = اتو</div>
      <div id="chart-src" class="chart-src">—</div>
    </section>

    <section id="add-level-box" class="card">
      <h2><span class="ico">✎</span> افزودن خط حمایت / مقاومت</h2>
      <div class="form-grid">
        <label class="field">
          <span>قیمت</span>
          <input id="level-price" type="number" inputmode="decimal" step="0.01" placeholder="مثال: 4380.50">
        </label>
        <div class="field">
          <span>نوع</span>
          <div class="seg" id="level-type">
            <button type="button" class="seg-btn active" data-type="support">حمایت</button>
            <button type="button" class="seg-btn" data-type="resistance">مقاومت</button>
          </div>
        </div>
      </div>
      <label class="field">
        <span>یادداشت (اختیاری)</span>
        <input id="level-note" type="text" maxlength="40" placeholder="مثلاً: کف روزانه">
      </label>
      <button id="level-add" class="btn-primary">تأیید و افزودن</button>
      <p id="level-msg" class="msg"></p>
    </section>

    <section id="levels-list-box" class="card">
      <h2>
        <span class="ico">☰</span> لیست خطوط
        <span class="count" id="levels-count">0</span>
      </h2>
      <div id="levels-list"></div>
      <p id="levels-empty" class="empty">هنوز خطی اضافه نشده است.</p>
    </section>
  </main>

  <footer>
    قیمت SPOT بین‌بانکی · نمودار از فید واقعی XAU/USD · زوم عمودی: روی نوار قیمت بکشید
  </footer>

  <script src="/static/app.js"></script>
</body>
</html>`)
})

export default app
