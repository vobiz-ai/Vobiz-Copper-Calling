/**
 * Unit tests for the pieces that are easy to get subtly wrong: phone numbers,
 * Copper phones and ids, the activity's details, Vobiz signatures, and the
 * retry of a Copper write that failed.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vzcp-unit-'));
process.env.PUBLIC_BASE_URL = 'https://calling.example.test';
process.env.SIGNING_SECRET = 'unit-secret';

const { toE164 } = require('../src/util');
const cp = require('../src/copper');
const logger = require('../src/call-logger');
const store = require('../src/store');
const { checkSignature } = require('../src/vobiz-signature');

const API = '/developer_api/v1';
const UNIT_KEY = 'cpTESTunit0000000000000000000001';

test('toE164 handles trunk prefixes, bare national numbers, 00 and SIP URIs', () => {
  assert.equal(toE164('09000000011', 'IN'), '+919000000011');
  assert.equal(toE164('9000000011', 'IN'), '+919000000011');
  assert.equal(toE164('+91 90000 00011', 'IN'), '+919000000011');
  assert.equal(toE164('0091 9000000011', 'IN'), '+919000000011');
  assert.equal(toE164('sip:+919000000011@registrar.vobiz.ai', 'IN'), '+919000000011');
  assert.equal(toE164('(555) 010-0000', 'US'), '+15550100000');
  assert.equal(toE164('12', 'IN'), '');
});

test('phonesOf reads every number on a Copper record, formatted or not', () => {
  const rec = { phone_numbers: [{ number: '+91 90000 00011' }, { number: '+1 555 010 0000' }, { number: '90000 00013' }, { number: '07000000001' }, { number: '' }, null] };
  assert.deepEqual(cp.phonesOf(rec, 'IN'), ['+919000000011', '+15550100000', '+919000000013', '+917000000001'], 'no country code: the default country');
  assert.deepEqual(cp.phonesOf({ phone_numbers: null }, 'IN'), []);
});

test('only integer Copper ids and known record types are accepted, so none can steer a request path', () => {
  assert.equal(cp.isCopperId(27140359), true);
  assert.equal(cp.isCopperId('27140359'), true);
  for (const bad of ['1/../me', '../1', '1?x=1', '', null, undefined, '1e5', '-1', '1234567890123456']) assert.equal(cp.isCopperId(bad), false, String(bad));
  assert.equal(cp.isRecordType('person'), true);
  for (const bad of ['opportunity', 'people', '__proto__', '']) assert.equal(cp.isRecordType(bad), false, bad);
});

test('the activity details: plain text, direction, outcome, talk time, numbers and the call UUID', () => {
  const s = {
    direction: 'inbound', outcome: 'missed', agentName: '<b>x</b>', talkSeconds: 0,
    remote: '+919000000011', did: '+910000000001', startedAt: 1000, callUuid: 'u-1', authId: 'MA_TEST0001',
  };
  const t = logger.detailsText(s, null);
  assert.match(t, /^Vobiz inbound call, missed$/m);
  assert.match(t, /^Agent: <b>x<\/b>$/m, 'kept as text: Copper shows details as text');
  assert.match(t, /^Talk time: 0s$/m);
  assert.match(t, /^Customer number: \+919000000011$/m);
  assert.match(t, /^Vobiz number: \+910000000001$/m);
  assert.match(t, /^Started: 1970-01-01 00:00 UTC$/m);
  assert.match(t, /^Call UUID: u-1$/m);
  assert.match(t, /^Recording: none$/m);
  const answered = logger.detailsText({ ...s, outcome: 'answered', talkSeconds: 61.4 }, 'https://calling.example.test/recordings/u-1?x');
  assert.match(answered, /^Talk time: 1m 1s$/m);
  assert.match(answered, /^Recording: https:\/\/calling\.example\.test\/recordings\/u-1\?x /m);
  assert.match(logger.detailsText({ ...s, outcome: 'answered' }, null), /^Recording: processing/m);
});

test('Vobiz signature: V3 over URL + "." + nonce, V2 without the dot, never the body', () => {
  const url = 'https://calling.example.test/vobiz/answer';
  const v3 = crypto.createHmac('sha256', 'tok').update(`${url}.n1`).digest('base64');
  const v2 = crypto.createHmac('sha256', 'tok').update(`${url}n2`).digest('base64');
  assert.equal(checkSignature({ 'x-vobiz-signature-v3': v3, 'x-vobiz-signature-v3-nonce': 'n1' }, ['tok'], url), 'valid');
  assert.equal(checkSignature({ 'x-vobiz-signature-v2': v2, 'x-vobiz-signature-v2-nonce': 'n2' }, ['tok'], url), 'valid');
  assert.equal(checkSignature({ 'x-vobiz-signature-v3': v3, 'x-vobiz-signature-v3-nonce': 'n1' }, ['other'], url), 'invalid');
  assert.equal(checkSignature({}, ['tok'], url), 'absent');
});

/** A fake Copper for the logger tests below: counts requests, fails on demand. */
function fakeCopper(fail, { known = true, phoneCall = true } = {}) {
  const seen = [];
  let n = 0;
  global.fetch = async (url, opts = {}) => {
    const p = new URL(url).pathname.replace(API, '');
    const key = `${opts.method || 'GET'} ${p}`;
    const h = opts.headers || {};
    seen.push({ key, body: opts.body ? JSON.parse(opts.body) : null, token: h['X-PW-AccessToken'], email: h['X-PW-UserEmail'], app: h['X-PW-Application'] });
    const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (fail[key] > 0) { fail[key]--; return ok({ message: 'boom' }, 503); }
    if (key === 'POST /people/search') return ok(known ? [{ id: 4401, name: 'Known Caller', phone_numbers: [{ number: '+919000000099' }] }] : []);
    if (key === 'POST /leads/search' || key === 'POST /companies/search') return ok([]);
    if (key === 'POST /leads') return ok({ id: 4501, name: opts.body && JSON.parse(opts.body).name });
    if (key === 'POST /people') return ok({ id: 4601 });
    if (key === 'GET /activity_types') return ok({ user: [{ id: 0, name: 'Note' }, { id: 190711, name: 'Phone Call', is_disabled: !phoneCall }] });
    if (key === 'POST /activities') return ok({ id: 3064242000 + (++n) });
    if (key.startsWith('PUT /activities/')) return ok({ id: 1 });
    if (key === 'POST /tasks') return ok({ id: 3726701 });
    return ok({}, 404);
  };
  return seen;
}

