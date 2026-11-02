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
const GOOD = { intent: 'compatibility', should_reply: true, needs_human: false, claims_fit: false, confidence: 0.9, reply: 'Yes, this glass fits.' };

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
    if (u.includes('/messages')) return reply(200, { message_id: 'mid_sent' });
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

test('a phone is known by the name people use for it', () => {
  const name = text => responder.phonesIn(text).map(p => p.name);
  assert.deepEqual(name('iphone 14 ku temper irukka'), ['Apple iPhone 14']);
  assert.deepEqual(name('samsung a52 glass'), ['Samsung Galaxy A52']);
  assert.deepEqual(name('a52'), [], 'Oppo and Samsung both have one, so it is a question');
  assert.deepEqual(name('note 10'), []);
});

test('the facts carry at most the names allowed, and no part code', async () => {
  const phones = responder.phonesIn('realme 5');
  const facts = await responder.factsFor(phones, 'temper', 2);
  assert.ok(facts.length > 0);
  assert.ok(!/MPF|SG-\d/i.test(facts), facts);
  facts.split('\n').filter(l => l.startsWith('- ') && l.includes('same part as')).forEach(l => {
    assert.ok(l.split(' and ')[0].split(',').length <= 2, l);
  });
});

test('"will this fit" is answered from the groups, against the phones in the post', async () => {
  const search = require('../_services/search-service');
  const [phone] = responder.phonesIn('realme 5');
  const compat = search.compatibilityFor(phone.id);
  const glass = compat.categories.filter(c => /guard|glass/i.test(c.categoryName))[0];
  const member = glass && glass.groups[0].members.filter(m => m.id !== phone.id)[0];
  if (!member) return;                     /* the fitment file is not in every checkout */
  const sameGlass = await responder.factsFor([phone], 'temper', 2, [{ id: member.id, name: member.name }]);
  assert.match(sameGlass, /take the same .*\? YES\./);
  const stranger = await responder.factsFor([phone], 'temper', 2, [{ id: 'not-in-this-group', name: 'Another Phone' }]);
  assert.match(stranger, /take the same .*\? NO\./);
  assert.ok(!/take the same/.test(await responder.factsFor([phone], 'temper', 2, [])));
});

test('a reply to a comment is told what the post is about', async () => {
  await fresh();
  const n = network();
  try {
    await deliver(commentEvent('realme 5 ku match aaguma'));
    const prompt = n.model()[0].body;
    assert.ok(prompt.includes('Realme 5 tempered glass'), 'the caption reaches the model');
    assert.ok(prompt.includes('take the same'), 'with the answer worked out');
  } finally { n.restore(); }
});

test('a phone with no record says so, rather than saying nothing fits', async () => {
  const phone = { id: 'not-a-real-model', name: 'Nokia 0000' };
  assert.equal(await responder.factsFor([phone], 'glass', 3), 'Nokia 0000\n- Nothing is recorded for this phone yet.');
});

test('with no names allowed the facts give a count', async () => {
  const facts = await responder.factsFor(responder.phonesIn('realme 5'), 'temper', 0);
  assert.ok(!/same part as/.test(facts), facts);
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
    const dm = n.calls.filter(c => c.url.includes(`/${OWN}/messages`))[0];
    assert.deepEqual(JSON.parse(dm.body), { recipient: { id: 'user2' }, message: { text: GOOD.reply } });
  } finally { n.restore(); }
});

