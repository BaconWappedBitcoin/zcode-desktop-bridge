'use strict';
/**
 * offers.cjs — DETECT claimable ZCode plan offers and notify the owner.
 *
 * ************** HARD RULE: THIS MODULE NEVER CLAIMS AN OFFER. **************
 * Claiming (POST /api/v1/zcode-plan/billing/claim) requires a human-solved
 * Aliyun captcha (header X-Aliyun-Captcha-Verify-Param). The bridge must
 * never call the claim endpoint, never automate the captcha, and never
 * script UI clicks on the desktop's Claim button. Detection and
 * notification only — the owner claims manually in the ZCode app.
 * **************************************************************************
 *
 * Verified against the ZCode desktop (resources/app.asar, out/host/index.js,
 * app version 3.14.4) plus one live read-only probe (2026-10-03):
 *
 *  - GET {origin}/api/v1/zcode-plan/billing/preview?app_version=<v>&platform=<plat-arch>
 *    headers: Authorization: Bearer <zcodejwttoken>, X-Device-Mid: <uuid>
 *    (X-Device-Mid is REQUIRED — without it the server answers
 *     HTTP 400 code 3001 "parameter error", verified live)
 *    -> { code:0, msg, data: { server_time (s), plans: [{
 *          plan_id, name, description, priority,
 *          entitlements: [{ entitlement_id, show_name, meter, unit_type,
 *            capabilities, grant_units, period, priority, effective_at (s) }]
 *        }] } }
 *    (desktop: CodingPlanSubscriptionProvider.getManualClaimPlanPreviews)
 *    The server lists only plans this account may still claim; claimed /
 *    already-taken / quota-exhausted offers simply drop out of the list
 *    (claim-time errors 1001-1005: notFound/unavailable/alreadyClaimed/
 *    ineligible/quotaExhausted). token amount = max grant_units across
 *    entitlements with meter "model_usage" (how the app's banner renders it).
 *
 *  - GET {origin}/api/v1/marketing/touch?seq=<n>&locale=<zh-CN|en-US>
 *    same headers + X-Client-Language — the campaign engine that renders
 *    the limited-time banner/popup. Deliveries: [{ campaign_id, priority,
 *    resource_position: "banner"|"popup", banner|popup: { buttons: [{
 *    text, action: { type: "claim_zcode_plan", args: { plan_id } } }],
 *    hero/background args: { zcode_plan: { name, ends_at (s),
 *    entitlements: [...] } } }] }. This is the only source of ends_at
 *    ("valid until"), so it powers the expiry reminder. Read-only.
 *
 *  - GET {origin}/api/v1/coding-plan/reset/status (the bridge already has
 *    this via coding-plan.getResetStatus) — the passive "opportunity"
 *    signal: banked five-hour/week resets with their expire_at. Surfaced as
 *    kind "reset-opportunity" entries. The grant call (POST
 *    .../reset/opportunity) is a different, active endpoint and is never
 *    made from here; the detector only notifies, never consumes.
 *
 * Notifications: Windows toast via built-in PowerShell (Windows.UI.
 * Notifications, no module installs), one toast per offer id plus one
 * expiry reminder; clicking launches the zcode:// deep link (the desktop
 * registers that protocol), which opens/focuses the ZCode app.
 *
 * Poller ownership: out/offers/poller.pid is a FIRST-ALIVE-WINS lock — the
 * first bridge process to grab it polls and toasts; later processes run
 * dormant so two servers never double-toast. A stale pid (dead process) is
 * taken over on the next start().
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { getResetStatus, loadAuth } = require('./coding-plan.cjs');

const DEFAULT_POLL_MS = 10 * 60 * 1000;
const EXPIRY_WARN_MS = 30 * 60 * 1000; // "about to expire" window
const TIMEOUT_MS = 15000;
const DEFAULT_APP_VERSION = '3.14.4'; // asar constant rS (chunk-AIU63WBB)
const DEFAULT_LOCALE = 'zh-CN';

// ------------------------------------------------------------------ helpers
const iso = (ms) => (Number.isFinite(ms) && ms !== null ? new Date(ms).toISOString() : null);
const secToMs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * 1000 : null);

function classifyKind(period) {
  const p = String(period || '').toLowerCase();
  if (/one[-_ ]?time|once|single/.test(p)) return 'oneTime';
  if (/daily|day/.test(p)) return 'daily';
  return 'daily'; // the desktop's default banner subtitle when period is absent
}

/** Token amount the way the app renders it: max grant_units of model_usage. */
function extractTokens(entitlements) {
  let max = 0;
  let unit = 'tokens';
  for (const e of Array.isArray(entitlements) ? entitlements : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.meter && e.meter !== 'model_usage') continue;
    if (typeof e.grant_units === 'number' && Number.isFinite(e.grant_units) && e.grant_units > max) {
      max = e.grant_units;
      if (typeof e.unit_type === 'string' && e.unit_type.trim()) unit = e.unit_type.trim();
    }
  }
  return max > 0 ? { amount: max, unit } : null;
}

