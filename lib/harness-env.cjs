'use strict';
/**
 * harness-env.cjs — machine integration for the ZCode Windows harness.
 *
 * Locates the installed harness (ZCode.exe + the glm agent bundle), reads the
 * harness's own configuration (~/.zcode), computes the provider-registry CAS
 * revision the app-server expects, and decrypts the coding-plan API key from
 * the harness credential store (AES-256-GCM, "enc:v1:" envelope — the same
 * scheme the CLI itself uses, so no secrets ever leave this process except to
 * the app-server over its stdio pipe).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function zcodeDir() {
  return process.env.ZCODE_DIR || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode');
}

function locateHarness(cfg = {}) {
  const dir = cfg.zcodeDir || zcodeDir();
  const exe = cfg.zcodeExe || process.env.ZCODE_EXE || path.join(dir, 'ZCode.exe');
  const bundle = cfg.zcodeBundle || process.env.ZCODE_BUNDLE || path.join(dir, 'resources', 'glm', 'zcode.cjs');
  if (!fs.existsSync(exe)) throw new Error(`ZCode.exe not found at ${exe} (set ZCODE_EXE)`);
  if (!fs.existsSync(bundle)) throw new Error(`zcode.cjs not found at ${bundle} (set ZCODE_BUNDLE)`);
  return { exe, bundle };
}

function readJsonBomSafe(p) {
  let s = fs.readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return JSON.parse(s);
}

function zcodeHome() {
  return process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
}

/** Default model selection from the desktop app's provider config. */
function readDefaultModel() {
  const fallback = { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } };
  try {
    const j = readJsonBomSafe(path.join(zcodeHome(), 'v2', 'provider_config.json'));
    const d = j.config && j.config.defaultModelSelection;
    if (d && d.providerId && d.modelId) {
      return { providerId: d.providerId, modelId: d.modelId, options: d.options || { reasoningLevel: 'high' } };
    }
  } catch { /* fall through */ }
  return fallback;
}

/**
 * The app-server's registry compares basedOnZCodeBuiltinRevision against
 * `zcode-builtin:<fileRevision>:<sha256(path.resolve(activePath))>`. The active
 * file is the runtime-cached registry the desktop refreshes. We compute the
 * same composite for each candidate (version dirs, newest-first) and let the
 * caller retry the push per candidate if needed.
 */
function builtinRevisionCandidates() {
  const out = [];
  if (process.env.ZCODE_BUILTIN_FILE) {
    out.push(compositeFor(process.env.ZCODE_BUILTIN_FILE));
  }
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : process.arch;
  const base = path.join(zcodeHome(), 'v2', 'runtime', 'provider', `${process.platform === 'win32' ? 'windows' : process.platform}-${arch}`);
  let versions = [];
  try { versions = fs.readdirSync(base).filter((d) => { try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; } }); }
  catch { return out.filter(Boolean); }
  // Prefer concrete versions over "0.0.0-dev", newest first.
  versions.sort((a, b) => (a === '0.0.0-dev' ? 1 : b === '0.0.0-dev' ? -1 : b.localeCompare(a, undefined, { numeric: true })));
  for (const ver of versions) {
    const dir = path.join(base, ver);
    let endpoints = [];
    try { endpoints = fs.readdirSync(dir).filter((d) => d.startsWith('endpoint-')); } catch { continue; }
    for (const ep of endpoints) {
      const f = path.join(dir, ep, 'zcode-builtin.json');
      if (fs.existsSync(f)) out.push(compositeFor(f));
    }
  }
  return out.filter(Boolean);
}

