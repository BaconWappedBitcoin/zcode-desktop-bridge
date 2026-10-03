'use strict';
/**
 * coding-plan.cjs — Z.ai coding-plan quota windows and consumable resets.
 *
 * Mirrors what the ZCode desktop's usage-quota provider does (verified live):
 *
 *  - GET  {planOrigin}/api/v1/coding-plan/reset/status
 *        headers: Authorization: Bearer <zcodejwttoken>,
 *                 X-Bigmodel-Authorization: <oauth:{family}:access_token>,
 *                 Bigmodel-Target-Type: PERSONAL
 *        -> { available_five_hour_resets:[{expire_at}], available_week_resets,
 *             latest_*_reset_history:{used_at}|null, has_unread_history }
 *
 *  - POST {planOrigin}/api/v1/coding-plan/reset/use
 *        body { idempotency_key (<=64 chars), reset_type: "FIVE_HOUR"|"WEEK" }
 *        -> { used: true }            (consumes one banked reset)
 *
 *  - POST {planOrigin}/api/v1/coding-plan/reset/opportunity
 *        body { idempotency_key } -> { granted:true } | code 3301 { next_try_at }
 *        (asks the backend to grant a reset opportunity; rate-limited)
 *
 *  - GET  {quotaOrigin}/api/monitor/usage/quota/limit
 *        headers: authorization: Bearer <coding-plan api key>
 *        -> { level, limits:[{type:"CREDIT_LIMIT", unit, number, usage,
 *              currentValue, remaining, percentage, nextResetTime}] }
 *        unit 3 = the 5-hour window, unit 6 = the natural-week window.
 *
 * Tokens/api-key are decrypted from ~/.zcode/v2/credentials.json (same enc:v1
 * scheme as lib/harness-env.cjs) and never logged or written anywhere.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { readJsonBomSafe, accountApiKey, readDefaultModel, listPlanCredentials, planCatalog } = require('./harness-env.cjs');

const PLAN_ORIGIN = process.env.ZCODE_PLAN_ORIGIN || 'https://zcode.z.ai';
const QUOTA_ORIGIN = process.env.ZCODE_QUOTA_ORIGIN || 'https://api.z.ai';
const TIMEOUT_MS = 15000;

const PREFIX = 'enc:v1:';
function credDecrypt(v) {
  if (typeof v !== 'string' || !v.startsWith(PREFIX)) return v;
  const [a, l, u] = v.slice(PREFIX.length).split('.');
  const secret = process.env.ZCODE_CREDENTIAL_SECRET && process.env.ZCODE_CREDENTIAL_SECRET.trim() || (() => {
    let user = 'unknown';
    try { user = os.userInfo().username; } catch { /* keep */ }
    return `zcode-credential-fallback:${process.platform}:${os.homedir()}:${user}`;
  })();
  const key = crypto.createHash('sha256').update(secret).digest();
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(a, 'base64url'));
  d.setAuthTag(Buffer.from(l, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(u, 'base64url')), d.final()]).toString('utf-8');
}

function loadCredentials() {
  const p = path.join(os.homedir(), '.zcode', 'v2', 'credentials.json');
  return readJsonBomSafe(p);
}

function loadAuth() {
  const c = loadCredentials();
  const zcodeJwt = credDecrypt(c['zcodejwttoken'] || '').trim();
  const family = credDecrypt(c['oauth:active_provider'] || '').trim() || 'zai';
  const maasToken = credDecrypt(c[`oauth:${family}:access_token`] || '').trim();
  if (!zcodeJwt) throw new Error('zcodejwttoken missing from harness credentials — sign in to ZCode once');
  if (!maasToken) throw new Error(`oauth:${family}:access_token missing from harness credentials`);
  return {
    family,
    resetHeaders: {
      Authorization: /^Bearer\s/i.test(zcodeJwt) ? zcodeJwt : `Bearer ${zcodeJwt}`,
      'X-Bigmodel-Authorization': maasToken,
      'Bigmodel-Target-Type': 'PERSONAL',
    },
    apiKey: accountApiKey(readDefaultModel().providerId),
  };
}