// ------------------------------------------------------------- cloud client
/**
 * Read-only HTTP client for the offer listing endpoints. Injectable fetch
 * and auth for tests; defaults reuse coding-plan.cjs credentials and fetch.
 */
class OffersClient {
  /** opts: {origin, appVersion, platform, locale, deviceMid, loadAuth, fetchImpl, timeoutMs} */
  constructor(opts = {}) {
    this.origin = opts.origin || process.env.ZCODE_PLAN_ORIGIN || 'https://zcode.z.ai';
    this.appVersion = opts.appVersion || process.env.ZCODE_APP_VERSION || DEFAULT_APP_VERSION;
    this.platform = opts.platform || `${process.platform}-${process.arch}`; // desktop r_(): plat-arch
    this.locale = opts.locale || DEFAULT_LOCALE;
    this.deviceMid = opts.deviceMid || null;
    this.loadAuth = opts.loadAuth || loadAuth;
    this.fetchImpl = opts.fetchImpl || ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    this._seq = 0;
  }

  _headers(extra) {
    const auth = this.loadAuth();
    return Object.assign(
      {
        Authorization: auth.resetHeaders.Authorization,
        'X-Device-Mid': this.deviceMid,
        'X-ZCode-App-Version': this.appVersion,
        'X-Platform': this.platform,
      },
      extra || {},
    );
  }

  async _get(url, headers, what) {
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`${what}: non-JSON response (HTTP ${res.status})`); }
    if (!res.ok) throw new Error(`${what}: HTTP ${res.status}${body && body.msg ? ` ${body.msg}` : ''}`);
    if (body && typeof body.code === 'number' && body.code !== 0) {
      throw new Error(`${what}: business code ${body.code}${body.msg ? ` (${body.msg})` : ''}`);
    }
    return body;
  }

  /** -> { serverTimeMs, plans: raw[] } (raw billing/preview plan objects) */
  async preview() {
    const url = new URL(`${this.origin}/api/v1/zcode-plan/billing/preview`);
    url.searchParams.set('app_version', this.appVersion);
    url.searchParams.set('platform', this.platform);
    const body = await this._get(url, this._headers(), 'billing/preview');
    const d = (body && body.data) || {};
    return { serverTimeMs: secToMs(d.server_time), plans: Array.isArray(d.plans) ? d.plans : [] };
  }

  /** -> { serverTimeMs, deliveries: raw[] } (marketing/touch campaign deliveries) */
  async touch() {
    const url = new URL(`${this.origin}/api/v1/marketing/touch`);
    url.searchParams.set('seq', String(this._seq++));
    url.searchParams.set('locale', this.locale);
    const body = await this._get(url, this._headers({ 'X-Client-Language': this.locale }), 'marketing/touch');
    const d = (body && body.data) || {};
    return { serverTimeMs: secToMs(d.server_time), deliveries: Array.isArray(d.deliveries) ? d.deliveries : [] };
  }
}

/**
 * Pull the zcode_plan payload out of a campaign delivery (banner or popup):
 * hero/background `args.zcode_plan` = { name, ends_at, entitlements }.
 */
