'use strict';
/**
 * ui-state.cjs — the dashboard's pure state aggregator.
 *
 * The task-tracking UI (bin/bridge-ui.cjs TUI and the GET /ui web page) is
 * INDEPENDENT OF ANY HARNESS: it reads only the bridge's on-disk state plus
 * the read-only HTTP API, so it works when no MCP client is attached and even
 * when the bridge process is down — the last-known state is shown, marked
 * stale. This module turns those files into one state object:
 *
 *   aggregate({ sessionsDir, offpeakDir, offersDir, uiDir, watchDirs, now }) -> state
 *
 * Data sources (all written by the bridge, schemas in the README):
 *   out/sessions/<id>.json + .log   bridge sessions (SessionStatusStore)
 *   out/offpeak/<id>.json + .log    idle-time tasks
 *   out/offers/state.json, events.log, poller.pid   offer detector
 *   out/ui/plan.json                plan-usage cache (see PlanUsageCache below)
 *   out/bridge.pid / out/bridge.port  HTTP facade liveness (server.cjs writes)
 *   <watchDir>/<name>.pid|.done|.log  generic "lane" trackers (config uiWatch)
 *
 * This module is PURE and synchronous: dirs + now -> object, no network, no
 * writes. The one async thing the dashboards need — polling plan usage via
 * lib/coding-plan.cjs READ-ONLY functions at most every 60 s — lives in
 * PlanUsageCache, which persists to out/ui/plan.json so any process (TUI, web
 * facade, or neither) can serve the last reading.
 *
 * The dashboard never claims offers and never spends resets: nothing here or
 * in the UI front-ends calls a plan write endpoint (a static test enforces
 * that); offers/resets panels are display-only with a hint to act in the app.
 */
const fs = require('fs');
const path = require('path');

const VERSION = '0.5.0';

const HISTORY_DEFAULT_MODE = 'hours';
const HISTORY_BUCKETS = { hours: 24, days: 14 };
const RESET_EXPIRY_WARN_MS = 2 * 60 * 60 * 1000; // brief: highlight < 2 h
const ACTIVE_CAP = 60;
const EVENTS_PER_FILE = 80;
const EVENTS_CAP = 300;
const HISTORY_LOG_LINES = 600;

/** outcome codes -> display glyphs (nightshift-style matrix cells) */
const GLYPHS = { ok: '✓', err: '✗', run: '◐', cancel: '⊘', idle: '·' };
const OUTCOME_PRIORITY = { err: 3, cancel: 2, ok: 1, run: 0 };

// ------------------------------------------------------------------ helpers
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function listDir(dir, suffix) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith(suffix)); } catch { return []; }
}

/**
 * Last non-empty lines of a text file, tolerating UTF-16LE (PowerShell
 * redirection writes UTF-16) and missing files. Returns [].
 */
function readTailLines(file, maxBytes = 4096, maxLines = 40) {
  let buf;
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const start = Math.max(0, st.size - maxBytes);
      buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  let text;
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    text = buf.toString('utf16le'); // LE BOM (PowerShell redirection default)
  } else if (buf[0] === 0xFE && buf[1] === 0xFF) {
    text = buf.swap16().toString('utf16le'); // BE BOM -> byte-swap into LE
  } else {
    const zeros = buf.subarray(0, Math.min(buf.length, 512)).filter((b) => b === 0).length;
    text = zeros > buf.subarray(0, Math.min(buf.length, 512)).length * 0.2
      ? buf.toString('utf16le') // heuristically BOM-less UTF-16LE (the Windows case)
      : buf.toString('utf8');
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  // A cut mid-line at the head of the window is fine to drop; keep the tail.
  return lines.slice(-maxLines);
}

