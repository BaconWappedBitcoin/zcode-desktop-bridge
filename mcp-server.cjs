#!/usr/bin/env node
'use strict';
/**
 * mcp-server.cjs — expose the ZCode Windows harness as MCP tools (stdio).
 *
 * Any MCP client (Claude Code, Cline, Cursor, another ZCode instance, …) can
 * mount this server and drive full harness agent sessions as tools:
 *
 *   zcode_agent          one-shot prompt -> full agent turn -> final text
 *   zcode_session_start  create a persistent session (optional first prompt)
 *   zcode_session_send   run a follow-up turn on a session
 *   zcode_session_status inspect a session
 *   zcode_session_stop   stop a running turn
 *   zcode_session_wait   block until the current (async) turn finishes
 *   zcode_session_output peek at the latest streamed output, non-blocking
 *   zcode_session_cancel cancel the running turn (session/stop interrupt)
 *   zcode_sessions_list  every session in memory or on disk (recovery)
 *   zcode_models         list models available to the harness
 *   zcode_offpeak_create queue a FREE idle-time (off-peak) task
 *   zcode_offpeak_list   list idle-time tasks (live queue positions)
 *   zcode_offpeak_status inspect one idle-time task
 *   zcode_offpeak_models idle-time allowed models + live eligibility
 *   zcode_offpeak_cancel stop/cancel an idle-time task
 *   zcode_offpeak_pause  pause a queued idle-time task
 *   zcode_offpeak_continue resume a paused idle-time task
 *   zcode_offpeak_delete remove an idle-time task record
 *   zcode_offers         claimable plan offers (detection only — never claims)
 *
 * zcode_agent / zcode_session_start / zcode_session_send accept async:true to
 * return {sessionId, turnId, status:"running"} immediately — long turns then
 * never hit the client's tool timeout; poll with zcode_session_wait.
 *
 * Long turns emit MCP progress notifications with the latest output snippet.
 * stdout is the MCP wire (newline-delimited JSON-RPC 2.0); logs go to stderr.
 *
 * Register in ZCode (~/.zcode/cli/config.json mcp.servers) or any MCP client:
 *   { "mcpServers": { "zcode-bridge": {
 *       "command": "<ZCode.exe>",
 *       "args": ["<this file>"],
 *       "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
 */
const path = require('path');
const fs = require('fs');
const { AgentManager } = require('./lib/agent-manager.cjs');
const codingPlan = require('./lib/coding-plan.cjs');

const SUPPORTED_PROTOCOL = '2025-06-18';

function loadConfig() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--config');
  const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : path.join(__dirname, 'config.json');
  let fileCfg = {};
  if (cfgPath && fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
  }
  return Object.assign({ workspacePath: path.join(__dirname, 'bridge-workspace'), mode: 'yolo', turnTimeoutMs: 15 * 60 * 1000, asyncTurnTimeoutMs: 6 * 60 * 60 * 1000 }, fileCfg);
}

const cfg = loadConfig();
const log = (...a) => process.stderr.write(`[zcode-mcp] ${new Date().toISOString()} ${a.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join(' ')}\n`);

let manager = null;
function mgr() {
  if (!manager) manager = new AgentManager(cfg, log);
  return manager;
}

let offPeak = null;
function off() {
  if (!offPeak) {
    offPeak = new (require('./lib/offpeak.cjs').OffPeakManager)({ manager: mgr(), logger: log });
    offPeak.start();
  }
  return offPeak;
}

// Offer detector: polls for claimable plan offers and toasts (config
// offersPollMs, 0 disables; offerToasts, default on). Detection only — the
// bridge NEVER claims offers (claiming needs the in-app Aliyun captcha).
// The out/offers/poller.pid lock (first-alive-wins) keeps this process and
// server.cjs from double-toasting when both run.
const offers = new (require('./lib/offers.cjs').OffersManager)({
  dir: cfg.offersDir,
  pollMs: cfg.offersPollMs,
  toasts: cfg.offerToasts !== false,
  logger: (m, x) => log('[offers]', m, x || ''),
});
offers.start();

