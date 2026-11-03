/**
 * Copper CRM client: who the agent is (OAuth 2.0 or the agent's own API key),
 * caller lookup, and the writes a call needs.
 *
 * From Copper's Developer API reference (developer.copper.com, read October 2026):
 *  - Base URL https://api.copper.com/developer_api/v1. Every body is JSON.
 *  - API key: X-PW-AccessToken (the key), X-PW-Application: developer_api and
 *    X-PW-UserEmail (the key owner's email). Only admins generate keys, under
 *    Settings > Integrations > API Keys. Writes are attributed to the key's owner.
 *  - OAuth 2.0 (apps registered with Copper): authorize on
 *    app.copper.com/oauth/authorize, token on app.copper.com/oauth/token, scope
 *    "developer/v1/all". Copper sends the code back with a form POST. Access
 *    tokens do not expire and there is no refresh token; requests send
 *    Authorization: Bearer.
 *  - 180 requests a minute per user, rolling; 429 when over.
 *  - Phone search: { phone_number: { value, match: "partial" } } matches
 *    numbers that END in the digits given, on people, leads and companies.
 *  - Activities: POST /activities with parent {type,id} and type {category:
 *    "user", id}. "Phone Call" is a user activity type whose id differs per
 *    account (GET /activity_types). A Copper activity has no duration or
 *    direction field, so both go in `details`.
 *
 * Tokens and API keys are stored encrypted (AES-256-GCM) and never sent back.
 */
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const { log, toE164, digitsOf, sleep } = require('./util');

class CopperError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 0;
  }
}

// Every request gets a deadline: a hung request would otherwise hold a call
// in flight forever, so it is never queued or retried.
const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });

const userKey = (wsKey, userId) => `${wsKey}:${userId}`;
// wsKey is the Copper account. The name is shared with the Vobiz modules,
// which only need "the CRM tenant a call is logged in".
const wsKeyOf = accountId => `a${crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 20)}`;
const redirectUri = () => `${config.PUBLIC_BASE_URL}/copper/oauth/callback`;
const oauthEnabled = () => !!(config.COPPER_CLIENT_ID && config.COPPER_CLIENT_SECRET);

// Copper ids are integers. Anything else is never put into a URL or a body.
const isCopperId = id => /^\d{1,15}$/.test(String(id == null ? '' : id));
const RECORD_TYPES = ['person', 'lead', 'company'];
const isRecordType = t => RECORD_TYPES.includes(t);
const SEARCH_PATH = { person: '/people/search', lead: '/leads/search', company: '/companies/search' };
const RECORD_PATH = { person: '/people', lead: '/leads', company: '/companies' };

// ─── OAuth ───────────────────────────────────────────────────────────────────

function authorizeUrl(stateToken) {
  const u = new URL(`${config.COPPER_APP_URL}/oauth/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.COPPER_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', 'developer/v1/all');
  u.searchParams.set('state', stateToken);
  return u.toString();
}

async function exchangeCode(code) {
  const res = await timedFetch(`${config.COPPER_APP_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
      client_id: config.COPPER_CLIENT_ID, client_secret: config.COPPER_CLIENT_SECRET,
    }).toString(),
  });
  let body = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || typeof body.access_token !== 'string' || !body.access_token) {
    throw new CopperError('token', `Copper token request failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''})`, res.status);
  }
  return body;
}

/** The headers that authenticate one credential. */
function credHeaders(cred) {
  if (cred.kind === 'oauth') return { Authorization: `Bearer ${cred.token}` };
  return { 'X-PW-AccessToken': cred.apiKey, 'X-PW-Application': 'developer_api', 'X-PW-UserEmail': cred.email };
}

