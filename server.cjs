#!/usr/bin/env node
'use strict';
/**
 * server.cjs — Anthropic-compatible HTTP facade over the ZCode Windows harness.
 *
 * Endpoints:
 *   POST /v1/messages            (stream + non-stream)
 *   GET  /v1/models
 *   POST /v1/messages/count_tokens
 *   GET  /v1/offpeak              list idle-time tasks (live refresh)
 *   POST /v1/offpeak              queue an idle-time task {title, prompt, ...}
 *   GET  /v1/offers               claimable plan offers (detect-only, never claims)
 *   GET  /healthz
 *
 * Run with system Node, or without any Node install via:
 *   ELECTRON_RUN_AS_NODE=1 ZCode.exe server.cjs   (see run-bridge.cmd)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { AgentManager, TurnAborted, followKey } = require('./lib/agent-manager.cjs');
const facade = require('./lib/anthropic-facade.cjs');

// ---------------------------------------------------------------- config
function loadConfig() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf('--config');
  const cfgPath = cfgIdx !== -1 ? args[cfgIdx + 1] : path.join(__dirname, 'config.json');
  let fileCfg = {};
  if (cfgPath && fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.error(`[bridge] failed to parse ${cfgPath}: ${e.message}`); process.exit(1); }
  }
  const cfg = Object.assign({
    port: 8787,
    bind: '127.0.0.1',
    workspacePath: path.join(__dirname, 'bridge-workspace'),
    mode: 'yolo',
    exposeThinking: false,
    includeToolActivity: false,
    turnTimeoutMs: 15 * 60 * 1000,
    maxConcurrentSessions: 8,
    sessionIdleMs: 30 * 60 * 1000,
    modelAliases: {},
  }, fileCfg);
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.BIND) cfg.bind = process.env.BIND;
  if (process.env.ZCODE_BRIDGE_API_KEY) cfg.apiKey = process.env.ZCODE_BRIDGE_API_KEY;
  return cfg;
}

const cfg = loadConfig();
const log = (...a) => console.log('[bridge]', new Date().toISOString(), ...a);
const manager = new AgentManager(cfg, (...a) => log('[agent]', ...a));
const { OffPeakManager, OffPeakApiError } = require('./lib/offpeak.cjs');
const offPeak = new OffPeakManager({ manager, dir: cfg.offpeakDir, logger: (...a) => log('[offpeak]', ...a) });
offPeak.start();

// Offer detector: polls + toasts (config offersPollMs / offerToasts).
// Detection only — NEVER claims (claiming needs the in-app Aliyun captcha).
// The out/offers/poller.pid lock (first-alive-wins) prevents this process and
// the MCP server from double-toasting when both run.
const { OffersManager } = require('./lib/offers.cjs');
const offers = new OffersManager({
  dir: cfg.offersDir,
  pollMs: cfg.offersPollMs,
  toasts: cfg.offerToasts !== false,
  logger: (...a) => log('[offers]', ...a),
});
offers.start();

// conversation continuity: prevKey -> sessionId, sessionId -> fullKey
const convCache = new Map();
const sessionKeys = new Map();
const sessionMutex = new Map(); // sessionId -> promise chain

function serialize(sessionId, fn) {
  const prev = sessionMutex.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn);
  sessionMutex.set(sessionId, next.catch(() => {}));
  next.finally(() => { if (sessionMutex.get(sessionId) === next) sessionMutex.delete(sessionId); });
  return next;
}

function findSessionFor(prevKey) {
  const sessionId = convCache.get(prevKey);
  if (!sessionId) return null;
  const rec = manager.sessionInfo(sessionId);
  if (!rec) { convCache.delete(prevKey); return null; }
  return sessionId;
}

async function ensureConversation(body, modelSel) {
  const { system, prior, finalText, prevKey, fullKey } = facade.decomposeRequest(body);
  let sessionId = findSessionFor(prevKey);
  if (!sessionId) {
    const importedHistory = facade.buildImportedHistory(system, prior, body.metadata && body.metadata.user_id);
    const created = await manager.createSession({ model: modelSel, importedHistory });
    sessionId = created.sessionId;
    log('conversation created', { sessionId, imported: importedHistory ? importedHistory.messages.length : 0 });
  } else {
    log('conversation continued', { sessionId });
  }
  // advance the cache to the new prefix, and pre-register the key the
  // conversation will have once the client appends our reply
  const oldFull = sessionKeys.get(sessionId);
  if (oldFull && oldFull !== prevKey) convCache.delete(oldFull);
  convCache.set(fullKey, sessionId);
  sessionKeys.set(sessionId, fullKey);
  const rememberReply = (replyText) => {
    const fk = followKey(system, body.messages, replyText);
    convCache.delete(fullKey);
    convCache.set(fk, sessionId);
    sessionKeys.set(sessionId, fk);
  };
  return { sessionId, finalText, rememberReply };
}

function resolveModel(body) {
  const alias = body.model && cfg.modelAliases && cfg.modelAliases[body.model];
  if (alias && alias.providerId && alias.modelId) {
    return { providerId: alias.providerId, modelId: alias.modelId, options: { reasoningLevel: alias.reasoningLevel || 'high' } };
  }
  return null; // harness default
}

// ---------------------------------------------------------------- helpers
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!cfg.apiKey) return true;
  const hdr = req.headers['x-api-key'] || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return hdr === cfg.apiKey || bearer === cfg.apiKey;
}

function sseInit(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

// ---------------------------------------------------------------- handlers
async function handleMessages(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return facade.anthropicError(res, 400, 'invalid_request_error', `invalid JSON body: ${e.message}`);
  }

  const verr = facade.validateMessagesBody(body);
  if (verr) return facade.anthropicError(res, 400, 'invalid_request_error', verr);

  const stream = body.stream === true;
  const modelSel = resolveModel(body);
  const displayModel = body.model || 'zcode-agent';

  let conv;
  try {
    conv = await ensureConversation(body, modelSel);
  } catch (e) {
    log('conversation setup failed', { error: e.message });
    return facade.anthropicError(res, 500, 'api_error', `failed to start harness session: ${e.message}`);
  }

  const { sessionId } = conv;
  const abort = new AbortController();
  req.on('close', () => { if (!res.writableEnded) abort.abort(new TurnAborted('client disconnected')); });

  const run = (onDelta) => serialize(sessionId, () => manager.runTurn(sessionId, conv.finalText, {
    onDelta,
    onToolActivity: cfg.includeToolActivity ? (info) => log('tool-activity', sessionId, JSON.stringify(info).slice(0, 200)) : undefined,
    signal: abort.signal,
    timeoutMs: cfg.turnTimeoutMs,
  }));

  if (!stream) {
    try {
      const result = await run();
      conv.rememberReply(result.text || '');
      const payload = facade.messageResponse(displayModel, result, { exposeThinking: cfg.exposeThinking });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      log('turn completed', { sessionId, out: (result.text || '').length, usage: result.usage && result.usage.total });
    } catch (e) {
      const status = e instanceof TurnAborted ? 499 : 500;
      if (status === 499) { try { res.end(); } catch { /* ignore */ } return; }
      facade.anthropicError(res, 500, 'api_error', e.message || 'agent turn failed');
    }
    return;
  }

  // streaming
  sseInit(res);
  const keepAlive = setInterval(() => {
    try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); } catch { /* ignore */ }
  }, 15000);
  let onDelta = null;
  const turnPromise = run((d) => { if (onDelta) onDelta(d); });
  try {
    const streamed = await facade.streamResponse((chunk) => res.write(chunk), displayModel, async (register) => {
      onDelta = register;
      return turnPromise;
    }, { exposeThinking: cfg.exposeThinking });
    conv.rememberReply((streamed && streamed.result && streamed.result.text) || '');
    res.end();
  } catch { try { res.end(); } catch { /* ignore */ } }
  finally { clearInterval(keepAlive); }
}

