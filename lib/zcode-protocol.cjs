'use strict';
/**
 * zcode-protocol.cjs — client for the ZCode Protocol app-server.
 *
 * The desktop harness drives agents through one app-server child per
 * connection: `ELECTRON_RUN_AS_NODE=1 ZCode.exe zcode.cjs app-server --stdio`.
 * The wire format is newline-delimited JSON-RPC: requests {id, method, params},
 * responses {id, result|error}, notifications {method, params}, plus
 * server->client requests ({id:"server-N", method, params}) that the desktop
 * host answers for account/auth/permission needs. This module replays exactly
 * what the desktop host does so the app-server behaves identically for us.
 */
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const harnessEnv = require('./harness-env.cjs');

const RUNTIME_PREFS = {
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: true,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
};

class ProtocolError extends Error {
  constructor(message, rpc) {
    super(message);
    this.name = 'ProtocolError';
    this.rpc = rpc; // {code, message, data}
    this.code = rpc && rpc.code;
  }
}

class ZCodeProtocolClient extends EventEmitter {
  /**
   * opts: { exe, bundle, surface, workspacePath, requestTimeoutMs, logger,
   *         permissionPolicy ('allow'|'deny'), runtimePrefs }
   */
  constructor(opts = {}) {
    super();
    this.exe = opts.exe;
    this.bundle = opts.bundle;
    this.surface = opts.surface || 'desktop';
    this.workspacePath = opts.workspacePath || process.cwd();
    this.requestTimeoutMs = opts.requestTimeoutMs || 120000;
    this.permissionPolicy = opts.permissionPolicy || 'allow';
    this.runtimePrefs = Object.assign({}, RUNTIME_PREFS, opts.runtimePrefs || {});
    this.log = opts.logger || (() => {});
       this.child = null;
    this.exited = false;
    this.nextId = 1;
    this.pending = new Map();
    this.lineBuf = '';
    this.stderrTail = [];
    this._serverRequestHandler = (msg) => this._onServerRequest(msg);
  }

  get running() { return !this.exited && this.child && this.child.stdin && this.child.stdin.writable; }

