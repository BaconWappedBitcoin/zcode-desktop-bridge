#!/usr/bin/env node
'use strict';
// Offline tests for lib/zcode-store.cjs on a temp copy of the tables of ZCode's session store it reads
// (columns as in ZCode 3.17.2): a turn's state from its prompt and turn_usage row, a steer stored inside a
// running turn (it is stored like a prompt) not taken for a new turn, a turn waiting for an answer in the app,
// stalled vs waiting, the turn's text, and the app's pending queue.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-store-'));
process.env.ZCODE_STORE_DB = path.join(dir, 'db.sqlite');
process.env.ZCODE_TASK_INDEX = path.join(dir, 'no-index.sqlite');
const store = require('../lib/zcode-store.cjs');

const db = new DatabaseSync(process.env.ZCODE_STORE_DB);
db.exec(`
CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT, task_type TEXT, time_deleted INTEGER);
CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, user_message_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER, tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER);
CREATE TABLE model_usage (session_id TEXT, model_id TEXT, started_at INTEGER);
CREATE TABLE session_input (id TEXT, session_id TEXT, kind TEXT, delivery TEXT, payload TEXT, admitted_sequence INTEGER, status TEXT, time_created INTEGER);
`);
const SID = 'sess_t1';
const T = Date.now() - 60000;
let seq = 0;
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL, NULL, NULL)').run(SID, 'Test session', 'C:\\ws', T);
db.prepare('INSERT INTO model_usage VALUES (?, ?, ?)').run(SID, 'model-a', T);
const prompt = { origin: 'real_user', kind: 'user_prompt' };
function message(role, at, text, { semantics = role === 'user' ? prompt : { kind: 'assistant_response' } } = {}) {
  const id = `msg_${++seq}`;
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)').run(id, SID, at, at, JSON.stringify({ role, semantics }), seq);
  if (text != null) db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, 0)').run(`part_${seq}`, id, SID, at, at, JSON.stringify({ type: 'text', text }));
  return id;
}
function tool(messageId, at, name, status, input) {
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, 1)').run(`part_t${++seq}`, messageId, SID, at, at, JSON.stringify({ type: 'tool', tool: name, state: { status, input } }));
}

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok   ${name}`); };

// turn 1: prompt, a tool step, a steer sent into it (stored like a prompt), the answer; turn_usage written at its end
const p1 = message('user', T + 1000, 'first task');
const a1 = message('assistant', T + 2000, 'working');
tool(a1, T + 2500, 'Bash', 'completed', { command: 'ping -n 40 127.0.0.1' });
message('user', T + 3000, '<session-message source="mailbox">also mention HERON</session-message>');
message('assistant', T + 4000, 'PING-DONE');
db.prepare("INSERT INTO turn_usage VALUES (?, 'turn_1', ?, 'completed', ?, ?, 1, 10, 5)").run(SID, p1, T + 1000, T + 5000);

t('a steer inside a finished turn does not read as a new turn still running', () => {
  const s = store.getSession(SID);
  assert.strictEqual(s.state, 'done');
  assert.strictEqual(s.prompt.text, 'first task');
  assert.strictEqual(store.finalText(SID), 'PING-DONE');
});

t('the turn text starts at its prompt and keeps the steer inside it', () => {
  const text = store.turnText(SID);
  assert.ok(text.startsWith('» first task'), text);
  assert.ok(/↳ Bash: ping -n 40/.test(text) && /PING-DONE/.test(text), text);
});

// turn 2: a new prompt after turn 1 ended, the agent asks a question in the app
const now = Date.now();
message('user', now - 3000, 'next task');
const a2 = message('assistant', now - 2000, 'need a decision');
tool(a2, now - 1000, 'AskUserQuestion', 'running', { questions: [{ header: 'Next step', question: 'Which path do you want to pursue now?', options: [] }] });

t('a prompt after the last turn ended is a turn still running', () => {
  const s = store.getSession(SID);
  assert.strictEqual(s.prompt.text, 'next task');
  assert.strictEqual(s.state, 'running');
});

t('a running turn on an unanswered question says it waits for the app', () => {
  const s = store.getSession(SID);
  assert.deepStrictEqual(s.waiting, { tool: 'AskUserQuestion', question: 'Which path do you want to pursue now?' });
  const listed = store.listSessions({ sinceMs: 0 }).find((x) => x.sessionId === SID);
  assert.ok(listed && listed.waiting && listed.state === 'running');
});

t('a turn waiting that long is still waiting, not stalled', () => {
  const later = Date.now() + 60 * 60 * 1000;
  const s = store.getSession(SID, later);
  assert.strictEqual(s.state, 'running');
  assert.ok(s.waiting);
});

t('once answered, it waits no more; with no progress for 15 min it is stalled', () => {
  db.prepare("UPDATE part SET data = json_set(data, '$.state.status', 'completed') WHERE data LIKE '%AskUserQuestion%'").run();
  assert.strictEqual(store.waitingOn(SID), null);
  assert.strictEqual(store.getSession(SID).state, 'running');
  assert.strictEqual(store.getSession(SID, Date.now() + 20 * 60 * 1000).state, 'stalled');
});

t('the app\'s own queue: inputs admitted and not run yet', () => {
  db.prepare("INSERT INTO session_input VALUES ('queue_1', ?, 'sendText', 'queue', ?, 7, 'admitted', ?)").run(SID, JSON.stringify({ text: 'queued follow-up' }), now);
  db.prepare("INSERT INTO session_input VALUES ('queue_0', ?, 'sendText', 'guide', ?, 6, 'promoted', ?)").run(SID, JSON.stringify({ text: 'done already' }), now);
  assert.deepStrictEqual(store.pendingInputs(SID).map((q) => [q.delivery, q.text]), [['queue', 'queued follow-up']]);
});

store.close();
db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* open handle */ }
console.log(`\n${n} passed`);
