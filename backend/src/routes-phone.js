/**
 * Routes the softphone tab and the Copper panel call, and the Copper connect flow.
 *
 * Order of sign-in: the agent connects Copper first (that is who they are, and
 * whose name calls are logged under), with OAuth or a Copper API key, then
 * signs in to Vobiz with an account (Auth ID + Auth Token).
 *
 * Every route under /api is behind a Bearer token: a softphone session token,
 * or for /api/panel/* a Copper panel link token. Only the routes that create a
 * session are open. No route returns a SIP password or access token, a list
 * of accounts, or a list of endpoints without a session.
 */
const express = require('express');
const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');
const v = require('./vobiz');
const cp = require('./copper');
const logger = require('./call-logger');
const events = require('./events');
const { state, liveSessions, sessionExpired } = require('./state');
const { log, toE164, isE164, randomToken, safeEqual } = require('./util');

const AUTH_ID_RE = /^[A-Za-z0-9_]{4,64}$/;

// ─── sessions ────────────────────────────────────────────────────────────────

function sessionFrom(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const s = state.sessions.get(token);
  if (!s) return null;
  if (sessionExpired(s)) { state.sessions.delete(token); return null; }
  return { token, s };
}

function requireIdentity(req, res, next) {
  const found = sessionFrom(req);
  if (!found) return res.status(401).json({ error: 'Not signed in', code: 'signed_out' });
  req.token = found.token;
  req.sess = found.s;
  next();
}

function requireVobiz(req, res, next) {
  requireIdentity(req, res, () => {
    if (req.sess.mode !== 'account') return res.status(403).json({ error: 'Sign in with your Vobiz account to use this.', code: 'needs_account' });
    if (!state.accounts.get(req.sess.authId)) return res.status(401).json({ error: 'Session expired. Sign in again.', code: 'signed_out' });
    next();
  });
}

function requireAdmin(req, res, next) {
  requireIdentity(req, res, () => {
    const u = cp.getUser(req.sess.wsKey, req.sess.userId);
    if (!u || !u.admin) return res.status(403).json({ error: 'Only a Copper admin can change this.' });
    next();
  });
}

// Alphanumeric, because it becomes part of a Vobiz SIP username (and, with
// access tokens, the token's `sub`).
const agentKeyOf = (wsKey, userId) => `cp${crypto.createHash('sha256').update(`${wsKey}|${userId}`).digest('hex').slice(0, 14)}`;

/** End a session: its stream, its SIP routing entry. */
function endSession(token, reason) {
  const s = state.sessions.get(token);
  if (!s) return;
  events.pushToSession(token, { type: 'signed-out', reason });
  events.closeSession(token);
  state.sessions.delete(token);
  if (s.sipUser && !liveSessions().some(([, o]) => o.sipUser === s.sipUser)) {
    state.sipUsers.delete(s.sipUser);
  }
}

function publicSession(s) {
  const ws = cp.getWorkspace(s.wsKey) || {};
  const user = cp.getUser(s.wsKey, s.userId) || {};
  const account = s.authId && state.accounts.get(s.authId);
  return {
    user: { name: s.name, id: s.userId, email: user.email || '', admin: !!user.admin, auth: user.auth || null },
    workspace: { name: ws.name || 'Copper' },
    mode: s.mode || null,
    authId: s.authId || null,
    numbers: s.numbers || [],
    numberApps: account ? Object.fromEntries((s.numbers || []).map(n => [n, (account.numberApps || {})[n] || null])) : {},
    appId: (account && account.appId) || null,
    from: s.from || null,
    sipUser: s.sipUser || null,
    sipAuth: s.sipAuth || null,
    settings: {
      defaultCountry: (ws.settings && ws.settings.defaultCountry) || config.DEFAULT_COUNTRY,
    },
  };
}

function newSession(user) {
  const token = randomToken(32);
  state.sessions.set(token, {
    wsKey: user.wsKey, userId: user.userId, name: user.name,
    agentKey: agentKeyOf(user.wsKey, user.userId), createdAt: Date.now(), mode: null,
  });
  return { token, session: publicSession(state.sessions.get(token)) };
}

// ─── Copper OAuth ────────────────────────────────────────────────────────────

const oauth = express.Router();
const COOKIE = 'vz_cp_oauth';

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

const apiKeysAllowed = () => config.COPPER_ALLOW_API_KEYS || !cp.oauthEnabled();