function unitAccount(name) {
  const accountId = String(10000 + Object.keys(store.load().workspaces).length);
  const wsKey = cp.wsKeyOf(accountId);
  const d = store.load();
  d.workspaces[wsKey] = { wsKey, accountId, name, settings: cp.defaultSettings() };
  d.users[`${wsKey}:811001`] = { wsKey, userId: '811001', name: 'Unit Agent', email: 'unit@acme.test', admin: true, auth: 'apikey', secret: store.encrypt(UNIT_KEY), broken: false };
  return wsKey;
}

test('a Copper write that fails is queued, then written once by the retry; the lead made on the first try is reused', async () => {
  const wsKey = unitAccount('retry');
  const seen = fakeCopper({ 'POST /activities': 1 }, { known: false });
  const snap = {
    callUuid: 'unit-call-1', authId: null, wsKey, userId: '811001', agentName: 'Unit Agent', direction: 'inbound', outcome: 'missed',
    talkSeconds: 0, remote: '+917000000009', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  };
  assert.equal(await logger.logCall(snap), null);
  assert.equal(store.load().pending.length, 1);
  assert.match(store.load().pending[0].lastError, /HTTP 503/);
  store.load().pending[0].nextAt = 0;
  await logger.retryPending();
  assert.equal(store.load().pending.length, 0);
  assert.equal(store.load().calls['unit-call-1'].activityId, '3064242001');
  assert.equal(seen.filter(s => s.key === 'POST /leads').length, 1, 'the lead made on the first try is reused, not created twice');
  assert.deepEqual(seen.find(s => s.key === 'POST /leads').body, { name: 'Caller +917000000009', phone_numbers: [{ number: '+917000000009', category: 'mobile' }] });
  const task = seen.filter(s => s.key === 'POST /tasks');
  assert.equal(task.length, 1);
  assert.deepEqual(task[0].body.related_resource, { type: 'lead', id: 4501 });
  assert.equal(task[0].body.assignee_id, 811001);
  assert.equal(task[0].body.name, 'Call back +917000000009');
  assert.equal(await logger.logCall(snap), store.load().calls['unit-call-1'], 'a logged call is never written again');
  assert.equal(seen.filter(s => s.key === 'POST /activities').length, 2, 'one failure, one success');
  assert.ok(seen.every(s => s.token === UNIT_KEY && s.email === 'unit@acme.test' && s.app === 'developer_api'), 'every request as the agent\'s own key');
});

test('the activity is a Phone Call on the matched record; a disabled Phone Call type falls back to a Note', async () => {
  const wsKey = unitAccount('type');
  let seen = fakeCopper({});
  await logger.logCall({
    callUuid: 'unit-type-1', authId: null, wsKey, userId: '811001', agentName: 'A', direction: 'outbound', outcome: 'answered',
    talkSeconds: 42, remote: '+919000000099', did: '+910000000001', startedAt: 1700000000000, endedAt: 1700000042000,
  });
  const a = seen.find(s => s.key === 'POST /activities').body;
  assert.deepEqual(a.parent, { type: 'person', id: 4401 });
  assert.deepEqual(a.type, { category: 'user', id: 190711 });
  assert.equal(a.activity_date, 1700000000, 'seconds, when the call started');
  assert.match(a.details, /^Vobiz outbound call, answered$/m);
  assert.equal(seen.filter(s => s.key === 'GET /activity_types').length, 1);

  const ws2 = unitAccount('note');
  seen = fakeCopper({}, { phoneCall: false });
  await logger.logCall({
    callUuid: 'unit-type-2', authId: null, wsKey: ws2, userId: '811001', agentName: 'A', direction: 'outbound', outcome: 'busy',
    talkSeconds: 0, remote: '+919000000099', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  });
  assert.deepEqual(seen.find(s => s.key === 'POST /activities').body.type, { category: 'user', id: 0 });
});

