/* =========================================================
   XAUUSD live spot + chart + support/resistance levels
   TradingView-style vertical (price-axis) zoom
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
    barSeconds: 3600,
    priceLines: {},          // id -> priceLine handle
    chart: null,
    series: null,
    autoScale: true,         // false once the user zooms/pans vertically
    customRange: null        // { top, bottom } while vertically zoomed
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
        scaleMargins: { top: 0.12, bottom: 0.12 },
        // TradingView-like price axis behaviour
        autoScale: true,
        mode: LightweightCharts.PriceScaleMode.Normal,
        alignLabels: true,
        entireTextOnly: false
      },
      timeScale: {
        borderColor: '#232c37',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 6,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        lockVisibleTimeRangeOnResize: true
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: '#4b5666', labelBackgroundColor: '#2a3441' },
        horzLine: { color: '#4b5666', labelBackgroundColor: '#2a3441' }
      },
      // vertical drag/scroll on the price scale + pane, like TradingView
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true
      },
      handleScale: {
        // IMPORTANT: the library's own price-axis scaling is disabled on
        // purpose. We implement the vertical zoom ourselves (see
        // installVerticalZoom). If both are enabled they each apply their own
        // factor to the same drag, so the zoom lands squared and the chart
        // collapses in one jump — that was the "sudden shrink" bug.
        axisPressedMouseMove: { time: true, price: false },
        axisDoubleClickReset: { time: true, price: false },
        mouseWheel: true,
        pinch: true
      },
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
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      priceLineVisible: true,
      priceLineColor: '#f0b90b',
      priceLineWidth: 1,
      priceLineStyle: LightweightCharts.LineStyle.Dotted,
      lastValueVisible: true,
      // The hook that makes vertical zoom possible: while the user has zoomed
      // the price axis we report our own range instead of the data extent.
      autoscaleInfoProvider: function (original) {
        if (state.customRange) {
          return {
            priceRange: {
              minValue: state.customRange.bottom,
              maxValue: state.customRange.top
            }
          };
        }
        return original();
      }
    });

    // introspection handle for the automated checks (harmless in production)
    window.__xauTs = state.chart.timeScale();

    // fade the "drag the price bar" hint away after a few seconds, and
    // immediately once the user actually performs a vertical zoom
    var hint = $('chart-hint');
    if (hint) {
      var killHint = function () { hint.classList.add('hide'); };
      setTimeout(killHint, 6500);
      el.addEventListener('mousedown', killHint, true);
      el.addEventListener('touchstart', killHint, true);
      el.addEventListener('wheel', killHint, { passive: true, capture: true });
    }

    installVerticalZoom(el);

    window.addEventListener('resize', function () {
      if (!state.chart) return;
      state.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
  }

  /* -----------------------------------------------------------------
     Vertical zoom, TradingView style.

     The library's own axisPressedMouseMove works on desktop, but it is
     unreliable on touch and gives no feedback. So we implement an explicit
     price-axis gesture on top of it:

       • drag vertically on the right price bar  -> zoom the price range
       • wheel over the price bar               -> zoom the price range
       • pinch vertically on the price bar      -> zoom the price range
       • double-click / double-tap the price bar-> back to auto scale
       • Shift + wheel anywhere on the chart    -> zoom the price range
     ----------------------------------------------------------------- */
  function installVerticalZoom(container) {
    var priceScaleWidth = 56; // px reserved for the right price axis hit area
    var ps = state.chart.priceScale('right');

    function inPriceAxis(clientX) {
      var rect = container.getBoundingClientRect();
      // RTL page, but lightweight-charts keeps the right price scale on the right edge
      return clientX >= rect.right - priceScaleWidth;
    }

    /* ---- height of the PRICE pane, not of the whole widget ----
       container.clientHeight also covers the time axis (~28px). Feeding that
       into coordinateToPrice() reads a price BELOW the pane, so every gesture
       measured a range wider than reality and the error compounded on each
       interaction until the chart collapsed. We measure the real pane height
       by probing where the price mapping stays linear. */
    function paneHeight() {
      var h = container.clientHeight;
      if (!h) return 0;
      // The chart canvas that paints the candles is the price pane; the time
      // axis lives in its own canvas below it. coordinateToPrice() happily
      // extrapolates past the pane, so probing it cannot find the edge —
      // we read the real pane canvas instead.
      try {
        var tables = container.querySelectorAll('canvas');
        var best = 0;
        for (var i = 0; i < tables.length; i++) {
          var r = tables[i].getBoundingClientRect();
          // the price pane is the tallest canvas in the widget
          if (r.height > best && r.height < h + 1) best = r.height;
        }
        if (best >= 40) return Math.round(best);
      } catch (e) {}
      return h;
    }

    /* ---- read the currently visible price range ---- */
    function visibleRange() {
      var h = paneHeight();
      if (!h) return null;
      var top = state.series.coordinateToPrice(0);
      var bottom = state.series.coordinateToPrice(h);
      if (top === null || bottom === null) return null;
      if (!isFinite(top) || !isFinite(bottom)) return null;
      if (top === bottom) return null;
      return { top: Math.max(top, bottom), bottom: Math.min(top, bottom), h: h };
    }

    /* ---- apply an explicit price range ----
       lightweight-charts v4 exposes no setVisiblePriceRange, and scaleMargins
       are rejected when negative — so margins alone can never zoom INTO the
       data. The reliable hook is the series' autoscaleInfoProvider (installed
       above): while a custom range is set we report it as the series' price
       range, so the price scale renders exactly what we ask for. */
    /* Zoom limits are derived from the DATA, not from absolute prices, so the
       chart can never be squeezed into a meaningless sliver nor blown up until
       the candles vanish into a flat line. */
    function dataSpan() {
      var arr = state.lastData;
      if (!arr || !arr.length) return null;
      var lo = Infinity, hi = -Infinity;
      for (var i = 0; i < arr.length; i++) {
        var k = arr[i];
        if (!k) continue;
        if (k.low < lo) lo = k.low;
        if (k.high > hi) hi = k.high;
      }
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
      return hi - lo;
    }

    function setPriceRange(top, bottom) {
      if (!(isFinite(top) && isFinite(bottom)) || top <= bottom) return;

      var span = top - bottom;
      var center = (top + bottom) / 2;

      // clamp the span against the data extent: at most 8x wider (zoomed out)
      // and at least 1/50 of it (zoomed in). This is what keeps the gesture
      // stable instead of letting a fast drag collapse the whole chart.
      var ds = dataSpan();
      if (ds) {
        var maxSpan = ds * 8;
        var minSpan = Math.max(ds / 50, 0.02);
        if (span > maxSpan) span = maxSpan;
        if (span < minSpan) span = minSpan;
      } else {
        if (span < 0.02) span = 0.02;
        if (span > 500000) span = 500000;
      }

      var half = span / 2;
      state.customRange = { top: center + half, bottom: center - half };
      state.autoScale = false;

      try {
        ps.applyOptions({ autoScale: true, scaleMargins: { top: 0, bottom: 0 } });
        ps.setAutoScale(true);         // force an immediate recompute
      } catch (e) {}
      markAuto();
    }

    /* ---- drag -> zoom factor ----
       A gentle, near-linear response instead of the old exp(dy/0.45h), which
       reached 9x within half a pane and made the chart appear to shrink in one
       jump. Dragging a full pane height now changes the range by 2.5x at most,
       which is what TradingView feels like. */
    function dragFactor(dy, h) {
      if (!h) return 1;
      var t = dy / h;                          // -1 .. +1 over one pane
      t = Math.max(-1.5, Math.min(1.5, t));    // ignore runaway drags
      var f = 1 + t * 1.5;                     // down => >1 (out), up => <1 (in)
      return Math.max(0.25, Math.min(2.5, f));
    }

    /* ---- zoom around a focus price ---- */
    function zoomBy(factor, focusPrice) {
      var vr = visibleRange();
      if (!vr) return;
      var center = (focusPrice === undefined || focusPrice === null || !isFinite(focusPrice))
        ? (vr.top + vr.bottom) / 2
        : focusPrice;
      var newTop = center + (vr.top - center) * factor;
      var newBottom = center - (center - vr.bottom) * factor;
      setPriceRange(newTop, newBottom);
    }

    /* ---- pan vertically ---- */
    function panBy(priceDelta) {
      var vr = visibleRange();
      if (!vr) return;
      setPriceRange(vr.top + priceDelta, vr.bottom + priceDelta);
    }

    window.__xauZoom = {
      zoomBy: zoomBy,
      panBy: panBy,
      reset: resetAuto,
      // read-only introspection used by the automated checks
      range: visibleRange,
      paneHeight: paneHeight
    };

    /* ================= mouse drag on the price axis ================= */
    var drag = null;

    container.addEventListener('mousedown', function (e) {
      if (!inPriceAxis(e.clientX)) return;
      var vr = visibleRange();
      if (!vr) return;
      drag = {
        y0: e.clientY,
        top: vr.top,
        bottom: vr.bottom,
        h: container.clientHeight,
        shift: e.shiftKey || e.ctrlKey || e.metaKey
      };
      container.classList.add('vzoom');
      e.preventDefault();
      e.stopPropagation();
    }, true);

    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var dy = e.clientY - drag.y0;
      var span = drag.top - drag.bottom;

      if (drag.shift) {
        // shift-drag = pan vertically
        var priceDelta = (dy / drag.h) * span;
        setPriceRange(drag.top + priceDelta, drag.bottom + priceDelta);
      } else {
        // drag DOWN => zoom out, drag UP => zoom in (TradingView direction).
        // The factor is always computed from the range captured on mousedown,
        // never from the live range, so the gesture is absolutely stable and
        // fully reversible: return the mouse to where it started and the chart
        // returns exactly to where it was.
        var factor = dragFactor(dy, drag.h);
        var center = (drag.top + drag.bottom) / 2;
        setPriceRange(
          center + (drag.top - center) * factor,
          center - (center - drag.bottom) * factor
        );
      }
      e.preventDefault();
    }, true);

    window.addEventListener('mouseup', function () {
      if (!drag) return;
      drag = null;
      container.classList.remove('vzoom');
    }, true);

    /* ============ drag the CHART BODY = pan both axes ============
       The library pans the time axis on its own, but it never moves the price
       axis, so the chart could be zoomed vertically yet not shifted up/down.
       We add the vertical half here: the horizontal drag keeps flowing to the
       library (we do NOT swallow the event), while we translate the vertical
       component of the same drag into a price-range shift. */
    var pan = null;

    container.addEventListener('mousedown', function (e) {
      if (inPriceAxis(e.clientX)) return;   // the axis has its own handler
      if (e.button !== 0) return;
      var vr = visibleRange();
      if (!vr) return;
      pan = {
        y0: e.clientY,
        top: vr.top,
        bottom: vr.bottom,
        h: vr.h,
        moved: false
      };
      // NOTE: no preventDefault here — the library still needs this event
      // to start its own horizontal pan.
    }, false);

    window.addEventListener('mousemove', function (e) {
      if (!pan) return;
      var dy = e.clientY - pan.y0;
      if (!pan.moved) {
        if (Math.abs(dy) < 2) return;       // ignore click jitter
        pan.moved = true;
        container.classList.add('vpan');
      }
      var span = pan.top - pan.bottom;
      // drag down => look at higher prices (content follows the cursor)
      var delta = (dy / pan.h) * span;
      setPriceRange(pan.top + delta, pan.bottom + delta);
    }, false);

    window.addEventListener('mouseup', function () {
      if (!pan) return;
      pan = null;
      container.classList.remove('vpan');
    }, false);

    /* ================= wheel ================= */
    container.addEventListener('wheel', function (e) {
      var overAxis = inPriceAxis(e.clientX);
      if (!overAxis && !e.shiftKey) return;   // let the library do horizontal zoom
      var rect = container.getBoundingClientRect();
      var focus = state.series.coordinateToPrice(e.clientY - rect.top);
      // scale the step with the wheel delta so a trackpad flick and a mouse
      // notch both feel right, but keep it bounded
      var mag = Math.min(1, Math.abs(e.deltaY) / 120);
      var step = 0.10 + 0.15 * mag;                  // 10%..25% per notch
      var factor = e.deltaY > 0 ? (1 + step) : 1 / (1 + step);
      zoomBy(factor, focus);
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false, capture: true });

    /* ================= touch: drag + vertical pinch ================= */
    var touch = null;

    container.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        var t = e.touches[0];
        if (!inPriceAxis(t.clientX)) {
          // one finger on the chart BODY: pan. The horizontal component keeps
          // going to the library; we own the vertical component. The gesture
          // only becomes a vertical pan once it is clearly more vertical than
          // horizontal, so ordinary left/right scrolling is untouched.
          var vrp = visibleRange();
          if (!vrp) return;
          touch = {
            kind: 'pan',
            x0: t.clientX,
            y0: t.clientY,
            top: vrp.top,
            bottom: vrp.bottom,
            h: vrp.h,
            decided: false,
            vertical: false
          };
          return;   // no preventDefault: the library still needs this touch
        }
        var vr = visibleRange();
        if (!vr) return;
        touch = {
          kind: 'drag',
          y0: t.clientY,
          top: vr.top,
          bottom: vr.bottom,
          h: vr.h
        };
        container.classList.add('vzoom');
        e.preventDefault();
        e.stopPropagation();
      } else if (e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1];
        var dy = Math.abs(a.clientY - b.clientY);
        var dx = Math.abs(a.clientX - b.clientX);
        // only hijack clearly-vertical pinches; horizontal pinch stays with the lib
        if (dy < dx * 1.2) return;
        var vr2 = visibleRange();
        if (!vr2) return;
        touch = {
          kind: 'pinch',
          d0: Math.max(8, dy),
          top: vr2.top,
          bottom: vr2.bottom
        };
        e.preventDefault();
        e.stopPropagation();
      }
    }, { passive: false, capture: true });

    container.addEventListener('touchmove', function (e) {
      if (!touch) return;
      if (touch.kind === 'pan' && e.touches.length === 1) {
        var pt = e.touches[0];
        var pdx = pt.clientX - touch.x0;
        var pdy = pt.clientY - touch.y0;
        if (!touch.decided) {
          if (Math.abs(pdx) < 8 && Math.abs(pdy) < 8) return;  // still ambiguous
          touch.decided = true;
          // vertical intent only when the finger travels mostly up/down
          touch.vertical = Math.abs(pdy) > Math.abs(pdx) * 1.2;
        }
        if (!touch.vertical) return;      // horizontal swipe -> leave to the lib
        var pspan = touch.top - touch.bottom;
        var pdelta = (pdy / touch.h) * pspan;
        setPriceRange(touch.top + pdelta, touch.bottom + pdelta);
        e.preventDefault();               // we own this gesture now
        e.stopPropagation();
      } else if (touch.kind === 'drag' && e.touches.length === 1) {
        var dy = e.touches[0].clientY - touch.y0;
        var factor = dragFactor(dy, touch.h);
        var center = (touch.top + touch.bottom) / 2;
        setPriceRange(
          center + (touch.top - center) * factor,
          center - (center - touch.bottom) * factor
        );
        e.preventDefault();
      } else if (touch.kind === 'pinch' && e.touches.length === 2) {
        var d = Math.max(8, Math.abs(e.touches[0].clientY - e.touches[1].clientY));
        var f = touch.d0 / d;                 // fingers apart -> zoom in
        f = Math.max(0.3, Math.min(3, f));    // keep pinch in a sane band
        var c2 = (touch.top + touch.bottom) / 2;
        setPriceRange(
          c2 + (touch.top - c2) * f,
          c2 - (c2 - touch.bottom) * f
        );
        e.preventDefault();
      }
    }, { passive: false, capture: true });

    function endTouch() {
      if (!touch) return;
      touch = null;
      container.classList.remove('vzoom');
    }
    container.addEventListener('touchend', endTouch, true);
    container.addEventListener('touchcancel', endTouch, true);

    /* ================= double click / double tap = auto scale ================= */
    container.addEventListener('dblclick', function (e) {
      if (!inPriceAxis(e.clientX)) return;
      resetAuto();
      e.preventDefault();
      e.stopPropagation();
    }, true);

    var lastTap = 0;
    container.addEventListener('touchend', function (e) {
      var t = e.changedTouches && e.changedTouches[0];
      if (!t || !inPriceAxis(t.clientX)) return;
      var now = Date.now();
      if (now - lastTap < 320) { resetAuto(); e.preventDefault(); }
      lastTap = now;
    }, true);
  }

  function resetAuto() {
    state.autoScale = true;
    state.customRange = null;
    try {
      var ps = state.chart.priceScale('right');
      ps.applyOptions({
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 }
      });
      ps.setAutoScale(true);
    } catch (e) {}
    markAuto();
  }

  function markAuto() {
    var b = $('btn-autoscale');
    if (!b) return;
    b.classList.toggle('on', !!state.autoScale);
    b.textContent = state.autoScale ? 'اتو' : 'دستی';
  }

  /* ---------------- candles ---------------- */
  function loadCandles(fit) {
    return fetch('/api/candles?tf=' + encodeURIComponent(state.tf) + '&limit=600', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.candles || !j.candles.length) throw new Error(j.error || 'no data');

        // keep the user's horizontal view when this is a background refresh
        var keepRange = null;
        if (!fit) {
          try { keepRange = state.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
        }

        state.lastData = j.candles;
        state.barSeconds = j.barSeconds || state.barSeconds;
        state.series.setData(j.candles);
        state.lastCandle = Object.assign({}, j.candles[j.candles.length - 1]);

        if (fit) {
          state.chart.timeScale().fitContent();
        } else if (keepRange) {
          try { state.chart.timeScale().setVisibleLogicalRange(keepRange); } catch (e) {}
        }

        var src = $('chart-src');
        if (src) {
          src.textContent = (j.source || '—') +
            (j.proxy ? ' · کالیبره ×' + (j.calibration || 1) : ' · فید واقعی');
          src.classList.toggle('proxy', !!j.proxy);
        }

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

    renderChange(q.price);
    $('live-badge').classList.remove('stale');

    // live-update the forming candle so the chart tracks spot in real time,
    // and roll a brand-new bar when the timeframe bucket changes
    if (state.series && state.lastCandle) {
      var sec = state.barSeconds || 3600;
      var bucket = Math.floor(Date.now() / 1000 / sec) * sec;
      var k = state.lastCandle;

      if (bucket > k.time) {
        k = {
          time: bucket,
          open: k.close,
          high: Math.max(k.close, q.price),
          low: Math.min(k.close, q.price),
          close: q.price
        };
        state.lastCandle = k;
        if (state.lastData) state.lastData.push(k);
      } else {
        k.close = q.price;
        if (q.price > k.high) k.high = q.price;
        if (q.price < k.low) k.low = q.price;
        if (state.lastData && state.lastData.length) {
          state.lastData[state.lastData.length - 1] = k;
        }
      }
      try { state.series.update(k); } catch (e) {}
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
    fetch('/api/candles?tf=1d&limit=5', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ok && j.candles && j.candles.length >= 2) {
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
        resetAuto();
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

    // chart tools
    var bAuto = $('btn-autoscale');
    if (bAuto) bAuto.addEventListener('click', resetAuto);

    var bFit = $('btn-fit');
    if (bFit) bFit.addEventListener('click', function () {
      state.chart.timeScale().fitContent();
      resetAuto();
    });

    var bIn = $('btn-zoom-in');
    if (bIn) bIn.addEventListener('click', function () {
      if (window.__xauZoom) window.__xauZoom.zoomBy(1 / 1.3);
    });

    var bOut = $('btn-zoom-out');
    if (bOut) bOut.addEventListener('click', function () {
      if (window.__xauZoom) window.__xauZoom.zoomBy(1.3);
    });

    // keyboard: up/down = vertical zoom, 0 = reset
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (!window.__xauZoom) return;
      if (e.key === 'ArrowUp') { window.__xauZoom.zoomBy(1 / 1.2); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { window.__xauZoom.zoomBy(1.2); e.preventDefault(); }
      else if (e.key === '0') { window.__xauZoom.reset(); }
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
    markAuto();

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