function campaignPlanArgs(delivery) {
  const spots = [];
  if (delivery && delivery.popup && typeof delivery.popup === 'object') {
    spots.push(delivery.popup.hero);
  }
  if (delivery && delivery.banner && typeof delivery.banner === 'object') {
    spots.push(delivery.banner.background);
    if (delivery.banner.success_popup) spots.push(delivery.banner.success_popup.hero);
  }
  for (const spot of spots) {
    const args = spot && spot.args;
    if (args && args.zcode_plan && typeof args.zcode_plan === 'object') return args.zcode_plan;
  }
  return null;
}

/** plan_ids a delivery's buttons would claim (action type claim_zcode_plan). */
function campaignClaimPlanIds(delivery) {
  const ids = [];
  const buttonsOf = (surface) => (surface && Array.isArray(surface.buttons) ? surface.buttons : []);
  for (const b of [...buttonsOf(delivery && delivery.popup), ...buttonsOf(delivery && delivery.banner)]) {
    const act = b && b.action;
    if (act && act.type === 'claim_zcode_plan' && act.args && act.args.plan_id) {
      ids.push(String(act.args.plan_id));
    }
  }
  return ids;
}

/**
 * Normalize the raw sources into the offer list:
 *   { id, title, kind: daily|oneTime|reset-opportunity, tokens, startsAt,
 *     endsAt, claimable, claimed } (+ description, source, campaignId, count)
 * `previewPlans` are claimable by definition (the server hides claimed /
 * exhausted ones); campaign entries only add endsAt/title context.
 */
function normalizeOffers({ previewPlans = [], deliveries = [], resetStatus = null, now = Date.now() } = {}) {
  const byId = new Map();

  for (const p of Array.isArray(previewPlans) ? previewPlans : []) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.plan_id || '').trim();
    if (!id) continue;
    const ents = Array.isArray(p.entitlements) ? p.entitlements : [];
    const starts = ents
      .map((e) => secToMs(e && e.effective_at))
      .filter((v) => v !== null);
    byId.set(id, {
      id,
      title: String(p.name || id).trim(),
      kind: classifyKind(ents.map((e) => e && e.period).find((x) => x) || ''),
      tokens: extractTokens(ents),
      startsAt: starts.length ? iso(Math.min(...starts)) : null,
      endsAt: null, // only the campaign side knows "valid until"
      claimable: true,
      claimed: false, // claimed offers never appear in the listing
      description: String(p.description || '').trim(),
      source: 'billing/preview',
      seenAt: now,
    });
  }

  for (const d of Array.isArray(deliveries) ? deliveries : []) {
    if (!d || typeof d !== 'object') continue;
    const ids = campaignClaimPlanIds(d);
    if (!ids.length) continue;
    const zp = campaignPlanArgs(d) || {};
    const tokens = extractTokens(zp.entitlements);
    for (const id of ids) {
      const base = byId.get(id) || {
        id,
        title: String(zp.name || id).trim(),
        kind: classifyKind((zp.entitlements || []).map((e) => e && e.period).find((x) => x) || ''),
        tokens: null,
        startsAt: null,
        endsAt: null,
        claimable: true,
        claimed: false,
        description: '',
        source: 'marketing/touch',
        seenAt: now,
      };
      if (zp.name) base.title = String(zp.name).trim();
      if (tokens) base.tokens = tokens;
      const ends = secToMs(zp.ends_at);
      if (ends !== null) base.endsAt = iso(ends);
      base.campaignId = d.campaign_id ? String(d.campaign_id) : undefined;
      if (base.source === 'marketing/touch' && byId.has(id)) base.source = 'billing/preview+marketing/touch';
      byId.set(id, base);
    }
  }

  const offers = [...byId.values()];

  // Passive reset signal: banked five-hour / week resets (never consumed here).
  if (resetStatus && resetStatus.available) {
    for (const [type, label] of [['five_hour', '5-hour window reset'], ['week', 'weekly window reset']]) {
      const list = resetStatus.available[type] || [];
      if (!list.length) continue;
      const expiries = list.map((r) => (r && r.expireAt ? Date.parse(r.expireAt) : NaN)).filter(Number.isFinite);
      offers.push({
        id: `reset:${type}:${expiries.length ? Math.min(...expiries) : 'none'}`,
        title: `${list.length} banked ${label}${list.length > 1 ? 's' : ''} available`,
        kind: 'reset-opportunity',
        tokens: null,
        startsAt: null,
        endsAt: expiries.length ? iso(Math.min(...expiries)) : null,
        claimable: false, // nothing to claim — spend via zcode_plan_reset in the app
        claimed: false,
        description: 'Banked coding-plan reset (passive reset/status signal); spend it with zcode_plan_reset or in the app.',
        source: 'coding-plan/reset/status',
        count: list.length,
        seenAt: now,
      });
    }
  }

  offers.sort((a, b) => (a.kind === 'reset-opportunity' ? 1 : 0) - (b.kind === 'reset-opportunity' ? 1 : 0)
    || String(a.id).localeCompare(String(b.id)));
  return offers;
}

