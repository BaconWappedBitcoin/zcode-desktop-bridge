#!/usr/bin/env node
'use strict';
/**
 * zcode-watch: follow one ZCode turn live and exit when it ends, so a client waits for it without being
 * blocked. In Claude Code run it as a background task: Bash with run_in_background (one notification when
 * it exits; the task's output shows the turn live), or the Monitor tool with --events (one notification per
 * tool step). The session keeps working meanwhile; zcode_session_wait would hold it for the whole turn.
 *
 *   node bin/zcode-watch.cjs <sessionId> [--events] [--turn <turnId>] [--status-dir <dir>] [--max-minutes <n>]
 *
 * It reads what the bridge writes for every session (config statusDir, default out/sessions/):
 * <id>.json (status), <id>.stream.log (the live stream: text, ↳ tool steps, a header and footer per turn)
 * and <id>.final.md (the full final answer). It prints the turn's stream as it grows, then the final answer.
 * Turns that start from the session's queue right after it are followed too: it exits when the session has
 * nothing left to run.
 * A session no bridge runs (the ZCode app's) has no such files: it is followed from ZCode's own store
 * (lib/zcode-store.cjs) the same way, with the messages left in its mailbox shown waiting and taken.
 * --events prints only the turn's tool steps and its end, for a watcher that notifies per line.
 * Exit code: 0 done, 1 error, 2 cancelled, 3 the bridge went away mid-turn (store: no progress for 15
 * min), 4 not found / timed out.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const sessionId = args.find((a, i) => !a.startsWith('--') && !['--turn', '--status-dir', '--max-minutes'].includes(args[i - 1]));
const eventsOnly = flag('--events');
const maxMs = (Number(option('--max-minutes')) || 24 * 60) * 60000;

const out = (text) => { if (text) fs.writeSync(1, text); }; // synchronous: a background task's output file sees it at once
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

function statusDir() {
  if (option('--status-dir')) return path.resolve(option('--status-dir'));
  const cfg = readJson(path.join(REPO, 'config.json')) || {};
  return cfg.statusDir ? path.resolve(REPO, cfg.statusDir) : path.join(REPO, 'out', 'sessions');
}

// The bytes of buf that end on a whole UTF-8 character: an incomplete sequence at the end waits for the next read.
function wholeLength(buf) {
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i] & 0xc0) === 0x80) { i--; continuation++; }
  if (i < 0) return 0;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i >= need ? buf.length : i;
}

function readFrom(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: '', offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const whole = wholeLength(buf);
    return { text: buf.subarray(0, whole).toString('utf8'), offset: offset + whole };
  } catch {
    return { text: '', offset };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// --events: keep the lines a notification is worth (tool steps, steer/queue/mailbox events, a turn's start and end)
let pending = '';
let atLineStart = true;
function emit(text) {
  if (!text) return;
  atLineStart = text.endsWith('\n');
  if (!eventsOnly) return out(text);
  pending += text;
  const lines = pending.split('\n');
  pending = lines.pop();
  out(lines.filter((l) => /^\s+[↳✗⇢»] |^── turn /.test(l)).map((l) => `${l}\n`).join(''));
}
const nl = () => (atLineStart ? '' : '\n');
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
const oneLine = (s, max) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Messages waiting in the session's queue that run as turns of their own (status document's queue). */
const queuedTurns = (status) => (status && status.queue && status.queue.autoDrain !== false && Array.isArray(status.queue.items)
  ? status.queue.items.filter((it) => it.delivery === 'queue').length : 0);

/**
 * Follow a session no bridge runs (the ZCode app's) from ZCode's store: the current turn's prompt, its text as
 * it grows and one line per tool step, mailbox messages waiting and taken; the turns its own queue starts
 * right after; then the final answer.
 */
async function watchStore(store) {
  let mailbox = null;
  try { mailbox = require('../lib/zcode-mailbox.cjs'); } catch { mailbox = null; }
  let entry = store.getSession(sessionId);
  out(`zcode-watch: session ${sessionId} (${entry.source}${entry.title ? `, "${oneLine(entry.title, 60)}"` : ''}, ${entry.model || '?'}) is ${entry.state}; following it from ZCode's store, in ${entry.workspace || '?'}\n`);
  const t0 = Date.now();
  let promptId = null;
  const seen = new Map(); // part id -> {len} | {status}
  const mail = new Map(); // messageId -> unread | read
  for (;;) {
    const { prompt, parts } = store.turnParts(sessionId);
    if (prompt && prompt.id !== promptId) {
      promptId = prompt.id;
      seen.clear();
      emit(`${nl()}── turn started ${clock(prompt.timeCreated)} · ${entry.model || '?'} ──\n» ${oneLine(prompt.text, 300)}\n`);
    }
    for (const p of parts) {
      const prev = seen.get(p.id);
      if (p.type === 'tool') {
        const st = (p.state && p.state.status) || 'pending';
        if (!prev || (st === 'error' && prev.status !== 'error')) emit(`${nl()}${store.toolLine(p)}\n`);
        seen.set(p.id, { status: st });
      } else if (p.type === 'text') {
        const text = p.text || '';
        const from = prev ? prev.len : 0;
        if (text.length > from) emit((from === 0 ? nl() : '') + text.slice(from));
        seen.set(p.id, { len: text.length });
      }
    }
    if (mailbox) {
      for (const m of mailbox.pending(sessionId)) {
        if (!mail.has(m.messageId)) { mail.set(m.messageId, 'unread'); emit(`${nl()}  ⇢ mailbox message waiting: ${oneLine(m.content, 200)}\n`); }
      }
      for (const [id, st] of mail) {
        if (st === 'unread' && mailbox.stateOf(sessionId, id) === 'read') { mail.set(id, 'read'); emit(`${nl()}  » mailbox message taken by the session (${id})\n`); }
      }
    }
    entry = store.getSession(sessionId) || entry;
    if (entry.state !== 'running') {
      // the app's own queue starts its next turn right after this one
      let next = false;
      if (entry.state === 'done' && store.pendingInputs(sessionId).some((q) => q.delivery === 'queue')) {
        for (let waited = 0; waited < 5000 && !next; waited += 500) {
          await sleep(500);
          const e = store.getSession(sessionId);
          next = Boolean(e && e.state === 'running');
        }
      }
      if (next) continue;
      if (pending) emit('\n');
      const took = entry.turn && entry.turn.completed_at && entry.turn.started_at ? ` · ${Math.round((entry.turn.completed_at - entry.turn.started_at) / 1000)} s` : '';
      emit(`${nl()}── turn ${entry.state}${took} ──\n`);
      if (entry.state === 'done') {
        out(eventsOnly ? 'zcode-watch: done.\n' : `\n==== final answer ====\n${store.finalText(sessionId)}\n`);
        process.exit(0);
      }
      if (entry.state === 'stalled') {
        out(`zcode-watch: no progress for ${Math.round(store.STALL_MS / 60000)} min (the app may have quit or hung mid-turn)\n`);
        process.exit(3);
      }
      out(`zcode-watch: turn ${entry.state}\n`);
      process.exit(entry.state === 'cancelled' ? 2 : entry.state === 'error' ? 1 : 0);
    }
    if (Date.now() - t0 > maxMs) {
      out(`\nzcode-watch: stopped watching after ${Math.round(maxMs / 60000)} min; the turn is still running\n`);
      process.exit(4);
    }
    await sleep(1000);
  }
}

