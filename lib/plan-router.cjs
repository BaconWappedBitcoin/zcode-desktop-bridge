'use strict';
/**
 * lib/plan-router.cjs — route a model to the coding plan that currently has
 * credit (owner 2026-10-05: "establish dynamic routing in the bridge depending
 * where I have credit").
 *
 * Policy (config.json `planRouter`, defaults below): an ordered candidate list
 * per model id. A candidate is usable when this machine holds its credentials,
 * its 5-hour window has credit, and (for plans listed in `reserveAppliesTo`,
 * when routing a model other than `reserveFor`) its weekly window is above
 * `weeklyReservePct` — that keeps the last slice of the individual plan for
 * GLM-5.3 work. Start plans are excluded unless `allowStartPlan` is true: the
 * zcode.z.ai proxy only serves the desktop app (code 3012 for other clients).
 *
 * route(modelId, opts) -> {
 *   modelId, providerId|null, reason, waitUntil|null,
 *   candidates: [{providerId, ok, why, fiveHourRemaining, weekRemainingPct, nextReset}]
 * }
 * Pure given opts.getQuota / opts.catalog / opts.creds (tests inject them);
 * never logs or returns keys.
 */
const harnessEnv = require('./harness-env.cjs');
const codingPlan = require('./coding-plan.cjs');
const isStartPlan = (pid) => /^account:(zai|bigmodel)-start-plan$/.test(String(pid || ''));

const DEFAULT_POLICY = {
  candidates: {
    'GLM-5.3-Flash': ['account:zai-start-plan', 'account:zai-individual-coding-plan', 'account:zai-team-coding-plan'],
    'GLM-5.3': ['account:zai-individual-coding-plan', 'account:zai-team-coding-plan'],
  },
  fallbackCandidates: ['account:zai-individual-coding-plan', 'account:zai-team-coding-plan'],
  weeklyReservePct: 10,
  reserveAppliesTo: ['account:zai-individual-coding-plan'],
  reserveFor: 'GLM-5.3',
  allowStartPlan: false,
  cacheMs: 60000,
};

const _cache = new Map(); // providerId -> {at, quota|error}

function normalizeQuota(q) {
  const out = { fiveHourRemaining: null, weekRemainingPct: null, nextReset: null };
  const limits = (q && q.limits) || [];
  for (const l of limits) {
    const win = l.window || (l.unit === 3 ? 'five_hour' : l.unit === 6 ? 'week' : null);
    if (win === 'five_hour') {
      out.fiveHourRemaining = Number(l.remaining);
      if (!out.nextReset || (l.nextResetTime && l.nextResetTime < out.nextReset)) out.nextReset = l.nextResetTime || null;
    } else if (win === 'week') {
      out.weekRemainingPct = 100 - Number(l.usedPercentage || 0);
      out.weekRemaining = Number(l.remaining);
      out.weekReset = l.nextResetTime || null;
    }
  }
  return out;
}

async function quotaFor(pid, opts) {
  const now = opts.now ? opts.now() : Date.now();
  const cacheMs = opts.policy.cacheMs;
  const hit = _cache.get(pid);
  if (hit && now - hit.at < cacheMs && !opts.getQuota) return hit.value;
  let value;
  try {
    const raw = opts.getQuota ? await opts.getQuota(pid) : await codingPlan.getQuotaForPlan(pid);
    value = { ok: true, ...normalizeQuota(raw) };
  } catch (e) {
    value = { ok: false, error: e.message };
  }
  _cache.set(pid, { at: now, value });
  return value;
}

async function route(modelId, opts = {}) {
  const policy = Object.assign({}, DEFAULT_POLICY, opts.policy || {});
  const model = String(modelId || '').trim();
  const catalog = opts.catalog || harnessEnv.planCatalog();
  const creds = new Set((opts.creds || harnessEnv.listPlanCredentials()).map((c) => c.providerId));
  const order = policy.candidates[model] || policy.fallbackCandidates;
  const results = [];
  let waitUntil = null;
  for (const pid of order) {
    const row = { providerId: pid, ok: false, why: '' };
    const plan = catalog.find((p) => p.providerId === pid);
    if (plan && plan.models && plan.models.length && !plan.models.includes(model)) {
      row.why = `plan does not offer ${model}`; results.push(row); continue;
    }
    if (isStartPlan(pid) && !policy.allowStartPlan) {
      row.why = 'start plan is desktop-app only (proxy rejects other clients, code 3012)'; results.push(row); continue;
    }
    if (!creds.has(pid)) { row.why = 'no local credentials'; results.push(row); continue; }
    const q = await quotaFor(pid, { ...opts, policy });
    if (!q.ok) { row.why = `quota lookup failed: ${q.error}`; results.push(row); continue; }
    Object.assign(row, { fiveHourRemaining: q.fiveHourRemaining, weekRemainingPct: q.weekRemainingPct, nextReset: q.nextReset });
    if (q.fiveHourRemaining !== null && q.fiveHourRemaining <= 0) {
      row.why = `5-hour window exhausted (resets ${q.nextReset || '?'})`;
      if (q.nextReset && (!waitUntil || q.nextReset < waitUntil)) waitUntil = q.nextReset;
      results.push(row); continue;
    }
    if (q.weekRemaining !== undefined && q.weekRemaining <= 0) {
      row.why = `weekly window exhausted (resets ${q.weekReset || '?'})`;
      if (q.weekReset && (!waitUntil || q.weekReset < waitUntil)) waitUntil = q.weekReset;
      results.push(row); continue;
    }
    const reserved = policy.reserveAppliesTo.includes(pid) && model !== policy.reserveFor;
    if (reserved && q.weekRemainingPct !== null && q.weekRemainingPct < policy.weeklyReservePct) {
      row.why = `weekly reserve: ${q.weekRemainingPct.toFixed(0)}% left < ${policy.weeklyReservePct}% kept for ${policy.reserveFor}`;
      results.push(row); continue;
    }
    row.ok = true; row.why = 'has credit'; results.push(row);
    return { modelId: model, providerId: pid, reason: `${pid}: ${row.why}`, waitUntil: null, candidates: results };
  }
  return {
    modelId: model, providerId: null,
    reason: 'no candidate plan has credit for ' + model + (waitUntil ? `; next reset ${waitUntil}` : ''),
    waitUntil, candidates: results,
  };
}

function clearCache() { _cache.clear(); }

module.exports = { route, normalizeQuota, DEFAULT_POLICY, clearCache };