function compositeFor(file) {
  try {
    const j = readJsonBomSafe(file);
    const hash = crypto.createHash('sha256').update(path.resolve(file)).digest('hex');
    return `zcode-builtin:${j.revision}:${hash}`;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Credential store ("enc:v1:" = aes-256-gcm(iv 12 | tag 16 | ct), key =
// sha256(secret); secret = $ZCODE_CREDENTIAL_SECRET or the deterministic
// fallback the CLI uses on this machine).
// ---------------------------------------------------------------------------
const CRED_PREFIX = 'enc:v1:';

function credSecret() {
  const t = process.env.ZCODE_CREDENTIAL_SECRET && process.env.ZCODE_CREDENTIAL_SECRET.trim();
  if (t) return t;
  let u = 'unknown';
  try { u = os.userInfo().username; } catch { /* keep 'unknown' */ }
  return `zcode-credential-fallback:${process.platform}:${os.homedir()}:${u}`;
}

function credDecrypt(v) {
  if (typeof v !== 'string' || !v.startsWith(CRED_PREFIX)) return v;
  const parts = v.slice(CRED_PREFIX.length).split('.');
  const [a, l, u] = parts;
  if (!a || !l || !u || parts.length !== 3) throw new Error('credential: invalid ciphertext format');
  const iv = Buffer.from(a, 'base64url');
  const tag = Buffer.from(l, 'base64url');
  const ct = Buffer.from(u, 'base64url');
  const key = crypto.createHash('sha256').update(credSecret()).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf-8');
}

function readCredentials() {
  try { return readJsonBomSafe(path.join(zcodeHome(), 'v2', 'credentials.json')); }
  catch { return {}; }
}

/** The zcode account JWT ("zcodejwttoken"), decrypted. Used by off-peak. */
function readZcodeJwt() {
  const raw = readCredentials()['zcodejwttoken'];
  if (!raw) return null;
  const jwt = credDecrypt(raw).trim();
  return jwt ? jwt.replace(/^Bearer\s+/i, '') : null;
}

/**
 * Resolve the coding-plan API key for an account provider. The api-key entry
 * is indexed by the *decrypted* account identity, exactly like the CLI's
 * standalone account resolver does.
 */
function accountApiKey(providerId) {
  const c = readCredentials();
  let identity = c[`account-provider:${providerId}:identity`];
  if (!identity) return null;
  try { identity = credDecrypt(identity).trim(); } catch { return null; }
  const enc = c[`account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`];
  if (!enc) return null;
  try { return credDecrypt(enc); } catch { return null; }
}

/**
 * Scan the credential store for every plan materialized on this machine.
 * Key shape: account-provider:coding-plan:<providerId>:account:<identity>:api-key
 * where <providerId> itself contains colons (e.g. "account:zai-individual-
 * coding-plan") — hence the greedy capture up to the LAST :account: segment.
 * Returns [{providerId, identity}] — API keys stay encrypted until needed.
 */
function listPlanCredentials() {
  const c = readCredentials();
  const out = [];
  const re = /^account-provider:coding-plan:(.+):account:([^:]+):api-key$/;
  for (const k of Object.keys(c)) {
    const m = re.exec(k);
    if (m) out.push({ providerId: m[1], identity: m[2] });
  }
  return out;
}

/** Plan catalog from the cached builtin registry: id, name, models, mode. */
function planCatalog() {
  try {
    const base = path.join(zcodeHome(), 'v2', 'runtime', 'provider', 'windows-x86_64');
    const versions = fs.readdirSync(base).filter((d) => { try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; } })
      .sort((a, b) => (a === '0.0.0-dev' ? 1 : b === '0.0.0-dev' ? -1 : b.localeCompare(a, undefined, { numeric: true })));
    for (const ver of versions) {
      const dir = path.join(base, ver);
      for (const ep of fs.readdirSync(dir)) {
        if (!ep.startsWith('endpoint-')) continue;
        const f = path.join(dir, ep, 'zcode-builtin.json');
        if (!fs.existsSync(f)) continue;
        const j = readJsonBomSafe(f);
        const rules = (j.config && j.config.providerConfigRules && j.config.providerConfigRules.providerRules) || [];
        return rules
          .filter((r) => String(r.providerId).startsWith('account:'))
          .map((r) => ({
            providerId: r.providerId,
            name: r.providerName,
            family: (r.config && r.config.access && r.config.access.accountType) || null,
            mode: (r.config && r.config.access && r.config.access.mode) || null,
            models: (r.config && r.config.builtinModelIds) || [],
          }));
      }
    }
  } catch { /* no catalog */ }
  return [];
}

module.exports = {
  locateHarness,
  readDefaultModel,
  builtinRevisionCandidates,
  accountApiKey,
  listPlanCredentials,
  planCatalog,
  zcodeHome,
  readJsonBomSafe,
  readZcodeJwt,
};