(async () => {
  if (!sessionId) {
    process.stderr.write('usage: node bin/zcode-watch.cjs <sessionId> [--events] [--turn <turnId>] [--status-dir <dir>] [--max-minutes <n>]\n');
    process.exit(4);
  }
  const dir = statusDir();
  const statusFile = path.join(dir, `${sessionId}.json`);
  const streamFile = path.join(dir, `${sessionId}.stream.log`);
  const finalFile = path.join(dir, `${sessionId}.final.md`);
  const t0 = Date.now();

  let status = readJson(statusFile);
  let store = null;
  for (let waited = 0; !status && waited < 30000; waited += 250) {
    if (waited === 0 || waited % 2000 === 0) {
      try { store = require('../lib/zcode-store.cjs'); } catch { store = null; }
      if (store && store.available() && store.getSession(sessionId)) return watchStore(store);
    }
    await sleep(250);
    status = readJson(statusFile);
  }
  if (!status) {
    out(`zcode-watch: no status for session ${sessionId} in ${dir}, and ZCode's store does not know it\n`);
    process.exit(4);
  }
  let turnId = option('--turn') || status.turnId;
  out(`zcode-watch: session ${sessionId}, turn ${turnId || '?'} (${status.status}) in ${status.workspace || '?'}\n`);

  // start at this turn's header in the stream (written when the turn started)
  let offset = 0;
  const header = `── turn ${turnId} started`;
  for (let tries = 0; ; tries++) {
    let whole = '';
    try { whole = fs.readFileSync(streamFile, 'utf8'); } catch { /* not written yet */ }
    const at = turnId ? whole.lastIndexOf(header) : -1;
    if (at >= 0) {
      offset = Buffer.byteLength(whole.slice(0, at), 'utf8');
      break;
    }
    if (tries > 40) break; // a turn started before the stream existed: follow from its current end
    await sleep(250);
  }
  if (offset === 0) {
    try { offset = fs.statSync(streamFile).size; } catch { offset = 0; }
  }

  for (;;) {
    const chunk = readFrom(streamFile, offset);
    offset = chunk.offset;
    emit(chunk.text);
    status = readJson(statusFile) || status;
    // a turn from the queue took over: follow it on (the stream goes on in the same file)
    if (turnId && status.turnId && status.turnId !== turnId && status.status === 'running') {
      turnId = status.turnId;
      continue;
    }
    const sameTurn = !turnId || status.turnId === turnId;
    let ended = sameTurn ? status.status !== 'running' : true;
    // the turn ended with messages queued behind it: the next one starts in a moment
    if (ended && sameTurn && queuedTurns(status) > 0) {
      for (let waited = 0; waited < 4000; waited += 250) {
        await sleep(250);
        const next = readJson(statusFile) || status;
        if (next.status === 'running') { status = next; turnId = next.turnId; ended = false; break; }
      }
      if (!ended) continue;
    }
    if (ended) {
      await sleep(300);
      const rest = readFrom(streamFile, offset);
      emit(rest.text);
      if (pending) emit('\n');
      const kind = sameTurn ? status.status : 'superseded';
      let final = '';
      try { final = fs.readFileSync(finalFile, 'utf8'); } catch { /* none */ }
      if (kind === 'done') {
        out(eventsOnly ? `zcode-watch: done. Full answer: ${finalFile}\n` : `\n==== final answer (${finalFile}) ====\n${final}\n`);
        process.exit(0);
      }
      out(`\nzcode-watch: turn ${kind}${status.error ? `: ${status.error}` : ''}\n`);
      process.exit(kind === 'cancelled' ? 2 : 1);
    }
    if (status.pid && !alive(status.pid)) {
      out(`\nzcode-watch: the bridge process (pid ${status.pid}) is gone while the turn was running; its end was not recorded\n`);
      process.exit(3);
    }
    if (Date.now() - t0 > maxMs) {
      out(`\nzcode-watch: stopped watching after ${Math.round(maxMs / 60000)} min; the turn is still running\n`);
      process.exit(4);
    }
    await sleep(500);
  }
})();