/** Which ways of connecting Copper this deployment offers. Public: no secrets. */
oauth.get('/options', (req, res) => res.json({ oauth: cp.oauthEnabled(), apiKey: apiKeysAllowed() }));

oauth.get('/start', (req, res) => {
  if (!config.PUBLIC_BASE_URL) return res.status(500).type('text/plain').send('This server has no PUBLIC_BASE_URL, so Copper cannot send you back here. Ask your administrator.');
  if (!cp.oauthEnabled()) return res.status(404).type('text/plain').send('This calling service has no Copper OAuth app. Connect with a Copper API key instead.');
  const st = randomToken(24);
  state.oauthStates.set(st, { exp: Date.now() + 10 * 60 * 1000 });
  // The cookie binds the callback to the browser that started it. Copper
  // comes back with a cross-site form POST, which only carries a
  // SameSite=None cookie, and that must be Secure.
  const secure = config.PUBLIC_BASE_URL.startsWith('https://');
  res.cookie(COOKIE, st, { httpOnly: true, secure, sameSite: secure ? 'none' : 'lax', maxAge: 10 * 60 * 1000, path: '/copper/oauth' });
  return res.redirect(302, cp.authorizeUrl(st));
});

/** Copper sends the user back with a form POST (code or error, and state). */
async function oauthCallback(req, res) {
  const p = { ...req.query, ...(req.body || {}) };
  const st = String(p.state || '');
  const code = String(p.code || '');
  const entry = st && state.oauthStates.get(st);
  const cookie = readCookie(req, COOKIE);
  res.clearCookie(COOKIE, { path: '/copper/oauth' });
  if (!entry || entry.exp < Date.now() || !cookie || !safeEqual(cookie, st)) {
    return res.status(400).type('text/plain').send('This Copper sign-in link is not valid any more. Go back to the softphone and click "Connect Copper" again.');
  }
  state.oauthStates.delete(st);
  // 303: the browser follows a POST callback with a GET.
  if (!code) return res.redirect(303, '/phone#error=denied');
  try {
    const tokens = await cp.exchangeCode(code);
    const cred = { kind: 'oauth', token: tokens.access_token };
    const me = await cp.getMe(cred);
    const user = cp.saveUser(me, cred);
    log(`Copper connected (OAuth): user ${user.userId} of ${user.wsKey}${user.admin ? ' (admin)' : ''}`);
    const link = randomToken(24);
    state.linkCodes.set(link, { wsKey: user.wsKey, userId: user.userId, exp: Date.now() + 2 * 60 * 1000 });
    // A fragment is never sent to any server or written to access logs.
    return res.redirect(303, `/phone#link=${encodeURIComponent(link)}`);
  } catch (err) {
    log(`x Copper connect failed: ${err.message}`);
    return res.redirect(303, '/phone#error=connect');
  }
}
oauth.get('/callback', oauthCallback);
oauth.post('/callback', express.urlencoded({ extended: false, limit: '8kb' }), oauthCallback);

// ─── softphone API ───────────────────────────────────────────────────────────

const api = express.Router();
api.use(express.json({ limit: '32kb' }));

/** Trade the one-time link code from the OAuth redirect for a session. */
api.post('/identity/claim', (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const entry = code && state.linkCodes.get(code);
  if (!entry || entry.exp < Date.now()) return res.status(401).json({ error: 'That link has expired. Connect Copper again.' });
  state.linkCodes.delete(code);
  const user = cp.getUser(entry.wsKey, entry.userId);
  if (!user) return res.status(401).json({ error: 'Connect Copper again.' });
  res.json(newSession(user));
});

/**
 * Connect with a Copper API key (Settings > Integrations > API Keys) and the
 * email of the user who generated it. The pair is checked with Copper, stored
 * encrypted, and never sent back. Calls are then written as the key's owner.
 */