// ------------------------------------------------------------------ wire
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { write({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { write({ jsonrpc: '2.0', method, params }); }
function progress(token, message) {
  if (token === undefined || token === null) return;
  notify('notifications/progress', { progressToken: token, progress: 0, message: String(message).slice(0, 400) });
}

function toolResult(text, extra) {
  return Object.assign({ content: [{ type: 'text', text: String(text) }] }, extra || {});
}
function toolError(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

const TOOLS = [
  {
    name: 'zcode_agent',
    description: 'Run a one-shot agent turn in the ZCode harness (full tool access: files, shell, MCP plugins). Returns the final answer text after all internal tool use completes. May take minutes for complex tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task / question for the agent.' },
        workspace: { type: 'string', description: 'Optional absolute directory the agent works in (default: the bridge workspace).' },
        reasoning_level: { type: 'string', enum: ['low', 'high', 'max'], description: 'Reasoning effort (default high).' },
        model: { type: 'string', description: 'Optional model override for this call only, e.g. "GLM-5.3" (see zcode_models).' },
        async: { type: 'boolean', description: 'Return immediately with {sessionId, turnId, status:"running"} instead of waiting for the turn. Then poll zcode_session_wait / zcode_session_output, or zcode_session_cancel.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'zcode_session_start',
    description: 'Create a persistent ZCode harness session (optionally with an opening prompt) for multi-turn orchestration. Returns the sessionId. With async:true and an initial_prompt it returns {sessionId, turnId, status:"running"} immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        initial_prompt: { type: 'string', description: 'Optional first prompt; if omitted the session starts idle.' },
        workspace: { type: 'string' },
        async: { type: 'boolean', description: 'Start the opening prompt without waiting; poll with zcode_session_wait.' },
      },
    },
  },
  {
    name: 'zcode_session_send',
    description: 'Send a follow-up prompt to a session created by zcode_session_start and wait for the turn to finish. Emits progress notifications with the latest output. With async:true returns {sessionId, turnId, status:"running"} immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        prompt: { type: 'string' },
        async: { type: 'boolean', description: 'Start the turn without waiting; poll with zcode_session_wait.' },
      },
      required: ['session_id', 'prompt'],
    },
  },
  {
    name: 'zcode_session_wait',
    description: 'Wait for the current turn on a session to finish (use after an async zcode_agent / zcode_session_start / zcode_session_send). Blocks up to timeout_s; returns {status: running|done|error|cancelled (idle if no turn ever ran), finalText when done, lastOutput, usage, model}. Call repeatedly until status is no longer "running".',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        timeout_s: { type: 'number', description: 'Maximum seconds to block (default 60, max 600).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'zcode_session_output',
    description: 'Peek at a session\'s latest streamed text/progress without blocking (for async turns). Returns {sessionId, status, turnId, tail}.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        tail_chars: { type: 'number', description: 'Length of the output tail to return (default 2000, capped at 2000).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'zcode_session_cancel',
    description: 'Cancel the running turn on a session: interrupts via the harness protocol\'s session/stop (the session stays usable for the next prompt) and records status "cancelled". Harmless if no turn is running.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_sessions_list',
    description: 'List every session this bridge process knows plus every session recorded on disk (the statusDir files), with id, workspace, model, status (idle|running|done|error|cancelled), turns, createdAt, lastActivity, pid — the recovery path for a sessionId lost to a client tool timeout.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_session_status',
    description: 'Inspect a bridge session (busy, turns, model, age).',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_session_stop',
    description: 'Stop a running turn on a session.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
  },
  {
    name: 'zcode_models',
    description: 'List models available to the harness (model id, provider, context window, reasoning levels) with the bridge\'s current default marked. Switch the default or a live session\'s model with zcode_model_set.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_model_set',
    description: 'Switch the model. Without session_id: changes the bridge default used for all future agent sessions. With session_id: live-switches that existing session\'s model (its conversation and history are kept; fails if a turn is currently running on it). Accepts "GLM-5.3-Flash", "account:zai-individual-coding-plan/GLM-5.3-Flash", or {providerId, modelId} plus an optional reasoning_level.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id ("GLM-5.3-Flash") or "providerId/modelId".' },
        reasoning_level: { type: 'string', description: 'Optional: low | high | max (validated against what the model supports).' },
        session_id: { type: 'string', description: 'Optional: switch this live session instead of the default.' },
      },
      required: ['model'],
    },
  },
  {
    name: 'zcode_plan_usage',
    description: 'Read the coding plan usage windows and banked resets: 5-hour and weekly credit windows (used/remaining/percentage/next reset time) plus how many five-hour and week resets are currently available to spend.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_plan_reset',
    description: 'Consume one banked coding-plan reset to refresh a usage window ("five_hour" or "week"). Checks availability first and refuses without consuming when none is banked. This is a real, irreversible action on the plan account.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['five_hour', 'week'], description: 'Which window to reset.' },
        force: { type: 'boolean', description: 'Skip the availability pre-check AND the reset policy (default false).' },
        queuedWork: { type: 'boolean', description: 'Caller has GLM work queued/stalled (the reset policy requires it by default).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'zcode_plan_reset_advise',
    description: 'Dry run: should a banked 5-hour reset be spent now? Applies config.json resetPolicy (owner 2026-10-06): only when the 5-hour window is nearly exhausted, GLM work is queued, the natural reset is far enough away, and the weekly window has room. Returns spend true/false, reasons, minutesSaved (time to the natural reset) and weekly remaining. Spends nothing.',
    inputSchema: { type: 'object', properties: { queuedWork: { type: 'boolean', description: 'Caller has GLM work queued/stalled.' } } },
  },
  {
    name: 'zcode_plan_reset_opportunity',
    description: 'Ask the Z.ai backend to grant a coding-plan reset opportunity (what the desktop app earns through its reward flow). Returns granted true/false and the next-allowed time when throttled.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_plan_route',
    description: 'Which plan currently has credit for a model (owner 2026-10-05 dynamic routing): ordered candidates per model from config.json planRouter, skipping plans without local credentials, with an exhausted 5-hour window, or under the weekly reserve kept for GLM-5.3; start plans are desktop-app only. Returns providerId (or null + waitUntil) and every candidate with its reason. Use model "auto:<modelId>" on zcode_session_start / zcode_model_set to route automatically.',
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'Model id, e.g. "GLM-5.3-Flash".' } }, required: ['model'] },
  },
  {
    name: 'zcode_plans',
    description: 'List every plan known to the harness (individual/team/start/off-peak coding plans), which ones this machine holds credentials for, live token availability per window (5-hour / weekly remaining, usage %, next reset) for those, and which plan is currently active for the bridge. Use zcode_plan_switch to change the active plan.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_plan_switch',
    description: 'Switch the bridge to another plan this machine holds credentials for (see zcode_plans). Sets the plan\'s default model as the bridge default (or pick one with `model`); all future agent sessions use it. Reversible — switch back any time. Fails with a clear message for plans without local credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan provider id, e.g. "account:zai-individual-coding-plan".' },
        model: { type: 'string', description: 'Optional model id from that plan to make the default.' },
        reasoning_level: { type: 'string', description: 'Optional reasoning level for the default model.' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'zcode_offpeak_create',
    description: 'Queue a FREE idle-time (off-peak) task: takes a cloud queue ticket now; the task runs unattended on spare capacity during off-peak hours at no plan-quota cost. No guaranteed start time. The prompt must be self-contained and state the deliverable explicitly — nobody answers questions during the run. The run happens in its own session (or a live bridge session when session_id is given, continuing its full history). Constraints: coding-plan subscribers only, one pending task per session, rate-limited creations (errors carry the next-allowed time), the machine must stay awake, and actions needing confirmation pause the run (prefer permission_mode yolo or plan).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise task title, no file paths (e.g. "Refactor utils directory").' },
        prompt: { type: 'string', description: 'Instructions for the unattended run. State the expected deliverable explicitly; never ask the run to create another idle-time task or automation.' },
        workspace: { type: 'string', description: 'Optional absolute directory the task works in (default: the bridge workspace).' },
        model: { type: 'string', description: 'Idle-time allowed model id (see zcode_offpeak_models); default = the newest allowed model.' },
        permission_mode: { type: 'string', enum: ['build', 'edit', 'plan', 'yolo'], description: 'Unattended run permission mode (default yolo). "plan" is read-only; "build" pauses for approval before changes.' },
        thought_level: { type: 'string', description: 'Reasoning effort for the chosen model (default: highest).' },
        session_id: { type: 'string', description: 'Optional live bridge session to bind — the run continues that conversation with its full history.' },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'zcode_offpeak_list',
    description: 'List idle-time (off-peak) tasks with live status: refreshes queue positions/ticket states from the server and mirrors every task to out/offpeak/<taskId>.json. Task status: queued|paused|running|completed|failed|cancelled; queuePosition and sessionId (once the run started) included.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Poll the server for live ticket state before listing (default true).' },
      },
    },
  },
  {
    name: 'zcode_offpeak_status',
    description: 'Inspect one idle-time task by id (local read, includes ticket state, attempts, timestamps and the on-disk status file path).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_models',
    description: 'Idle-time (off-peak) allowed models (from the harness provider registry) plus the default pick, and live eligibility: whether a task can be created right now and, when rate-limited, the next-allowed time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zcode_offpeak_cancel',
    description: 'Cancel an idle-time task (stops a running turn, marks it cancelled, settles its queue ticket). Already-modified files are kept.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_pause',
    description: 'Pause a queued idle-time task: the poller stops dispatching it while paused. Pausing longer than the queue-wait limit expires the ticket — continuing then re-queues the task at the tail.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_continue',
    description: 'Continue a paused idle-time task (un-pauses; retakes the queue ticket automatically when the old one expired).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offpeak_delete',
    description: 'Delete an idle-time task record (cancels first when still queued/running; the on-disk status file is removed). Irreversible.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'zcode_offers',
    description: 'List claimable ZCode plan offers (limited-time daily/one-time token offers the desktop app would pop up), plus banked reset opportunities, with title, token amount, period and valid-until. The bridge DETECTS and notifies only — it never claims an offer (claiming requires the in-app Aliyun captcha); claim manually in the ZCode app.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Run a live read-only check before answering (default false: return the poller\'s cached list and last check time).' },
      },
    },
  },
];

