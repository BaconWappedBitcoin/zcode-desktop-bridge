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
 * --events prints only the turn's tool steps and its end, for a watcher that notifies per line.
 * Exit code: 0 done, 1 error, 2 cancelled, 3 the bridge went away mid-turn, 4 not found / timed out.
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

// --events: keep the lines a notification is worth (tool steps, the turn's start and end)
let pending = '';
function emit(text) {
  if (!eventsOnly) return out(text);
  pending += text;
  const lines = pending.split('\n');
  pending = lines.pop();
  out(lines.filter((l) => /^\s+[↳✗] |^── turn /.test(l)).map((l) => `${l}\n`).join(''));
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
  for (let waited = 0; !status && waited < 30000; waited += 250) {
    await sleep(250);
    status = readJson(statusFile);
  }
  if (!status) {
    out(`zcode-watch: no status for session ${sessionId} in ${dir}\n`);
    process.exit(4);
  }
  const turnId = option('--turn') || status.turnId;
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
    const sameTurn = !turnId || status.turnId === turnId;
    const ended = sameTurn ? status.status !== 'running' : true;
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