const API_KEY_RE = /^[A-Za-z0-9._-]{16,200}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// The one route that reaches Copper without a session: at most 10 tries a
// minute per client address, so it cannot be used to hammer Copper.
const keyTries = new Map();
function tooManyKeyTries(ip) {
  const now = Date.now();
  for (const [k, t] of keyTries) if (t.reset < now) keyTries.delete(k);
  const t = keyTries.get(ip) || { n: 0, reset: now + 60 * 1000 };
  t.n += 1;
  keyTries.set(ip, t);
  return t.n > 10;
}
api.post('/identity/apikey', async (req, res) => {
  if (!apiKeysAllowed()) return res.status(403).json({ error: 'This calling service connects Copper with OAuth only.' });
  if (tooManyKeyTries(String(req.socket.remoteAddress || ''))) return res.status(429).json({ error: 'Too many tries. Wait a minute.' });
  const apiKey = String((req.body && req.body.apiKey) || '').trim();
  const email = String((req.body && req.body.email) || '').trim();
  if (!API_KEY_RE.test(apiKey) || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your Copper email and paste your Copper API key.' });
  try {
    const cred = { kind: 'apikey', apiKey, email };
    const me = await cp.getMe(cred);
    const user = cp.saveUser(me, cred);
    log(`Copper connected (API key): user ${user.userId} of ${user.wsKey}${user.admin ? ' (admin)' : ''}`);
    res.json(newSession(user));
  } catch (err) {
    log(`x Copper API key refused: ${err.message}`);
    if (err.status === 401) return res.status(401).json({ error: 'Copper did not accept that email and API key. Copy the key again from Copper (Settings, Integrations, API Keys) and use the email of the user who generated it.' });
    res.status(502).json({ error: 'Could not check the key with Copper. Try again.' });
  }
});

api.get('/session', requireIdentity, (req, res) => res.json(publicSession(req.sess)));

api.post('/login', requireIdentity, async (req, res) => {
  const { authId, authToken } = req.body || {};
  if (!AUTH_ID_RE.test(String(authId || '')) || typeof authToken !== 'string' || !authToken) {
    return res.status(400).json({ error: 'Enter your Vobiz Auth ID and Auth Token.' });
  }
  if (!config.PUBLIC_BASE_URL.startsWith('https://')) {
    return res.status(500).json({ error: 'This server has no public https PUBLIC_BASE_URL, so Vobiz could not reach it. Ask your administrator.' });
  }
  const candidate = { authId: String(authId), authToken };
  const list = await v.fetchAccountNumbers(candidate);
  if (!list.all) {
    log(`login refused for ${authId}: Vobiz returned ${list.status} checking the credentials`);
    return res.status(401).json({ error: 'Vobiz did not accept that Auth ID and Auth Token. Copy both from the Vobiz Console and try again.' });
  }
  const account = state.accounts.get(candidate.authId) || { authId: candidate.authId };
  account.authToken = authToken;
  account.numbers = list.all;
  account.callerIds = list.callerIds;
  account.numberApps = list.apps;
  state.accounts.set(account.authId, account);

  const s = req.sess;
  const appId = await v.ensureApplication(account);
  if (!appId) return res.status(502).json({ error: 'Could not find or create the calling application in your Vobiz account.' });

  let sip;
  let bound = true;
  if (config.VOBIZ_SIP_AUTH === 'jwt') {
    // No endpoint: the identity comes from the token's sub. One mint now, so
    // an account that cannot issue tokens fails here and not at registration.
    const minted = await v.mintAccessToken(account, { sub: s.agentKey, appId, ttl: config.VOBIZ_JWT_TTL_SECONDS });
    if (!minted) return res.status(502).json({ error: 'Vobiz would not issue an access token for this account. Try again, or ask your administrator.' });
    sip = { sipAuth: 'jwt', sipUser: v.jwtSipUser(s.agentKey, account.authId), sipPassword: null, endpointId: null };
  } else {
    const ep = await v.ensureEndpoint(account, s.agentKey);
    if (!ep) return res.status(502).json({ error: 'Could not set up your SIP endpoint in your Vobiz account.' });
    bound = await v.bindEndpoint(account, ep.endpointId, appId);
    if (!bound) log(`! ${account.authId}: endpoint ${ep.endpointId} is not bound to ${appId}; outbound calls may not reach /vobiz/answer`);
    sip = { sipAuth: 'endpoint', sipUser: ep.username, sipPassword: ep.password, endpointId: ep.endpointId };
  }

  // One tab per agent: with an endpoint the password just rotated, so another
  // session holds a dead one, and with a token two tabs would both ring. End
  // it: that tab shows "signed in elsewhere" instead of looking ready.
  for (const [t, o] of liveSessions()) {
    if (t !== req.token && o.agentKey === s.agentKey && o.mode) endSession(t, 'elsewhere');
  }
  const d = store.load();
  const links = d.accountLinks[account.authId] || [];
  if (!links.includes(s.wsKey)) { d.accountLinks[account.authId] = [...links, s.wsKey]; store.saveNow(); }

  const numbers = list.callerIds;
  const from = numbers.includes(s.lastCallerId) ? s.lastCallerId : (numbers[0] || '');
  Object.assign(s, { mode: 'account', authId: account.authId, numbers, from, ...sip });
  state.sipUsers.set(sip.sipUser, { authId: account.authId, agentKey: s.agentKey, wsKey: s.wsKey, userId: s.userId, name: s.name, callerId: from });
  log(`login ok: ${account.authId} / ${s.agentKey} as ${sip.sipUser} (${sip.sipAuth}), ${numbers.length} caller ID(s)`);
  res.json({ ...publicSession(s), bound });
});

/**
 * A fresh access token for this tab's SIP identity. The softphone calls it to
 * register and again shortly before each token expires. Only the token goes
 * out; the Auth Token that signed it stays in memory here.
 */
api.post('/sip-token', requireVobiz, async (req, res) => {
  const s = req.sess;
  res.set('Cache-Control', 'no-store');
  if (s.sipAuth !== 'jwt') return res.status(400).json({ error: 'This sign-in uses a SIP password, not an access token.' });
  // Renewal is about once an hour; this only stops a loop from hammering Vobiz.
  if (s.lastMintAt && Date.now() - s.lastMintAt < 5000) return res.status(429).json({ error: 'Too many token requests. Wait a few seconds.' });
  s.lastMintAt = Date.now();
  const account = state.accounts.get(s.authId);
  const minted = await v.mintAccessToken(account, { sub: s.agentKey, appId: account.appId, ttl: config.VOBIZ_JWT_TTL_SECONDS });
  if (!minted) return res.status(502).json({ error: 'Vobiz would not issue an access token. Try again.' });
  res.json({ token: minted.token, exp: minted.exp, sipUser: `${s.sipUser}@${config.VOBIZ_REGISTRAR}` });
});

// There is no "SIP direct" sign-in (an existing endpoint's username and
// password, no account credentials). With no Auth Token the backend cannot
// verify Vobiz callbacks about those calls, and cannot prove the agent owns
// the endpoint, so anyone could claim an endpoint and have its calls logged
// into their Copper account. Agents sign in with their Vobiz account.

api.post('/logout', requireIdentity, (req, res) => {
  endSession(req.token, 'logout');
  res.json({ ok: true });
});

/**
 * The SIP identity this tab registers as, and how: "jwt" (fetch a token from
 * /sip-token) or "endpoint" (with the password minted at this sign-in).
 * Behind the session on purpose: there is no /agent/:id route.
 */
api.get('/agent', requireVobiz, (req, res) => {
  const s = req.sess;
  res.set('Cache-Control', 'no-store');
  res.json({
    sipUser: `${s.sipUser}@${config.VOBIZ_REGISTRAR}`, auth: s.sipAuth,
    ...(s.sipAuth === 'endpoint' ? { sipPassword: s.sipPassword } : {}),
    registrarUrl: `wss://${config.VOBIZ_REGISTRAR}:5063/`, displayName: s.name,
  });
});

api.get('/numbers', requireVobiz, (req, res) => res.json(publicSession(req.sess)));

api.post('/select-number', requireVobiz, (req, res) => {
  const number = String((req.body && req.body.number) || '');
  const s = req.sess;
  if (!s.numbers.includes(number)) return res.status(400).json({ error: 'That number is not one of your Vobiz numbers.' });
  s.from = number;
  s.lastCallerId = number;
  const who = state.sipUsers.get(s.sipUser);
  if (who) who.callerId = number;
  res.json({ from: number });
});

/** "Enable inbound calls": moves the number onto this application. Explicit only. */
api.post('/setup-inbound', requireVobiz, async (req, res) => {
  const s = req.sess;
  const account = state.accounts.get(s.authId);
  const number = String((req.body && req.body.number) || s.from || '');
  if (!s.numbers.includes(number)) return res.status(400).json({ error: 'Pick one of your Vobiz numbers first.' });
  const appId = await v.ensureApplication(account);
  if (!appId) return res.status(502).json({ error: 'Could not find or create the calling application.' });
  const previousAppId = (account.numberApps || {})[number] || null;
  const r = await v.attachNumber(account, number, appId);
  log(`${account.authId}: attach ${number} to ${appId} (was ${previousAppId || 'none'}): HTTP ${r.status}`);
  if (!v.ok(r)) return res.status(502).json({ error: `Vobiz returned ${r.status} attaching ${number}.` });
  account.numberApps = { ...(account.numberApps || {}), [number]: appId };
  res.json({ ok: true, number, appId, previousAppId });
});

const copperErr = (res, err) => res.status(err.code === 'not_connected' ? 401 : 502)
  .json({ error: err.message, code: err.code === 'not_connected' ? 'copper_reconnect' : err.code });

/** The record's last calls through this softphone, for the ringing card. */
function recentFor(s, parent) {
  if (!parent) return [];
  return Object.entries(store.load().calls)
    .filter(([, c]) => c.wsKey === s.wsKey && c.parent && c.parent.type === parent.type && c.parent.id === parent.id && c.activityId)
    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0)).slice(0, 3)
    .map(([callUuid, c]) => ({ callUuid, direction: c.direction, outcome: c.outcome, talkSeconds: c.talkSeconds, startedAt: c.startedAt }));
}

