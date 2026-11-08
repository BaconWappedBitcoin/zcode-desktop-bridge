#!/usr/bin/env node
'use strict';
// Offline tests for lib/zcode-wake.cjs against temp copies of the ZCode app's task index and session store
// (the tables it touches, columns as in ZCode 3.17.2): the one-off automation a wake writes, its states as
// the app's scheduler would move it, cleanup (rows gone, the session's scheduled-task mark cleared), the
// app's 20-automation limit, and the model selection taken from the session's own runtime entries.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-wake-'));
process.env.ZCODE_TASK_INDEX = path.join(dir, 'tasks-index.sqlite');
process.env.ZCODE_STORE_DB = path.join(dir, 'db.sqlite');
const wake = require('../lib/zcode-wake.cjs');

const idx = new DatabaseSync(process.env.ZCODE_TASK_INDEX);
idx.exec(`
CREATE TABLE tasks (workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT, task_id TEXT NOT NULL, title TEXT, model TEXT, mode TEXT, deleted INTEGER DEFAULT 0, cron_automation_id TEXT, host_id TEXT, project_id TEXT, execution_directories TEXT);
CREATE TABLE automations (automation_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', cron_expr TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, provider TEXT, mode TEXT, thought_level TEXT,
  workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT, target_task_id TEXT, bot_delivery_target TEXT, location_kind TEXT NOT NULL DEFAULT 'local',
  recurring INTEGER NOT NULL DEFAULT 1, max_runs INTEGER, end_at INTEGER, schedule_rule TEXT, schedule_edited_by_user INTEGER NOT NULL DEFAULT 0, run_count INTEGER NOT NULL DEFAULT 0,
  scheduled_run_count INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, lifecycle_status TEXT NOT NULL DEFAULT 'active', next_run_at INTEGER, last_run_at INTEGER,
  running INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER, dispatch_status TEXT NOT NULL DEFAULT 'idle', dispatch_attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_selection TEXT, project_id TEXT, host_id TEXT, additional_directories TEXT);
CREATE TABLE automation_runs (run_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, workspace_key TEXT NOT NULL, scheduled_at INTEGER, trigger TEXT NOT NULL DEFAULT 'schedule',
  dispatch_status TEXT NOT NULL DEFAULT 'claimed', outcome TEXT, session_id TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model_selection TEXT);
`);
idx.prepare("INSERT INTO tasks (workspace_key, workspace_path, task_id, title, model, mode, host_id, project_id) VALUES ('C:\\ws', 'C:\\ws', 'sess_app1', 'App task', 'prov-1/model-a', 'build', 'local', 'proj-1')").run();
const store = new DatabaseSync(process.env.ZCODE_STORE_DB);
store.exec('CREATE TABLE session_entry (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
store.prepare("INSERT INTO session_entry VALUES ('e1', 'sess_app1', 'runtime/model_selection', 1, 1, ?)").run(JSON.stringify({ modelSelection: { providerId: 'prov-1', modelId: 'model-a', options: { reasoningLevel: 'medium' } } }));
store.prepare("INSERT INTO session_entry VALUES ('e2', 'sess_app1', 'runtime/model_selection', 2, 2, ?)").run(JSON.stringify({ modelSelection: { providerId: 'prov-1', modelId: 'model-b', options: { reasoningLevel: 'high' } } }));

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok   ${name}`); };

t('taskOf finds the app\'s task, not a session it does not list', () => {
  assert.strictEqual(wake.taskOf('sess_app1').title, 'App task');
  assert.strictEqual(wake.taskOf('sess_cli9'), null);
});

t('the model selection comes from the session\'s latest runtime entry', () => {
  assert.deepStrictEqual(wake.modelSelectionOf('sess_app1', wake.taskOf('sess_app1')), { providerId: 'prov-1', modelId: 'model-b', options: { reasoningLevel: 'high' } });
});

let w;
t('wake writes one one-off automation for the session, due now, on its own model and mode', () => {
  w = wake.wake('sess_app1', 'hello there', { now: 1000 });
  const row = idx.prepare('SELECT * FROM automations WHERE automation_id = ?').get(w.automationId);
  assert.strictEqual(row.title, wake.TITLE);
  assert.strictEqual(row.target_task_id, 'sess_app1');
  assert.strictEqual(row.prompt, 'hello there');
  assert.deepStrictEqual(JSON.parse(row.model_selection), { providerId: 'prov-1', modelId: 'model-b', options: { reasoningLevel: 'high' } });
  assert.deepStrictEqual([row.mode, row.workspace_path, row.project_id, row.host_id], ['build', 'C:\\ws', 'proj-1', 'local']);
  assert.deepStrictEqual([row.recurring, row.max_runs, row.enabled, row.lifecycle_status, row.next_run_at, row.running, row.dispatch_status], [0, 1, 1, 'active', 1000, 0, 'idle']);
  assert.strictEqual(w.model, 'model-b (high)');
});

t('its state follows the app scheduler: pending, dispatched, then the run\'s outcome', () => {
  assert.strictEqual(wake.wakeState(w.automationId).state, 'pending');
  assert.ok(!wake.settled(wake.wakeState(w.automationId)));
  // the scheduler claims it, the host dispatches it, the run starts
  idx.prepare("UPDATE automations SET running = 1, dispatch_status = 'claimed' WHERE automation_id = ?").run(w.automationId);
  assert.strictEqual(wake.cleanup(w.automationId), false, 'a claimed wake is not removed');
  idx.prepare("UPDATE automations SET running = 0, dispatch_status = 'dispatched', lifecycle_status = 'completed', enabled = 0, next_run_at = NULL, run_count = 1 WHERE automation_id = ?").run(w.automationId);
  idx.prepare("INSERT INTO automation_runs (run_id, automation_id, workspace_key, trigger, dispatch_status, outcome, session_id, created_at, updated_at) VALUES (?, ?, 'C:\\ws', 'schedule', 'dispatched', 'running', 'sess_app1', 2, 2)").run(`${w.automationId}:1000`, w.automationId);
  idx.prepare('UPDATE tasks SET cron_automation_id = ? WHERE task_id = ?').run(w.automationId, 'sess_app1');
  assert.strictEqual(wake.wakeState(w.automationId).state, 'running');
  assert.ok(!wake.settled(wake.wakeState(w.automationId)));
  idx.prepare("UPDATE automation_runs SET outcome = 'succeeded' WHERE automation_id = ?").run(w.automationId);
  assert.strictEqual(wake.wakeState(w.automationId).state, 'succeeded');
  assert.ok(wake.settled(wake.wakeState(w.automationId)));
});

t('cleanup removes the automation and its runs and clears the session\'s scheduled-task mark', () => {
  assert.deepStrictEqual(wake.listWakes().map((x) => x.automationId), [w.automationId]);
  assert.strictEqual(wake.sweep(), 1);
  assert.strictEqual(idx.prepare('SELECT COUNT(*) AS n FROM automations').get().n, 0);
  assert.strictEqual(idx.prepare('SELECT COUNT(*) AS n FROM automation_runs').get().n, 0);
  assert.strictEqual(wake.taskOf('sess_app1').cron_automation_id, null);
  assert.strictEqual(wake.wakeState(w.automationId).state, 'gone');
});

t('a wake the app could not dispatch reports its error and counts as settled', () => {
  const f = wake.wake('sess_app1', 'x');
  idx.prepare("UPDATE automations SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed', last_error = 'model selection unavailable' WHERE automation_id = ?").run(f.automationId);
  const st = wake.wakeState(f.automationId);
  assert.deepStrictEqual([st.state, st.error], ['failed', 'model selection unavailable']);
  assert.ok(wake.settled(st));
  assert.ok(wake.cleanup(f.automationId));
});

t('the app\'s limit of 20 scheduled tasks is kept; other automations are never touched', () => {
  for (let i = 0; i < 20; i++) idx.prepare("INSERT INTO automations (automation_id, title, cron_expr, prompt, workspace_key, workspace_path, created_at, updated_at) VALUES (?, 'theirs', '0 9 * * *', 'p', 'w', 'w', 1, 1)").run(`automation-theirs-${i}`);
  assert.throws(() => wake.wake('sess_app1', 'too many'), /limit is 20/);
  assert.strictEqual(wake.sweep(), 0);
  assert.strictEqual(idx.prepare("SELECT COUNT(*) AS n FROM automations WHERE title = 'theirs'").get().n, 20);
  assert.throws(() => wake.wake('sess_cli9', 'x'), /not a task of the ZCode app/);
});

idx.close();
store.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* open handle */ }
console.log(`\n${n} passed`);