  async start() {
    if (this.running) return;
    this.exited = false;
    this.log('spawning app-server', { exe: this.exe, surface: this.surface, cwd: this.workspacePath });
    this.child = spawn(this.exe, [this.bundle, 'app-server', '--stdio', '--surface', this.surface], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      cwd: this.workspacePath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this._onStdout(d));
    this.child.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (!s) return;
      this.stderrTail.push(s.slice(-2000));
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      const err = new Error(`app-server exited (code=${code} signal=${signal})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.emit('exit', err);
    });
    this.on('server-request', this._serverRequestHandler);
    // Boot: wait until the server answers a ping. It emits startup/storageState
    // notifications for ~1-10s while opening its SQLite store first.
    await this._waitReady();
  }

  async _waitReady() {
    const deadline = Date.now() + 60000;
    let delay = 250;
    while (Date.now() < deadline) {
      if (!this.running) throw new Error('app-server died during startup');
      try {
        await this.call('runtime/capabilities', {}, 15000);
        return;
      } catch (e) {
        if (e instanceof ProtocolError) throw e; // server is up and talking
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 2000);
      }
    }
    throw new Error('app-server did not become ready within 60s');
  }

  _onStdout(d) {
    this.lineBuf += d;
    let i;
    while ((i = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, i).trim();
      this.lineBuf = this.lineBuf.slice(i + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new ProtocolError(msg.error.message || 'RPC error', msg.error));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg && typeof msg.method === 'string' && typeof msg.id === 'string') {
      this.emit('server-request', msg); // server->client request
      return;
    }
    this.emit('notification', msg);
  }

  send(obj) {
    if (!this.running) throw new Error('app-server not running');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  call(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.running) return reject(new Error('app-server not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout calling ${method} after ${timeoutMs || this.requestTimeoutMs}ms`));
      }, timeoutMs || this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async stop() {
    if (!this.child) return;
    const c = this.child;
    this.exited = true;
    try { c.kill(); } catch { /* already gone */ }
    await new Promise((r) => { c.once('exit', r); setTimeout(r, 3000); });
  }

  // -------------------------------------------------------------------------
  // Server->client requests (what the desktop host normally answers)
  // -------------------------------------------------------------------------
  _onServerRequest(msg) {
    // offPeak/create|list are host-side requests (the agent's OffPeakCreate /
    // OffPeakList tools forward here). The desktop answers from its task
    // service; we answer from the bridge's OffPeakManager. Without one
    // attached we fail exactly like the desktop without its service:
    // -32601 "service unavailable".
    if (msg.method === 'offPeak/create' || msg.method === 'offPeak/list') {
      const respond = (result) => {
        try { this.send({ id: msg.id, result }); }
        catch (e) { this.log('failed to answer offPeak request', { method: msg.method, error: e.message }); }
      };
      const respondErr = (err, code) => {
        try { this.send({ id: msg.id, error: { code: code || -32603, message: String(err && err.message || err) } }); }
        catch (e) { this.log('failed to answer offPeak request', { method: msg.method, error: e.message }); }
      };
      if (!this.offPeakHandler) {
        return respondErr(new Error('Off-peak task service is unavailable on this host'), -32601);
      }
      Promise.resolve()
        .then(() => this.offPeakHandler(msg.method, msg.params || {}))
        .then(respond, respondErr);
      return;
    }
    let result;
    switch (msg.method) {
      case 'session/requestRuntimePreferences':
        result = this.runtimePrefs;
        break;
      case 'interaction/requestProviderRuntimeHeaders': {
        const providerId = (msg.params && (msg.params.providerId
          || (msg.params.modelSelection && msg.params.modelSelection.providerId))) || '';
        const apiKey = providerId ? harnessEnv.accountApiKey(providerId) : null;
        this.log('provider runtime headers request', { providerId, ok: !!apiKey });
        result = apiKey ? { headersApplied: true, requestAuth: { apiKey } } : { headersApplied: false };
        break;
      }
      case 'interaction/requestPermission':
        result = { decision: this.permissionPolicy === 'deny' ? 'deny' : 'allow' };
        break;
      case 'interaction/requestUserInput':
        result = { cancelled: true };
        break;
      case 'interaction/requestOfficialMcpAuthHeaders':
        result = { decision: 'allow' };
        break;
      default:
        result = { decision: 'allow' };
    }
    try { this.send({ id: msg.id, result }); } catch (e) { this.log('failed to answer server request', { method: msg.method, error: e.message }); }
  }

  // -------------------------------------------------------------------------
  // Account push: worker app-servers start with account providers
  // unentitled; the desktop host pushes entitlement after spawn. The registry
  // CAS-checks basedOnZCodeBuiltinRevision — the agent-manager retries over
  // candidate composites and verifies via a real session snapshot.
  // `providerIds` may be a single id or a list (entitle every plan this
  // machine holds credentials for, so plan switching never drops one).
  // -------------------------------------------------------------------------
  async pushAccountConfig(providerIds, basedOnZCodeBuiltinRevision) {
    const list = Array.isArray(providerIds) ? providerIds : [providerIds];
    const providers = {};
    const states = {};
    for (const pid of list) {
      providers[pid] = { access: { type: 'zhipu-account', entitled: true } };
      states[pid] = { availability: 'available', entitled: true, current: true };
    }
    const r = await this.call('provider/updateAccountConfig', {
      revision: `bridge-${Date.now()}`,
      basedOnZCodeBuiltinRevision,
      providers,
      states,
    }, 20000);
    return r; // {receivedRevision, providerCount, status}
  }
}

module.exports = { ZCodeProtocolClient, ProtocolError, RUNTIME_PREFS };