/** Caller lookup: people, then leads, then companies with this number. */
async function lookup(s, number) {
  const country = cp.countryFor(s.wsKey);
  const e164 = toE164(number, country);
  if (!isE164(e164)) return null;
  const people = (await cp.findByPhone(s.wsKey, s.userId, e164, country)).slice(0, 3);
  return { number: e164, people, recent: recentFor(s, people[0] && { type: people[0].type, id: people[0].id }) };
}

/** Caller lookup for the ringing card and the in-call contact card. */
api.get('/lookup', requireIdentity, async (req, res) => {
  try {
    const r = await lookup(req.sess, req.query.number);
    if (!r) return res.status(400).json({ error: 'Not a phone number' });
    res.json(r);
  } catch (err) { copperErr(res, err); }
});

/** Calls this agent handled, newest first, with fresh recording links. */
api.get('/calls', requireIdentity, (req, res) => {
  const s = req.sess;
  const settings = logger.settingsFor(s.wsKey);
  const d = store.load();
  const calls = Object.entries(d.calls)
    .filter(([, c]) => c.wsKey === s.wsKey && c.userId === s.userId && c.logged)
    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0)).slice(0, 20)
    .map(([callUuid, c]) => ({
      callUuid, direction: c.direction, outcome: c.outcome, talkSeconds: c.talkSeconds, remote: c.remote, startedAt: c.startedAt,
      contactName: c.contactName || '', record: c.parent || null,
      recordingUrl: c.recordingId && c.authId ? logger.recordingLink(c.authId, callUuid, settings.recordingTtlSeconds) : null,
    }));
  res.json({ calls });
});