/** "exit=0 at 2026-10-03T11:57:15" (lane .done files) -> {exit, at} | null */
function parseDoneLine(file) {
  const lines = readTailLines(file, 512, 4);
  for (const line of lines) {
    const m = /^(?:.*[\r\n])?\s*exit=(-?\d+)\s+at\s+(\S+)/.exec(line) || /^\s*exit=(-?\d+)\s+at\s+(\S+)/.exec(line);
    if (m) {
      const at = Date.parse(m[2]);
      return { exit: Number(m[1]), at: Number.isFinite(at) ? at : mtimeMs(file) };
    }
  }
  // tolerate a bare "exit=N"
  for (const line of lines) {
    const m = /^\s*exit=(-?\d+)\s*$/.exec(line);
    if (m) return { exit: Number(m[1]), at: mtimeMs(file) };
  }
  return null;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function firstLine(s, max = 120) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// -------------------------------------------------------------- liveness
/** Bridge up/down from pid/port files: out/bridge.pid, offers poller.pid and
 *  the pid recorded inside session/offpeak docs. httpUp (caller's /healthz
 *  probe result, true|false|undefined) is folded in when present. */
function bridgeStatus({ rootDir, sessionsDir, offpeakDir, offersDir, docs, httpUp, now }) {
  const pids = new Map(); // pid -> source label
  const addPid = (pid, source) => {
    if (Number.isInteger(pid) && pid > 0) pids.set(pid, source);
  };
  const bridgePidFile = path.join(rootDir, 'out', 'bridge.pid');
  const bp = Number(String(readJsonSafe(bridgePidFile) ?? readTextTrim(bridgePidFile) ?? '').trim());
  addPid(bp, 'bridge.pid');
  const pollerPid = Number(readTextTrim(path.join(offersDir, 'poller.pid')).trim());
  addPid(pollerPid, 'offers poller');
  for (const d of docs.sessions) addPid(d.pid, 'session host');
  for (const d of docs.offpeak) addPid(d.pid, 'offpeak host');
  const live = [...pids.entries()].filter(([pid]) => isPidAlive(pid));
  const up = live.length > 0 || httpUp === true;
  const port = Number(readTextTrim(path.join(rootDir, 'out', 'bridge.port')).trim()) || null;
  return {
    up,
    stale: !up,
    httpUp: httpUp === undefined ? null : httpUp,
    pids: live.map(([pid, source]) => ({ pid, source })).slice(0, 4),
    port,
    version: VERSION,
    checkedAt: now,
  };
}

function readTextTrim(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------- sources
function loadSessions(sessionsDir) {
  const docs = [];
  for (const name of listDir(sessionsDir, '.json')) {
    const doc = readJsonSafe(path.join(sessionsDir, name));
    if (doc && doc.id && String(doc.id).startsWith('sess')) docs.push(doc);
  }
  docs.sort((a, b) => (b.lastActivity || b.finishedAt || b.createdAt || 0) - (a.lastActivity || a.finishedAt || a.createdAt || 0));
  return docs;
}

function loadOffpeak(offpeakDir) {
  const docs = [];
  for (const name of listDir(offpeakDir, '.json')) {
    const doc = readJsonSafe(path.join(offpeakDir, name));
    if (doc && doc.id && String(doc.id).startsWith('offpeak-')) docs.push(doc);
  }
  docs.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  return docs;
}

/**
 * Generic "lane" trackers: a watch dir holds <name>.pid / <name>.done /
 * <name>.log triplets (e.g. the owner's game project build lanes). Running
 * when the pid is alive; done/failed from .done's exit= value; the log's
 * last line is the tail. Kept generic — no project-specific code.
 */
function loadLanes(watchDirs, now) {
  const lanes = [];
  for (const w of watchDirs) {
    const dir = path.resolve(w.dir);
    const prefix = w.name ? `${w.name}:` : '';
    for (const name of listDir(dir, '.pid')) {
      const base = name.slice(0, -4); // strip ".pid"
      const pidPath = path.join(dir, name);
      const donePath = path.join(dir, `${base}.done`);
      const logPath = path.join(dir, `${base}.log`);
      const pid = Number(readTextTrim(pidPath).trim());
      const done = fs.existsSync(donePath) ? parseDoneLine(donePath) : null;
      let status = 'lost';
      let startedAt = mtimeMs(pidPath);
      let finishedAt = null;
      if (done) {
        status = done.exit === 0 ? 'done' : 'failed';
        finishedAt = done.at;
      } else if (isPidAlive(pid)) {
        status = 'running';
      }
      const lastActivityAt = Math.max(
        mtimeMs(logPath) || 0, mtimeMs(donePath) || 0, finishedAt || 0, mtimeMs(pidPath) || 0,
      ) || null;
      lanes.push({
        kind: 'lane',
        id: `${prefix}${base}`,
        name: `${prefix}${base}`,
        laneDir: dir,
        status,
        pid: Number.isInteger(pid) ? pid : null,
        exitCode: done ? done.exit : null,
        startedAt,
        finishedAt,
        lastActivityAt,
        elapsedMs: Math.max(0, (finishedAt || now) - (startedAt || finishedAt || now)),
        tail: firstLine(readTailLines(logPath, 4096, 3).slice(-1)[0] || ''),
        model: null,
        cancelable: false,
        jsonPath: fs.existsSync(donePath) ? donePath : pidPath,
        logPath,
        detailPath: logPath,
      });
    }
  }
  lanes.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return lanes;
}

function sessionRow(doc, sessionsDir, now, bridgeUp) {
  const startedAt = doc.startedAt || doc.createdAt || null;
  const finishedAt = doc.finishedAt || null;
  const lastActivityAt = doc.lastActivity || finishedAt || startedAt;
  const running = doc.status === 'running';
  const tail = firstLine(doc.lastOutputTail || doc.finalTextTail || doc.error || '');
  return {
    kind: 'session',
    id: doc.id,
    name: doc.id,
    model: doc.model && doc.model.modelId ? doc.model.modelId : null,
    status: doc.status || 'idle',
    running,
    turns: doc.turns || 0,
    startedAt,
    finishedAt,
    lastActivityAt,
    elapsedMs: Math.max(0, (running ? now : finishedAt || lastActivityAt || now) - (startedAt || now)),
    tail,
    usage: doc.usage || null,
    error: doc.error || null,
    cancelable: running && bridgeUp,
    jsonPath: path.join(sessionsDir, `${doc.id}.json`),
    logPath: path.join(sessionsDir, `${doc.id}.log`),
    detailPath: path.join(sessionsDir, `${doc.id}.json`),
  };
}

function offpeakRow(doc, offpeakDir, now, bridgeUp) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(doc.status);
  const startedAt = doc.startedAt || doc.createdAt || null;
  const finishedAt = doc.finishedAt || null;
  return {
    kind: 'offpeak',
    id: doc.id,
    name: doc.title || doc.id,
    model: doc.modelSelection && doc.modelSelection.modelId ? doc.modelSelection.modelId : null,
    status: doc.status || 'queued',
    running: doc.status === 'running',
    queuePosition: doc.queuePosition ?? null,
    ticketState: doc.ticketState || null,
    startedAt,
    finishedAt,
    lastActivityAt: doc.updatedAt || finishedAt || startedAt,
    elapsedMs: Math.max(0, (terminal ? finishedAt || now : now) - (startedAt || now)),
    tail: firstLine(doc.lastError || tailEventName(offpeakDir, doc.id) || doc.title || ''),
    error: doc.lastError || null,
    cancelable: !terminal && bridgeUp,
    jsonPath: path.join(offpeakDir, `${doc.id}.json`),
    logPath: path.join(offpeakDir, `${doc.id}.log`),
    detailPath: path.join(offpeakDir, `${doc.id}.json`),
  };
}

function tailEventName(offpeakDir, id) {
  const lines = readTailLines(path.join(offpeakDir, `${id}.log`), 2048, 2);
  const last = lines[lines.length - 1];
  if (!last) return '';
  try { const j = JSON.parse(last); return j.event ? `${j.event}${j.state ? ` (${j.state})` : ''}` : ''; } catch { return firstLine(last, 40); }
}

// ------------------------------------------------------------------ events
/** Merged NDJSON feed from all bridge .log files, newest first. */
function loadEvents({ sessionsDir, offpeakDir, offersDir }) {
  const out = [];
  const sources = [
    { dir: sessionsDir, kind: 'session', name: (j, f) => j.sessionId || f },
    { dir: offpeakDir, kind: 'offpeak', name: (j, f) => j.sessionId || j.offPeakTaskId || f },
    { dir: offersDir, kind: 'offers', name: () => 'offers', file: 'events.log' },
  ];
  for (const src of sources) {
    const files = src.file ? [src.file] : listDir(src.dir, '.log');
    for (const f of files.slice(0, 60)) {
      for (const line of readTailLines(path.join(src.dir, f), 32 * 1024, EVENTS_PER_FILE)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue; // lane logs etc. are not NDJSON
        let j;
        try { j = JSON.parse(t); } catch { continue; }
        const ts = Date.parse(j.ts);
        if (!Number.isFinite(ts)) continue;
        const { ts: _ts, event, ...rest } = j;
        out.push({
          tsMs: ts,
          ts: j.ts,
          kind: src.kind,
          name: String(src.name(j, f.replace(/\.log$/, ''))).slice(0, 40),
          event: String(event || 'log'),
          detail: firstLine(JSON.stringify(rest), 140),
        });
      }
    }
  }
  out.sort((a, b) => b.tsMs - a.tsMs);
  return out.slice(0, EVENTS_CAP);
}

// ----------------------------------------------------------------- history
/**
 * History matrix: rows = tasks/lanes, columns = the last N hours (or days),
 * cells = outcome codes per bucket. Sessions/offpeak outcomes come from
 * their .log events (turn-completed -> ok, turn-failed -> err,
 * turn-cancelled -> cancel, currently running -> run); lanes from .done.
 */
function historyFor({ sessions, offpeak, lanes, mode, now }) {
  const n = HISTORY_BUCKETS[mode] || HISTORY_BUCKETS.hours;
  const bucketMs = mode === 'days' ? 24 * 3600 * 1000 : 3600 * 1000;
  const windowStart = now - n * bucketMs; // bucket i covers [windowStart + i*bucketMs, +bucketMs)
  const bucketOf = (ts) => {
    const i = Math.floor((ts - windowStart) / bucketMs);
    return i >= 0 && i < n ? i : null;
  };
  const labels = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(windowStart + i * bucketMs);
    labels.push(mode === 'days'
      ? `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
      : `${String(t.getHours()).padStart(2, '0')}:00`);
  }

  const rows = [];
  const addRow = (label, key, markEventLog, docLike) => {
    const cells = new Array(n).fill(null);
    const put = (ts, code) => {
      const i = bucketOf(ts);
      if (i === null) return;
      if ((OUTCOME_PRIORITY[code] || 0) > (OUTCOME_PRIORITY[cells[i]] ?? -1)) cells[i] = code;
    };
    if (markEventLog) {
      for (const line of readTailLines(markEventLog, 64 * 1024, HISTORY_LOG_LINES)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let j;
        try { j = JSON.parse(t); } catch { continue; }
        const ts = Date.parse(j.ts);
        if (!Number.isFinite(ts)) continue;
        if (j.event === 'turn-completed') put(ts, 'ok');
        else if (j.event === 'turn-failed') put(ts, 'err');
        else if (j.event === 'turn-cancelled') put(ts, 'cancel');
        else if (j.event === 'cancelled') put(ts, 'cancel');
      }
    }
    if (docLike && docLike.running) put(now - 1, 'run'); // now sits on the boundary after the last bucket
    rows.push({
      label,
      key,
      kind: docLike ? docLike.kind : 'lane',
      cells,
      lastActivityAt: docLike ? docLike.lastActivityAt : null,
    });
  };

  for (const r of sessions) addRow(`ses:${shortId(r.id)}`, r.id, r.logPath, r);
  for (const r of offpeak) addRow(`idle:${firstLine(r.name, 16)}`, r.id, r.logPath, r);
  for (const r of lanes) {
    // one synthetic row per lane: outcome at .done time, run marker if alive
    const cells = new Array(n).fill(null);
    const put = (ts, code) => {
      const i = bucketOf(ts);
      if (i === null) return;
      if ((OUTCOME_PRIORITY[code] || 0) > (OUTCOME_PRIORITY[cells[i]] ?? -1)) cells[i] = code;
    };
    if (r.status === 'running') put(now - 1, 'run');
    if (r.finishedAt) put(r.finishedAt, r.status === 'failed' ? 'err' : 'ok');
    rows.push({ label: `lane:${firstLine(r.name, 14)}`, key: r.id, kind: 'lane', cells, lastActivityAt: r.lastActivityAt });
  }

  rows.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return { mode, bucketMs, buckets: n, windowStart, labels, rows };
}

function shortId(id) {
  const s = String(id);
  const m = /^(?:sess_|offpeak-)(\d{6,8})/.exec(s);
  if (m) return m[1];
  return s.slice(0, 10);
}

// ------------------------------------------------------------------- plan
/** Parse the out/ui/plan.json cache into gauge data (null when absent). */
function planGauges(uiDir, now) {
  const cache = readJsonSafe(path.join(uiDir, 'plan.json'));
  if (!cache || (!cache.quota && !cache.resets)) return null;
  const limits = (cache.quota && Array.isArray(cache.quota.limits)) ? cache.quota.limits : [];
  const gauge = (window) => {
    const l = limits.find((x) => x.window === window);
    if (!l) return null;
    const limit = Number.isFinite(l.limit) ? l.limit : null;
    const used = Number.isFinite(l.used) ? l.used : null;
    const pct = Number.isFinite(l.usedPercentage) ? l.usedPercentage
      : limit && used !== null ? (used / limit) * 100 : null;
    return {
      limit, used,
      remaining: Number.isFinite(l.remaining) ? l.remaining : null,
      usedPercentage: pct === null ? null : Math.round(pct * 10) / 10,
      nextResetAt: l.nextResetTime || null,
    };
  };
  const avail = (cache.resets && cache.resets.available) || {};
  const resets = {};
  for (const [type, label] of [['five_hour', 'fiveHour'], ['week', 'week']]) {
    const list = Array.isArray(avail[type]) ? avail[type] : [];
    const expiries = list.map((r) => (r && r.expireAt ? Date.parse(r.expireAt) : NaN)).filter(Number.isFinite);
    resets[label] = {
      count: list.length,
      earliestExpireAt: expiries.length ? Math.min(...expiries) : null,
      expiringSoon: expiries.length ? Math.min(...expiries) - now < RESET_EXPIRY_WARN_MS : false,
    };
  }
  return {
    source: 'cache',
    fetchedAt: cache.fetchedAt ? Date.parse(cache.fetchedAt) : null,
    ageMs: cache.fetchedAt ? now - Date.parse(cache.fetchedAt) : null,
    fiveHour: gauge('five_hour'),
    week: gauge('week'),
    resets,
    error: cache.error || (cache.quota && cache.quota.error) || null,
  };
}

// -------------------------------------------------------------- aggregate
/**
 * Build the whole dashboard state. Pure: files + now -> object.
 * opts: { rootDir, sessionsDir, offpeakDir, offersDir, uiDir, watchDirs,
 *         historyMode, now, httpUp }
 *   watchDirs: [{name?, dir}] — config uiWatch entries.
 */
function aggregate(opts = {}) {
  const rootDir = path.resolve(opts.rootDir || path.join(__dirname, '..'));
  const sessionsDir = path.resolve(opts.sessionsDir || path.join(rootDir, 'out', 'sessions'));
  const offpeakDir = path.resolve(opts.offpeakDir || path.join(rootDir, 'out', 'offpeak'));
  const offersDir = path.resolve(opts.offersDir || path.join(rootDir, 'out', 'offers'));
  const uiDir = path.resolve(opts.uiDir || path.join(rootDir, 'out', 'ui'));
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const sessionDocs = loadSessions(sessionsDir);
  const offpeakDocs = loadOffpeak(offpeakDir);
  const watchDirs = (opts.watchDirs || [])
    .map((w) => (typeof w === 'string' ? { name: null, dir: w } : w))
    .filter((w) => w && w.dir);
  const bridge = bridgeStatus({ rootDir, sessionsDir, offpeakDir, offersDir, docs: { sessions: sessionDocs, offpeak: offpeakDocs }, httpUp: opts.httpUp, now });

  const sessions = sessionDocs.map((d) => sessionRow(d, sessionsDir, now, bridge.up));
  const offpeak = offpeakDocs.map((d) => offpeakRow(d, offpeakDir, now, bridge.up));
  const lanes = loadLanes(watchDirs, now);
  const active = [...sessions, ...offpeak, ...lanes]
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
    .slice(0, ACTIVE_CAP);

  const offersState = readJsonSafe(path.join(offersDir, 'state.json')) || {};
  const offers = {
    lastCheckAt: offersState.lastCheckAt || null,
    lastError: offersState.lastError || null,
    items: (Array.isArray(offersState.offers) ? offersState.offers : []).map((o) => {
      const endsMs = o.endsAt ? Date.parse(o.endsAt) : NaN;
      return {
        id: o.id,
        title: o.title || o.id,
        kind: o.kind || null,
        tokens: o.tokens || null,
        endsAt: o.endsAt || null,
        msLeft: Number.isFinite(endsMs) ? endsMs - now : null,
        claimable: !!o.claimable,
        count: o.count || null,
      };
    }),
  };

  return {
    now,
    generatedAt: new Date(now).toISOString(),
    version: VERSION,
    dirs: { rootDir, sessionsDir, offpeakDir, offersDir, uiDir },
    bridge,
    plan: planGauges(uiDir, now),
    active,
    history: historyFor({ sessions, offpeak, lanes, mode: opts.historyMode === 'days' ? 'days' : HISTORY_DEFAULT_MODE, now }),
    offers,
    events: loadEvents({ sessionsDir, offpeakDir, offersDir }),
  };
}

// -------------------------------------------------------- plan-usage cache
/**
 * Polls plan usage with lib/coding-plan.cjs READ-ONLY functions at most
 * every `minIntervalMs` (default 60 s) and mirrors the snapshot to
 * <dir>/plan.json (atomic) so aggregate() can read it even when this
 * process goes away. Network failures keep the previous cache.
 */
class PlanUsageCache {
  /** opts: { dir, minIntervalMs (>=60_000 in production), fetchSnapshot, logger } */
  constructor(opts = {}) {
    this.dir = path.resolve(opts.dir);
    this.minIntervalMs = Math.max(1000, Number.isFinite(opts.minIntervalMs) ? opts.minIntervalMs : 60 * 1000);
    this.fetchSnapshot = opts.fetchSnapshot || (() => require('./coding-plan.cjs').getPlanSnapshot());
    this.log = opts.logger || (() => {});
    this._inflight = null;
    this._lastFetch = 0;
    this._cached = null;
  }

  get file() { return path.join(this.dir, 'plan.json'); }

  read() {
    if (this._cached) return this._cached;
    const c = readJsonSafe(this.file);
    this._cached = c;
    return c;
  }

  _write(snapshot, fetchedAt, error) {
    const doc = { fetchedAt: new Date(fetchedAt).toISOString(), ...snapshot, ...(error ? { error } : {}) };
    this._cached = doc;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('plan cache write failed', { error: e.message }); }
    return doc;
  }

  /** Returns the freshest cache document, fetching when older than the cap. */
  ensureFresh() {
    if (this._inflight) return this._inflight;
    const cached = this.read();
    const age = cached && cached.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
    if (age < this.minIntervalMs) return Promise.resolve(cached);
    this._lastFetch = Date.now();
    this._inflight = (async () => {
      try {
        const snapshot = await this.fetchSnapshot();
        return this._write(snapshot, Date.now(), null);
      } catch (e) {
        this.log('plan usage fetch failed', { error: e.message });
        // keep the previous cache on disk; surface the error + timestamp
        const prev = this.read() || {};
        return this._write({ quota: prev.quota || null, resets: prev.resets || null }, Date.now(), String(e.message || e));
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }
}

module.exports = {
  VERSION,
  aggregate,
  PlanUsageCache,
  planGauges,
  bridgeStatus,
  loadLanes,
  loadEvents,
  historyFor,
  parseDoneLine,
  readTailLines,
  isPidAlive,
  fmtDuration,
  fmtTokens,
  firstLine,
  shortId,
  GLYPHS,
  HISTORY_BUCKETS,
  RESET_EXPIRY_WARN_MS,
};