test('a failed call-back task is not retried and never duplicates the call', async () => {
  const wsKey = unitAccount('task');
  const seen = fakeCopper({ 'POST /tasks': 1 });
  const snap = {
    callUuid: 'unit-task-1', authId: null, wsKey, userId: '811001', agentName: '', direction: 'inbound', outcome: 'missed',
    talkSeconds: 0, remote: '+919000000099', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  };
  const saved = await logger.logCall(snap);
  assert.equal(saved.logged, true);
  assert.deepEqual(saved.parent, { type: 'person', id: '4401' });
  assert.equal(seen.filter(s => s.key === 'POST /activities').length, 1);
});

test('a log written after the recording arrived keeps the recording', async () => {
  const wsKey = unitAccount('rec');
  const seen = fakeCopper({});
  // What /vobiz/recording stores when the file is ready before the call is logged.
  store.putCall('unit-rec-1', { recordingId: 'rec-early', authId: 'MA_TEST0001', wsKey });
  const snap = {
    callUuid: 'unit-rec-1', authId: 'MA_TEST0001', wsKey, userId: '811001', agentName: 'Unit Agent', direction: 'inbound', outcome: 'answered',
    talkSeconds: 30, remote: '+919000000099', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(), recordingId: null,
  };
  const saved = await logger.logCall(snap);
  assert.equal(saved.recordingId, 'rec-early', 'not overwritten with the snapshot\'s null');
  assert.equal(saved.recordingNoted, true);
  const a = seen.find(s => s.key === 'POST /activities').body;
  assert.match(a.details, /^Recording: https:\/\/calling\.example\.test\/recordings\/unit-rec-1\?aid=MA_TEST0001&/m);
  assert.equal(seen.filter(s => s.key.startsWith('PUT')).length, 0, 'the link went in with the activity, no extra update');
});

test('unknown number with "create a record" off: nothing is written, nothing is retried', async () => {
  const wsKey = unitAccount('norecord');
  store.load().workspaces[wsKey].settings.createUnknown = false;
  const seen = fakeCopper({}, { known: false });
  const saved = await logger.logCall({
    callUuid: 'unit-norecord-1', authId: null, wsKey, userId: '811001', agentName: '', direction: 'outbound', outcome: 'answered',
    talkSeconds: 5, remote: '+917000000008', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  });
  assert.equal(saved.skipped, 'no-record');
  assert.deepEqual(seen.map(s => s.key), ['POST /people/search', 'POST /leads/search', 'POST /companies/search']);
  assert.ok(!store.load().pending.some(p => p.callUuid === 'unit-norecord-1'));
});

test('"unknown numbers become a person" creates a person, not a lead', async () => {
  const wsKey = unitAccount('person');
  store.load().workspaces[wsKey].settings.unknownAs = 'person';
  const seen = fakeCopper({}, { known: false });
  await logger.logCall({
    callUuid: 'unit-person-1', authId: null, wsKey, userId: '811001', agentName: '', direction: 'outbound', outcome: 'answered',
    talkSeconds: 5, remote: '+917000000007', did: '+910000000001', startedAt: Date.now(), endedAt: Date.now(),
  });
  assert.equal(seen.filter(s => s.key === 'POST /people').length, 1);
  assert.equal(seen.filter(s => s.key === 'POST /leads').length, 0);
  assert.deepEqual(seen.find(s => s.key === 'POST /activities').body.parent, { type: 'person', id: 4601 });
});

test('a 401 from Copper marks the user as needing to reconnect; later writes are queued, not sent', async () => {
  const wsKey = unitAccount('revoked');
  global.fetch = async () => new Response(JSON.stringify({ message: 'Invalid credentials' }), { status: 401 });
  await assert.rejects(cp.api(wsKey, '811001', 'GET', '/users/me'), e => e.code === 'not_connected');
  assert.equal(cp.getUser(wsKey, '811001').broken, true);
  assert.equal(cp.writerFor(wsKey, '811001'), null);
});

test('the verifier accepts a nonce once per URL', () => {
  const { makeVerifier } = require('../src/vobiz-signature');
  const verify = makeVerifier({ mode: 'require', publicBaseUrl: 'https://calling.example.test' });
  const sign = (p, nonce) => crypto.createHmac('sha256', 'tok').update(`https://calling.example.test${p}.${nonce}`).digest('base64');
  const reqFor = (p, nonce) => ({ headers: { 'x-vobiz-signature-v3': sign(p, nonce), 'x-vobiz-signature-v3-nonce': nonce } });
  assert.equal(verify(reqFor('/vobiz/answer', 'n-1'), '/vobiz/answer', ['tok']), true);
  assert.equal(verify(reqFor('/vobiz/answer', 'n-1'), '/vobiz/answer', ['tok']), false, 'replay');
  assert.equal(verify(reqFor('/vobiz/hangup', 'n-1'), '/vobiz/hangup', ['tok']), true, 'same nonce on another URL is another signature');
});