api.get('/events', requireIdentity, (req, res) => events.attach(req.token, res));

/**
 * The softphone's report of an outbound call. Calls that reached /vobiz/answer
 * are logged from the server's own record; this only covers an INVITE that
 * never got there (JsSIP "failed" before Vobiz ran our XML), so no call is
 * ever silently dropped.
 */
const CAUSE_OUTCOME = { Busy: 'busy', Canceled: 'cancelled', 'No Answer': 'no-answer', 'Request Timeout': 'no-answer', Rejected: 'declined' };
api.post('/call-log', requireIdentity, (req, res) => {
  const s = req.sess;
  const b = req.body || {};
  const ref = String(b.ref || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const number = toE164(b.number, cp.countryFor(s.wsKey));
  if (!ref || !isE164(number)) return res.status(400).json({ error: 'ref and number are required' });
  const prior = state.refs.get(ref) || {};
  state.refs.set(ref, { ...prior, report: { cause: String(b.cause || '') }, at: prior.at || Date.now() });
  res.json({ ok: true });
  const t = setTimeout(() => {
    const r = state.refs.get(ref);
    if (!r || r.callUuid || r.panelLogged) return;
    r.panelLogged = true;
    const startedAt = Number(b.startedAt) || Date.now();
    logger.logCall({
      callUuid: `panel-${ref}`, authId: s.authId || null, wsKey: s.wsKey, userId: s.userId, agentName: s.name,
      direction: 'outbound', outcome: CAUSE_OUTCOME[b.cause] || 'failed', talkSeconds: 0, remote: number, did: s.from || '',
      startedAt, endedAt: Date.now(), recordingId: null, hangupCause: String(b.cause || ''),
    });
  }, config.PANEL_REPORT_GRACE_MS);
  if (t.unref) t.unref();
});

/** Other agents of this Copper account and Vobiz account who can take a transfer. */
api.get('/agents', requireVobiz, (req, res) => {
  const s = req.sess;
  const seen = new Set();
  const agents = [];
  for (const [, o] of liveSessions()) {
    if (o.wsKey !== s.wsKey || o.authId !== s.authId || o.mode !== 'account' || o.userId === s.userId || seen.has(o.userId)) continue;
    seen.add(o.userId);
    agents.push({ userId: o.userId, name: o.name });
  }
  res.json({ agents });
});

/** Blind transfer of an inbound caller to another signed-in agent. */
api.post('/transfer', requireVobiz, async (req, res) => {
  const s = req.sess;
  const target = String((req.body && req.body.userId) || '');
  const call = [...state.calls.values()].find(c => c.agentSipUser === s.sipUser && c.answeredAt && !c.endedAt);
  if (!call) return res.status(404).json({ error: 'No answered call to transfer.' });
  if (call.direction !== 'inbound') return res.status(400).json({ error: 'Transfer is available on inbound calls.' });
  const t = liveSessions().map(([, o]) => o).find(o => o.wsKey === s.wsKey && o.authId === s.authId && o.userId === target && o.mode === 'account' && o.sipUser);
  if (!t) return res.status(404).json({ error: 'That agent is not signed in.' });
  const account = state.accounts.get(s.authId);
  state.transfers.set(call.callUuid, { authId: s.authId, targetSipUser: t.sipUser, callerId: call.did, callerName: call.remote, exp: Date.now() + 60 * 1000 });
  const r = await v.transferLeg(account, call.callUuid, 'aleg', `${config.PUBLIC_BASE_URL}/vobiz/transfer-xml`);
  log(`transfer ${call.callUuid} from ${s.agentKey} to ${t.agentKey}: HTTP ${r.status}`);
  if (!v.ok(r)) { state.transfers.delete(call.callUuid); return res.status(502).json({ error: `Vobiz returned ${r.status} for the transfer.` }); }
  events.pushToUser(t.wsKey, t.userId, { type: 'transfer-incoming', callUuid: call.callUuid, from: call.remote, fromAgent: s.name });
  res.json({ ok: true });
});

// ─── Copper panel link ───────────────────────────────────────────────────────
//
// The Copper panel (/copper, framed by Copper) cannot see this tab's session:
// the browser keeps a framed page's storage apart from the same site opened
// as a tab. So the agent links it once: the panel opens /pair in a popup, the
// popup asks the softphone tab (same origin, BroadcastChannel), the softphone
// mints a panel token here and the popup hands it to the panel. The token only
// lets the panel look numbers up and send a number to this agent's softphone;
// it never reaches Vobiz or Copper credentials. Stored as a SHA-256 hash.

const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const MAX_PANELS_PER_USER = 10;

api.post('/panel-link', requireIdentity, (req, res) => {
  const s = req.sess;
  const d = store.load();
  const mine = Object.entries(d.panelLinks).filter(([, l]) => l.wsKey === s.wsKey && l.userId === s.userId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [h] of mine.slice(0, Math.max(0, mine.length - MAX_PANELS_PER_USER + 1))) delete d.panelLinks[h];
  const token = randomToken(32);
  d.panelLinks[hashToken(token)] = { wsKey: s.wsKey, userId: s.userId, createdAt: Date.now(), exp: Date.now() + config.PANEL_LINK_TTL_MS };
  store.saveNow();
  log(`Copper panel linked for ${s.agentKey}`);
  res.set('Cache-Control', 'no-store');
  res.json({ token, name: s.name, workspace: (cp.getWorkspace(s.wsKey) || {}).name || 'Copper' });
});

api.post('/panel-link/revoke', requireIdentity, (req, res) => {
  const s = req.sess;
  const d = store.load();
  let revoked = 0;
  for (const [h, l] of Object.entries(d.panelLinks)) if (l.wsKey === s.wsKey && l.userId === s.userId) { delete d.panelLinks[h]; revoked++; }
  store.saveNow();
  res.json({ ok: true, revoked });
});

const panel = express.Router();
panel.use(express.json({ limit: '8kb' }));

function requirePanel(req, res, next) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const link = token && store.load().panelLinks[hashToken(token)];
  if (!link || link.exp < Date.now()) return res.status(401).json({ error: 'Link this panel to your softphone.', code: 'unlinked' });
  const user = cp.getUser(link.wsKey, link.userId);
  if (!user) return res.status(401).json({ error: 'Connect Copper in the softphone, then link this panel again.', code: 'unlinked' });
  req.link = link;
  req.panelUser = user;
  next();
}

