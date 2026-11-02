/* ============================================================================
   api/_lib/auto-reply.test.js
   ----------------------------------------------------------------------------
   Auto Reply through the real webhook route and the real admin route, over the
   in-memory Firestore.

   Meta and Gemini are a stubbed fetch. These tests prove what this code does with
   their answers, not that they answer this way: that takes a real delivery from
   Instagram, which only the live account can give.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

delete process.env.OWNER_UID;
const TOKEN = 'EAAtest-token-not-real';
const SECRET = 'test-app-secret-not-real';
const OWN = '17841400000000000';
process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN = TOKEN;
process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = OWN;
process.env.INSTAGRAM_APP_SECRET = SECRET;
process.env.GEMINI_API_KEY = 'test-gemini-key-not-real';

const { createFakeFirestore, FieldValue } = require('./testing/fake-firestore');
const firebase = require('./firebase');
let fake = createFakeFirestore();
/* the limiter counts with increment(), which this store only understands from its own */
firebase.admin = { firestore: { FieldValue } };
firebase.auth = () => ({
  verifyIdToken: async token => {
    const who = {
      'owner-token': { uid: 'ownerUid000001', email: 'Stark.ai.India@gmail.com', email_verified: true },
      'shop-token': { uid: 'shopUid0000001', email: 'shop@example.com', email_verified: true }
    }[token];
    if (!who) { const e = new Error('bad'); e.code = 'auth/argument-error'; throw e; }
    return who;
  }
});
firebase.db = () => fake.db;

const hook = require('../razorpay-webhook');
const admin = require('../admin');
const responder = require('../_services/auto-reply/responder');
const events = require('../_services/auto-reply/events');
const replies = require('../_services/auto-reply/service');

const reply = (status, body) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body });
const GOOD = { intent: 'compatibility', should_reply: true, needs_human: false, confidence: 0.9, reply: 'Yes, this glass fits.' };

/** Meta and Gemini, as far as these tests need them. */
function network(model) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body || '' });
    if (u.includes('generativelanguage')) {
      if (model === 'down') return reply(500, { error: { message: 'down' } });
      return reply(200, { status: 'completed', model: 'gemini-test', output_text: JSON.stringify(model || GOOD), usage: { total_input_tokens: 10, total_output_tokens: 5 } });
    }
    if (u.includes('/replies')) return reply(200, { id: 'reply_1' });
    if (u.includes('me/messages')) return reply(200, { message_id: 'mid_sent' });
    if (u.includes('/me?')) return reply(200, { id: 'page1', name: 'The Page', instagram_business_account: { id: OWN } });
    return reply(200, { caption: 'Realme 5 tempered glass' });
  };
  return { calls, restore() { global.fetch = real; }, model: () => calls.filter(c => c.url.includes('generativelanguage')), sent: () => calls.filter(c => c.method === 'POST' && c.url.includes('graph.')) };
}

function fresh(settings) {
  fake = createFakeFirestore();
  return replies.saveSettings(Object.assign({ mode: 'review', links: 'https://play.google.com/store/apps/details?id=x' }, settings));
}