async function handleModels(req, res) {
  try {
    const models = await manager.listModels();
    const data = models.map((m) => ({
      id: m.ref ? `${m.ref.providerId}/${m.ref.modelId}` : 'zcode-default',
      display_name: m.label || (m.ref && m.ref.modelId),
      type: 'model',
    }));
    data.unshift({ id: 'zcode-agent', display_name: 'ZCode harness (default model)', type: 'model' });
    for (const alias of Object.keys(cfg.modelAliases || {})) data.push({ id: alias, display_name: `alias -> ${cfg.modelAliases[alias].modelId}`, type: 'model' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data, has_more: false }));
  } catch (e) {
    facade.anthropicError(res, 500, 'api_error', e.message);
  }
}

// ---------------------------------------------------------------- off-peak
/** GET /v1/offpeak — list idle-time tasks (live refresh). POST /v1/offpeak — create one. */
async function handleOffpeakList(req, res) {
  try {
    const refresh = !/[?&]refresh=0/.test(req.url || '');
    const result = await offPeak.list({ refresh });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    facade.anthropicError(res, 500, 'api_error', e.message);
  }
}

async function handleOffpeakCreate(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return facade.anthropicError(res, 400, 'invalid_request_error', `invalid JSON body: ${e.message}`);
  }
  try {
    const task = await offPeak.create({
      title: body.title,
      prompt: body.prompt,
      workspace: body.workspace,
      model: body.model,
      permissionMode: body.permission_mode || body.permissionMode,
      thoughtLevel: body.thought_level || body.thoughtLevel,
      sessionId: body.session_id || body.sessionId || body.boundSessionId,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(task));
  } catch (e) {
    if (e instanceof OffPeakApiError) {
      const status = e.kind === 'eligibility' ? 403 : e.kind === 'quota' || e.kind === 'rate_limited' ? 429 : 502;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'offpeak_request_error', message: e.describe(), kind: e.kind, nextAllowedAt: iso(e.nextTakeAt) } }));
      return;
    }
    facade.anthropicError(res, 400, 'invalid_request_error', e.message);
  }
}