for (const [name, model, reason] of [
  ['the model asks for a person', Object.assign({}, GOOD, { needs_human: true }), 'needs-human'],
  ['the model is unsure', Object.assign({}, GOOD, { confidence: 0.3 }), 'low-confidence'],
  ['the reply names the other brand', Object.assign({}, GOOD, { reply: 'Try Mobile Parts Finder' }), 'blocked-word'],
  ['the reply carries a stranger\'s link', Object.assign({}, GOOD, { reply: 'see https://evil.example' }), 'unknown-link'],
  ['it claims a fit nothing was checked against', Object.assign({}, GOOD, { claims_fit: true }), 'unchecked-fit']
]) {
  test(`even in auto nothing goes out when ${name}`, async () => {
    await fresh({ mode: 'auto' });
    const n = network(model);
    try {
      await deliver(commentEvent('nice, does it fit'));
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

test('a token refused as the account goes through the linked Page instead', async () => {
  const { createMetaClient } = require('../_services/auto-reply/meta');
  const seen = [];
  const client = createMetaClient({
    token: 'EAAuser', igUserId: OWN,
    fetchImpl: async url => {
      const u = String(url);
      seen.push(u);
      if (u.includes(`/${OWN}/messages`)) return reply(400, { error: { code: 3, message: 'no capability' } });
      if (u.includes('me/accounts')) return reply(200, { data: [{ id: 'page1', access_token: 'PAGE', instagram_business_account: { id: OWN } }] });
      return reply(200, { message_id: 'via_page' });
    }
  });
  assert.equal(await client.sendMessage('user1', 'hi'), 'via_page');
  assert.ok(seen[seen.length - 1].includes('me/messages') && seen[seen.length - 1].includes('access_token=PAGE'));
});

test('a Page is subscribed with a Page\'s fields, and the first refusal is the one reported', async () => {
  const { createMetaClient } = require('../_services/auto-reply/meta');
  const seen = [];
  const client = createMetaClient({
    token: 'EAAuser', igUserId: OWN,
    fetchImpl: async url => {
      const u = String(url);
      seen.push(u);
      if (u.includes('me/accounts')) return reply(200, { data: [{ id: 'page1', access_token: 'PAGE', instagram_business_account: { id: OWN } }] });
      if (u.includes(`/${OWN}/subscribed_apps`)) return reply(400, { error: { code: 200, message: 'the token lacks a permission' } });
      return reply(400, { error: { code: 100, message: 'a Page has no such field' } });
    }
  });
  await assert.rejects(client.subscribe(), /lacks a permission/);
  const page = seen.filter(u => u.includes('/page1/subscribed_apps'))[0];
  assert.equal(new URL(page).searchParams.get('subscribed_fields'), 'feed,messages');
});

test('a rate limit is not retried through the Page', async () => {
  const { createMetaClient } = require('../_services/auto-reply/meta');
  let calls = 0;
  const client = createMetaClient({
    token: 'EAAuser', igUserId: OWN,
    fetchImpl: async () => { calls++; return reply(429, { error: { code: 4, message: 'slow down' } }); }
  });
  await assert.rejects(client.sendMessage('user1', 'hi'), /rate limit/i);
  assert.equal(calls, 1);
});

test('Connect webhook points the app here with its own token, then starts the account', async () => {
  await fresh();
  const n = network();
  const real = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('debug_token')) {
      return reply(200, { data: { is_valid: true, type: 'SYSTEM_USER', app_id: '1988', scopes: ['instagram_basic'] } });
    }
    return real(url, init);
  };
  try {
    assert.equal((await adminCall('owner-token', 'POST', {}, { action: 'subscribe' })).status, 200);
    const hook = n.calls.filter(c => c.method === 'POST' && c.url.includes('/1988/subscriptions'))[0];
    const params = new URL(hook.url).searchParams;
    assert.equal(params.get('callback_url'), 'https://www.mobilepartsfinder.com/api/instagram-webhook');
    assert.equal(params.get('verify_token'), replies.verifyToken());
    assert.equal(params.get('fields'), 'comments,messages');
    assert.equal(params.get('access_token'), '1988|' + SECRET);
    assert.ok(n.calls.some(c => c.method === 'POST' && c.url.includes(`/${OWN}/subscribed_apps`)));
  } finally { global.fetch = real; n.restore(); }
});

test('asking for the app is recognised, and praise is not', () => {
  ['link', 'app link pls', 'Link bro', 'play store link anuppunga', 'apk irukka', 'app name enna?', 'app peru enna',
    'லிங்க் அனுப்புங்க', 'ஆப் எங்க கிடைக்கும்', 'download pannanum'].forEach(t => assert.equal(responder.asksForApp(t), true, t));
  ['nice app', 'super bro', 'realme 5 ku match aaguma?', 'ஆப்பிள் போனுக்கு இருக்கா?', 'price evlo?', 'how to install temper'].forEach(t => {
    assert.equal(responder.asksForApp(t), false, t);
  });
});

const PLAY = 'https://play.google.com/store/apps/details?id=test.app';

test('a message asking for the app gets the link at once, even in review, with no AI', async () => {
  await fresh({ appLink: PLAY });
  const n = network();
  try {
    await deliver(messageEvent('app link pls', 'user9'));
    const [e] = await stored();
    assert.equal(e.status, 'sent');
    assert.equal(e.intent, 'app_link');
    assert.equal(n.model().length, 0);
    const sent = JSON.parse(n.sent()[0].body);
    assert.deepEqual(sent.recipient, { id: 'user9' });
    assert.ok(sent.message.text.includes(PLAY) && sent.message.text.includes('ProGlide'));
  } finally { n.restore(); }
});

test('a comment asking for the app gets the link by message and a word on the comment', async () => {
  await fresh({ appLink: PLAY });
  const n = network();
  try {
    await deliver(commentEvent('link'));
    const dm = n.calls.filter(c => c.url.includes('/messages'))[0];
    assert.ok(JSON.parse(dm.body).recipient.comment_id);
    const onComment = new URL(n.calls.filter(c => c.url.includes('/replies'))[0].url).searchParams.get('message');
    assert.equal(onComment, 'Sent you the link in DM');
  } finally { n.restore(); }
});

test('if the message cannot go, the comment carries the link', async () => {
  await fresh({ appLink: PLAY });
  const n = network();
  const real = global.fetch;
  global.fetch = async (url, init) => (String(url).includes('/messages') ? reply(400, { error: { code: 10, message: 'not allowed' } }) : real(url, init));
  try {
    await deliver(commentEvent('link'));
    const onComment = new URL(n.calls.filter(c => c.url.includes('/replies'))[0].url).searchParams.get('message');
    assert.ok(onComment.includes(PLAY));
    assert.equal((await stored())[0].status, 'sent');
  } finally { global.fetch = real; n.restore(); }
});

test('with no link set, or with Auto Reply off, a request for the app is not answered by this', async () => {
  await fresh();
  let n = network();
  try {
    await deliver(messageEvent('app link pls'));
    assert.equal((await stored())[0].status, 'draft', 'it goes to the AI like anything else');
  } finally { n.restore(); }

  await fresh({ appLink: PLAY, mode: 'off' });
  n = network();
  try {
    await deliver(messageEvent('app link pls'));
    assert.equal((await stored())[0].status, 'skipped');
    assert.equal(n.sent().length, 0);
  } finally { n.restore(); }
});

test('only an https link is kept, and the app link may appear in an AI reply', async () => {
  await fresh({ appLink: 'javascript:alert(1)' });
  assert.equal((await replies.loadSettings()).appLink, '');
  const s = await replies.saveSettings({ appLink: PLAY, links: '' });
  assert.equal(responder.guard('Get it here ' + PLAY, 'comment', s), null);
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