function deliver(payload, secret) {
  const raw = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.url = '/api/razorpay-webhook.js?source=instagram';
  req.headers = { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', secret || SECRET).update(raw).digest('hex') };
  return send(hook, req);
}
function send(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
      end(b) { let body = b; try { body = JSON.parse(b); } catch (e) { /* plain text */ } resolve({ status: this.statusCode, body }); }
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const adminCall = (token, method, query, body) => send(admin, {
  method, url: '/api/admin/auto-reply', query: Object.assign({ section: 'auto-reply' }, query || {}),
  headers: token ? { authorization: 'Bearer ' + token } : {}, body
});

let seq = 0;
const commentEvent = (text, from) => ({
  object: 'instagram',
  entry: [{ id: OWN, time: 1, changes: [{ field: 'comments', value: {
    from: { id: from || 'user1', username: 'customer' }, comment_id: 'c' + (++seq), text, media: { id: 'media1' }
  } }] }]
});
const messageEvent = (text, from) => ({
  object: 'instagram',
  entry: [{ id: OWN, time: 1, messaging: [{ sender: { id: from || 'user1' }, recipient: { id: OWN }, timestamp: 1, message: { mid: 'm' + (++seq), text } }] }]
});
const stored = async () => (await fake.db.collection('autoReplyEvents').get()).docs.map(d => d.data());

/* ------------------------------------------------------------ the handshake */
test('Meta\'s handshake needs the verify token, and nothing else is echoed', async () => {
  const shake = (t, c) => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = `/api/razorpay-webhook.js?source=instagram&hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=${c}`;
    req.headers = {};
    return send(hook, req);
  };
  const good = await shake(replies.verifyToken(), '12345');
  assert.equal(good.status, 200);
  assert.equal(good.body, 12345);
  assert.equal((await shake('wrong', '12345')).status, 403);
  assert.equal((await shake(replies.verifyToken(), '<script>')).status, 403);
  assert.ok(!replies.verifyToken().includes(SECRET));
});

test('a delivery with the wrong signature is refused before anything is stored', async () => {
  await fresh();
  const n = network();
  try {
    assert.equal((await deliver(commentEvent('hello'), 'someone-else')).status, 403);
    assert.equal((await stored()).length, 0);
    assert.equal(n.calls.length, 0);
  } finally { n.restore(); }
});

/* -------------------------------------------------------------- parsing */
test('both comment shapes are read, and the account\'s own words are not', () => {
  const instagramLogin = { object: 'instagram', entry: [{ id: OWN, field: 'comments', value: { id: 'c1', from: { id: 'u', username: 'a' }, text: 'hi', media: { id: 'm' } } }] };
  assert.equal(events.parse(instagramLogin)[0].targetId, 'c1');
  assert.equal(events.parse(commentEvent('hi'))[0].kind, 'comment');
  assert.equal(events.parse(commentEvent('mine', OWN)).length, 0, 'its own reply comes back as a comment');
  const echo = messageEvent('sent by us');
  echo.entry[0].messaging[0].message.is_echo = true;
  assert.equal(events.parse(echo).length, 0);
  assert.equal(events.parse({ object: 'page', entry: [] }).length, 0);
});

/* --------------------------------------------------------------- catalogue */
test('a phone is found in the way people write, and only an exact phone counts', () => {
  const names = responder.phonesIn('realme 5 ku indha temper match aaguma bro').map(p => p.name.toLowerCase());
  assert.ok(names.some(n => n.includes('realme 5')), JSON.stringify(names));
  assert.equal(responder.phonesIn('super glass bro, price?').length, 0);
});

test('the facts carry at most the names allowed, and no part code', () => {
  const phones = responder.phonesIn('realme 5');
  const facts = responder.factsFor(phones, 'temper', 2);
  assert.ok(facts.length > 0);
  assert.ok(!/MPF|SG-\d/i.test(facts), facts);
  facts.split('\n').filter(l => l.startsWith('- ') && l.includes('same part as')).forEach(l => {
    assert.ok(l.split(' and ')[0].split(',').length <= 2, l);
  });
});

/* -------------------------------------------------------------- the guard */
test('the guard reads the reply itself', () => {
  const s = { blocked: 'Mobile Parts Finder', links: 'https://play.google.com/store/apps/details?id=x' };
  assert.equal(responder.guard('Fits well', 'comment', s), null);
  assert.equal(responder.guard('', 'comment', s), 'empty');
  assert.equal(responder.guard('see mobile parts finder', 'comment', s), 'blocked-word');
  assert.equal(responder.guard('see https://evil.example/x', 'comment', s), 'unknown-link');
  assert.equal(responder.guard('see www.evil.example', 'comment', s), 'unknown-link');
  assert.equal(responder.guard('see https://play.google.com/store/apps', 'comment', s), null);
  assert.equal(responder.guard('த'.repeat(400), 'dm', s), 'too-long', 'Meta counts bytes, and Tamil is three each');
  assert.equal(responder.guard('த'.repeat(300), 'dm', s), null);
});

/* --------------------------------------------------------------- the pipe */
test('in review a reply is written and waits: nothing reaches Instagram', async () => {
  await fresh();
  const n = network();
  try {
    assert.equal((await deliver(commentEvent('realme 5 ku match aaguma'))).status, 200);
    const [e] = await stored();
    assert.equal(e.status, 'draft');
    assert.equal(e.reply, GOOD.reply);
    assert.equal(n.sent().length, 0);
  } finally { n.restore(); }
});

test('the same delivery twice is one reply and one AI call', async () => {
  await fresh({ mode: 'auto' });
  const n = network();
  try {
    const event = commentEvent('realme 5 ku match aaguma');
    await deliver(event);
    await deliver(event);
    assert.equal((await stored()).length, 1);
    assert.equal(n.model().length, 1);
    assert.equal(n.sent().filter(c => c.url.includes('/replies')).length, 1);
  } finally { n.restore(); }
});

test('in auto a comment is answered on its thread and a message by message', async () => {
  await fresh({ mode: 'auto' });
  const n = network();
  try {
    await deliver(commentEvent('realme 5 ku match aaguma'));
    await deliver(messageEvent('realme 5 glass irukka', 'user2'));
    const list = await stored();
    assert.deepEqual(list.map(e => e.status), ['sent', 'sent']);
    assert.ok(n.calls.some(c => /\/c\d+\/replies/.test(c.url)));
    const dm = n.calls.filter(c => c.url.includes('me/messages'))[0];
    assert.deepEqual(JSON.parse(dm.body), { recipient: { id: 'user2' }, message: { text: GOOD.reply } });
  } finally { n.restore(); }
});

for (const [name, model, reason] of [
  ['the model asks for a person', Object.assign({}, GOOD, { needs_human: true }), 'needs-human'],
  ['the model is unsure', Object.assign({}, GOOD, { confidence: 0.3 }), 'low-confidence'],
  ['the reply names the other brand', Object.assign({}, GOOD, { reply: 'Try Mobile Parts Finder' }), 'blocked-word'],
  ['the reply carries a stranger\'s link', Object.assign({}, GOOD, { reply: 'see https://evil.example' }), 'unknown-link']
]) {
  test(`even in auto nothing goes out when ${name}`, async () => {
    await fresh({ mode: 'auto' });
    const n = network(model);
    try {
      await deliver(commentEvent('realme 5 ku match aaguma'));
      const [e] = await stored();
      assert.equal(e.status, 'needs_human');
      assert.equal(e.reason, reason);
      assert.equal(n.sent().length, 0);
    } finally { n.restore(); }
  });
}

test('praise needs no reply, and off spends nothing', async () => {
  await fresh({ mode: 'auto' });
  let n = network(Object.assign({}, GOOD, { should_reply: false, reply: '' }));
  try {
    await deliver(commentEvent('super bro'));
    assert.equal((await stored())[0].status, 'ignored');
    assert.equal(n.sent().length, 0);
  } finally { n.restore(); }

  await fresh({ mode: 'off' });
  n = network();
  try {
    await deliver(commentEvent('realme 5?'));
    assert.equal((await stored())[0].status, 'skipped');
    assert.equal(n.calls.length, 0);
  } finally { n.restore(); }
});

test('a phone number in a message reaches neither the model nor the record', async () => {
  await fresh();
  const n = network();
  try {
    await deliver(messageEvent('realme 5 glass, call me on 9876543210'));
    assert.ok(!n.model()[0].body.includes('9876543210'));
    assert.ok(!JSON.stringify(await stored()).includes('9876543210'));
  } finally { n.restore(); }
});

test('the model being down loses nothing: Meta gets a 200 and the page can try again', async () => {
  await fresh({ mode: 'auto' });
  let n = network('down');
  let id;
  try {
    assert.equal((await deliver(commentEvent('realme 5 ku match aaguma'))).status, 200);
    const snap = await fake.db.collection('autoReplyEvents').get();
    id = snap.docs[0].id;
    assert.equal(snap.docs[0].data().status, 'failed');
  } finally { n.restore(); }

  n = network();
  try {
    assert.equal((await adminCall('owner-token', 'POST', {}, { action: 'retry', id })).status, 200);
    assert.equal((await stored())[0].status, 'sent');
  } finally { n.restore(); }
});

test('one person cannot run the account out of replies', async () => {
  await fresh({ mode: 'auto', perSenderHour: 2 });
  const n = network();
  try {
    for (let i = 0; i < 4; i++) await deliver(messageEvent('realme 5 glass ' + i));
    const list = await stored();
    assert.equal(list.filter(e => e.status === 'sent').length, 2);
    assert.equal(list.filter(e => e.reason === 'sender-limit').length, 2);
  } finally { n.restore(); }
});

/* -------------------------------------------------------------- the page */
test('only the owner reaches the page, and no secret is on it', async () => {
  await fresh();
  assert.equal((await adminCall(null, 'GET', { view: 'overview' })).status, 401);
  assert.equal((await adminCall('shop-token', 'GET', { view: 'overview' })).status, 403);
  assert.equal((await adminCall('shop-token', 'POST', {}, { action: 'save', settings: { mode: 'auto' } })).status, 403);

  const page = await adminCall('owner-token', 'GET', { view: 'overview' });
  assert.equal(page.status, 200);
  const raw = JSON.stringify(page.body);
  assert.ok(!raw.includes(TOKEN) && !raw.includes(SECRET) && !raw.includes('test-gemini-key'));
  assert.equal(page.body.connection.verifyToken, replies.verifyToken());
});

test('settings stay in range, and an unknown mode falls back to review', async () => {
  await fresh();
  const r = await adminCall('owner-token', 'POST', {}, { action: 'save', settings: { mode: 'chaos', maxNames: 999, minConfidence: 9 } });
  assert.equal(r.body.settings.mode, 'review');
  assert.equal(r.body.settings.maxNames, 20);
  assert.equal(r.body.settings.minConfidence, 1);
});

test('a test message writes a reply and sends nothing', async () => {
  await fresh();
  const n = network();
  try {
    const r = await adminCall('owner-token', 'POST', {}, { action: 'test', text: 'realme 5 ku match aaguma', kind: 'comment' });
    assert.equal(r.body.reply, GOOD.reply);
    assert.equal(n.sent().length, 0);
    assert.equal((await stored()).length, 0);
  } finally { n.restore(); }
});

test('Send takes the owner\'s edit, still passes the guard, and happens once', async () => {
  await fresh();
  const n = network();
  try {
    await deliver(commentEvent('realme 5 ku match aaguma'));
    const id = (await fake.db.collection('autoReplyEvents').get()).docs[0].id;
    const blocked = await adminCall('owner-token', 'POST', {}, { action: 'send', id, reply: 'from mobilepartsfinder' });
    assert.equal(blocked.status, 409);
    assert.equal(n.sent().length, 0);

    assert.equal((await adminCall('owner-token', 'POST', {}, { action: 'send', id, reply: 'Edited by the owner' })).status, 200);
    assert.ok(n.calls.some(c => c.url.includes('/replies') && c.url.includes('Edited+by+the+owner')));
    assert.equal((await adminCall('owner-token', 'POST', {}, { action: 'send', id, reply: 'Again' })).status, 409);
    assert.equal(n.sent().filter(c => c.url.includes('/replies')).length, 1);
  } finally { n.restore(); }
});
