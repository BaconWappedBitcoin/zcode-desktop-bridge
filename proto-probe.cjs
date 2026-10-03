#!/usr/bin/env node
/**
 * proto-probe.cjs v2 — drive the ZCode Protocol app-server with the schemas
 * decoded from resources/glm/zcode.cjs.
 *
 * Confirmed so far:
 *  - No handshake: plain JSON-RPC {id, method, params} over stdio NDJSON.
 *  - session/create {workspace:{workspacePath, workspaceKey}, mode, ...}
 *  - session/send {sessionId, content}
 *  - session/subscribe {sessionId, deliveryKind?, afterSeq?, includeSnapshot?}
 *  - session/messages {sessionId, afterMessageId?, limit?}
 *  - session/stop {sessionId} / session/close {sessionId}
 *  - workspace/generateText {workspace, prompt|messages, querySource}
 *
 * Discovers empirically: event notification wire format, when session/send
 * resolves (accept vs turn-end), assistant message shape, server->client
 * request format.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}
const os = require('os');
const USER_DIR = os.homedir();
const EXE = arg('--exe', process.env.ZCODE_EXE || path.join(USER_DIR, 'AppData', 'Local', 'Programs', 'ZCode', 'ZCode.exe'));
const BUNDLE = arg('--bundle', process.env.ZCODE_BUNDLE || path.join(USER_DIR, 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
const WORKSPACE = path.resolve(arg('--workspace', path.join(__dirname, 'bridge-workspace')));

const OUT_DIR = path.join(__dirname, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
const TRANSCRIPT = path.join(OUT_DIR, 'probe-transcript.jsonl');
try { fs.writeFileSync(TRANSCRIPT, ''); } catch {}

const findings = { events: [], sendTimings: [] };
let child = null, exited = false;

function log(...a) { console.log('[probe]', ...a); }
function truncate(v, max = 4000) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + `…<+${s.length - max} chars>` : s;
}
function transcript(dir, msg) {
  try { fs.appendFileSync(TRANSCRIPT, JSON.stringify({ t: new Date().toISOString(), dir, msg: truncate(msg, 8000) }) + '\n'); } catch {}
}

// ---------------------------------------------------------------- plumbing
let nextId = 1;
const pending = new Map();
const listeners = [];

function startChild() {
  child = spawn(EXE, [BUNDLE, 'app-server', '--stdio', '--surface', 'desktop'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: WORKSPACE, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (d) => { const s = String(d).trim(); if (s) transcript('stderr', s); });
  child.on('exit', (code, signal) => {
    exited = true;
    log(`app-server exited code=${code} signal=${signal}`);
    for (const [, p] of pending) { try { p.reject(new Error(`app-server exited (code=${code})`)); } catch {} }
    pending.clear();
  });
}

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { transcript('stdout-unparseable', line); return; }
  transcript('recv', msg);
  if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(Object.assign(new Error(msg.error.message || 'RPC error'), { rpc: msg.error }))
                : p.resolve(msg.result);
      return;
    }
  }
  for (const h of listeners) { try { h(msg); } catch (e) { log('handler error:', e.message); } }
}

function send(msg) { transcript('send', msg); child.stdin.write(JSON.stringify(msg) + '\n'); }

function call(method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (exited || !child || !child.stdin.writable) return reject(new Error('app-server not running'));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout calling ${method} after ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, { resolve, reject, method, timer });
    send({ id, method, params });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- event watch
class EventWatch {
  constructor(label) {
    this.label = label;
    this.events = [];
    this.done = null;
    this.p = new Promise((r) => { this.done = r; });
    this.h = (msg) => this.push(msg);
    listeners.push(this.h);
  }
  push(msg) {
    // skip RPC responses; keep notifications + server->client requests
    if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) return;
    this.events.push({ t: Date.now(), msg });
    this.bump(this.graceMs); // any traffic extends the silence window
    const flat = JSON.stringify(msg);
    if (/turn\.terminal|"status":"(failed|completed)"/i.test(flat)) this.terminalSeen = true;
  }
  async end(waitMs = 8000, maxWaitMs = 5 * 60 * 1000) {
    // resolve after `waitMs` of silence (or immediately once a terminal event
    // has been seen and 3s pass), with a hard deadline of maxWaitMs.
    this.graceMs = waitMs;
    const started = Date.now();
    this.stopAt = Date.now() + waitMs;
    this.deadline = started + maxWaitMs;
    const timer = setInterval(() => {
      if (this.terminalSeen && Date.now() > (this.terminalAt ?? (this.terminalAt = Date.now() + 3000))) return this.finish();
      if (Date.now() >= this.stopAt || Date.now() >= this.deadline) this.finish();
    }, 250);
    await this.p;
    clearInterval(timer);
    const i = listeners.indexOf(this.h);
    if (i !== -1) listeners.splice(i, 1);
    return this.events;
  }
  bump(ms) { if (this.stopAt !== undefined) { this.stopAt = Date.now() + ms; if (Date.now() >= this.deadline) this.finish(); } }
  finish() { if (this.done) { const d = this.done; this.done = null; d(this.events); } }
}

function summarizeEvents(events, label) {
  const byKey = new Map();
  for (const { msg } of events) {
    const key = msg && (msg.method ? `method:${msg.method}` : msg.kind ? `kind:${msg.kind}` : `keys:${Object.keys(msg).join(',')}`);
    if (!byKey.has(key)) byKey.set(key, { count: 0, sample: msg });
    byKey.get(key).count++;
  }
  log(`--- ${label}: ${events.length} notifications, ${byKey.size} shapes ---`);
  for (const [key, { count, sample }] of byKey) {
    log(`  ${key} x${count}: ${truncate(sample, 500)}`);
  }
  findings.events.push({ label, shapes: [...byKey.entries()].map(([k, v]) => ({ key: k, count: v.count, sample: v.sample })) });
}

// ------------------------------------------------------------------- steps
const PROMPT1 = 'This is a protocol probe. Reply with exactly the token BRIDGE_PROBE_OK and nothing else. Do not use any tools.';
const PROMPT2 = 'Now reply with exactly BRIDGE_SECOND_OK and nothing else.';

function extractSessionId(r) {
  if (!r) return null;
  return r.session?.sessionId ?? r.sessionId ?? r.value?.sessionId ?? r.snapshot?.sessionId ?? (typeof r === 'string' ? r : null);
}

function readDefaultModel() {
  try {
    let s = fs.readFileSync(path.join(USER_DIR, '.zcode', 'v2', 'provider_config.json'), 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const j = JSON.parse(s);
    const d = j.config && j.config.defaultModelSelection;
    if (d && d.providerId && d.modelId) {
      return { providerId: d.providerId, modelId: d.modelId, ...(d.options ? { options: d.options } : { options: { reasoningLevel: 'high' } }) };
    }
  } catch (e) { log('readDefaultModel failed:', e.message); }
  return { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } };
}

function readCredentialsMap() {
  try {
    let s = fs.readFileSync(path.join(USER_DIR, '.zcode', 'v2', 'credentials.json'), 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch (e) { log('readCredentialsMap failed:', e.message); return {}; }
}
const CRED_PREFIX = 'enc:v1:';
function credSecret() {
  const t = process.env.ZCODE_CREDENTIAL_SECRET && process.env.ZCODE_CREDENTIAL_SECRET.trim();
  if (t) return t;
  let u = 'unknown';
  try { u = require('os').userInfo().username; } catch {}
  return `zcode-credential-fallback:${process.platform}:${require('os').homedir()}:${u}`;
}
function credDecrypt(v) {
  if (typeof v !== 'string' || !v.startsWith(CRED_PREFIX)) return v;
  const [a, l, u] = v.slice(CRED_PREFIX.length).split('.');
  const iv = Buffer.from(a, 'base64url'), tag = Buffer.from(l, 'base64url'), ct = Buffer.from(u, 'base64url');
  const key = crypto.createHash('sha256').update(credSecret()).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf-8');
}

function accountApiKey(providerId) {
  const c = readCredentialsMap();
  let identity = c[`account-provider:${providerId}:identity`];
  if (!identity) return null;
  try { identity = credDecrypt(identity).trim(); } catch (e) { log('identity decrypt failed:', e.message); return null; }
  const enc = c[`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`];
  if (!enc) return null;
  try { return credDecrypt(enc); } catch (e) { log('api-key decrypt failed:', e.message); return null; }
}

function computeBuiltinRevision() {
  // The worker's registry CAS-compares basedOnZCodeBuiltinRevision against
  // `zcode-builtin:<fileRevision>:<sha256(path.resolve(activePath))>` where
  // activePath is the runtime-cached zcode-builtin.json. Verified against the
  // live worker's own accountRevision telemetry.
  try {
    const cryptoMod = require('crypto');
    const base = path.join(USER_DIR, '.zcode', 'v2', 'runtime', 'provider', 'windows-x86_64');
    const versions = fs.readdirSync(base).filter((d) => {
      try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
    }).sort((a, b) => (a === '3.14.4' ? -1 : b === '3.14.4' ? 1 : 0));
    for (const ver of versions) {
      const dir = path.join(base, ver);
      for (const ep of fs.readdirSync(dir)) {
        if (!ep.startsWith('endpoint-')) continue;
        const f = path.join(dir, ep, 'zcode-builtin.json');
        if (!fs.existsSync(f)) continue;
        let s = fs.readFileSync(f, 'utf8');
        if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        const rev = JSON.parse(s).revision;
        const hash = cryptoMod.createHash('sha256').update(path.resolve(f)).digest('hex');
        return `zcode-builtin:${rev}:${hash}`;
      }
    }
  } catch (e) { log('computeBuiltinRevision failed:', e.message); }
  return null;
}

async function main() {
  const overall = setTimeout(() => { log('OVERALL TIMEOUT'); try { child.kill(); } catch {}; process.exit(2); }, 8 * 60 * 1000);

  log('spawning app-server…');
  startChild();
  await sleep(2500);

  // Auto-respond to server->client requests (runtime preferences, permissions).
  // Server->client requests arrive as {id:"server-N", method, params}.
  const RUNTIME_PREFS = {
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: true,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1',
  };
  listeners.push((msg) => {
    if (msg && typeof msg.id === 'string' && typeof msg.method === 'string' && msg.result === undefined && msg.error === undefined) {
      log('>>> SERVER->CLIENT REQUEST:', truncate(msg, 1200));
      findings.serverRequests = findings.serverRequests || [];
      findings.serverRequests.push(msg);
      let result;
      if (msg.method === 'session/requestRuntimePreferences') result = RUNTIME_PREFS;
      else if (msg.method === 'interaction/requestPermission') result = { decision: 'allow' };
      else if (msg.method === 'interaction/requestUserInput') result = { cancelled: true };
      else if (msg.method === 'interaction/requestProviderRuntimeHeaders') {
        const key = accountApiKey(String(msg.params?.providerId || readDefaultModel().providerId));
        result = key ? { headersApplied: true, requestAuth: { apiKey: key } } : { headersApplied: false };
      }
      else result = { decision: 'allow' };
      send({ id: msg.id, result });
      const safe = msg.method === 'interaction/requestProviderRuntimeHeaders'
        ? { ...(result || {}), requestAuth: result && result.requestAuth ? { apiKey: '<redacted>' } : undefined }
        : result;
      log(`<<< replied to ${msg.method}:`, truncate(safe, 300));
    }
  });

  // 1. liveness
  const caps = await call('runtime/capabilities', {}, 30000);
  log('runtime/capabilities:', JSON.stringify(caps));

  // 1b. push account provider config (worker-mode app-servers start unentitled;
  //     the desktop host does this same push after spawn)
  const wanted2 = readDefaultModel();
  if (wanted2.providerId && wanted2.providerId.startsWith('account:')) {
    const basedOn = computeBuiltinRevision();
    log(`basedOnZCodeBuiltinRevision = ${basedOn}`);
    const push = {
      revision: `bridge-${Date.now()}`,
      basedOnZCodeBuiltinRevision: basedOn || 'zcode-builtin:30:unknown',
      providers: {
        [wanted2.providerId]: { access: { type: 'zhipu-account', entitled: true } },
      },
      states: { [wanted2.providerId]: { availability: 'available', entitled: true, current: true } },
    };
    try {
      const r = await call('provider/updateAccountConfig', push, 20000);
      log('provider/updateAccountConfig OK:', JSON.stringify(r));
    } catch (e) { log('provider/updateAccountConfig failed:', e.message, e.rpc ? truncate(e.rpc, 500) : ''); }
  }

  // 2. session list (workspace-filtered)
  try {
    const sl = await call('session/list', { workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE }, limit: 5 }, 15000);
    log('session/list OK:', truncate(sl, 600));
  } catch (e) { log('session/list(filtered) failed:', e.message, e.rpc ? truncate(e.rpc.data || e.rpc, 400) : ''); }

  // 3. create session in yolo mode WITH model selection (worker sessions have
  //    no implicit default; selection must be explicit after the account push)
  const created = await call('session/create', {
    workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE },
    mode: 'yolo',
    model: readDefaultModel(),
    titleGenerationEnabled: false,
  }, 60000);
  log('session/create OK. Top-level keys:', Object.keys(created || {}));
  log('session/create result:', truncate(created, 1500));
  const sessionId = extractSessionId(created);
  if (!sessionId) throw new Error('could not find sessionId in create result: ' + truncate(created, 500));
  findings.sessionId = sessionId;
  log('sessionId =', sessionId);

  // 3b. poll for the model registry to populate (standalone account sync is async)
  const wanted = readDefaultModel();
  let models = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const snap = await call('session/read', { sessionId }, 15000);
      models = (snap.settings && snap.settings.model && snap.settings.model.available) || [];
      if (models.length) break;
    } catch (e) { log('session/read failed:', e.message, e.rpc ? truncate(e.rpc, 200) : ''); break; }
    log(`waiting for model registry… (${attempt + 1})`);
    await sleep(3000);
  }
  log('models available:', JSON.stringify(models).slice(0, 1200));
  findings.modelsAvailable = models;

  // 3c. choose a model: prefer the configured default, else first entry
  const pick = models.find((m) => m.ref && m.ref.providerId === wanted.providerId && m.ref.modelId === wanted.modelId)
    || models.find((m) => m.ref && m.ref.providerId === wanted.providerId)
    || models[0];
  if (pick) {
    const level = (pick.reasoning && pick.reasoning.defaultLevel) || 'high';
    log('setting model:', pick.ref && `${pick.ref.providerId}/${pick.ref.modelId}`, 'reasoning:', level);
    try {
      const r = await call('session/setModel', {
        sessionId,
        model: { providerId: pick.ref.providerId, modelId: pick.ref.modelId, options: { reasoningLevel: level } },
      }, 20000);
      log('session/setModel OK:', truncate(r, 400));
    } catch (e) { log('session/setModel failed:', e.message, e.rpc ? truncate(e.rpc, 300) : ''); }
  } else {
    log('NO MODELS AVAILABLE — will send anyway to observe the failure mode');
  }

  // 4. subscribe BEFORE sending (deliveryKind required)
  try {
    const sub = await call('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, 15000);
    log('session/subscribe OK:', truncate(sub, 600));
    findings.subscribe = sub;
  } catch (e) { log('session/subscribe failed:', e.message, e.rpc ? truncate(e.rpc, 400) : ''); }

  // 5. first turn; observe when the send response resolves + event stream
  const watch1 = new EventWatch('turn1');
  const t0 = Date.now();
  const sendP = call('session/send', { sessionId, content: PROMPT1 }, 4 * 60 * 1000);
  const sendResolved = { done: false };
  sendP.then((r) => {
    sendResolved.done = true;
    findings.sendTimings.push({ turn: 1, ms: Date.now() - t0, resolvedAtTurnEnd: null });
    log(`session/send[1] RESOLVED after ${Date.now() - t0}ms:`, truncate(r, 900));
  }).catch((e) => log(`session/send[1] FAILED after ${Date.now() - t0}ms:`, e.message, e.rpc ? truncate(e.rpc, 500) : ''));
  // let turn run; keep watching until 12s of silence after send resolves
  await sleep(3000);
  while (!sendResolved.done && Date.now() - t0 < 3 * 60 * 1000) await sleep(2000);
  const ev1 = await watch1.end(12000);
  watch1.finish();
  summarizeEvents(ev1, 'turn1');
  const send1 = await sendP;

  // 6. messages shape
  try {
    const msgs = await call('session/messages', { sessionId, limit: 8 }, 15000);
    log('session/messages OK. count:', msgs.messages?.length);
    for (const m of (msgs.messages || []).slice(-4)) log('  msg:', truncate(m, 700));
    findings.messages1 = msgs;
  } catch (e) { log('session/messages failed:', e.message, e.rpc ? truncate(e.rpc, 400) : ''); }

  // 7. second turn on same session
  const watch2 = new EventWatch('turn2');
  const t1 = Date.now();
  try {
    const r2 = await call('session/send', { sessionId, content: PROMPT2 }, 4 * 60 * 1000);
    log(`session/send[2] took ${Date.now() - t1}ms:`, truncate(r2, 700));
  } catch (e) { log('session/send[2] failed:', e.message, e.rpc ? truncate(e.rpc, 500) : ''); }
  const ev2 = await watch2.end(10000);
  watch2.finish();
  summarizeEvents(ev2, 'turn2');

  try {
    const msgs2 = await call('session/messages', { sessionId, limit: 4 }, 15000);
    for (const m of (msgs2.messages || []).slice(-2)) log('  msg2:', truncate(m, 700));
    findings.messages2 = msgs2;
  } catch (e) { log('session/messages[2] failed:', e.message); }

  // 8. workspace/generateText (non-agent path)
  for (const [name, params] of [
    ['prompt', { workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE }, prompt: 'Say OK.', querySource: 'bridge-probe' }],
    ['messages', { workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE }, messages: [{ role: 'user', content: 'Say OK.' }], querySource: 'bridge-probe' }],
  ]) {
    try {
      const r = await call('workspace/generateText', params, 90000);
      log(`workspace/generateText[${name}] OK:`, truncate(r, 800));
      findings.generateText = { variant: name, result: r };
      break;
    } catch (e) { log(`workspace/generateText[${name}] failed:`, e.message, e.rpc ? truncate(e.rpc.data || e.rpc, 500) : ''); }
  }

  // 9. stop + close
  try { await call('session/stop', { sessionId }, 10000); log('session/stop OK'); } catch (e) { log('session/stop:', e.message); }
  try { const c = await call('session/close', { sessionId }, 10000); log('session/close OK:', JSON.stringify(c)); } catch (e) { log('session/close:', e.message); }

  clearTimeout(overall);
  fs.writeFileSync(path.join(OUT_DIR, 'probe-summary.json'), JSON.stringify(findings, null, 2));
  log('=== DONE ===');
  log('sessionId:', findings.sessionId);
  try { child.kill(); } catch {}
  await sleep(500);
  process.exit(0);
}

main().catch((e) => {
  log('FATAL:', e && e.stack || e);
  try { fs.writeFileSync(path.join(OUT_DIR, 'probe-summary.json'), JSON.stringify(findings, null, 2)); } catch {}
  try { child.kill(); } catch {}
  process.exit(1);
});