async function rawGet(cred, apiPath) {
  const res = await timedFetch(`${config.COPPER_API_BASE}${apiPath}`, {
    headers: { ...credHeaders(cred), Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

/**
 * Who a credential belongs to: GET /users/me and GET /account.
 * Admin: Copper lets only admins generate API keys, so an API-key connection
 * is an admin's. An OAuth user is an admin when their email is listed in
 * COPPER_ADMIN_EMAILS (the REST API does not report roles).
 */
async function getMe(cred) {
  const me = await rawGet(cred, '/users/me');
  if (me.status === 401 || me.status === 403) throw new CopperError('unauthorized', 'Copper did not accept that key.', 401);
  if (me.status !== 200 || !me.body || !isCopperId(me.body.id)) throw new CopperError('me', `Could not read the Copper user (HTTP ${me.status})`, me.status);
  const acct = await rawGet(cred, '/account');
  if (acct.status !== 200 || !acct.body || !isCopperId(acct.body.id)) throw new CopperError('me', `Could not read the Copper account (HTTP ${acct.status})`, acct.status);
  const email = String(me.body.email || '');
  if (cred.kind === 'apikey' && email && email.toLowerCase() !== String(cred.email).toLowerCase()) {
    throw new CopperError('unauthorized', 'That email is not the owner of this API key.', 401);
  }
  return {
    userId: String(me.body.id), email, name: String(me.body.name || email || `User ${me.body.id}`),
    accountId: String(acct.body.id), accountName: String(acct.body.name || 'Copper'),
    admin: cred.kind === 'apikey' || config.COPPER_ADMIN_EMAILS.includes(email.toLowerCase()),
  };
}

function defaultSettings() {
  return {
    defaultCountry: config.DEFAULT_COUNTRY, createUnknown: true, unknownAs: 'lead', missedTask: true,
    recordingTtlSeconds: config.RECORDING_LINK_TTL_SECONDS,
  };
}

/**
 * Store a freshly connected user. cred is { kind: 'oauth', token } or
 * { kind: 'apikey', apiKey, email }. Both are stored encrypted.
 */
function saveUser(me, cred) {
  const d = store.load();
  const wsKey = wsKeyOf(me.accountId);
  const ws = d.workspaces[wsKey] || { wsKey, accountId: me.accountId, settings: defaultSettings(), createdAt: Date.now() };
  ws.name = me.accountName;
  d.workspaces[wsKey] = ws;
  const user = {
    wsKey, userId: me.userId, name: me.name, email: me.email, admin: !!me.admin, auth: cred.kind,
    secret: store.encrypt(cred.kind === 'oauth' ? cred.token : cred.apiKey),
    connectedAt: Date.now(), broken: false,
  };
  d.users[userKey(wsKey, me.userId)] = user;
  store.saveNow();
  return user;
}

const getUser = (wsKey, userId) => store.load().users[userKey(wsKey, userId)] || null;
const getWorkspace = wsKey => store.load().workspaces[String(wsKey)] || null;

/** The credential to send as this user, or null when they must reconnect. */
function credFor(wsKey, userId) {
  const user = getUser(wsKey, userId);
  if (!user || user.broken) return null;
  const secret = store.decrypt(user.secret);
  if (!secret) return null;
  return user.auth === 'oauth' ? { kind: 'oauth', token: secret } : { kind: 'apikey', apiKey: secret, email: user.email };
}

/**
 * The user to write as: the agent who handled the call when they are
 * connected, else a connected admin of the account, else any connected user.
 */
function writerFor(wsKey, preferredUserId) {
  const users = Object.values(store.load().users).filter(u => u.wsKey === String(wsKey) && !u.broken && u.secret);
  const pref = preferredUserId && users.find(u => u.userId === String(preferredUserId));
  if (pref) return pref.userId;
  const admin = users.find(u => u.admin);
  return (admin || users[0] || {}).userId || null;
}

const RECONNECT = 'Reconnect Copper: the connection stopped working.';

/**
 * One REST call as one user. 401 marks the user as needing to reconnect
 * (Copper tokens do not refresh); 429 waits Retry-After (at most 10 s) and
 * retries once.
 */
async function api(wsKey, userId, method, apiPath, body) {
  const cred = credFor(wsKey, userId);
  if (!cred) throw new CopperError('not_connected', RECONNECT);
  for (let attempt = 0; ; attempt++) {
    const res = await timedFetch(`${config.COPPER_API_BASE}${apiPath}`, {
      method,
      headers: { ...credHeaders(cred), Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (res.status === 401) {
      const user = getUser(wsKey, userId);
      if (user) { user.broken = true; store.save(); }
      throw new CopperError('not_connected', RECONNECT, 401);
    }
    if (res.status === 429 && attempt === 0) {
      await sleep(Math.min(10, Math.ceil(Number(res.headers.get('retry-after')) || 2)) * 1000);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = parsed && typeof parsed === 'object' ? (parsed.message || parsed.error) : '';
      throw new CopperError('api', `Copper ${method} ${apiPath.split('?')[0]} failed (HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''})`, res.status);
    }
    return parsed;
  }
}

// ─── people, leads and companies ─────────────────────────────────────────────

/** Every number on a Copper record, as E.164. */
function phonesOf(record, country) {
  const out = [];
  for (const p of (record && Array.isArray(record.phone_numbers) ? record.phone_numbers : [])) {
    const e = p && p.number ? toE164(p.number, country) : '';
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

/** A Copper record as the softphone and the call log see it. */
function cardOf(type, r) {
  return {
    type, id: String(r.id), name: String(r.name || ''),
    company: String(r.company_name || ''), jobTitle: String(r.title || ''),
  };
}

/**
 * People, then leads, then companies with this number on any of their phones.
 * Copper's partial search matches the trailing digits; every hit is then
 * checked against the full number, so a partial match never links the wrong
 * record.
 */
async function findByPhone(wsKey, userId, e164, country) {
  const digits = digitsOf(e164);
  const tail = digits.slice(-Math.min(10, Math.max(6, digits.length - 1)));
  const out = [];
  for (const type of RECORD_TYPES) {
    const r = await api(wsKey, userId, 'POST', SEARCH_PATH[type], { page_size: 20, phone_number: { value: tail, match: 'partial' } });
    for (const rec of (Array.isArray(r) ? r : [])) {
      if (isCopperId(rec.id) && phonesOf(rec, country).includes(e164)) out.push(cardOf(type, rec));
    }
  }
  return out;
}

async function getRecord(wsKey, userId, type, id) {
  if (!isRecordType(type) || !isCopperId(id)) return null;
  return api(wsKey, userId, 'GET', `${RECORD_PATH[type]}/${id}`);
}

/** An unknown caller becomes a lead (or a person), so the call is never dropped. */
async function createRecord(wsKey, userId, e164, type) {
  const kind = type === 'person' ? 'person' : 'lead';
  const name = `Caller ${e164}`;
  const r = await api(wsKey, userId, 'POST', RECORD_PATH[kind], { name, phone_numbers: [{ number: e164, category: 'mobile' }] });
  if (!r || !isCopperId(r.id)) throw new CopperError('api', `Copper did not return the new ${kind}`);
  return { type: kind, id: String(r.id), name };
}

// ─── activities and tasks ────────────────────────────────────────────────────

const TYPE_CACHE_MS = 24 * 3600 * 1000;

/**
 * The account's "Phone Call" activity type id. It differs per account, so it
 * is read once a day and kept with the workspace. A disabled or missing type
 * falls back to a Note (id 0), so a call is still logged.
 */
async function phoneCallTypeId(wsKey, userId) {
  const ws = getWorkspace(wsKey);
  if (ws && ws.phoneCallType && Date.now() - ws.phoneCallType.at < TYPE_CACHE_MS) return ws.phoneCallType.id;
  const r = await api(wsKey, userId, 'GET', '/activity_types');
  const hit = (r && Array.isArray(r.user) ? r.user : []).find(t => /^phone call$/i.test(String(t.name || '').trim()) && !t.is_disabled && isCopperId(t.id));
  const id = hit ? Number(hit.id) : 0;
  if (!hit) log(`! ${wsKey}: no enabled "Phone Call" activity type; logging calls as Notes`);
  if (ws) { ws.phoneCallType = { id, at: Date.now() }; store.save(); }
  return id;
}

async function createActivity(wsKey, userId, { parent, details, activityDate }) {
  if (!parent || !isRecordType(parent.type) || !isCopperId(parent.id)) throw new CopperError('api', 'Not a Copper record');
  const typeId = await phoneCallTypeId(wsKey, userId);
  const r = await api(wsKey, userId, 'POST', '/activities', {
    parent: { type: parent.type, id: Number(parent.id) },
    type: { category: 'user', id: typeId },
    details,
    activity_date: Math.floor((activityDate || Date.now()) / 1000),
  });
  if (!r || !isCopperId(r.id)) throw new CopperError('api', 'Copper did not return the new activity');
  return String(r.id);
}

async function updateActivity(wsKey, userId, activityId, { details }) {
  if (!isCopperId(activityId)) throw new CopperError('api', 'Not a Copper activity id');
  await api(wsKey, userId, 'PUT', `/activities/${activityId}`, { details });
}

async function createTask(wsKey, userId, { parent, name, details, assigneeId, due }) {
  const body = { name, details, status: 'Open', priority: 'High', due_date: Math.floor((due || Date.now()) / 1000) };
  if (parent && isRecordType(parent.type) && isCopperId(parent.id)) body.related_resource = { type: parent.type, id: Number(parent.id) };
  if (isCopperId(assigneeId)) body.assignee_id = Number(assigneeId);
  const r = await api(wsKey, userId, 'POST', '/tasks', body);
  if (!r || !isCopperId(r.id)) throw new CopperError('api', 'Copper did not return the new task');
  return String(r.id);
}

const countryFor = wsKey => ((getWorkspace(wsKey) || {}).settings || {}).defaultCountry || config.DEFAULT_COUNTRY;

// ─── disconnect ──────────────────────────────────────────────────────────────

function disconnectUser(wsKey, userId) {
  const d = store.load();
  delete d.users[userKey(wsKey, userId)];
  for (const [h, l] of Object.entries(d.panelLinks)) if (l.wsKey === wsKey && l.userId === String(userId)) delete d.panelLinks[h];
  store.saveNow();
}

function disconnectWorkspace(wsKey) {
  const d = store.load();
  for (const k of Object.keys(d.users)) if (k.startsWith(`${wsKey}:`)) delete d.users[k];
  delete d.workspaces[wsKey];
  for (const [authId, links] of Object.entries(d.accountLinks)) {
    d.accountLinks[authId] = links.filter(w => w !== wsKey);
    if (!d.accountLinks[authId].length) delete d.accountLinks[authId];
  }
  for (const [uuid, c] of Object.entries(d.calls)) if (c.wsKey === wsKey) delete d.calls[uuid];
  for (const [h, l] of Object.entries(d.panelLinks)) if (l.wsKey === wsKey) delete d.panelLinks[h];
  d.pending = d.pending.filter(p => p.wsKey !== wsKey);
  store.saveNow();
}

module.exports = {
  CopperError, oauthEnabled, authorizeUrl, exchangeCode, getMe, saveUser, getUser, getWorkspace, credFor, writerFor,
  api, phonesOf, findByPhone, getRecord, createRecord, phoneCallTypeId, createActivity, updateActivity, createTask,
  countryFor, disconnectUser, disconnectWorkspace, wsKeyOf, defaultSettings, redirectUri, isCopperId, isRecordType,
};