// ---------------------------------------------------------------- handlers
async function handleToolCall(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  const token = params && params._meta && params._meta.progressToken;

  if (name === 'zcode_agent' || name === 'zcode_session_start' || name === 'zcode_session_send') {
    progress(token, 'starting harness session…');
  }

  if (name === 'zcode_agent') {
    let modelSel;
    if (args.model) modelSel = await mgr().resolveModelSelection(String(args.model), { reasoningLevel: args.reasoning_level });
    const { sessionId, model } = await mgr().createSession({
      workspacePath: args.workspace,
      reasoningLevel: args.reasoning_level,
      ...(modelSel ? { model: modelSel } : {}),
    });
    if (args.async === true) {
      const started = mgr().startTurn(sessionId, String(args.prompt || ''), {});
      const text = `sessionId: ${sessionId}\nturnId: ${started.turnId}\nstatus: running\n\nPoll with zcode_session_wait { "session_id": "${sessionId}" }, peek with zcode_session_output, cancel with zcode_session_cancel.`;
      return toolResult(text, { structuredContent: { sessionId, turnId: started.turnId, status: 'running', model } });
    }
    try {
      const result = await mgr().runTurn(sessionId, String(args.prompt || ''), {
        onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
      });
      const parts = [];
      if (result.reasoning) parts.push(`[reasoning]\n${result.reasoning}\n\n[answer]`);
      parts.push(result.text || '(no textual output)');
      parts.push(`\n\n[model] ${model.providerId}/${model.modelId}`);
      parts.push(`\n[usage] input=${result.usage.input || 0} output=${result.usage.output || 0} cacheRead=${(result.usage.cache && result.usage.read) || 0}`);
      return toolResult(parts.join('\n'), { structuredContent: { sessionId, model, text: result.text, reasoning: result.reasoning, usage: result.usage, finishReason: result.finishReason } });
    } finally {
      // one-shot sessions are disposable; leave reaping to the idle timer
    }
  }

  if (name === 'zcode_session_start') {
    const created = await mgr().createSession({ workspacePath: args.workspace });
    if (args.initial_prompt) {
      if (args.async === true) {
        const started = mgr().startTurn(created.sessionId, String(args.initial_prompt), {});
        return toolResult(`sessionId: ${created.sessionId}\nturnId: ${started.turnId}\nstatus: running`, { structuredContent: { sessionId: created.sessionId, turnId: started.turnId, status: 'running', model: created.model } });
      }
      progress(token, 'running opening prompt…');
      const result = await mgr().runTurn(created.sessionId, String(args.initial_prompt), {
        onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
      });
      return toolResult(`sessionId: ${created.sessionId}\nmodel: ${created.model.providerId}/${created.model.modelId}\n\n${result.text || ''}`, { structuredContent: { sessionId: created.sessionId, model: created.model, firstReply: result.text } });
    }
    return toolResult(`sessionId: ${created.sessionId}\nmodel: ${created.model.providerId}/${created.model.modelId}\n(idle, awaiting prompts)`, { structuredContent: { sessionId: created.sessionId, model: created.model } });
  }

  if (name === 'zcode_session_send') {
    const info = mgr().sessionInfo(String(args.session_id || ''));
    if (!info) return toolError(`unknown session ${args.session_id} (start one with zcode_session_start, or recover it with zcode_sessions_list)`);
    if (args.async === true) {
      const started = mgr().startTurn(String(args.session_id), String(args.prompt || ''), {});
      return toolResult(`sessionId: ${args.session_id}\nturnId: ${started.turnId}\nstatus: running`, { structuredContent: started });
    }
    const result = await mgr().runTurn(String(args.session_id), String(args.prompt || ''), {
      onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
    });
    return toolResult(result.text || '(no textual output)', { structuredContent: { text: result.text, usage: result.usage, finishReason: result.finishReason } });
  }

  if (name === 'zcode_session_wait') {
    const sid = String(args.session_id || '');
    if (!mgr().sessionInfo(sid)) return toolError(`unknown session ${sid} (recover it with zcode_sessions_list)`);
    let timeoutS = Number(args.timeout_s);
    if (!Number.isFinite(timeoutS)) timeoutS = 60;
    timeoutS = Math.max(0, Math.min(timeoutS, 600));
    const view = await mgr().waitTurn(sid, timeoutS * 1000);
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }

  if (name === 'zcode_session_output') {
    const sid = String(args.session_id || '');
    let tailChars = Number(args.tail_chars);
    if (!Number.isFinite(tailChars) || tailChars < 0) tailChars = 2000;
    tailChars = Math.min(tailChars, 2000);
    let out;
    try { out = mgr().sessionOutput(sid); } catch (e) { return toolError(e.message); }
    const view = { sessionId: out.sessionId, status: out.status, turnId: out.turnId, tail: String(out.tail).slice(-tailChars) };
    return toolResult(JSON.stringify(view, null, 2), { structuredContent: view });
  }

  if (name === 'zcode_session_cancel') {
    const result = await mgr().cancelTurn(String(args.session_id || ''));
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_sessions_list') {
    const sessions = mgr().sessionsList();
    return toolResult(JSON.stringify({ statusDir: mgr().statusDir, sessions }, null, 2), { structuredContent: { statusDir: mgr().statusDir, sessions } });
  }

  if (name === 'zcode_session_status') {
    const info = mgr().sessionInfo(String(args.session_id || ''));
    if (!info) return toolError(`unknown session ${args.session_id}`);
    return toolResult(JSON.stringify(info, null, 2));
  }

  if (name === 'zcode_session_stop') {
    await mgr().stopSession(String(args.session_id || ''));
    return toolResult('stop requested');
  }

  if (name === 'zcode_models') {
    const models = await mgr().listModels();
    const def = mgr().defaultModel;
    const payload = models.map((m) => ({
      modelId: m.ref && m.ref.modelId,
      providerId: m.ref && m.ref.providerId,
      label: m.label,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      reasoning: m.reasoning,
      isDefault: !!(m.ref && def && m.ref.providerId === def.providerId && m.ref.modelId === def.modelId),
    }));
    return toolResult(JSON.stringify({ default: def, models: payload }, null, 2), { structuredContent: { default: def, models: payload } });
  }

  if (name === 'zcode_model_set') {
    const ref = String(args.model || '').trim();
    if (!ref) return toolError('model is required (see zcode_models)');
    if (args.session_id) {
      const updated = await mgr().setSessionModel(String(args.session_id), ref, { reasoningLevel: args.reasoning_level });
      return toolResult(`session ${args.session_id} now uses ${updated.providerId}/${updated.modelId} (reasoning: ${updated.options && updated.options.reasoningLevel})`, { structuredContent: { scope: 'session', sessionId: args.session_id, model: updated } });
    }
    const updated = await mgr().setDefaultModel(ref, { reasoningLevel: args.reasoning_level });
    return toolResult(`bridge default model is now ${updated.providerId}/${updated.modelId} (reasoning: ${updated.options && updated.options.reasoningLevel})`, { structuredContent: { scope: 'default', model: updated } });
  }

  if (name === 'zcode_plan_usage') {
    const snap = await codingPlan.getPlanSnapshot();
    return toolResult(JSON.stringify(snap, null, 2), { structuredContent: snap });
  }

  if (name === 'zcode_plan_reset_advise') {
    const snap = await codingPlan.getPlanSnapshot();
    const advice = require('./lib/reset-policy.cjs').evaluate(snap, cfg.resetPolicy, { queuedWork: args.queuedWork === true });
    return toolResult(JSON.stringify(advice, null, 2), { structuredContent: advice });
  }

  if (name === 'zcode_plan_reset') {
    const type = String(args.type || '');
    if (args.force !== true && (type === 'five_hour' || type === 'FIVE_HOUR')) {
      const snap = await codingPlan.getPlanSnapshot();
      const advice = require('./lib/reset-policy.cjs').evaluate(snap, cfg.resetPolicy, { queuedWork: args.queuedWork === true });
      if (!advice.spend) {
        const refused = { used: false, refusedByPolicy: true, advice };
        return toolResult(JSON.stringify(refused, null, 2), { structuredContent: refused });
      }
    }
    const result = await codingPlan.useReset(type, { force: args.force === true });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_reset_opportunity') {
    const result = await codingPlan.requestOpportunity();
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_route') {
    if (!args.model) return toolError('model is required');
    const result = await require('./lib/plan-router.cjs').route(String(args.model), { policy: cfg.planRouter });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plans') {
    const result = await codingPlan.listPlans(mgr().defaultModel.providerId);
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_switch') {
    if (!args.plan) return toolError('plan is required (see zcode_plans for ids)');
    const updated = await mgr().setPlan(String(args.plan), {
      modelId: args.model ? String(args.model) : undefined,
      reasoningLevel: args.reasoning_level,
    });
    return toolResult(`active plan is now ${updated.providerId} (default model ${updated.modelId}, reasoning ${updated.options && updated.options.reasoningLevel})`, { structuredContent: { plan: updated.providerId, model: updated } });
  }

  if (name === 'zcode_offpeak_create') {
    const task = await off().create({
      title: args.title,
      prompt: args.prompt,
      workspace: args.workspace,
      model: args.model,
      permissionMode: args.permission_mode,
      thoughtLevel: args.thought_level,
      sessionId: args.session_id,
    });
    const pos = typeof task.queuePosition === 'number' ? ` (#${task.queuePosition} in queue)` : '';
    const text = `Created idle-time task ${task.offPeakTaskId}${pos}.\nstatus: ${task.status}\nmodel: ${task.model.providerId}/${task.model.modelId}\nworkspace: ${task.workspace}\nstatus file: ${off().store.fileFor(task.offPeakTaskId)}\nTrack with zcode_offpeak_list; it runs unattended when off-peak capacity is granted (keep the machine awake).`;
    return toolResult(text, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_list') {
    const result = await off().list({ refresh: args.refresh !== false });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_offpeak_status') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().get(String(args.task_id));
    return toolResult(JSON.stringify(task, null, 2), { structuredContent: task });
  }

  if (name === 'zcode_offpeak_models') {
    const models = off().allowedModels();
    const def = models.find((m) => m.isDefault) || models[models.length - 1] || null;
    let availability = null;
    let availabilityError = null;
    try { availability = await off().availability(); }
    catch (e) { availabilityError = e.describe ? e.describe() : e.message; }
    const result = { default: def ? { providerId: def.providerId, modelId: def.modelId } : null, models, availability, availabilityError };
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_offpeak_cancel') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().cancel(String(args.task_id));
    return toolResult(`idle-time task ${task.offPeakTaskId}: ${task.status}`, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_pause') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().pause(String(args.task_id));
    return toolResult(`idle-time task ${task.offPeakTaskId}: ${task.status}`, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_continue') {
    if (!args.task_id) return toolError('task_id is required');
    const task = await off().continue(String(args.task_id));
    return toolResult(`idle-time task ${task.offPeakTaskId}: ${task.status}`, { structuredContent: task });
  }

  if (name === 'zcode_offpeak_delete') {
    if (!args.task_id) return toolError('task_id is required');
    const result = await off().delete(String(args.task_id));
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_offers') {
    const result = await offers.list({ refresh: args.refresh === true });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  return toolError(`unknown tool: ${name}`);
}

// ------------------------------------------------------------------ loop
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) dispatch(JSON.parse(line)).catch((e) => log('dispatch error', e.message));
  }
});
process.stdin.on('end', () => { log('stdin closed, exiting'); shutdown(); });

let initialized = false;
async function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined) {
    // notification
    if (msg.method === 'notifications/initialized') initialized = true;
    return;
  }
  if (msg.method === 'initialize') {
    const clientProto = msg.params && msg.params.protocolVersion;
    const protocolVersion = clientProto || SUPPORTED_PROTOCOL;
    return reply(msg.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'zcode-bridge', version: '0.5.2', title: 'ZCode harness bridge' },
    });
  }
  if (msg.method === 'ping') return reply(msg.id, {});
  if (msg.method === 'tools/list') {
    return reply(msg.id, { tools: TOOLS });
  }
  if (msg.method === 'tools/call') {
    try {
      const result = await handleToolCall(msg.params);
      return reply(msg.id, result);
    } catch (e) {
      log('tool call failed', e.message);
      return reply(msg.id, toolError(e.message));
    }
  }
  if (msg.method === 'resources/list') return reply(msg.id, { resources: [] });
  if (msg.method === 'prompts/list') return reply(msg.id, { prompts: [] });
  return replyErr(msg.id, -32601, `method not found: ${msg.method}`);
}

async function shutdown() {
  offers.stop();
  if (manager) await manager.shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('zcode-bridge MCP server ready on stdio');
