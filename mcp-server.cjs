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
 *   zcode_models         list models available to the harness
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
  return Object.assign({ workspacePath: path.join(__dirname, 'bridge-workspace'), mode: 'yolo', turnTimeoutMs: 15 * 60 * 1000 }, fileCfg);
}

const cfg = loadConfig();
const log = (...a) => process.stderr.write(`[zcode-mcp] ${new Date().toISOString()} ${a.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join(' ')}\n`);

let manager = null;
function mgr() {
  if (!manager) manager = new AgentManager(cfg, log);
  return manager;
}

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
      },
      required: ['prompt'],
    },
  },
  {
    name: 'zcode_session_start',
    description: 'Create a persistent ZCode harness session (optionally with an opening prompt) for multi-turn orchestration. Returns the sessionId.',
    inputSchema: {
      type: 'object',
      properties: {
        initial_prompt: { type: 'string', description: 'Optional first prompt; if omitted the session starts idle.' },
        workspace: { type: 'string' },
      },
    },
  },
  {
    name: 'zcode_session_send',
    description: 'Send a follow-up prompt to a session created by zcode_session_start and wait for the turn to finish. Emits progress notifications with the latest output.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['session_id', 'prompt'],
    },
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
        force: { type: 'boolean', description: 'Skip the availability pre-check (default false).' },
      },
      required: ['type'],
    },
  },
  {
    name: 'zcode_plan_reset_opportunity',
    description: 'Ask the Z.ai backend to grant a coding-plan reset opportunity (what the desktop app earns through its reward flow). Returns granted true/false and the next-allowed time when throttled.',
    inputSchema: { type: 'object', properties: {} },
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
    if (!info) return toolError(`unknown session ${args.session_id} (start one with zcode_session_start)`);
    const result = await mgr().runTurn(String(args.session_id), String(args.prompt || ''), {
      onDelta: (d) => { if (d.type === 'text') progress(token, d.text.slice(-300)); },
    });
    return toolResult(result.text || '(no textual output)', { structuredContent: { text: result.text, usage: result.usage, finishReason: result.finishReason } });
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

  if (name === 'zcode_plan_reset') {
    const result = await codingPlan.useReset(String(args.type || ''), { force: args.force === true });
    return toolResult(JSON.stringify(result, null, 2), { structuredContent: result });
  }

  if (name === 'zcode_plan_reset_opportunity') {
    const result = await codingPlan.requestOpportunity();
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
      serverInfo: { name: 'zcode-bridge', version: '0.1.0', title: 'ZCode harness bridge' },
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
  if (manager) await manager.shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('zcode-bridge MCP server ready on stdio');
