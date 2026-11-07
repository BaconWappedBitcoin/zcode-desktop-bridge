#!/usr/bin/env node
'use strict';
/** test/model-selection.cjs — default/override model resolution and account activation with a
 *  personal (API-key) default provider, over a scripted fake protocol client. No harness, no network.
 *  Style follows test/plan-router.cjs: PASS/FAIL lines, exit 1 on any failure. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + (extra || '')}`);
  if (!cond) failures += 1;
}

const PLAN = 'account:zai-individual-coding-plan';
const PERSONAL = 'personal-0000';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-models-'));
const saved = { ZCODE_HOME: process.env.ZCODE_HOME, ZCODE_BUILTIN_FILE: process.env.ZCODE_BUILTIN_FILE, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE };
delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
process.env.ZCODE_HOME = path.join(root, '.zcode');
process.env.ZCODE_BUILTIN_FILE = path.join(root, 'zcode-builtin.json');
fs.writeFileSync(process.env.ZCODE_BUILTIN_FILE, JSON.stringify({ revision: 43 }));
fs.mkdirSync(path.join(process.env.ZCODE_HOME, 'v2'), { recursive: true });
const credFile = path.join(process.env.ZCODE_HOME, 'v2', 'credentials.json');
const setPlanCredentials = (on) => fs.writeFileSync(credFile, JSON.stringify(on
  ? { [`account-provider:coding-plan:${PLAN}:account:acct-1:api-key`]: 'unused-in-this-test' } : {}));

// The manager caches the winning revision under <repo>/out; keep the real cache untouched.
const cacheFile = path.join(__dirname, '..', 'out', '.builtin-revision.json');
const cacheBefore = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile) : null;

const { AgentManager } = require('../lib/agent-manager.cjs');

/** Registry stand-in: the personal provider is always listed; the plan only after an entitling push. */
class FakeClient extends EventEmitter {
  constructor({ entitleOnPush = true } = {}) {
    super();
    this.running = true;
    this.entitleOnPush = entitleOnPush;
    this.entitled = false;
    this.pushes = [];
    this.closed = [];
    this.seq = 0;
  }
  async pushAccountConfig(pids, basedOn) {
    this.pushes.push({ pids, basedOn });
    if (this.entitleOnPush) this.entitled = true;
    return { status: 'received' };
  }
  async call(method, params) {
    if (method === 'session/create') {
      this.seq += 1;
      const lv = { levels: [{ value: 'high' }, { value: 'max' }], defaultLevel: 'max' };
      const available = [{ ref: { providerId: PERSONAL, modelId: 'deepseek-v4-pro' }, reasoning: lv }];
      if (this.entitled) available.unshift({ ref: { providerId: PLAN, modelId: 'GLM-5.3' }, reasoning: lv });
      return { session: { sessionId: `s-${this.seq}` }, settings: { model: { available } } };
    }
    if (method === 'session/close') this.closed.push(params.sessionId);
    return {};
  }
}

function makeManager(model, clientOpts) {
  const dir = fs.mkdtempSync(path.join(root, 'm-'));
  fs.writeFileSync(path.join(dir, 'ZCode.exe'), '');
  fs.writeFileSync(path.join(dir, 'zcode.cjs'), '');
  const mgr = new AgentManager({
    zcodeExe: path.join(dir, 'ZCode.exe'), zcodeBundle: path.join(dir, 'zcode.cjs'),
    workspacePath: path.join(dir, 'ws'), statusDir: path.join(dir, 'out', 'sessions'), model,
  }, () => {});
  const fake = new FakeClient(clientOpts);
  mgr.ensureClient = async () => fake;
  mgr.client = fake;
  return { mgr, fake };
}

(async () => {
  // 1. Personal default + plan credentials: plans still get entitled; the session runs on the default.
  setPlanCredentials(true);
  let { mgr, fake } = makeManager({ providerId: PERSONAL, modelId: 'deepseek-v4-pro' });
  const c1 = await mgr.createSession({});
  check('personal default: session uses the personal provider', c1.model.providerId === PERSONAL && c1.model.modelId === 'deepseek-v4-pro', JSON.stringify(c1.model));
  check('personal default: credentialed plan is pushed anyway', fake.pushes.length >= 1 && fake.pushes[0].pids.includes(PLAN), JSON.stringify(fake.pushes));
  check('personal default: plan models are listed after activation', c1.models.some((m) => m.ref.providerId === PLAN));
  check('personal default: model default level comes from the catalog', c1.model.options.reasoningLevel === 'max');
  const sel = await mgr.resolveModelSelection('GLM-5.3');
  check('per-call override "GLM-5.3" resolves to the plan', sel.providerId === PLAN && sel.modelId === 'GLM-5.3', JSON.stringify(sel));

  // 2. Personal default, no plan credentials: nothing to push.
  setPlanCredentials(false);
  ({ mgr, fake } = makeManager({ providerId: PERSONAL, modelId: 'deepseek-v4-pro' }));
  const c2 = await mgr.createSession({});
  check('no plan credentials: no account push', fake.pushes.length === 0, JSON.stringify(fake.pushes));
  check('no plan credentials: session still on the personal provider', c2.model.providerId === PERSONAL);

  // 3. Plan default whose activation fails: never run on another provider.
  setPlanCredentials(true);
  ({ mgr, fake } = makeManager({ providerId: PLAN, modelId: 'GLM-5.3' }, { entitleOnPush: false }));
  let err = null;
  try { await mgr.createSession({}); } catch (e) { err = e; }
  check('missing default provider: createSession throws', !!err && /not available/.test(err.message), err && err.message);
  check('missing default provider: error lists what is available', !!err && err.message.includes(`${PERSONAL}/deepseek-v4-pro`), err && err.message);
  // (activation's own verification sessions are closed too; the last created one is createSession's)
  check('missing default provider: the half-made session is closed', fake.closed.includes(`s-${fake.seq}`) && mgr.sessions.size === 0, JSON.stringify(fake.closed));

  // 4. zcode_models must still read the catalog in that state (it runs no turn).
  const models = await mgr.listModels();
  check('listModels works without the default provider', models.some((m) => m.ref.providerId === PERSONAL), JSON.stringify(models.map((m) => m.ref)));

  // ------------------------------------------------------------------ cleanup
  if (cacheBefore) fs.writeFileSync(cacheFile, cacheBefore); else { try { fs.unlinkSync(cacheFile); } catch { /* none */ } }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  console.log(failures ? `${failures} FAILED` : 'ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test error:', e); process.exit(1); });