async function readEnvelope(res, what) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${what}: non-JSON response (HTTP ${res.status})`); }
  if (!res.ok) {
    const msg = (body && (body.msg || body.message || body.error)) || `HTTP ${res.status}`;
    throw new Error(`${what}: ${msg}`);
  }
  // Z.ai monitor endpoints report success as code 0 OR code 200.
  if (body && typeof body.code === 'number' && body.code !== 0 && body.code !== 200) {
    const err = new Error(`${what}: business code ${body.code}${body.msg ? ` (${body.msg})` : ''}`);
    err.code = body.code;
    err.data = body.data;
    throw err;
  }
  return body;
}

function idKey() {
  // The backend validates this: the desktop app always sends a UUID.
  return crypto.randomUUID();
}

// ------------------------------------------------------------------- reads
/** Quota windows for an arbitrary plan's api key (defaults to the active plan). */
async function getQuotaForPlan(providerId) {
  const key = accountApiKey(providerId);
  if (!key) throw new Error(`no local credentials for plan ${providerId}`);
  const origin = /bigmodel/.test(providerId) ? 'https://open.bigmodel.cn' : QUOTA_ORIGIN;
  const res = await fetch(`${origin}/api/monitor/usage/quota/limit`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readEnvelope(res, 'quota/limit');
  const limits = ((body.data && body.data.limits) || []).map((l) => ({
    window: l.unit === 3 ? 'five_hour' : l.unit === 6 ? 'week' : `unit_${l.unit}`,
    type: l.type,
    unit: l.unit,
    limit: l.number ?? l.usage ?? null,
    used: l.currentValue ?? null,
    remaining: l.remaining ?? null,
    usedPercentage: l.percentage ?? null,
    nextResetTime: l.nextResetTime ? new Date(l.nextResetTime).toISOString() : null,
    nextResetTs: l.nextResetTime ?? null,
  }));
  return { level: (body.data && body.data.level) || null, limits };
}

async function getQuota() {
  return getQuotaForPlan(readDefaultModel().providerId);
}

/**
 * Every plan known to the harness, annotated with whether this machine holds
 * credentials and (when it does) live token availability per window.
 * `activeProviderId` marks the bridge's current plan.
 */
async function listPlans(activeProviderId) {
  const withCreds = new Map(listPlanCredentials().map((p) => [p.providerId, p]));
  const catalog = planCatalog();
  const ids = new Set([...withCreds.keys(), ...catalog.map((p) => p.providerId)]);
  const plans = [];
  for (const id of ids) {
    const cat = catalog.find((p) => p.providerId === id) || null;
    const hasCreds = withCreds.has(id);
    let quota = null;
    let quotaError = null;
    if (hasCreds) {
      try { quota = await getQuotaForPlan(id); }
      catch (e) { quotaError = e.message; }
    }
    plans.push({
      providerId: id,
      name: cat ? cat.name : id,
      family: cat ? cat.family : (/bigmodel/.test(id) ? 'bigmodel' : 'zai'),
      mode: cat ? cat.mode : null,
      models: cat ? cat.models : [],
      hasLocalCredentials: hasCreds,
      tokensAvailable: quota ? quota.limits.map((l) => ({ window: l.window, remaining: l.remaining, usedPercentage: l.usedPercentage, nextResetTime: l.nextResetTime })) : null,
      quota,
      quotaError,
      isActive: id === activeProviderId,
    });
  }
  return { activeProviderId, plans, generatedAt: new Date().toISOString() };
}

async function getResetStatus() {
  const auth = loadAuth();
  const res = await fetch(`${PLAN_ORIGIN}/api/v1/coding-plan/reset/status`, {
    headers: auth.resetHeaders,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readEnvelope(res, 'reset/status');
  const d = body.data || {};
  const ts = (v) => (v ? new Date(v).toISOString() : null);
  return {
    available: {
      five_hour: (d.available_five_hour_resets || []).map((x) => ({ expireAt: ts(x.expire_at) })),
      week: (d.available_week_resets || []).map((x) => ({ expireAt: ts(x.expire_at) })),
    },
    lastUsed: {
      five_hour: d.latest_five_hour_reset_history ? ts(d.latest_five_hour_reset_history.used_at) : null,
      week: d.latest_week_reset_history ? ts(d.latest_week_reset_history.used_at) : null,
    },
    hasUnreadHistory: !!d.has_unread_history,
    generatedAt: new Date().toISOString(),
  };
}

/** Combined read: usage windows + reset availability. */
async function getPlanSnapshot() {
  const [quota, resets] = await Promise.all([
    getQuota().catch((e) => ({ error: e.message })),
    getResetStatus().catch((e) => ({ error: e.message })),
  ]);
  return { quota, resets };
}

// ------------------------------------------------------------------ writes
/**
 * Consume one banked reset. `type` is "five_hour" | "week" (wire enum
 * FIVE_HOUR | WEEK). Refuses (without calling /use) when none is available
 * unless force=true.
 */
async function useReset(type, { force = false } = {}) {
  const wireType = type === 'five_hour' || type === 'FIVE_HOUR' ? 'FIVE_HOUR'
    : type === 'week' || type === 'WEEK' ? 'WEEK' : null;
  if (!wireType) throw new Error(`invalid reset type "${type}" (use five_hour or week)`);

  const status = await getResetStatus().catch((e) => {
    if (force) return null;
    throw e;
  });
  if (status) {
    const available = status.available[type === 'week' || type === 'WEEK' ? 'week' : 'five_hour'];
    if (!available.length && !force) {
      return { used: false, reason: `no ${type} resets available`, available, status };
    }
  }

  const auth = loadAuth();
  const res = await fetch(`${PLAN_ORIGIN}/api/v1/coding-plan/reset/use`, {
    method: 'POST',
    headers: Object.assign({}, auth.resetHeaders, { 'content-type': 'application/json' }),
    body: JSON.stringify({ idempotency_key: idKey(), reset_type: wireType }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readEnvelope(res, 'reset/use');
  const used = !!(body.data && body.data.used);
  return { used, type: wireType, at: new Date().toISOString() };
}

/** Ask the backend for a reset opportunity (what the desktop's reward flow earns). */
async function requestOpportunity() {
  const auth = loadAuth();
  const res = await fetch(`${PLAN_ORIGIN}/api/v1/coding-plan/reset/opportunity`, {
    method: 'POST',
    headers: Object.assign({}, auth.resetHeaders, { 'content-type': 'application/json' }),
    body: JSON.stringify({ idempotency_key: idKey() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 3301 = not granted (with next_try_at); delivered as business code, HTTP 200
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`reset/opportunity: non-JSON response (HTTP ${res.status})`); }
  if (body && body.code === 3301) {
    return { granted: false, nextTryAt: body.data && body.data.next_try_at ? new Date(body.data.next_try_at * 1000).toISOString() : null };
  }
  if (!res.ok || (body && typeof body.code === 'number' && body.code !== 0)) {
    throw new Error(`reset/opportunity failed: ${(body && (body.msg || body.code)) || `HTTP ${res.status}`}`);
  }
  return { granted: !!(body.data && body.data.granted) };
}

module.exports = { getQuota, getQuotaForPlan, getResetStatus, getPlanSnapshot, useReset, requestOpportunity, loadAuth, listPlans };
