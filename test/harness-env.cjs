#!/usr/bin/env node
'use strict';
/** test/harness-env.cjs — install-layout and credential-store compatibility (ZCode 3.14 → 3.17).
 *  Fake install dirs and a fake credential store under os.tmpdir(); no harness, no network.
 *  Style follows test/plan-router.cjs: PASS/FAIL lines, exit 1 on any failure. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + (extra || '')}`);
  if (!cond) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zbridge-henv-'));
const home = path.join(root, 'home', '.zcode');
const SECRET = 'test-secret';
const saved = {};
for (const k of ['ZCODE_HOME', 'ZCODE_CREDENTIAL_SECRET', 'ZCODE_BUILTIN_FILE', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']) {
  saved[k] = process.env[k];
  delete process.env[k];
}
process.env.ZCODE_HOME = home;
process.env.ZCODE_CREDENTIAL_SECRET = SECRET;
const henv = require('../lib/harness-env.cjs');

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}
/** enc:v1:<iv>.<tag>.<ct> — the harness envelope credDecrypt reads. */
function enc(plain) {
  const key = crypto.createHash('sha256').update(SECRET).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
const composite = (file, rev) => `zcode-builtin:${rev}:${crypto.createHash('sha256').update(path.resolve(file)).digest('hex')}`;

// ------------------------------------------------------------ install layouts
// >= 3.16: built-in config packaged at <resources>/config/provider, not next to the bundle.
const newBundle = write(path.join(root, 'new', 'resources', 'glm', 'zcode.cjs'), '');
const newBuiltin = write(path.join(root, 'new', 'resources', 'config', 'provider', 'zcode-builtin.json'), { revision: 43 });
// <= 3.15: built-in config next to the bundle; the CLI finds it itself.
const oldBundle = write(path.join(root, 'old', 'resources', 'glm', 'zcode.cjs'), '');
write(path.join(root, 'old', 'resources', 'glm', 'provider', 'zcode-builtin.json'), { revision: 30 });
write(path.join(root, 'old', 'resources', 'config', 'provider', 'zcode-builtin.json'), { revision: 30 });

let env = henv.providerRuntimeEnv(newBundle);
check('3.16+ layout: built-in config path handed to the app-server', env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === newBuiltin, JSON.stringify(env));
check('3.16+ layout: personal config set alongside it (runtime requires both)',
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE === path.join(home, 'v2', 'provider_config.json'), JSON.stringify(env));

env = henv.providerRuntimeEnv(oldBundle);
check('pre-3.16 layout: no extra env (CLI resolves its bundled file)', Object.keys(env).length === 0, JSON.stringify(env));

check('no built-in file anywhere: no extra env',
  Object.keys(henv.providerRuntimeEnv(path.join(root, 'none', 'resources', 'glm', 'zcode.cjs'))).length === 0);

process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = path.join(root, 'custom', 'builtin.json');
env = henv.providerRuntimeEnv(oldBundle);
check('explicit ZCODE_BUILTIN_PROVIDER_CONFIG_FILE always wins and keeps its partner',
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && !!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, JSON.stringify(env));
process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(root, 'custom', 'personal.json');
env = henv.providerRuntimeEnv(oldBundle);
check('explicit ZCODE_PERSONAL_PROVIDER_CONFIG_FILE is kept', env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE === process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE);
delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;

// ------------------------------------------------- CAS revision candidates
const cacheFile = write(path.join(home, 'v2', 'runtime', 'provider',
  `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch}`,
  '3.14.1', 'endpoint-abc', 'zcode-builtin.json'), { revision: 30 });
let cands = henv.builtinRevisionCandidates({ bundle: newBundle });
check('3.16+: packaged file composite is the first candidate', cands[0] === composite(newBuiltin, 43), JSON.stringify(cands));
check('3.16+: runtime-cache candidates still follow', cands.includes(composite(cacheFile, 30)), JSON.stringify(cands));
cands = henv.builtinRevisionCandidates({ bundle: oldBundle });
check('pre-3.16: no packaged candidate, runtime cache only', cands.length === 1 && cands[0] === composite(cacheFile, 30), JSON.stringify(cands));
check('no bundle given: runtime cache only (old call signature)', henv.builtinRevisionCandidates().length === 1);
process.env.ZCODE_BUILTIN_FILE = cacheFile;
cands = henv.builtinRevisionCandidates({ bundle: newBundle });
check('ZCODE_BUILTIN_FILE override stays first', cands[0] === composite(cacheFile, 30) && cands[1] === composite(newBuiltin, 43), JSON.stringify(cands));
delete process.env.ZCODE_BUILTIN_FILE;

// ------------------------------------------------------- credential layouts
const PID = 'account:zai-individual-coding-plan';
const credFile = path.join(home, 'v2', 'credentials.json');
const keyName = (id) => `account-provider:coding-plan:${PID}:account:${encodeURIComponent(id)}:api-key`;

// <= 3.16: identity entry + api-key entry indexed by the decrypted identity.
write(credFile, { [`account-provider:${PID}:identity`]: enc('user@example.com'), [keyName('user@example.com')]: enc('key-legacy') });
check('legacy layout (identity entry): api key resolved', henv.accountApiKey(PID) === 'key-legacy');

// 3.17: no identity entry; the account id appears only in the api-key entry's name.
write(credFile, { [keyName('43ecd172-59a8-4f90-8209-a27038085288')]: enc('key-317'), zcodejwttoken: enc('jwt') });
check('3.17 layout (no identity entry): api key resolved from the key name', henv.accountApiKey(PID) === 'key-317');
check('3.17 layout: listPlanCredentials still sees the plan', henv.listPlanCredentials().some((p) => p.providerId === PID));
check('unknown plan: null', henv.accountApiKey('account:zai-team-coding-plan') === null);

// Two accounts for the same plan and no identity entry: ambiguous, never guess.
write(credFile, { [keyName('acct-a')]: enc('key-a'), [keyName('acct-b')]: enc('key-b') });
check('ambiguous accounts without identity entry: null', henv.accountApiKey(PID) === null);

// Identity entry present but its key missing: falls back to the single key by name.
write(credFile, { [`account-provider:${PID}:identity`]: enc('gone@example.com'), [keyName('acct-c')]: enc('key-c') });
check('stale identity entry: falls back to the only key for the plan', henv.accountApiKey(PID) === 'key-c');

// ------------------------------------------------------------------ cleanup
for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