// ------------------------------------------------------------------- toast
/** Escape text for embedding in toast XML. */
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Raise a Windows toast with built-in PowerShell only (Windows.UI.Notifications
 * through the WinRT projection in powershell.exe 5.1 — no module installs).
 * Clicking activates the zcode:// deep link, which opens/focuses the ZCode
 * app (the desktop registers that protocol). Returns a promise; never throws.
 */
function toastPowerShell({ title, body, launch = 'zcode://', logger = () => {} } = {}) {
  return new Promise((resolve) => {
    const xml = `<toast activationType="protocol" launch="${xmlEscape(launch)}" duration="short">`
      + '<visual><binding template="ToastGeneric">'
      + `<text>${xmlEscape(title)}</text>`
      + `<text>${xmlEscape(body)}</text>`
      + '</binding></visual></toast>';
    const b64 = Buffer.from(xml, 'utf8').toString('base64');
    // The PowerShell AUMID works for transient toasts without registering a shortcut.
    const appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script = [
      '$ErrorActionPreference=\'Stop\'',
      'try {',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))`,
      '$t = New-Object Windows.UI.Notifications.ToastNotification($x)',
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($t)`,
      'exit 0',
      '} catch { exit 1 }',
    ].join('\n');
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (e) {
      logger('toast spawn failed', { error: e.message });
      return resolve(false);
    }
    const kill = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 10000);
    child.once('error', (e) => { clearTimeout(kill); logger('toast failed', { error: e.message }); resolve(false); });
    child.once('exit', (code) => {
      clearTimeout(kill);
      if (code !== 0) logger('toast rejected', { code });
      resolve(code === 0);
    });
  });
}

// ----------------------------------------------------------------- manager
/**
 * Poller + notifier. opts: { dir (default out/offers), client (OffersClient),
 *   pollMs (config offersPollMs, 0 disables), toasts (config offerToasts),
 *   toastImpl, logger, expiryWarnMs, loadResetStatus }
 */
class OffersManager {
  constructor(opts = {}) {
    this.dir = opts.dir ? path.resolve(opts.dir) : path.join(__dirname, '..', 'out', 'offers');
    this.log = opts.logger || (() => {});
    this.pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DEFAULT_POLL_MS;
    this.toastsEnabled = opts.toasts !== false;
    this.toastImpl = opts.toastImpl || toastPowerShell;
    this.expiryWarnMs = Number.isFinite(opts.expiryWarnMs) ? opts.expiryWarnMs : EXPIRY_WARN_MS;
    this.loadResetStatus = opts.loadResetStatus || (() => getResetStatus().catch(() => null));
    this.client = opts.client || null;
    this._timer = null;
    this._checking = false;
    this._stopped = true;
    this.dormant = false; // true when another live bridge process owns the poller
    this.state = this._loadState();
  }

  // ------------------------------------------------------------------ disk
  get stateFile() { return path.join(this.dir, 'state.json'); }
  get eventsFile() { return path.join(this.dir, 'events.log'); }
  get pidFile() { return path.join(this.dir, 'poller.pid'); }