/** The live softphone sessions of the linked agent. */
const softphonesOf = link => liveSessions().map(([, o]) => o).filter(o => o.wsKey === link.wsKey && o.userId === link.userId);

panel.get('/status', requirePanel, (req, res) => {
  const tabs = softphonesOf(req.link);
  res.json({
    name: req.panelUser.name, email: req.panelUser.email || '',
    workspace: (cp.getWorkspace(req.link.wsKey) || {}).name || 'Copper',
    softphone: tabs.some(o => o.mode === 'account') ? 'ready' : (tabs.length ? 'open' : 'closed'),
  });
});

panel.get('/lookup', requirePanel, async (req, res) => {
  try {
    const r = await lookup({ wsKey: req.link.wsKey, userId: req.link.userId }, req.query.number);
    if (!r) return res.status(400).json({ error: 'Not a phone number' });
    res.json(r);
  } catch (err) { copperErr(res, err); }
});

/**
 * A number clicked in Copper. It goes to the agent's open softphone tab,
 * which shows it and waits for the agent to click Call: nothing dials here.
 */
panel.post('/dial', requirePanel, (req, res) => {
  const b = req.body || {};
  const number = toE164(b.number, cp.countryFor(req.link.wsKey));
  if (!isE164(number)) return res.status(400).json({ error: 'That is not a phone number.' });
  // eslint-disable-next-line no-control-regex
  const name = String(b.name || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  const delivered = events.pushToUser(req.link.wsKey, req.link.userId, { type: 'dial', number, name });
  res.json({ delivered, number });
});

// ─── settings (per Copper account; admins change them) ──────────────────────

api.get('/settings', requireIdentity, (req, res) => {
  const s = req.sess;
  const ws = cp.getWorkspace(s.wsKey) || {};
  const u = cp.getUser(s.wsKey, s.userId) || {};
  res.json({ admin: !!u.admin, workspace: ws.name || 'Copper', settings: logger.settingsFor(s.wsKey) });
});

api.post('/settings', requireAdmin, (req, res) => {
  const ws = cp.getWorkspace(req.sess.wsKey);
  if (!ws) return res.status(404).json({ error: 'Connect Copper again.' });
  const b = req.body || {};
  const next = { ...cp.defaultSettings(), ...(ws.settings || {}) };
  if (b.defaultCountry !== undefined && /^[A-Z]{2}$/.test(String(b.defaultCountry))) next.defaultCountry = String(b.defaultCountry);
  if (b.createUnknown !== undefined) next.createUnknown = !!b.createUnknown;
  if (b.unknownAs === 'lead' || b.unknownAs === 'person') next.unknownAs = b.unknownAs;
  if (b.missedTask !== undefined) next.missedTask = !!b.missedTask;
  if (b.recordingTtlSeconds !== undefined) next.recordingTtlSeconds = Math.min(7 * 86400, Math.max(300, Number(b.recordingTtlSeconds) || config.RECORDING_LINK_TTL_SECONDS));
  ws.settings = next;
  store.saveNow();
  res.json({ settings: next });
});

/** Disconnect: "me" forgets this user's credential; "workspace" (admins) forgets the whole account's data. */
api.post('/copper/disconnect', requireIdentity, (req, res) => {
  const s = req.sess;
  const scope = (req.body && req.body.scope) === 'workspace' ? 'workspace' : 'me';
  const u = cp.getUser(s.wsKey, s.userId);
  if (scope === 'workspace' && !(u && u.admin)) return res.status(403).json({ error: 'Only a Copper admin can disconnect the whole account.' });
  for (const [t, o] of liveSessions()) {
    if (o.wsKey === s.wsKey && (scope === 'workspace' || o.userId === s.userId)) endSession(t, 'disconnected');
  }
  if (scope === 'workspace') cp.disconnectWorkspace(s.wsKey); else cp.disconnectUser(s.wsKey, s.userId);
  log(`Copper disconnected: ${scope} ${s.wsKey}${scope === 'me' ? `/${s.userId}` : ''}`);
  res.json({ ok: true });
});

module.exports = { api, oauth, panel, requireIdentity };
