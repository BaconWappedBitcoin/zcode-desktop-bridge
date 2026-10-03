#!/usr/bin/env node
'use strict';
/**
 * bridge-ui.cjs — zero-dependency task-tracking TUI for the zcode desktop
 * bridge (in the spirit of openslop/nightshift: clock, gauges, job matrix,
 * drill into a job's transcript). Node + raw ANSI only — no npm packages.
 *
 * INDEPENDENT OF ANY HARNESS: it reads only the bridge's on-disk state
 * (out/sessions, out/offpeak, out/offers, out/ui/plan.json, generic uiWatch
 * lanes) plus the read-only HTTP API (/healthz probe; cancel endpoint), so it
 * works when no MCP client is attached and even when the bridge process is
 * down — the last-known state is shown, marked stale.
 *
 * Panels: header (clock + bridge up/down), PLAN gauges (5h/weekly windows +
 * banked resets), ACTIVE table (sessions, idle tasks, watched lanes), HISTORY
 * matrix (outcome glyphs per hour/day bucket), OFFERS (expiry countdowns),
 * EVENTS (merged NDJSON feed, newest first).
 *
 * Keys: ↑/↓ select · Enter detail · o open transcript/log · c cancel (y/N
 * confirm, via the bridge HTTP API only) · f filter · h history range ·
 * r refresh · ? help · q quit. The UI NEVER claims offers and NEVER spends
 * resets — those panels are read-only with a hint to act in the app.
 *
 * Compatibility: Windows Terminal and conhost; truecolor only when the
 * terminal advertises it (WT_SESSION / COLORTERM), else 16-color ANSI, else
 * plain (BRIDGE_UI_COLOR=off / --plain / non-TTY / --once).
 *
 * Run: node bin/bridge-ui.cjs [--config config.json] [--watch DIR]...
 *      node bin/bridge-ui.cjs --once --width 140   (one plain-text frame)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ui = require('../lib/ui-state.cjs');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------------ config
/** --root <dir>: read another checkout's state (config.json + out/ defaults). */
function rootDir(argv) {
  const i = argv.indexOf('--root');
  const r = i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : ROOT;
  return r;
}

/** Same config file the server reads; the UI cares about a subset. */
function loadConfig(argv, root = rootDir(argv)) {
  const cfgIdx = argv.indexOf('--config');
  const cfgPath = cfgIdx !== -1 ? argv[cfgIdx + 1] : path.join(root, 'config.json');
  let fileCfg = {};
  if (cfgPath && fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.error(`[bridge-ui] failed to parse ${cfgPath}: ${e.message}`); process.exit(1); }
  }
  const cfg = {
    root,
    port: fileCfg.port || 8787,
    bind: fileCfg.bind || '127.0.0.1',
    apiKey: fileCfg.apiKey || process.env.ZCODE_BRIDGE_API_KEY || '',
    statusDir: fileCfg.statusDir || path.join(root, 'out', 'sessions'),
    offpeakDir: fileCfg.offpeakDir || path.join(root, 'out', 'offpeak'),
    offersDir: fileCfg.offersDir || path.join(root, 'out', 'offers'),
    uiDir: fileCfg.uiDir || path.join(root, 'out', 'ui'),
    uiWatch: [],
  };
  pushWatch(cfg, fileCfg.uiWatch);
  const envWatch = process.env.UI_WATCH || process.env.BRIDGE_UI_WATCH;
  if (envWatch) pushWatch(cfg, envWatch.split(';').map((s) => s.trim()).filter(Boolean));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--watch' && argv[i + 1]) pushWatch(cfg, [argv[i + 1]]);
  }
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  return cfg;
}

/** uiWatch entries: strings, {dir}, or {name, dir} — kept generic. */
function pushWatch(cfg, entries) {
  for (const e of Array.isArray(entries) ? entries : entries ? [entries] : []) {
    if (typeof e === 'string' && e.trim()) cfg.uiWatch.push({ name: null, dir: e.trim() });
    else if (e && typeof e === 'object' && e.dir) cfg.uiWatch.push({ name: e.name || null, dir: String(e.dir) });
  }
}

