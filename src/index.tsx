import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

app.use('/api/*', cors())

/* ------------------------------------------------------------------ *
 *  Timeframe mapping: UI code -> OKX bar code
 * ------------------------------------------------------------------ */
const TF_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1Dutc',
  '1w': '1Wutc'
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'

/* ------------------------------------------------------------------ *
 *  SPOT price — Swissquote real interbank XAU/USD feed (primary)
 *  Fallbacks: gold-api.com, then OKX XAUT-USDT
 * ------------------------------------------------------------------ */
async function fromSwissquote() {
  const r = await fetch(
    'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
    { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } as any }
  )
  if (!r.ok) throw new Error('swissquote ' + r.status)
  const arr: any = await r.json()
  // Collect every quoted bid/ask across all platforms, use the tightest book
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
    bid: best.bid,
    ask: best.ask,
    price: (best.bid + best.ask) / 2,
    ts: best.ts,
    source: 'Swissquote (Spot XAU/USD)'
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
    source: 'gold-api (Spot XAU)'
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
    source: 'OKX XAUT (Spot proxy)'
  }
}

app.get('/api/price', async (c) => {
  const errors: string[] = []
  for (const fn of [fromSwissquote, fromGoldApi, fromOkxTicker]) {
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

/* ------------------------------------------------------------------ *
 *  CANDLES — OKX XAUT-USDT OHLC, calibrated to live spot
 * ------------------------------------------------------------------ */
app.get('/api/candles', async (c) => {
  const tf = String(c.req.query('tf') ?? '5m')
  const bar = TF_MAP[tf]
  if (!bar) return c.json({ ok: false, error: 'bad timeframe' }, 400)

  const limit = Math.min(Number(c.req.query('limit') ?? 300) || 300, 300)

  try {
    const r = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=XAUT-USDT&bar=${bar}&limit=${limit}`,
      { headers: { 'User-Agent': UA } }
    )
    if (!r.ok) throw new Error('okx candles ' + r.status)
    const j: any = await r.json()
    const rows: any[] = j?.data ?? []
    if (!rows.length) throw new Error('no candle data')

    // OKX returns newest-first -> reverse to oldest-first
    const candles = rows
      .map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4])
      }))
      .filter((k) => Number.isFinite(k.close))
      .sort((a, b) => a.time - b.time)

    // Calibrate the series so the last close matches true spot exactly.
    let offset = 0
    let spot: number | null = null
    try {
      const q = await fromSwissquote()
      spot = q.price
      offset = spot - candles[candles.length - 1].close
      // Sanity guard: ignore absurd offsets (feed mismatch)
      if (Math.abs(offset) > 40) offset = 0
    } catch {
      /* uncalibrated is still fine */
    }

    const out = offset
      ? candles.map((k) => ({
          time: k.time,
          open: +(k.open + offset).toFixed(2),
          high: +(k.high + offset).toFixed(2),
          low: +(k.low + offset).toFixed(2),
          close: +(k.close + offset).toFixed(2)
        }))
      : candles

    return c.json(
      { ok: true, tf, spot, offset: +offset.toFixed(3), candles: out },
      200,
      { 'Cache-Control': 'no-store' }
    )
  } catch (e: any) {
    return c.json({ ok: false, error: String(e?.message ?? e) }, 502)
  }
})

/* ------------------------------------------------------------------ *
 *  Page
 * ------------------------------------------------------------------ */
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0b0e11">
<title>XAUUSD | قیمت لحظه‌ای طلا</title>
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
    قیمت SPOT از فید بین‌بانکی Swissquote · نمودار کالیبره‌شده با قیمت لحظه‌ای
  </footer>

  <script src="/static/app.js"></script>
</body>
</html>`)
})

export default app
