'use strict';
/**
 * session-status.cjs — on-disk session status for external watchers.
 *
 * Every bridge process writes one <sessionId>.json per session into the
 * status dir (config `statusDir`, default <repo>/out/sessions/) and appends
 * one NDJSON summary line per lifecycle event to <sessionId>.log. The .json
 * documents are replaced atomically (temp file + rename) so a watcher never
 * reads a half-written file, and streaming updates are throttled to at most
 * one write per 5 s; state changes always write immediately.
 *
 * Document schema (see README "On-disk session status"):
 *   { id, workspace, model, status, turnId, turns, createdAt, startedAt,
 *     finishedAt, lastActivity, lastOutputTail, finalTextTail, error,
 *     usage {input, output, cacheRead}, pid [, closed, closedAt] }
 */
const fs = require('fs');
const path = require('path');

const TAIL_MAX = 2000;
const MIN_WRITE_INTERVAL_MS = 5000;

const _sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  try { Atomics.wait(_sleepCell, 0, 0, ms); } catch { /* best effort */ }
}

class SessionStatusStore {
  constructor(dir, logger = () => {}) {
    this.dir = path.resolve(dir);
    this.log = logger;
    this.writeCount = 0;
    this._lastWrite = new Map(); // sessionId -> epoch ms of last .json write
    this._dirReady = false;
  }

  fileFor(sessionId) { return path.join(this.dir, `${sessionId}.json`); }
  logFileFor(sessionId) { return path.join(this.dir, `${sessionId}.log`); }

  _ensureDir() {
    if (this._dirReady) return;
    fs.mkdirSync(this.dir, { recursive: true });
    this._dirReady = true;
  }

  /**
   * Atomic replace: write a temp file, rename it over the target. On Windows
   * a watcher or antivirus can hold the destination briefly, so retry the
   * rename a few times with a short synchronous backoff before giving up.
   */
  _writeAtomic(file, data) {
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, data);
    let lastErr = null;
    for (let i = 0; i < 5; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) { lastErr = e; sleepSync(25 * (i + 1)); }
    }
    try { fs.unlinkSync(tmp); } catch { /* nothing more to clean */ }
    throw lastErr;
  }

  _appendEvent(sessionId, event) {
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), sessionId }, event)) + '\n';
    fs.appendFileSync(this.logFileFor(sessionId), line);
  }

  /**
   * Persist a status document. `force` (state changes) bypasses the 5 s
   * streaming throttle. `event` (e.g. {event:'turn-started', turnId}) is
   * appended to the .log as one NDJSON line; 'progress' events are summary
   * heartbeats and are only written when the throttle allows a write, so
   * logs stay small while streaming. Returns true when the .json was written.
   */
  record(sessionId, doc, { force = false, event = null } = {}) {
    try {
      this._ensureDir();
      const now = Date.now();
      const last = this._lastWrite.get(sessionId) || 0;
      const throttled = !force && now - last < MIN_WRITE_INTERVAL_MS;
      const isProgress = !!event && event.event === 'progress';
      if (throttled && (!event || isProgress)) return false;
      if (event) this._appendEvent(sessionId, event);
      this._writeAtomic(this.fileFor(sessionId), `${JSON.stringify(doc, null, 2)}\n`);
      this._lastWrite.set(sessionId, Date.now());
      this.writeCount += 1;
      return true;
    } catch (e) {
      this.log('status write failed', { sessionId, error: e.message });
      return false;
    }
  }

  /** Every status document currently on disk (unparseable files are skipped). */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'))); } catch { /* stale temp / partial */ }
    }
    return out;
  }
}

module.exports = { SessionStatusStore, TAIL_MAX, MIN_WRITE_INTERVAL_MS };