// -------------------------------------------------------------------- ANSI
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
function stripAnsi(s) { return String(s).replace(ANSI_RE, ''); }

/** Terminal color depth: 'tc' (truecolor) | '16' | 'none'. */
function detectColorDepth(env = process.env) {
  if (/^(off|none|0|no)$/i.test(env.BRIDGE_UI_COLOR || '')) return 'none';
  if (/^(tc|truecolor|24)$/i.test(env.BRIDGE_UI_COLOR || '')) return 'tc';
  const ct = String(env.COLORTERM || '').toLowerCase();
  if (env.WT_SESSION || ct.includes('truecolor') || ct.includes('24bit')) return 'tc';
  return '16'; // TERM/ConEmu/ANSICON or plain conhost: basic ANSI, no truecolor
}

const S16 = { dim: '90', ok: '32', warn: '33', err: '91', accent: '36', bold: '1', inv: '7' };
const STC = {
  dim: [107, 114, 128], ok: [52, 211, 153], warn: [251, 191, 36],
  err: [248, 113, 113], accent: [34, 211, 238], bold: [229, 231, 235], inv: null,
};

function makePainter(depth) {
  if (depth === 'none') return (_style, t) => t;
  return (style, t) => {
    if (!style) return t;
    if (style === 'inv') return `\x1b[7m${t}\x1b[27m`;
    if (depth === 'tc') {
      const rgb = STC[style];
      return rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${t}\x1b[39m` : t;
    }
    const code = S16[style];
    return code ? `\x1b[${code}m${t}\x1b[0m` : t;
  };
}

// --------------------------------------------------------------- text utils
/** East-Asian-aware display width (good-enough wcwidth for tails/labels). */
function vw(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3)
      || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60)
      || (c >= 0xFFE0 && c <= 0xFFE6) ? 2 : 1;
  }
  return w;
}

function padEndW(s, n) {
  const gap = n - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

function truncW(s, n) {
  if (vw(s) <= n) return s;
  let out = '';
  let w = 0;
  for (const ch of String(s)) {
    const cw = vw(ch);
    if (w + cw > n - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

const clock = (ms) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
};
const hm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ filters
const RUN_STATES = new Set(['running', 'queued', 'paused']);
const FAIL_STATES = new Set(['error', 'failed', 'lost']);

function filterRows(rows, filter) {
  if (filter === 'running') return rows.filter((r) => RUN_STATES.has(r.status));
  if (filter === 'failed') return rows.filter((r) => FAIL_STATES.has(r.status));
  return rows;
}

const STATUS_STYLE = {
  running: 'accent', queued: 'warn', paused: 'warn',
  done: 'ok', completed: 'ok', idle: 'dim',
  error: 'err', failed: 'err', lost: 'err', cancelled: 'dim',
};
const STATUS_GLYPH = {
  running: '●', queued: '…', paused: '⏸', done: '✓', completed: '✓',
  idle: '·', error: '✗', failed: '✗', lost: '✗', cancelled: '⊘',
};

function statusLabel(row) {
  if (row.kind === 'offpeak' && row.status === 'queued' && row.queuePosition !== null) return `queued#${row.queuePosition}`;
  return row.status;
}

// ----------------------------------------------------------------- rendering
const seg = (t, s) => ({ t: String(t), s }); // one styled span of a frame line

/**
 * Render one frame. Pure: (state, view, opts) -> string (plain when
 * opts.color is falsy). Rows are trimmed to the height budget bottom-up so
 * the footer/legend always survives. view: { mode, selected, filter,
 * historyMode, confirm, toast, detailScroll }.
 */
function renderFrame(state, view, opts = {}) {
  const width = Math.max(60, opts.width || 80);
  const height = Math.max(20, opts.height || 42);
  const paint = makePainter(opts.color ? detectColorDepth(opts.env) : 'none');
  const lines = []; // arrays of {t, s?} segments
  const L = (segs) => lines.push(segs);
  const now = state.now;

  // ---- header: clock + bridge status (up/down via the pid/port files)
  const up = state.bridge.up;
  const statusSegs = up
    ? [seg(' ● ', 'ok'), seg(`up ${state.bridge.pids.map((p) => `pid ${p.pid}`).slice(0, 2).join(' ') || '(http)'}${state.bridge.httpUp ? ' · http' : ''}`, 'ok'), state.bridge.port ? seg(` · :${state.bridge.port}`, 'ok') : null].filter(Boolean)
    : [seg(' ○ ', 'warn'), seg('down — showing last-known state (stale)', 'warn')];
  const left = [seg('zcode-bridge ', 'bold'), seg(`v${state.version} `, 'dim'), ...statusSegs];
  const right = [seg(`filter:${view.filter} `, 'dim'), seg(`hist:${view.historyMode === 'days' ? '14d' : '24h'} `, 'dim'), seg(clock(now), 'bold')];
  L(headerLine(left, right, width));

  // ---- PLAN gauges (5h/weekly bars, banked-reset counts, earliest expiry)
  L(panelTitle('PLAN', width));
  if (state.plan) {
    L(gaugeLine('5h ', state.plan.fiveHour));
    L(gaugeLine('wk ', state.plan.week));
    L(resetLine(state.plan));
  } else {
    L([seg(' plan usage: no data yet — the bridge polls (≤60 s) into out/ui/plan.json', 'dim')]);
  }

  // ---- ACTIVE table (sessions, idle tasks, watched lanes in one table)
  const rows = filterRows(state.active, view.filter);
  const cols = activeColumns(width);
  L(panelTitle(`ACTIVE ${rows.length}/${state.active.length}`, width, [seg(`  filter: ${view.filter} [f]`, 'dim')]));
  L([seg(` ${padEndW('KIND', cols.kind)} ${padEndW('NAME', cols.name)} ${padEndW('MODEL', cols.model)} ${padEndW('STATUS', cols.status)} ${padEndW('ELAPSED', cols.elapsed)} ${padEndW('AGE', cols.age)}${cols.tail > 6 ? ' TAIL' : ''}`, 'dim')]);
  const activeBudget = Math.max(3, Math.min(10, height - 30));
  const selIdx = view.mode === 'dashboard' ? view.selected : -1;
  const shown = rows.slice(0, activeBudget);
  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    const selected = i === selIdx;
    const inv = (t) => (selected ? 'inv' : null);
    const segs = [
      seg(selected ? '›' : ' ', inv('')),
      seg(padEndW(r.kind === 'session' ? 'ses' : r.kind === 'offpeak' ? 'idle' : 'lane', cols.kind - 1), selected ? 'inv' : 'dim'), seg(' ', null),
      seg(padEndW(truncW(r.name, cols.name), cols.name), inv('')), seg(' ', null),
      seg(padEndW(truncW(r.model || '—', cols.model), cols.model), selected ? 'inv' : 'dim'), seg(' ', null),
      seg(`${STATUS_GLYPH[r.status] || '·'} `, STATUS_STYLE[r.status] || 'dim'),
      seg(padEndW(truncW(statusLabel(r), cols.status - 2), cols.status - 2), selected ? 'inv' : STATUS_STYLE[r.status] || 'dim'), seg(' ', null),
      seg(padEndW(ui.fmtDuration(r.elapsedMs), cols.elapsed), selected ? 'inv' : 'dim'), seg(' ', null),
      seg(padEndW(r.lastActivityAt ? ui.fmtDuration(Math.max(0, now - r.lastActivityAt)) : '—', cols.age), selected ? 'inv' : 'dim'),
    ];
    if (cols.tail > 6) segs.push(seg(' ', null), seg(truncW(r.tail || '', cols.tail), selected ? 'inv' : 'dim'));
    L(segs);
  }
  if (rows.length > shown.length) L([seg(` +${rows.length - shown.length} more (filter: ${view.filter})`, 'dim')]);

  // ---- HISTORY matrix (rows = tasks/lanes, cols = hours|days, glyphs)
  const h = state.history;
  L(panelTitle(`HISTORY ${h.mode === 'days' ? 'last 14d' : 'last 24h'}`, width, [seg('  [h] range', 'dim')]));
  const labelW = 18;
  const cellW = 2;
  const cells = Math.min(h.buckets, Math.floor((width - labelW - 3) / cellW));
  const skip = Math.max(0, h.buckets - cells); // drop oldest columns when narrow
  const histBudget = Math.max(2, Math.min(8, height - 32));
  for (const row of h.rows.slice(0, histBudget)) {
    const cellText = row.cells.slice(skip).map((c) => (ui.GLYPHS[c] || ui.GLYPHS.idle) + ' ').join('');
    L([seg(` ${padEndW(truncW(row.label, labelW - 1), labelW)}│ ${cellText}`, null)]);
  }
  const areaW = cells * cellW;
  const leftMark = h.mode === 'days' ? `-${cells}d` : `-${cells}h`;
  const fill = Math.max(1, areaW - vw(leftMark) - 3);
  L([seg(` ${' '.repeat(labelW)}│ ${leftMark}${' '.repeat(fill)}now`, 'dim')]);

  // ---- OFFERS (open offers + resets, expiry countdown)
  L(panelTitle('OFFERS', width, state.offers.lastCheckAt ? [seg(`  last check ${hm(Date.parse(state.offers.lastCheckAt))}`, 'dim')] : []));
  const items = state.offers.items.slice(0, 3);
  if (!items.length) L([seg(' none open', 'dim')]);
  for (const o of items) {
    const segs = [seg(' • ', o.claimable ? 'accent' : 'warn'), seg(o.title, o.claimable ? 'accent' : null)];
    if (o.kind !== 'reset-opportunity' && o.tokens) segs.push(seg(` · ${ui.fmtTokens(o.tokens.amount)} ${o.tokens.unit}`, 'dim'));
    if (o.msLeft !== null) segs.push(seg(` · ${o.msLeft > 0 ? `ends in ${ui.fmtDuration(o.msLeft)}` : 'EXPIRED'}`, o.msLeft > 0 && o.msLeft < 30 * 60 * 1000 ? 'warn' : 'dim'));
    L(segs);
  }
  L([seg(' claiming is manual (ZCode app) · resets: zcode_plan_reset — never from the UI', 'dim')]);

  // ---- EVENTS (merged NDJSON feed, newest first)
  L(panelTitle('EVENTS', width));
  for (const e of state.events.slice(0, Math.max(2, Math.min(4, height - 38)))) {
    L([
      seg(` ${clock(e.tsMs)} `, 'dim'), seg(padEndW(e.kind, 6), 'accent'), seg(`${e.event} `, 'bold'),
      seg(truncW(`${e.name} ${e.detail || ''}`, Math.max(8, width - vw(` ${clock(e.tsMs)} ${e.kind} ${e.event} `) - 1)), 'dim'),
    ]);
  }

  // ---- pad to height, then footer / confirm / toast
  while (lines.length < height - 1) L([seg('')]);
  if (view.confirm) {
    L([seg(` Cancel "${view.confirm.name}"? (y/N) `, 'warn')]);
  } else if (view.toast && view.toast.until > now) {
    L([seg(` ${view.toast.text}`, view.toast.style || 'dim')]);
  } else {
    L([seg(truncW(' ↑↓ select · ↵ detail · o open · c cancel · f filter · h range · r refresh · ? help · q quit', width - 1), 'dim')]);
  }
  while (lines.length > height) lines.pop();

  return lines.map((segs) => renderSegs(segs, width, paint)).join('\n');
}

/** Paint a segment row, padding to exact width inside the last styled span. */
function renderSegs(segs, width, paint) {
  const plain = segs.map((s) => s.t).join('');
  if (vw(plain) > width) return truncW(plain, width);
  const pad = ' '.repeat(width - vw(plain));
  if (pad) {
    const last = segs[segs.length - 1];
    const painted = segs.slice(0, -1).map((s) => (s.s ? paint(s.s, s.t) : s.t)).join('');
    return painted + (last.s ? paint(last.s, last.t + pad) : last.t + pad);
  }
  return segs.map((s) => (s.s ? paint(s.s, s.t) : s.t)).join('');
}

function headerLine(left, right, width) {
  const leftW = vw(left.map((s) => s.t).join(''));
  const rightW = vw(right.map((s) => s.t).join(''));
  const gap = Math.max(1, width - leftW - rightW);
  return [...left, { t: ' '.repeat(gap), s: null }, ...right];
}

function panelTitle(name, width, extra = []) {
  const label = `─ ${name} `;
  const extraW = extra.reduce((a, s) => a + vw(s.t), 0);
  const dashes = Math.max(1, width - vw(label) - extraW - 1);
  return [{ t: label, s: 'bold' }, { t: '─'.repeat(dashes), s: 'dim' }, ...extra];
}

function gaugeLine(prefix, g) {
  if (!g) return [seg(` ${prefix}(no data)`, 'dim')];
  const barW = 18;
  const pct = Number.isFinite(g.usedPercentage) ? Math.max(0, Math.min(100, g.usedPercentage)) : null;
  const filled = pct === null ? 0 : Math.round((pct / 100) * barW);
  const bar = pct === null ? '░'.repeat(barW) : '█'.repeat(filled) + '░'.repeat(barW - filled);
  const pctTxt = pct === null ? ' ?%' : ` ${String(Math.round(pct)).padStart(3)}%`;
  return [
    seg(` ${prefix}`, 'bold'),
    seg(bar, pct !== null && pct >= 90 ? 'err' : pct >= 70 ? 'warn' : 'ok'),
    seg(pctTxt, 'bold'),
    seg(`  used ${ui.fmtTokens(g.used)}/${ui.fmtTokens(g.limit)}`, 'dim'),
    g.remaining !== null ? seg(` · ${ui.fmtTokens(g.remaining)} left`, 'dim') : null,
    g.nextResetAt ? seg(` · window resets ${hm(Date.parse(g.nextResetAt))}`, 'dim') : null,
  ].filter(Boolean);
}

function resetLine(plan) {
  const r = plan.resets;
  const parts = [];
  for (const [label, x] of [['5h', r.fiveHour], ['wk', r.week]]) {
    if (!x || !x.count) { parts.push(`${label} ×0`); continue; }
    const inMs = x.earliestExpireAt ? x.earliestExpireAt - plan.now : null;
    parts.push(`${label} ×${x.count}${inMs === null ? '' : ` (in ${ui.fmtDuration(Math.max(0, inMs))}${x.expiringSoon ? ' ⚠ <2h' : ''})`}`);
  }
  const soon = (r.fiveHour && r.fiveHour.expiringSoon) || (r.week && r.week.expiringSoon);
  return [seg(` banked resets: ${parts.join(' · ')}`, soon ? 'warn' : 'dim')];
}

function activeColumns(width) {
  const spec = { kind: 5, name: 24, model: 14, status: 11, elapsed: 8, age: 7 };
  const fixed = () => spec.kind + spec.name + spec.model + spec.status + spec.elapsed + spec.age + 6;
  let tail = width - 1 - fixed();
  if (tail < 10) { spec.name = 16; spec.model = 10; tail = width - 1 - fixed(); }
  if (tail < 6) tail = 0;
  spec.tail = tail;
  return spec;
}

// -------------------------------------------------------------- detail body
/** Scrollable detail text for a row: full status JSON + log tail. */
function buildDetailBody(row, width) {
  const lines = [];
  const push = (s) => lines.push(...String(s).split('\n').flatMap((l) => wrapLine(l || ' ', Math.max(20, width - 3))));
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(row.jsonPath, 'utf8')); } catch { /* missing/corrupt */ }
  push(JSON.stringify(doc ?? { note: `unreadable: ${row.jsonPath}` }, null, 2));
  lines.push('');
  push('── log tail');
  const tail = ui.readTailLines(row.logPath, 16 * 1024, 30);
  push(tail.length ? tail.join('\n') : '(empty log)');
  return lines;
}

function wrapLine(s, width) {
  if (vw(s) <= width) return [s];
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (vw(cur) + vw(ch) > width) { out.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ HTTP
function httpRequest({ port, method, urlPath, body, apiKey, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: Object.assign(
        apiKey ? { 'x-api-key': apiKey } : {},
        body ? { 'content-type': 'application/json' } : {},
      ),
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* text body */ }
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function openInDefaultApp(file) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
  }
}

// -------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`usage: node bin/bridge-ui.cjs [--root <dir>] [--config <file>] [--watch <dir>]... [--once] [--width N] [--height N] [--plain]\n`
      + `  --root    read another checkout's state (its config.json + out/ dirs)\n`
      + `  --once    render one plain-text frame and exit (no alt screen)\n`
      + `  --watch   add a lane watch dir (repeatable; also config uiWatch / UI_WATCH env)\n`);
    return;
  }
  const cfg = loadConfig(argv);
  const once = argv.includes('--once');
  const widthArg = argv.indexOf('--width');
  const heightArg = argv.indexOf('--height');
  const planCache = new ui.PlanUsageCache({
    dir: cfg.uiDir,
    logger: (m, x) => process.stderr.write(`[bridge-ui] ${m} ${x ? JSON.stringify(x) : ''}\n`),
  });

  const view = {
    mode: 'dashboard', selected: 0, filter: 'all', historyMode: 'hours',
    confirm: null, toast: null, detailScroll: 0, detailRowId: null,
  };
  let httpUp; // undefined = never probed; true/false from /healthz
  let state = null;
  const refresh = () => {
    state = ui.aggregate({
      rootDir: cfg.root,
      sessionsDir: cfg.statusDir,
      offpeakDir: cfg.offpeakDir,
      offersDir: cfg.offersDir,
      uiDir: cfg.uiDir,
      watchDirs: cfg.uiWatch,
      historyMode: view.historyMode,
      httpUp,
    });
  };
  refresh();
  const fill = planCache.ensureFresh().catch(() => {});
  if (once) await Promise.race([fill, new Promise((r) => setTimeout(r, 6000))]);
  refresh();

  if (once || !process.stdout.isTTY || argv.includes('--plain')) {
    const width = widthArg !== -1 ? Number(argv[widthArg + 1]) : 140;
    const height = heightArg !== -1 ? Number(argv[heightArg + 1]) : 42;
    process.stdout.write(`${renderFrame(state, view, { width, height, color: false })}\n`);
    return;
  }

  // ---- interactive
  const out = process.stdout;
  const color = detectColorDepth();
  const write = (s) => { try { out.write(s); } catch { /* closed */ } };
  write('\x1b[?1049h\x1b[?25l'); // alternate screen, hide cursor
  const restore = () => {
    try {
      write('\x1b[?25h\x1b[0m\x1b[?1049l');
      if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch { /* best effort */ }
  };
  process.on('exit', restore);
  const quit = () => { restore(); process.exit(0); };

  // redraw at most 2/s (clock tick); fs.watch events only nudge the next tick
  let lastRender = 0;
  let pending = false;
  const renderNow = () => {
    lastRender = Date.now();
    pending = false;
    refresh();
    const width = out.columns || 120;
    const height = out.rows || 42;
    if (view.mode === 'detail') {
      const row = state.active.find((r) => r.id === view.detailRowId);
      if (!row) view.mode = 'dashboard';
      else renderDetail(row, width, height);
    } else if (view.mode === 'help') {
      renderHelp();
    } else {
      const rows = filterRows(state.active, view.filter);
      if (view.selected >= rows.length) view.selected = Math.max(0, rows.length - 1);
      write(`\x1b[H\x1b[2J${renderFrame(state, view, { width, height, color: color !== 'none' })}`);
    }
  };
  const tick = setInterval(() => {
    if (pending || Date.now() - lastRender >= 500) renderNow();
  }, 100);

  const renderDetail = (row, width, height) => {
    const body = buildDetailBody(row, width);
    const maxScroll = Math.max(0, body.length - (height - 4));
    view.detailScroll = Math.max(0, Math.min(view.detailScroll, maxScroll));
    const visible = body.slice(view.detailScroll, view.detailScroll + height - 4);
    const head = `─ DETAIL ${row.kind}:${row.name} `;
    const lines = [
      head + '─'.repeat(Math.max(1, width - vw(head) - 1)),
      ...visible,
      `─ scroll ${view.detailScroll}/${maxScroll} `.padEnd(width, '─'),
      ' ↑↓ scroll · o open log · esc back · q quit',
    ];
    write(`\x1b[H\x1b[2J${lines.join('\n')}`);
  };

  const renderHelp = () => {
    const help = [
      'zcode-bridge dashboard — keys',
      '',
      '  ↑/↓ (j/k)  move selection (ACTIVE table)',
      '  Enter      detail view: full status JSON + log tail (scrollable)',
      '  o          open the transcript/log file in the default app',
      '  c          cancel the selected session / idle task — asks y/N first;',
      '             goes through the bridge HTTP API only, never files',
      '  f          filter: all → running → failed',
      '  h          history range: 24 hours → 14 days',
      '  r          refresh now',
      '  ?          this help ·  q / Ctrl+C  quit',
      '',
      '  Panels: PLAN gauges (read-only quota APIs polled ≤60 s, cached in',
      '  out/ui/plan.json), ACTIVE tasks, HISTORY outcome matrix, OFFERS with',
      '  expiry countdowns, EVENTS feed (merged NDJSON, newest first).',
      '',
      '  The dashboard NEVER claims offers and NEVER spends resets — claim in',
      '  the ZCode app; spend resets via zcode_plan_reset with the owner OK.',
      '',
      '  Stale mode: when the bridge process is down, the last-known state is',
      '  shown and the header marks it STALE.',
    ];
    write(`\x1b[H\x1b[2J${help.map((l) => ` ${l}`).join('\n')}`);
  };

  // fs.watch nudge (debounced) + polling fallback (network-drive safe)
  const watchDirs = [cfg.statusDir, cfg.offpeakDir, cfg.offersDir, cfg.uiDir, ...cfg.uiWatch.map((w) => w.dir)];
  let debounce = null;
  for (const d of watchDirs) {
    try {
      fs.watch(d, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { pending = true; }, 150);
      });
    } catch { /* dir missing — polling covers it */ }
  }

  // /healthz probe (read-only) now + every 5 s
  const probeOnce = () => httpRequest({ port: cfg.port, method: 'GET', urlPath: '/healthz', apiKey: cfg.apiKey, timeoutMs: 1500 })
    .then((r) => { httpUp = r.status === 200; })
    .catch(() => { httpUp = false; });
  probeOnce();
  const probe = setInterval(probeOnce, 5000);

  // plan-usage poll (≤ every 60 s; read-only quota APIs, cached on disk)
  const planPoll = setInterval(() => { planCache.ensureFresh().catch(() => {}); }, 30 * 1000);

  out.on('resize', renderNow);

  // ---------------------------------------------------------------- keys
  const toast = (text, style) => { view.toast = { text, style, until: Date.now() + 5000 }; pending = true; };

  const confirmCancel = async (row) => {
    const kind = row.kind === 'session' ? 'session' : 'offpeak';
    try {
      const r = await httpRequest({
        port: cfg.port, method: 'POST', urlPath: '/v1/ui/cancel', apiKey: cfg.apiKey,
        body: { kind, id: row.id },
      });
      if (r.status === 200 && r.json && (r.json.status === 'cancelled' || r.json.offPeakTaskId)) toast('cancelled ✓', 'ok');
      else toast(`cancel failed: ${(r.json && r.json.error && r.json.error.message) || `HTTP ${r.status}`}`, 'err');
    } catch (e) {
      toast(`cancel failed: bridge HTTP API unreachable (${e.message})`, 'err');
    }
    pending = true;
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  let escBuf = [];
  const feed = (ch, byte) => {
    if (view.confirm) { // y/N dialogs swallow everything else
      if (ch === 'y' || ch === 'Y') {
        const row = state.active.find((r) => r.id === view.confirm.id);
        view.confirm = null;
        if (row) confirmCancel(row);
      } else if (ch === 'n' || ch === 'N' || ch === '\r' || ch === '\n' || byte === 0x1b) view.confirm = null;
      pending = true;
      return;
    }
    if (ch === 'q' || byte === 0x03) return quit();
    if (byte === 0x1b) return key('esc');
    if (ch === '?') { view.mode = view.mode === 'help' ? 'dashboard' : 'help'; pending = true; return; }
    if (ch === '\r' || ch === '\n') return key('enter');
    if (ch === 'o') return key('open');
    if (ch === 'c') return key('cancel');
    if (ch === 'f') return key('filter');
    if (ch === 'h') return key('hist');
    if (ch === 'r') return key('refresh');
    if (ch === 'j') return key('down');
    if (ch === 'k') return key('up');
  };
  process.stdin.on('data', (buf) => {
    for (const b of buf) {
      if (escBuf.length) { // inside an escape sequence: collect until final byte
        escBuf.push(b);
        const s = Buffer.from(escBuf).toString('latin1');
        if (/^\x1b\[[0-9;]*[A-Za-z~]/.test(s) || /^\x1bO[A-Za-z]/.test(s)) {
          const k = {
            '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': null, '\x1b[D': null,
            '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end',
            '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1bOH': 'home', '\x1bOF': 'end',
          }[s] ?? null;
          escBuf = [];
          if (k) key(k);
          continue;
        }
        if (escBuf.length > 16) escBuf = []; // garbage — drop
        continue;
      }
      if (b === 0x1b) { escBuf = [b]; continue; } // CSI/O sequence or lone Esc?
      feed(String.fromCharCode(b), b);
    }
    // a lone ESC with no follow-up byte in this chunk = Esc key
    if (escBuf.length === 1) { escBuf = []; key('esc'); }
  });

  function key(k) {
    if (k === 'esc') {
      if (view.mode !== 'dashboard') { view.mode = 'dashboard'; pending = true; }
      return;
    }
    if (view.mode === 'help') { view.mode = 'dashboard'; pending = true; return; }
    if (view.mode === 'detail') {
      if (k === 'up') view.detailScroll -= 1;
      else if (k === 'down') view.detailScroll += 1;
      else if (k === 'pgup') view.detailScroll -= 10;
      else if (k === 'pgdn') view.detailScroll += 10;
      else if (k === 'home') view.detailScroll = 0;
      else if (k === 'end') view.detailScroll = 1e9;
      else if (k === 'enter' || k === 'open') {
        const row = state.active.find((r) => r.id === view.detailRowId);
        if (row && fs.existsSync(row.logPath)) openInDefaultApp(row.logPath);
      }
      pending = true;
      return;
    }
    const rows = filterRows(state.active, view.filter);
    if (k === 'up') view.selected = Math.max(0, view.selected - 1);
    else if (k === 'down') view.selected = Math.min(Math.max(0, rows.length - 1), view.selected + 1);
    else if (k === 'home') view.selected = 0;
    else if (k === 'end') view.selected = Math.max(0, rows.length - 1);
    else if (k === 'enter') {
      const row = rows[view.selected];
      if (row) { view.mode = 'detail'; view.detailRowId = row.id; view.detailScroll = 0; }
    } else if (k === 'open') {
      const row = rows[view.selected];
      if (row && fs.existsSync(row.logPath)) { openInDefaultApp(row.logPath); toast(`opening ${path.basename(row.logPath)}`); }
      else toast('no log file for this row', 'warn');
    } else if (k === 'cancel') {
      const row = rows[view.selected];
      if (row && row.cancelable) view.confirm = { id: row.id, name: row.name };
      else if (row) toast(`cannot cancel a ${row.status} ${row.kind} from here`, 'warn');
    } else if (k === 'filter') {
      view.filter = view.filter === 'all' ? 'running' : view.filter === 'running' ? 'failed' : 'all';
      view.selected = 0;
    } else if (k === 'hist') {
      view.historyMode = view.historyMode === 'hours' ? 'days' : 'hours';
    } else if (k === 'refresh') {
      planCache.ensureFresh().catch(() => {});
      probeOnce();
      toast('refreshed');
    }
    pending = true;
  }

  renderNow();
}

module.exports = { renderFrame, stripAnsi, filterRows, buildDetailBody, loadConfig, detectColorDepth, vw, truncW };

if (require.main === module) {
  main().catch((e) => { console.error('[bridge-ui] fatal:', e); process.exit(1); });
}