  _ensureDir() { fs.mkdirSync(this.dir, { recursive: true }); }

  _loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }

  /** Atomic replace (temp + rename, retried — Windows watchers can hold files). */
  _writeAtomic(file, data) {
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tmp, data);
    for (let i = 0; i < 5; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (i === 4) { try { fs.unlinkSync(tmp); } catch { /* nothing */ } throw e; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
      }
    }
  }

  _saveState() {
    try {
      this._ensureDir();
      this._writeAtomic(this.stateFile, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch (e) { this.log('offers state write failed', { error: e.message }); }
  }

  _event(event, fields) {
    try {
      this._ensureDir();
      fs.appendFileSync(this.eventsFile, `${JSON.stringify(Object.assign({ ts: new Date().toISOString(), event }, fields))}\n`);
    } catch (e) { this.log('offers event write failed', { error: e.message }); }
  }

  /** Stable per-installation device id (the server rejects calls without it). */
  _deviceMid() {
    if (this.state.deviceMid) return this.state.deviceMid;
    this.state.deviceMid = crypto.randomUUID();
    this._saveState();
    return this.state.deviceMid;
  }

  _ensureClient() {
    if (!this.client) this.client = new OffersClient({ deviceMid: this._deviceMid(), logger: this.log });
    return this.client;
  }

  // ----------------------------------------------------------- pid lock
  _pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }

  /**
   * FIRST-ALIVE-WINS: grab out/offers/poller.pid unless a live process holds
   * it. The winner polls and toasts; losers stay dormant (list() still works)
   * so two bridge processes never double-toast.
   */
  _acquirePollerLock() {
    try {
      const raw = fs.readFileSync(this.pidFile, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && this._pidAlive(pid)) {
        this.dormant = true;
        this.log('offers poller already owned by pid', { pid });
        return false;
      }
    } catch { /* no lock file — we take it */ }
    try {
      this._ensureDir();
      this._writeAtomic(this.pidFile, `${process.pid}\n`);
      this.dormant = false;
      return true;
    } catch (e) {
      this.log('offers pid lock write failed', { error: e.message });
      return false;
    }
  }

  _releasePollerLock() {
    try {
      const raw = fs.readFileSync(this.pidFile, 'utf8').trim();
      if (Number(raw) === process.pid) fs.unlinkSync(this.pidFile);
    } catch { /* not ours / already gone */ }
  }

  // -------------------------------------------------------------- polling
  start() {
    if (!this._stopped) return;
    if (this.pollMs === 0) { this.log('offers poller disabled (offersPollMs=0)'); return; }
    if (!this._acquirePollerLock()) return;
    this._stopped = false;
    this._schedule(Math.max(1000, Math.min(this.pollMs, 30 * 1000))); // first check soon
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._releasePollerLock();
  }

  _schedule(delayMs) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.check().catch((e) => this.log('offers check failed', { error: e.message })); }, delayMs);
    this._timer.unref && this._timer.unref();
  }

  /** Fetch + normalize the current offer list (read-only, no state writes). */
  async _collect() {
    const client = this._ensureClient();
    const preview = await client.preview();
    let deliveries = [];
    try { deliveries = (await client.touch()).deliveries; }
    catch (e) { this.log('marketing/touch unavailable, continuing without endsAt', { error: e.message }); }
    const resetStatus = await Promise.resolve(this.loadResetStatus());
    const offers = normalizeOffers({ previewPlans: preview.plans, deliveries, resetStatus, now: Date.now() });
    return { offers, serverTimeMs: preview.serverTimeMs };
  }

  /** One detection pass: fetch, diff against state, notify + persist. */
  async check() {
    if (this._checking) return this._view();
    this._checking = true;
    try {
      const { offers, serverTimeMs } = await this._collect();
      if (this.dormant) {
        // Another live bridge process owns the poller lock and therefore
        // state.json + toasts. Refresh read-only so a dormant facade's
        // explicit refresh can neither double-toast nor mark an offer
        // toasted before the owner has notified it.
        return { ...this._view(), offers: offers.map((o) => this._publicOffer(o)), lastCheckAt: new Date().toISOString() };
      }

      const prevSeen = this.state.seen || {};
      const seen = {};
      const toasted = this.state.toasted || {};
      const expiringToasted = this.state.expiringToasted || {};
      const now = Date.now();

      for (const o of offers) {
        seen[o.id] = prevSeen[o.id] || now;
        const isNew = prevSeen[o.id] === undefined;
        if (isNew) {
          this._event('offer-new', this._publicOffer(o));
          if (this.toastsEnabled && !toasted[o.id]) {
            toasted[o.id] = true;
            this._toastFor(o, false);
          }
        }
        const endsMs = o.endsAt ? Date.parse(o.endsAt) : null;
        if (endsMs !== null && endsMs > now && endsMs - now <= this.expiryWarnMs && !expiringToasted[o.id]) {
          expiringToasted[o.id] = true;
          this._event('offer-expiring', this._publicOffer(o));
          if (this.toastsEnabled) this._toastFor(o, true);
        }
      }
      for (const id of Object.keys(prevSeen)) {
        if (!seen[id]) this._event('offer-gone', { id, lastSeenAt: iso(prevSeen[id]) });
      }

      this.state = {
        lastCheckAt: new Date().toISOString(),
        lastError: null,
        serverTime: serverTimeMs ? iso(serverTimeMs) : null,
        deviceMid: this.state.deviceMid,
        offers,
        seen,
        toasted,
        expiringToasted,
      };
      this._saveState();
      return this._view();
    } catch (e) {
      this.log('offers check failed', { error: String(e.message || e) });
      if (!this.dormant) {
        this.state.lastError = String(e.message || e);
        this.state.lastCheckAt = new Date().toISOString();
        this._saveState();
        this._event('check-error', { error: this.state.lastError });
      }
      throw e;
    } finally {
      this._checking = false;
      if (!this._stopped) this._schedule(this.pollMs);
    }
  }

  /** The toast copy for an offer (or its expiry reminder). */
  _toastFor(offer, expiring) {
    const bits = [offer.title];
    if (offer.tokens) bits.push(`${offer.tokens.amount} ${offer.tokens.unit}`);
    if (offer.kind === 'daily') bits.push('daily');
    if (expiring && offer.endsAt) bits.push(`ends ${new Date(offer.endsAt).toLocaleString()}`);
    else if (offer.endsAt) bits.push(`valid until ${new Date(offer.endsAt).toLocaleString()}`);
    const body = bits.join(' · ') + ' — claim it in the ZCode app';
    // The toast NEVER claims; clicking only opens/focuses the app (zcode://).
    return Promise.resolve(this.toastImpl({ title: 'ZCode offer available', body, launch: 'zcode://' }))
      .catch(() => false);
  }

  _publicOffer(o) {
    const { seenAt, ...rest } = o;
    return rest;
  }

  /** Cached view (refresh=true runs a live check first and returns its view). */
  async list({ refresh = false } = {}) {
    if (refresh) {
      const fresh = await this.check().catch((e) => { this.log('offers refresh failed', { error: e.message }); return null; });
      if (fresh) return fresh;
    }
    return this._view();
  }

  _view() {
    const offers = (this.state.offers || []).map((o) => this._publicOffer(o));
    return {
      lastCheckAt: this.state.lastCheckAt || null,
      lastError: this.state.lastError || null,
      serverTime: this.state.serverTime || null,
      claimableCount: offers.filter((o) => o.claimable).length,
      offers,
      note: 'Detection only — the bridge never claims offers (claiming requires the in-app Aliyun captcha).',
    };
  }
}

module.exports = {
  OffersClient,
  OffersManager,
  normalizeOffers,
  classifyKind,
  extractTokens,
  campaignPlanArgs,
  campaignClaimPlanIds,
  toastPowerShell,
  DEFAULT_POLL_MS,
  EXPIRY_WARN_MS,
};