function iso(epoch) { return epoch ? new Date(epoch).toISOString() : null; }

// ------------------------------------------------------------------ offers
/** GET /v1/offers — claimable plan offers (cached; ?refresh=1 for a live check). */
async function handleOffers(req, res) {
  try {
    const refresh = /[?&]refresh=1\b/.test(req.url || '');
    const result = await offers.list({ refresh });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    facade.anthropicError(res, 502, 'api_error', e.message);
  }
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-api-key, authorization, anthropic-version, anthropic-beta');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (!authorized(req)) return facade.anthropicError(res, 401, 'authentication_error', 'invalid x-api-key');

    if (req.method === 'POST' && (url === '/v1/messages' || url === '/v1/messages/')) return await handleMessages(req, res);
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) return await handleModels(req, res);
    if (req.method === 'GET' && (url === '/v1/offpeak' || url === '/v1/offpeak/')) return await handleOffpeakList(req, res);
    if (req.method === 'POST' && (url === '/v1/offpeak' || url === '/v1/offpeak/')) return await handleOffpeakCreate(req, res);
    if (req.method === 'GET' && (url === '/v1/offers' || url === '/v1/offers/')) return await handleOffers(req, res);
    if (req.method === 'POST' && url === '/v1/messages/count_tokens') {
      const raw = await readBody(req).catch(() => Buffer.alloc(0));
      let n = 0;
      try { const b = JSON.parse(raw.toString('utf8')); n = JSON.stringify(b.messages || []).length; } catch { /* empty */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: Math.ceil(n / 3.6) }));
      return;
    }
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clientUp: !!(manager.client && manager.client.running), sessions: manager.listSessions().length }));
      return;
    }
    if (req.method === 'GET' && (url === '/' || url === '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service: 'zcode-anthropic-bridge', endpoints: ['/v1/messages', '/v1/models', '/v1/messages/count_tokens', '/v1/offpeak', '/v1/offers', '/healthz'] }));
      return;
    }
    facade.anthropicError(res, 404, 'not_found_error', `no such endpoint: ${req.method} ${url}`);
  } catch (e) {
    log('request failed', { url, error: e.message });
    try { facade.anthropicError(res, 500, 'api_error', e.message); } catch { /* ignore */ }
  }
});

setInterval(() => { manager.reapIdle(cfg.sessionIdleMs).then((n) => { if (n) log('reaped idle sessions', { n }); }).catch(() => {}); }, 5 * 60 * 1000).unref();

server.listen(cfg.port, cfg.bind, () => {
  log(`zcode-anthropic-bridge listening on http://${cfg.bind}:${cfg.port}`);
  log(`workspace: ${path.resolve(cfg.workspacePath)}  model: ${manager.defaultModel.providerId}/${manager.defaultModel.modelId}`);
  if (!cfg.apiKey) log('no API key configured — accepting all local requests (set ZCODE_BRIDGE_API_KEY or config.apiKey to require one)');
});

async function shutdown() {
  log('shutting down…');
  server.close();
  offPeak.stop();
  offers.stop();
  await manager.shutdown().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
