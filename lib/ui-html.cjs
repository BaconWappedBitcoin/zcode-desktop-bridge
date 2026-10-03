'use strict';
/**
 * ui-html.cjs — the GET /ui dashboard page, one self-contained HTML string.
 *
 * No CDN, no external assets: inline CSS + vanilla JS. The page polls
 * GET /v1/ui/state (the same aggregate the TUI renders, lib/ui-state.cjs)
 * every few seconds and draws the same panels: header status, PLAN gauges,
 * ACTIVE tasks, HISTORY matrix, OFFERS, EVENTS.
 *
 * Read-only EXCEPT cancel: a Cancel button on running sessions/idle tasks
 * asks for confirmation, then POSTs /v1/ui/cancel {kind, id}. Offers and
 * banked resets are display-only — the page never claims and never spends;
 * it points at the ZCode app / zcode_plan_reset instead.
 *
 * The string avoids backticks and "${" so it can live in one template
 * literal; the page's own JS uses plain string concatenation.
 */
const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zcode-bridge dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0f14; color: #d5dde5;
         font: 13px/1.45 Consolas, "Cascadia Mono", Menlo, monospace; }
  a { color: #67e8f9; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 14px 18px 60px; }
  header { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline;
           border-bottom: 1px solid #1d2733; padding-bottom: 8px; }
  header h1 { font-size: 15px; margin: 0; color: #e8eef4; letter-spacing: .4px; }
  header .v { color: #6b7684; }
  .dot { font-weight: bold; }
  .up { color: #34d399; } .down { color: #fbbf24; }
  #clock { margin-left: auto; color: #e8eef4; }
  h2 { font-size: 12px; color: #8fa1b3; letter-spacing: 1.4px; margin: 20px 0 6px;
       border-bottom: 1px dashed #1d2733; padding-bottom: 3px; }
  h2 .aux { float: right; font-weight: normal; letter-spacing: 0; color: #6b7684; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; color: #6b7684; font-weight: normal; font-size: 11px;
       letter-spacing: .8px; padding: 2px 8px 2px 0; border-bottom: 1px solid #16202b; }
  td { padding: 3px 8px 3px 0; border-bottom: 1px solid #101820; vertical-align: top; }
  td.n, th.n { white-space: nowrap; }
  .dim { color: #6b7684; } .ok { color: #34d399; } .warn { color: #fbbf24; }
  .err { color: #f87171; } .accent { color: #67e8f9; }
  .tail { color: #8fa1b3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 380px; }
  .bar { display: inline-block; height: 10px; background: #16202b; width: 220px;
         border-radius: 3px; overflow: hidden; vertical-align: middle; }
  .bar i { display: block; height: 100%; background: #34d399; }
  .bar i.w { background: #fbbf24; } .bar i.e { background: #f87171; }
  button { font: inherit; background: #16202b; color: #f87171; border: 1px solid #3a1d20;
           border-radius: 4px; padding: 1px 8px; cursor: pointer; }
  button:hover { background: #2a1215; }
  pre.matrix { margin: 0; overflow-x: auto; color: #cfe3d8; }
  pre.matrix .ok { color: #34d399; } pre.matrix .err { color: #f87171; }
  pre.matrix .run { color: #67e8f9; } pre.matrix .can { color: #6b7684; }
  .card { background: #0e141b; border: 1px solid #16202b; border-radius: 6px; padding: 8px 12px; }
  .hint { color: #6b7684; font-size: 12px; }
  #toast { position: fixed; right: 16px; bottom: 16px; background: #16202b; color: #e8eef4;
           border: 1px solid #24313f; border-radius: 6px; padding: 8px 14px; display: none; }
  #toast.err { color: #f87171; }
  footer { margin-top: 26px; color: #4d5a68; font-size: 12px; }
  .stale-banner { background: #2a2110; border: 1px solid #4d3d12; color: #fbbf24;
                  padding: 6px 10px; border-radius: 6px; margin: 10px 0; display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>zcode-bridge <span class="v" id="ver"></span></h1>
    <span class="dot up" id="bridge">&#9679; checking&hellip;</span>
    <span class="dim" id="pids"></span>
    <span id="clock" class="n"></span>
  </header>
  <div class="stale-banner" id="stale">bridge process down &mdash; showing last-known state (stale); data comes from on-disk files only</div>

  <h2>PLAN <span class="aux">read-only quota APIs, polled at most every 60&nbsp;s into out/ui/plan.json</span></h2>
  <div class="card" id="plan"><span class="dim">no data yet</span></div>

  <h2>ACTIVE <span class="aux" id="active-aux"></span></h2>
  <table id="active"><thead><tr>
    <th>KIND</th><th>NAME</th><th>MODEL</th><th>STATUS</th><th>ELAPSED</th><th>LAST ACTIVITY</th><th>TAIL</th><th></th>
  </tr></thead><tbody></tbody></table>

  <h2>HISTORY <span class="aux" id="hist-aux"></span></h2>
  <div class="card"><pre class="matrix" id="hist"></pre></div>

  <h2>OFFERS <span class="aux" id="offers-aux"></span></h2>
  <div class="card" id="offers"><span class="dim">none open</span></div>
  <p class="hint">Claiming is manual (ZCode app, captcha) and resets are spent via
     zcode_plan_reset with the owner's OK &mdash; never from this dashboard. Display only.</p>

  <h2>EVENTS <span class="aux">merged NDJSON from all bridge logs, newest first</span></h2>
  <table id="events"><tbody></tbody></table>

  <footer>cancel goes through the bridge HTTP API (/v1/ui/cancel) after a confirm
          &middot; everything else here is read-only &middot; zcode desktop bridge dashboard</footer>
</div>
<div id="toast"></div>
<script>
(function () {
  'use strict';
  var last = null;
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clockStr(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtDur(ms) {
    if (!isFinite(ms) || ms < 0) return '\\u2014';
    var s = Math.round(ms / 1000);
    if (s < 90) return s + 's';
    var m = Math.round(s / 60);
    if (m < 90) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h' + pad(m % 60) + 'm';
    return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
  }
  function fmtTok(n) {
    if (!isFinite(n)) return '\\u2014';
    var a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }
  function toast(text, isErr) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.className = isErr ? 'err' : '';
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.display = 'none'; }, 4000);
  }
  function cancel(kind, id, name) {
    if (!confirm('Cancel ' + kind + ' "' + name + '"? This interrupts the task via the bridge HTTP API.')) return;
    fetch('/v1/ui/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: kind, id: id }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        if (res.status === 200) toast('cancel sent: ' + id);
        else toast('cancel failed: ' + (res.j && res.j.error && res.j.error.message ? res.j.error.message : 'HTTP ' + res.status), true);
        poll();
      })
      .catch(function (e) { toast('cancel failed: ' + e, true); });
  }

  var GLYPH = { ok: '\\u2713', err: '\\u2717', run: '\\u25d0', cancel: '\\u2298', idle: '\\u00b7' };
  var CLS = { ok: 'ok', err: 'err', run: 'run', cancel: 'can', idle: 'can' };
  var STATUS_CLS = { running: 'accent', queued: 'warn', paused: 'warn', done: 'ok', completed: 'ok',
                     idle: 'dim', error: 'err', failed: 'err', lost: 'err', cancelled: 'dim' };

  function render(s) {
    last = s;
    var now = s.now;
    document.getElementById('ver').textContent = 'v' + s.version;
    document.getElementById('clock').textContent = clockStr(now) + ' \\u00b7 refresh ' + hm(Date.now());
    var up = s.bridge.up;
    var dot = document.getElementById('bridge');
    dot.innerHTML = up ? '&#9679; up' : '&#9675; down';
    dot.className = 'dot ' + (up ? 'up' : 'down');
    document.getElementById('stale').style.display = up ? 'none' : 'block';
    document.getElementById('pids').textContent = (s.bridge.pids || []).map(function (p) { return p.source + ' pid ' + p.pid; }).join(' \\u00b7 ')
      + (s.bridge.port ? ' \\u00b7 :' + s.bridge.port : '');

    // plan gauges
    var plan = document.getElementById('plan');
    if (s.plan && (s.plan.fiveHour || s.plan.week)) {
      function gauge(label, g) {
        if (!g) return '';
        var pct = g.usedPercentage == null ? null : Math.max(0, Math.min(100, g.usedPercentage));
        var cls = pct != null && pct >= 90 ? 'e' : pct != null && pct >= 70 ? 'w' : '';
        return '<tr><td class="n"><b>' + label + '</b></td>'
          + '<td class="n"><span class="bar"><i class="' + cls + '" style="width:' + (pct == null ? 0 : pct) + '%"></i></span></td>'
          + '<td class="n">' + (pct == null ? '?' : Math.round(pct) + '%') + '</td>'
          + '<td class="dim n">used ' + fmtTok(g.used) + '/' + fmtTok(g.limit) + (g.remaining != null ? ' \\u00b7 ' + fmtTok(g.remaining) + ' left' : '')
          + (g.nextResetAt ? ' \\u00b7 resets ' + hm(Date.parse(g.nextResetAt)) : '') + '</td></tr>';
      }
      function resetPart(label, x) {
        if (!x || !x.count) return label + ' \\u00d70';
        var inn = x.earliestExpireAt ? ' (in ' + fmtDur(x.earliestExpireAt - now) + (x.expiringSoon ? ' \\u26a0 &lt;2h' : '') + ')' : '';
        return label + ' \\u00d7' + x.count + inn;
      }
      var r = s.plan.resets || {};
      var resetHtml = '<tr><td class="n"><b>banked</b></td><td colspan="3" class="' + ((r.fiveHour && r.fiveHour.expiringSoon) || (r.week && r.week.expiringSoon) ? 'warn' : 'dim')
        + ' n">5h ' + resetPart('', r.fiveHour).replace(/^ /, '') + ' \\u00b7 wk ' + resetPart('', r.week).replace(/^ /, '') + '</td></tr>';
      plan.innerHTML = '<table>' + gauge('5-hour window', s.plan.fiveHour) + gauge('weekly window', s.plan.week) + resetHtml + '</table>'
        + (s.plan.error ? '<div class="err">last fetch error: ' + esc(s.plan.error) + '</div>' : '');
    }

    // active table
    var tb = document.querySelector('#active tbody');
    var rows = '';
    for (var i = 0; i < s.active.length; i++) {
      var t = s.active[i];
      var st = STATUS_CLS[t.status] || 'dim';
      var label = t.status + (t.kind === 'offpeak' && t.queuePosition != null && t.status === 'queued' ? '#' + t.queuePosition : '');
      rows += '<tr><td class="dim n">' + (t.kind === 'session' ? 'ses' : t.kind === 'offpeak' ? 'idle' : 'lane') + '</td>'
        + '<td class="n">' + esc(t.name) + '</td>'
        + '<td class="dim n">' + esc(t.model || '\\u2014') + '</td>'
        + '<td class="n ' + st + '">' + esc(label) + '</td>'
        + '<td class="n">' + fmtDur(t.elapsedMs) + '</td>'
        + '<td class="n dim">' + (t.lastActivityAt ? fmtDur(Math.max(0, now - t.lastActivityAt)) + ' ago' : '\\u2014') + '</td>'
        + '<td class="tail">' + esc(t.tail || '') + '</td>'
        + '<td class="n">' + (t.cancelable
            ? '<button data-kind="' + t.kind + '" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">cancel</button>' : '')
          + '</td></tr>';
    }
    if (!rows) rows = '<tr><td colspan="8" class="dim">no sessions, idle tasks or watched lanes on disk</td></tr>';
    tb.innerHTML = rows;
    document.getElementById('active-aux').textContent = s.active.length + ' tracked \\u00b7 filter here: none (TUI only)';

    // history matrix
    var h = s.history;
    document.getElementById('hist-aux').textContent = h.mode === 'days' ? 'last 14 days' : 'last 24 hours';
    var out = '';
    for (var j = 0; j < h.rows.length; j++) {
      var row = h.rows[j];
      var line = ' ' + row.label + ' \\u2502 ';
      var spans = '';
      for (var k = 0; k < row.cells.length; k++) {
        var c = row.cells[k] || 'idle';
        spans += '<span class="' + CLS[c] + '">' + GLYPH[c] + '</span> ';
      }
      out += esc(line) + spans + '\\n';
    }
    document.getElementById('hist').innerHTML = out || '<span class="dim">nothing yet</span>';

    // offers
    var offers = document.getElementById('offers');
    document.getElementById('offers-aux').textContent = s.offers.lastCheckAt ? 'last check ' + hm(Date.parse(s.offers.lastCheckAt)) : '';
    if (s.offers.items.length) {
      var oh = '';
      for (var m = 0; m < s.offers.items.length; m++) {
        var o = s.offers.items[m];
        var line2 = '<div>&bull; <span class="' + (o.claimable ? 'accent' : 'warn') + '">' + esc(o.title) + '</span> ';
        if (o.kind !== 'reset-opportunity' && o.tokens) line2 += '<span class="dim">\\u00b7 ' + fmtTok(o.tokens.amount) + ' ' + esc(o.tokens.unit) + '</span> ';
        if (o.msLeft != null) line2 += '<span class="dim">\\u00b7 ' + (o.msLeft > 0 ? 'ends in ' + fmtDur(o.msLeft) : 'EXPIRED') + '</span>';
        oh += line2 + '</div>';
      }
      offers.innerHTML = oh;
    } else offers.innerHTML = '<span class="dim">none open</span>';

    // events
    var ev = document.querySelector('#events tbody');
    var eh = '';
    var list = s.events.slice(0, 40);
    for (var n = 0; n < list.length; n++) {
      var e = list[n];
      eh += '<tr><td class="dim n">' + clockStr(e.tsMs) + '</td><td class="accent n">' + esc(e.kind) + '</td>'
         + '<td class="n">' + esc(e.event) + '</td><td class="dim">' + esc(e.name) + ' ' + esc(e.detail || '') + '</td></tr>';
    }
    if (!eh) eh = '<tr><td class="dim">no events yet</td></tr>';
    ev.innerHTML = eh;
  }

  function poll() {
    fetch('/v1/ui/state', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(render)
      .catch(function (e) {
        document.getElementById('bridge').innerHTML = '&#9675; unreachable';
        document.getElementById('bridge').className = 'dot down';
        toast('state unavailable: ' + e, true);
      });
  }
  document.addEventListener('click', function (ev2) {
    var b = ev2.target;
    if (b && b.tagName === 'BUTTON' && b.dataset.kind) cancel(b.dataset.kind, b.dataset.id, b.dataset.name);
  });
  poll();
  setInterval(poll, 3000);
})();
</script>
</body>
</html>
`;

module.exports = { UI_HTML };
