/* =========================================================
   XAUUSD live spot + chart + support/resistance levels
   ========================================================= */
(function () {
  'use strict';

  var LS_KEY = 'xau_levels_v1';
  var PRICE_MS = 3000;      // spot poll
  var CANDLE_MS = 20000;    // candle refresh

  var state = {
    tf: '1h',
    type: 'support',
    levels: [],
    lastPrice: null,
    prevClose: null,
    lastCandle: null,        // live-updating last bar
    priceLines: {},          // id -> priceLine handle
    chart: null,
    series: null
  };

  /* ---------------- helpers ---------------- */
  var $ = function (id) { return document.getElementById(id); };

  function fmt(n, d) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: d === undefined ? 2 : d,
      maximumFractionDigits: d === undefined ? 2 : d
    });
  }

  function saveLevels() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.levels)); } catch (e) {}
  }

  function loadLevels() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  /* ---------------- chart ---------------- */
  function initChart() {
    var el = $('chart');
    state.chart = LightweightCharts.createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { type: 'solid', color: '#151b23' },
        textColor: '#8b98a8',
        fontFamily: 'Vazirmatn, sans-serif',
        fontSize: 10
      },
      grid: {
        vertLines: { color: 'rgba(35,44,55,.55)' },
        horzLines: { color: 'rgba(35,44,55,.55)' }
      },
      rightPriceScale: {
        borderColor: '#232c37',
        scaleMargins: { top: 0.12, bottom: 0.12 }
      },
      timeScale: {
        borderColor: '#232c37',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 6
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#4b5666', labelBackgroundColor: '#2a3441' },
        horzLine: { color: '#4b5666', labelBackgroundColor: '#2a3441' }
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: {
        priceFormatter: function (p) { return Number(p).toFixed(2); }
      }
    });

    state.series = state.chart.addCandlestickSeries({
      upColor: '#26a37b',
      downColor: '#e2544c',
      borderUpColor: '#26a37b',
      borderDownColor: '#e2544c',
      wickUpColor: '#26a37b',
      wickDownColor: '#e2544c',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }
    });

    window.addEventListener('resize', function () {
      if (!state.chart) return;
      state.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
  }

  function loadCandles(fit) {
    return fetch('/api/candles?tf=' + encodeURIComponent(state.tf) + '&limit=300', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.candles || !j.candles.length) throw new Error(j.error || 'no data');
        state.series.setData(j.candles);
        state.lastCandle = Object.assign({}, j.candles[j.candles.length - 1]);
        if (fit) state.chart.timeScale().fitContent();
        $('chart-loading').classList.add('hide');
      })
      .catch(function (e) {
        $('chart-loading').textContent = 'خطا در بارگذاری نمودار — تلاش مجدد…';
        $('chart-loading').classList.remove('hide');
      });
  }

  /* ---------------- price ---------------- */
  function renderPrice(q) {
    var big = $('price-big');
    var prev = state.lastPrice;
    state.lastPrice = q.price;

    big.textContent = fmt(q.price, 2);
    big.classList.remove('up', 'dn');
    if (prev !== null && q.price !== prev) {
      big.classList.add(q.price > prev ? 'up' : 'dn');
    }

    $('price-bid').textContent = fmt(q.bid, 2);
    $('price-ask').textContent = fmt(q.ask, 2);
    $('price-src').textContent = q.source || '—';

    var d = q.ts ? new Date(q.ts) : new Date();
    $('price-time').textContent = d.toLocaleTimeString('fa-IR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    // daily change vs. previous close from candles (1d)
    renderChange(q.price);

    $('live-badge').classList.remove('stale');
    // live price marker on chart
    if (state.series) {
      try {
        state.series.applyOptions({
          priceLineVisible: true,
          priceLineColor: '#f0b90b',
          priceLineWidth: 1,
          priceLineStyle: LightweightCharts.LineStyle.Dotted,
          lastValueVisible: true
        });
      } catch (e) {}
    }
    renderList(); // update distances
  }

  function pollPrice() {
    fetch('/api/price', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error('bad');
        renderPrice(j);
      })
      .catch(function () {
        $('live-badge').classList.add('stale');
        $('price-src').textContent = 'اتصال قطع — تلاش مجدد';
      });
  }

  function loadPrevClose() {
    fetch('/api/candles?tf=1d&limit=3', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.candles && j.candles.length >= 2) {
          // last item is today's forming candle -> use the one before it (yesterday's close)
          state.prevClose = j.candles[j.candles.length - 2].close;
          if (state.lastPrice) renderChange(state.lastPrice);
        }
      })
      .catch(function () {});
  }

  function renderChange(price) {
    if (!state.prevClose) return;
    var diff = price - state.prevClose;
    var pct = (diff / state.prevClose) * 100;
    var ch = $('price-change');
    ch.textContent = (diff >= 0 ? '+' : '') + fmt(diff, 2) +
      ' (' + (diff >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
    ch.className = 'chg ' + (diff >= 0 ? 'up' : 'dn');
  }

  /* ---------------- levels ---------------- */
  function drawLevel(lv) {
    if (!state.series) return;
    var color = lv.type === 'support' ? '#26a37b' : '#e2544c';
    var title = (lv.type === 'support' ? 'S' : 'R') + ' ' + lv.price.toFixed(2) +
      (lv.note ? ' · ' + lv.note : '');
    var line = state.series.createPriceLine({
      price: lv.price,
      color: color,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true,
      title: title
    });
    state.priceLines[lv.id] = line;
  }

  function redrawAllLevels() {
    if (!state.series) return;
    Object.keys(state.priceLines).forEach(function (id) {
      try { state.series.removePriceLine(state.priceLines[id]); } catch (e) {}
    });
    state.priceLines = {};
    state.levels.forEach(drawLevel);
  }

  function removeLevel(id) {
    if (state.priceLines[id]) {
      try { state.series.removePriceLine(state.priceLines[id]); } catch (e) {}
      delete state.priceLines[id];
    }
    state.levels = state.levels.filter(function (l) { return l.id !== id; });
    saveLevels();
    renderList();
  }

  function renderList() {
    var box = $('levels-list');
    var empty = $('levels-empty');
    $('levels-count').textContent = state.levels.length;

    if (!state.levels.length) {
      box.innerHTML = '';
      empty.classList.remove('hide');
      return;
    }
    empty.classList.add('hide');

    // resistance first (high -> low), then support (high -> low)
    var sorted = state.levels.slice().sort(function (a, b) { return b.price - a.price; });

    box.innerHTML = sorted.map(function (lv) {
      var dist = '';
      if (state.lastPrice) {
        var d = lv.price - state.lastPrice;
        var pct = (d / state.lastPrice) * 100;
        dist = (d >= 0 ? '+' : '') + d.toFixed(2) + ' (' + pct.toFixed(2) + '%)';
      }
      return '<div class="level-item ' + lv.type + '">' +
        '<span class="lv-type">' + (lv.type === 'support' ? 'حمایت' : 'مقاومت') + '</span>' +
        '<span class="lv-price">' + lv.price.toFixed(2) + '</span>' +
        (lv.note ? '<span class="lv-note">' + escapeHtml(lv.note) + '</span>' : '') +
        '<span class="lv-dist">' + dist + '</span>' +
        '<button class="lv-del" data-id="' + lv.id + '" aria-label="حذف">&times;</button>' +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.lv-del'), function (b) {
      b.addEventListener('click', function () { removeLevel(b.getAttribute('data-id')); });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function showMsg(text, kind) {
    var el = $('level-msg');
    el.textContent = text;
    el.className = 'msg ' + (kind || '');
    if (text) setTimeout(function () {
      if (el.textContent === text) { el.textContent = ''; el.className = 'msg'; }
    }, 2600);
  }

  function addLevel() {
    var raw = $('level-price').value.trim();
    var price = parseFloat(raw);
    if (!raw || isNaN(price) || price <= 0) {
      showMsg('یک قیمت معتبر وارد کنید.', 'err');
      return;
    }
    if (price < 100 || price > 100000) {
      showMsg('قیمت خارج از محدوده منطقی است.', 'err');
      return;
    }
    var dup = state.levels.some(function (l) {
      return Math.abs(l.price - price) < 0.005 && l.type === state.type;
    });
    if (dup) {
      showMsg('این خط قبلاً اضافه شده است.', 'err');
      return;
    }

    var lv = {
      id: 'lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      price: Math.round(price * 100) / 100,
      type: state.type,
      note: $('level-note').value.trim(),
      at: Date.now()
    };
    state.levels.push(lv);
    saveLevels();
    drawLevel(lv);
    renderList();

    $('level-price').value = '';
    $('level-note').value = '';
    showMsg((lv.type === 'support' ? 'حمایت' : 'مقاومت') + ' ' + lv.price.toFixed(2) + ' اضافه شد.', 'ok');
  }

  /* ---------------- events ---------------- */
  function bindEvents() {
    // timeframe
    Array.prototype.forEach.call(document.querySelectorAll('.tf'), function (btn) {
      btn.addEventListener('click', function () {
        if (btn.classList.contains('active')) return;
        document.querySelector('.tf.active').classList.remove('active');
        btn.classList.add('active');
        state.tf = btn.getAttribute('data-tf');
        $('chart-loading').textContent = 'در حال بارگذاری نمودار…';
        $('chart-loading').classList.remove('hide');
        loadCandles(true).then(redrawAllLevels);
      });
    });

    // type segment
    Array.prototype.forEach.call(document.querySelectorAll('#level-type .seg-btn'), function (btn) {
      btn.addEventListener('click', function () {
        document.querySelector('#level-type .seg-btn.active').classList.remove('active');
        btn.classList.add('active');
        state.type = btn.getAttribute('data-type');
      });
    });

    $('level-add').addEventListener('click', addLevel);
    $('level-price').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addLevel();
    });
    $('level-note').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') addLevel();
    });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    state.levels = loadLevels();
    initChart();
    bindEvents();
    renderList();

    loadCandles(true).then(redrawAllLevels);
    loadPrevClose();
    pollPrice();

    setInterval(pollPrice, PRICE_MS);
    setInterval(function () {
      if (document.hidden) return;
      loadCandles(false);
    }, CANDLE_MS);
    setInterval(loadPrevClose, 300000);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { pollPrice(); loadCandles(false); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
