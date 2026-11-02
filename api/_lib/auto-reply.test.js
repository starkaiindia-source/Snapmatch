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
  },
  getUserByEmail: async () => ({ uid: 'ownerUid000001' })
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
      const out = typeof model === 'function' ? model(init.body) : (model || GOOD);
      return reply(200, { status: 'completed', model: 'gemini-test', output_text: JSON.stringify(out), usage: { total_input_tokens: 10, total_output_tokens: 5 } });
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
    const [words, card] = n.sent().map(c => JSON.parse(c.body));
    assert.deepEqual(words.recipient, { id: 'user9' });
    assert.ok(words.message.text.includes('ProGlide') && !words.message.text.includes('{'));
    const element = card.message.attachment.payload.elements[0];
    assert.equal(card.message.attachment.payload.template_type, 'generic');
    assert.deepEqual(element.buttons, [{ type: 'web_url', url: PLAY, title: 'Download the app' }]);
  } finally { n.restore(); }
});

test('a comment asking for the app gets the link by message and a word on the comment', async () => {
  await fresh({ appLink: PLAY });
  const n = network();
  try {
    await deliver(commentEvent('link'));
    const dm = JSON.parse(n.calls.filter(c => c.url.includes('/messages'))[0].body);
    assert.ok(dm.recipient.comment_id);
    assert.equal(dm.message.attachment.payload.elements[0].buttons[0].url, PLAY);
    const onComment = new URL(n.calls.filter(c => c.url.includes('/replies'))[0].url).searchParams.get('message');
    assert.equal(onComment, 'Sent you the link in DM 📩');
  } finally { n.restore(); }
});

test('one person gets the link once a day, however often they ask', async () => {
  await fresh({ appLink: PLAY });
  const n = network();
  try {
    for (const t of ['link', 'Link', 'link pls']) await deliver(messageEvent(t, 'fan5'));
    const list = await stored();
    assert.equal(list.filter(e => e.status === 'sent').length, 1);
    assert.equal(list.filter(e => e.reason === 'link-already-sent').length, 2);
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

function reader(comments, messages) {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init.method, body: init.body || '' });
    if (u.includes('/media?')) return reply(200, { data: [{ id: 'media1', comments: { data: comments } }] });
    if (u.includes('/conversations?')) return reply(200, { data: [{ messages: { data: messages } }] });
    if (u.includes('debug_token')) return reply(200, { data: { is_valid: true, type: 'SYSTEM_USER', scopes: [] } });
    if (u.includes('fields=id%2Cusername')) return reply(200, { id: OWN, username: 'proglide_9h_screenguard' });
    if (u.includes('generativelanguage')) return reply(200, { status: 'completed', model: 'g', output_text: JSON.stringify(GOOD), usage: {} });
    if (u.includes('/replies')) return reply(200, { id: 'r1' });
    if (u.includes('/messages')) return reply(200, { message_id: 'm1' });
    return reply(200, { caption: '' });
  };
  return { calls, restore() { global.fetch = real; } };
}
const iso = ms => new Date(ms).toISOString();
const poll = () => send(hook, Object.assign(Readable.from([]), { method: 'GET', url: '/api/razorpay-webhook.js?source=instagram&poll=1', headers: {} }));

test('reading the account finds what Meta did not deliver, skips its own words, and answers once', async () => {
  await fresh({ appLink: 'https://play.google.com/store/apps/details?id=x' });
  const now = Date.now();
  const r = reader([
    { id: 'c900', text: 'link', timestamp: iso(now - 60000), from: { id: 'fan1', username: 'fan' } },
    { id: 'c901', text: 'thanks all', timestamp: iso(now - 50000), username: 'proglide_9h_screenguard' },
    { id: 'c902', text: 'old one', timestamp: iso(now - 5 * 3600 * 1000), from: { id: 'fan2', username: 'old' } }
  ], [
    { id: 'mid900', message: 'app link pls', created_time: iso(now - 30000), from: { id: 'fan3', username: 'dm' } },
    { id: 'mid901', message: 'here you go', created_time: iso(now - 20000), from: { id: OWN, username: 'proglide_9h_screenguard' } }
  ]);
  try {
    const first = await poll();
    assert.deepEqual(first.body, { polled: true, found: 2, answered: 2, followed: 0 });
    const list = await stored();
    assert.deepEqual(list.map(e => e.status), ['sent', 'sent']);
    assert.equal((await poll()).body.reason, 'too soon', 'a second read inside the minute does nothing');

    /* the same comment delivered later by Meta is not answered again */
    await deliver({ object: 'instagram', entry: [{ id: OWN, changes: [{ field: 'comments', value: {
      comment_id: 'c900', from: { id: 'fan1', username: 'fan' }, text: 'link', media: { id: 'media1' } } }] }] });
    assert.equal((await stored()).length, 2);
    assert.equal(r.calls.filter(c => c.url.includes('/replies')).length, 1);
  } finally { r.restore(); }
});

test('what a read had no time for is answered by the next one', async () => {
  await fresh({ appLink: 'https://play.google.com/store/apps/details?id=x' });
  const r = reader([], []);
  try {
    await fake.db.collection('autoReplyEvents').doc('a'.repeat(32)).set({
      kind: 'dm', targetId: 'fan7', senderId: 'fan7', username: '', text: 'link', status: 'queued', at: Date.now() - 600000
    });
    assert.equal((await poll()).body.answered, 1);
    assert.equal((await stored())[0].status, 'sent');
    assert.equal(r.calls.filter(c => c.url.includes('/messages') && c.method === 'POST').length, 2, 'the words, then the card');
  } finally { r.restore(); }
});

test('an event left working by a run that stopped is taken up once it has been still', async () => {
  await fresh({ appLink: 'https://play.google.com/store/apps/details?id=x' });
  const r = reader([], []);
  try {
    const col = fake.db.collection('autoReplyEvents');
    await col.doc('b'.repeat(32)).set({ kind: 'dm', targetId: 'f1', senderId: 'f1', text: 'link', status: 'working', at: 1, updatedAt: Date.now() - 600000 });
    await col.doc('c'.repeat(32)).set({ kind: 'dm', targetId: 'f2', senderId: 'f2', text: 'link', status: 'working', at: 1, updatedAt: Date.now() });
    assert.equal((await poll()).body.answered, 1, 'the one still being worked on is left alone');
    const byId = Object.fromEntries((await col.get()).docs.map(d => [d.id[0], d.data().status]));
    assert.deepEqual(byId, { b: 'sent', c: 'working' });
  } finally { r.restore(); }
});

test('with Auto Reply off, a read spends nothing', async () => {
  await fresh({ mode: 'off' });
  const r = reader([], []);
  try {
    assert.equal((await poll()).body.reason, 'off');
    assert.equal(r.calls.length, 0);
  } finally { r.restore(); }
});

/* ------------------------------------------------------------- the sale */
const sales = require('../_services/auto-reply/sales');
const ORDER = { models: [], name: '', phone: '', address: '', city: '', state: '', pincode: '', cancel: false, question: '' };
const said = extra => () => Object.assign({}, ORDER, extra);

test('price questions and keywords start a sale, and other talk does not', () => {
  const kw = '9h\n9 h';
  ['9H', '9h', '9H temper price?', 'temper price evlo', 'glass rate kitna hai', 'விலை என்ன டெம்பர்'].forEach(t => assert.equal(sales.asksToBuy(t, kw), true, t));
  ['super bro', 'realme 5 ku match aaguma', 'link'].forEach(t => assert.equal(sales.asksToBuy(t, kw), false, t));
});

test('courier follows the state, from the pincode when no state is named', () => {
  const s = replies.DEFAULTS;
  assert.equal(sales.stateOfPincode('625001'), 'Tamil Nadu');
  assert.equal(sales.stateOfPincode('682001'), 'Kerala');
  assert.equal(sales.stateOfPincode('560001'), 'Karnataka');
  assert.equal(sales.stateOfPincode('110001'), 'Other');
  assert.equal(sales.courierFor('Tamil Nadu', s).paise, 6000);
  assert.equal(sales.courierFor('Kerala', s).paise, 10000);
  assert.equal(sales.courierFor('Delhi', s).paise, 20000);
});

test('a sale runs from the price to an unpaid bill in the owner\'s Quick Billing', async () => {
  await fresh({ salesOn: true });
  let next = said({});
  const n = network(body => next(body));
  const texts = () => n.calls.filter(c => c.url.includes('/messages')).map(c => JSON.parse(c.body).message);
  try {
    await deliver(messageEvent('9H temper price?', 'buyer1'));
    let lead = await sales.loadLead('buyer1');
    assert.equal(lead.stage, 'price_sent');
    assert.ok(texts()[0].text.includes('₹299') && texts()[0].text.includes('minimum 4 boxes'));
    assert.equal(n.model().length, 0, 'the price is the owner\'s own words');

    next = said({ models: [{ phone: 'realme 5', boxes: 2 }] });
    await deliver(messageEvent('realme 5 2 boxes', 'buyer1'));
    lead = await sales.loadLead('buyer1');
    assert.equal(lead.stage, 'models');
    const short = texts().pop().text;
    assert.match(short, /Wholesale starts at 4 boxes/);
    assert.match(short, /add 2 more boxes/);
    assert.equal(n.model().length, 0, 'an order like this is read by rule');

    next = said({ models: [{ phone: 'samsung a52', boxes: 2 }] });
    await deliver(messageEvent('samsung a52 2 box', 'buyer1'));
    lead = await sales.loadLead('buyer1');
    assert.equal(lead.stage, 'models', 'more models may follow, so the bill waits to be asked for');
    assert.equal(lead.items.reduce((k, i) => k + i.boxes, 0), 4);
    const ready = texts().pop();
    assert.match(ready.text, /Added Samsung Galaxy A52 \(.+ glass\) × 2[\s\S]*Need more models\? Send them, or tap Make bill/, 'the phone they asked for, and its glass');
    assert.deepEqual(ready.quick_replies.map(q => q.title), sales.ASK_BILL);

    await deliver(messageEvent('Price', 'buyer1'));
    const price = texts().pop().text;
    assert.match(price, /Matte: out of stock/, 'the price, with what is in stock');
    assert.match(price, /Your order: .+\(4 boxes\)/, 'and the order so far');

    await deliver(messageEvent('Make bill 🧾', 'buyer1'));
    lead = await sales.loadLead('buyer1');
    assert.equal(lead.stage, 'address');
    const form = texts().pop().text;
    assert.equal(form, sales.FORM, 'the form to copy, fill in and send back');
    assert.match(form, /Name:\nMobile:\nAddress:\nCity:\nState:\nPincode:$/);
    const summary = texts().slice(-2)[0].text;
    assert.match(summary, /^🧾 YOUR ORDER\n\n1\. Realme 5 glass · 2 boxes · ₹598\n {4}Fits .+ \+\d+ more\n\n2\. Samsung Galaxy A52 \(.+ glass\) · 2 boxes · ₹598/, 'laid out like a bill');
    assert.match(summary, /Boxes: 4 \(40 pieces\)\nAmount: ₹1,196/);

    next = said({ name: 'Ravi', address: '12 Main Road', city: 'Madurai', pincode: '625001' });
    await deliver(messageEvent('Ravi, 12 Main Road, Madurai 625001, 98765 43210', 'buyer1'));
    lead = await sales.loadLead('buyer1');
    assert.equal(lead.stage, 'billed');
    assert.equal(lead.address.phone, '9876543210', 'read from the message, not the model');
    assert.ok(!n.model().some(c => c.body.includes('9876543210')), 'the number never reached the model');
    assert.equal(lead.courierPaise, 6000);
    assert.equal(lead.totalPaise, 4 * 29900 + 6000);
    const bill = fake.db.collection('shops').doc('ownerUid000001').collection('bills').doc(lead.billId);
    const saved = (await bill.get()).data();
    assert.equal(saved.payment.status, 'unpaid');
    assert.equal(saved.totalPaise, lead.totalPaise);
    const card = texts().pop().attachment.payload.elements[0];
    assert.equal(card.buttons[0].title, 'View bill', 'no Razorpay connected, so the bill itself');
    assert.equal(saved.brand.name, 'ProGlide', 'the bill page carries the brand');
    assert.equal(saved.brand.whatsapp, '919894301600');
    assert.ok(card.buttons[0].url.startsWith('https://www.mobilepartsfinder.com/i/'));
  } finally { n.restore(); }
});

test('an order is read by rule however it is written', () => {
  const s = replies.DEFAULTS;
  const read = t => sales.parseOrder(t, s).map(o => o.phone + ' ' + o.boxes);
  assert.deepEqual(read('Realme 5 4 boxes'), ['Realme 5 4']);
  assert.deepEqual(read('Realme 5 2 boxes Vivo Y20 3 boxes'), ['Realme 5 2', 'vivo Y20 3']);
  assert.deepEqual(read('vivo y20 - 2, redmi note 10 x3'), ['vivo Y20 2', 'Xiaomi Redmi Note 10 3']);
  assert.deepEqual(read('samsung a52 2'), ['Samsung Galaxy A52 2']);
  assert.deepEqual(read('40 pcs realme 5'), ['Realme 5 4'], 'pieces become boxes');
  assert.deepEqual(read('realme 5'), ['Realme 5 1'], 'no count is one box');
  assert.deepEqual(read('super bro, thanks'), []);

  const filled = sales.parseAddress(sales.FORM.replace('Name:', 'Name: Ravi Kumar').replace('Mobile:', 'Mobile: 98765 43210')
    .replace('Address:', 'Address: 12 Main Road').replace('City:', 'City: Madurai').replace('State:', 'State: Tamil Nadu').replace('Pincode:', 'Pincode: 625001'));
  assert.equal(filled.lines, 6);
  assert.deepEqual(filled.address, { name: 'Ravi Kumar', phone: '9876543210', address: '12 Main Road', city: 'Madurai', state: 'Tamil Nadu', pincode: '625001' });
});

test('a filled form gets the bill and its own payment QR, and the payment is confirmed by itself', async () => {
  await fresh({ salesOn: true, mode: 'auto' });
  const shopSettings = require('../_services/shop-settings');
  const realQr = shopSettings.orderQr, realStatus = shopSettings.qrStatus;
  let paid = false;
  shopSettings.orderQr = async (uid, o) => ({ id: 'qr_Order0001', imageUrl: 'https://rzp.io/i/order1', amount: o.amountPaise });
  shopSettings.qrStatus = async () => ({ status: paid ? 'paid' : 'active' });
  const n = network(() => { throw new Error('the model is not needed'); });
  const out = () => n.calls.filter(c => c.url.includes('/messages')).map(c => JSON.parse(c.body).message);
  try {
    await deliver(messageEvent('Realme 5 4 boxes', 'buyer2'));
    let lead = await sales.loadLead('buyer2');
    assert.equal(lead.stage, 'models', 'four boxes as the first message is an order');
    await deliver(messageEvent('Oppo A6 10 boxes', 'buyer2'));
    await deliver(messageEvent('Bill', 'buyer2'));
    lead = await sales.loadLead('buyer2');
    assert.equal(lead.stage, 'address');
    assert.deepEqual(lead.items.map(i => i.boxes), [4, 10], 'every model sent along the way is in the order');
    assert.equal(out().pop().text, sales.FORM);

    /* typed without a space, and the pincode says Tamil Nadu anyway */
    const form = 'Name: Ravi\nMobile: 9876543210\nAddress: 62a Main Street\nCity: Rajapalayam\nState: tamilnadu\nPincode: 626117';
    await deliver(messageEvent(form, 'buyer2'));
    lead = await sales.loadLead('buyer2');
    assert.equal(lead.stage, 'billed');
    assert.equal(lead.qrId, 'qr_Order0001');
    assert.equal(lead.courierPaise, 6000, 'tamilnadu is Tamil Nadu');
    assert.equal(lead.totalPaise, 14 * 29900 + 6000);
    const sent = out();
    assert.ok(sent.some(m => m.text && /TOTAL: ₹4,246/.test(m.text) && /UPI app/.test(m.text)), 'the bill, with how to pay');
    const card = sent.filter(m => m.attachment && m.attachment.type === 'template').pop().attachment.payload.elements[0];
    assert.equal(card.image_url, 'https://api.razorpay.com/v1/l/qrcode/qr_Order0001', 'the QR is the card picture, at an address with no redirect');
    assert.equal(card.buttons[0].title, 'Pay now');
    assert.ok(card.buttons[0].url.startsWith('https://www.mobilepartsfinder.com/o/'), 'Pay now opens the bill through its loading page');
    assert.ok(!sent.some(m => m.text && /rzp\.io/.test(m.text)), 'no bare link');
    assert.equal(n.model().length, 0, 'nothing here needed the model');

    /* "paid" before Razorpay has it is not taken at its word */
    await deliver(messageEvent('Paid', 'buyer2'));
    assert.match(out().filter(m => m.text).pop().text, /not received this payment yet[\s\S]*screenshot/);
    assert.equal((await sales.loadLead('buyer2')).stage, 'billed');

    paid = true;
    const r = reader([], []);
    try { await poll(); } finally { r.restore(); }
    lead = await sales.loadLead('buyer2');
    assert.equal(lead.stage, 'paid');
    const bill = (await fake.db.collection('shops').doc('ownerUid000001').collection('bills').doc(lead.billId).get()).data();
    assert.equal(bill.payment.status, 'paid');
    assert.ok(r.calls.some(c => c.url.includes('/messages') && /being packed/.test(c.body)), 'told the money is in and the boxes are being packed');
  } finally { n.restore(); shopSettings.orderQr = realQr; shopSettings.qrStatus = realStatus; }
});

test('short of the minimum, the customer is told why and shown boxes that fit many phones', async () => {
  await fresh({ salesOn: true, mode: 'auto' });
  const n = network();
  try {
    await deliver(messageEvent('9H temper price?', 'buyer3'));
    await deliver(messageEvent('realme 5 2 boxes', 'buyer3'));
    const last = JSON.parse(n.calls.filter(c => c.url.includes('/messages')).pop().body).message.text;
    assert.match(last, /Wholesale starts at 4 boxes \(₹1,196\)/);
    assert.match(last, /Trending boxes/);
    assert.ok(!/Realme 5 glass: fits/.test(last), 'not the box already in the order');
  } finally { n.restore(); }
});

test('asking for the app mid-order gets the app, and a day later the useful question, then the rating link', async () => {
  await fresh({ salesOn: true, mode: 'auto', appLink: 'https://play.google.com/store/apps/details?id=x' });
  const n = network();
  try {
    await deliver(messageEvent('9H temper price?', 'buyer4'));
    await deliver(messageEvent('Link', 'buyer4'));
    const card = JSON.parse(n.sent().pop().body).message.attachment.payload.elements[0];
    assert.equal(card.buttons[0].url, 'https://play.google.com/store/apps/details?id=x');
    const doc = fake.db.collection('autoReplyFeedback').doc('buyer4');
    assert.equal((await doc.get()).data().state, 'waiting');

    /* the next day, inside Instagram's 24 hours */
    const now = Date.now();
    await doc.set({ linkAt: now - 21 * 3600000, lastCustomerAt: now - 2 * 3600000 }, { merge: true });
    const r = reader([], []);
    try { await poll(); } finally { r.restore(); }
    const ask = r.calls.filter(c => c.url.includes('/messages')).map(c => JSON.parse(c.body).message).find(m => m.quick_replies);
    assert.ok(ask, 'the question went with Yes and No buttons');
    assert.match(ask.text, /useful/);
    assert.deepEqual(ask.quick_replies.map(q => q.title), ['Yes 👍', 'No 👎']);
    assert.equal((await doc.get()).data().state, 'asked');

    await deliver(messageEvent('Yes 👍', 'buyer4'));
    const after = n.sent().slice(-2).map(c => JSON.parse(c.body).message);
    assert.match(after[0].text, /rate/i);
    assert.equal(after[1].attachment.payload.elements[0].buttons[0].title, 'Rate on Play Store');
    assert.equal((await doc.get()).data().answer, 'yes');
  } finally { n.restore(); }
});

test('a quiet lead is followed up inside the 24 hours, twice at most', async () => {
  await fresh({ salesOn: true });
  const n = network();
  const now = Date.now();
  await sales.saveLead('quiet1', { senderId: 'quiet1', stage: 'address', items: [], address: {}, followUps: 0, canMessage: true,
    needsHuman: false, lastCustomerAt: now - 4 * 3600000, lastSentAt: now - 4 * 3600000, createdAt: now - 5 * 3600000, log: [] });
  await sales.saveLead('cold1', { senderId: 'cold1', stage: 'address', items: [], address: {}, followUps: 0, canMessage: true,
    needsHuman: false, lastCustomerAt: now - 30 * 3600000, lastSentAt: now - 30 * 3600000, createdAt: now - 31 * 3600000, log: [] });
  try {
    const r = reader([], []);
    try { await poll(); } finally { r.restore(); }
    assert.equal((await sales.loadLead('quiet1')).followUps, 1);
    assert.equal((await sales.loadLead('cold1')).followUps, 0, 'past 24 hours Instagram allows nothing');
  } finally { n.restore(); }
});

test('an iPhone user asking for the app gets the website card, and a glass question does not', async () => {
  assert.equal(responder.asksForIos('iphone ku app irukka?', ''), true);
  assert.equal(responder.asksForIos('ios', ''), true);
  assert.equal(responder.asksForIos('iphone 14 temper irukka', ''), false);
  await fresh({ appLink: 'https://play.google.com/store/apps/details?id=x' });
  const n = network();
  try {
    await deliver(messageEvent('ios app irukka?', 'apple1'));
    const card = JSON.parse(n.sent()[1].body).message.attachment.payload.elements[0];
    assert.equal(card.buttons[0].url, 'https://www.mobilepartsfinder.com');
  } finally { n.restore(); }
});

test('the words a reel asks people to comment get the app link', () => {
  const kw = replies.DEFAULTS.appKeywords;
  ['Pro glide', 'Proglide', 'Proglite', 'App', 'Aap', 'tool', 'website'].forEach(t => assert.equal(responder.asksForApp(t, kw), true, t));
  assert.equal(responder.asksForApp('this temper is good for my shop and the app helps a lot every day', kw), false);
});

test('the Leads page is the owner\'s', async () => {
  await fresh();
  assert.equal((await adminCall('shop-token', 'GET', { view: 'leads' })).status, 403);
  assert.ok(Array.isArray((await adminCall('owner-token', 'GET', { view: 'leads' })).body.leads));
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

test('an order bill page shows the brand, hides the shop number, and pays by QR or button', () => {
  const { invoicePage } = require('../_services/shop-invoice-page');
  const bill = {
    number: 'QB-0023', createdAt: Date.now(), items: [{ name: 'Glass', qty: 4, unitPaise: 29900, totalPaise: 119600 }],
    subtotalPaise: 119600, totalPaise: 125600, payment: { status: 'unpaid', method: 'upi', balancePaise: 125600 },
    customer: { name: 'Ravi' }, brand: { name: 'ProGlide', logo: 'https://example.test/logo.png', whatsapp: '919894301600' }
  };
  const html = invoicePage(bill, { name: 'Ozo', mobile: '09894301600', place: 'Rajapalayam' },
    { pay: { upiUri: 'upi://pay?pa=x@y&am=1256.00', image: '/i/tok/qr.png' } });
  assert.match(html, /<h1>ProGlide<\/h1>/);
  assert.ok(!html.includes('Mobile: 09894301600'), 'the shop number is not on an order bill');
  assert.match(html, /href="upi:\/\/pay\?pa=x@y&amp;am=1256\.00">Pay with UPI app/);
  assert.match(html, /wa\.me\/919894301600\?text=Enquiry%20about%20order%20QB-0023/);
  assert.match(html, /Download bill/);
  const plain = invoicePage(Object.assign({}, bill, { brand: undefined }), { name: 'Ozo', mobile: '09894301600' });
  assert.match(plain, /Mobile: 09894301600/, 'a shop bill still shows the shop');
});

test('messages sent close together are answered once, in the order written', async () => {
  await fresh({ salesOn: true, mode: 'auto' });
  await sales.saveLead('burst1', { senderId: 'burst1', stage: 'price_sent', items: [], address: {}, followUps: 0, canMessage: true,
    needsHuman: false, lastCustomerAt: Date.now() - 60000, lastSentAt: Date.now() - 60000, createdAt: Date.now() - 60000, log: [] });
  const t = Date.now() - 30000;
  /* the conversation comes back newest first */
  const r = reader([], [
    { id: 'mid_b3', message: 'Make bill', created_time: iso(t + 2000), from: { id: 'burst1', username: 'burst' } },
    { id: 'mid_b2', message: '3 boxes', created_time: iso(t + 1000), from: { id: 'burst1', username: 'burst' } },
    { id: 'mid_b1', message: 'iPhone 14 promax', created_time: iso(t), from: { id: 'burst1', username: 'burst' } }
  ]);
  try { await poll(); } finally { r.restore(); }
  const lead = await sales.loadLead('burst1');
  assert.deepEqual(lead.items.map(i => [i.asked, i.boxes]), [['Apple iPhone 14 Pro Max', 3]], 'the count on the next line is the phone\'s');
  assert.equal(lead.stage, 'models', 'three boxes is short of wholesale, so no bill yet');
  const sent = r.calls.filter(c => c.url.includes('/messages')).map(c => JSON.parse(c.body).message);
  assert.equal(sent.length, 1, 'one answer to the three messages');
  assert.match(sent[0].text, /Added Apple iPhone 14 Pro Max/);
});

test('someone still typing is answered once they stop', async () => {
  await fresh({ salesOn: true, mode: 'auto' });
  const r = reader([], [{ id: 'mid_now', message: '9H price', created_time: iso(Date.now() - 1000), from: { id: 'typer1', username: 'typer' } }]);
  try { await poll(); } finally { r.restore(); }
  assert.ok(!r.calls.some(c => c.url.includes('/messages') && c.method === 'POST'), 'nothing yet');
  assert.equal((await fake.db.collection('autoReplyEvents').get()).docs.length, 0, 'not even claimed');
});

test('a question mid-order is answered in words, briefly, with the buttons back to the order', async () => {
  await fresh({ salesOn: true, mode: 'auto' });
  await sales.saveLead('ask1', { senderId: 'ask1', stage: 'models', items: [{ key: 'sg-x', asked: 'Realme 5', master: 'Realme 5', covers: ['Realme 5'], boxes: 4 }],
    address: {}, followUps: 0, canMessage: true, needsHuman: false, lastCustomerAt: Date.now(), lastSentAt: Date.now(), createdAt: Date.now(), log: [] });
  const n = network(() => ({ reply: 'Matte is out of stock right now, Clear is available at the same price.', handoff: false }));
  try {
    await deliver(messageEvent('matte irukka bro?', 'ask1'));
    const m = JSON.parse(n.calls.filter(c => c.url.includes('/messages')).pop().body).message;
    assert.match(m.text, /Matte is out of stock/);
    assert.deepEqual(m.quick_replies.map(q => q.title), sales.ASK_BILL);
  } finally { n.restore(); }
});

test('a billed order can still grow: the old bill is voided, and Make bill makes the new one', async () => {
  await fresh({ salesOn: true, mode: 'auto' });
  const shopSettings = require('../_services/shop-settings');
  const realQr = shopSettings.orderQr, realStatus = shopSettings.qrStatus, realClose = shopSettings.closeQr;
  let made = 0;
  const closed = [];
  shopSettings.orderQr = async () => ({ id: 'qr_Grow000' + (++made), imageUrl: 'https://rzp.io/i/g' + made });
  shopSettings.qrStatus = async () => ({ status: 'active' });
  shopSettings.closeQr = async (uid, b) => { closed.push(b.id); return { closed: true }; };
  const n = network(() => { throw new Error('the model is not needed'); });
  const out = () => n.calls.filter(c => c.url.includes('/messages')).map(c => JSON.parse(c.body).message);
  try {
    await deliver(messageEvent('Realme 5 4 boxes', 'grow1'));
    await deliver(messageEvent('Make bill', 'grow1'));
    await deliver(messageEvent('Name: Ravi\nMobile: 9876543210\nAddress: 1 Main St\nCity: Madurai\nState: Tamil Nadu\nPincode: 625001', 'grow1'));
    let lead = await sales.loadLead('grow1');
    assert.equal(lead.stage, 'billed');
    const first = lead.billId;

    await deliver(messageEvent('9h', 'grow1'));
    assert.match(out().pop().text, /Matte: out of stock[\s\S]*is ready above/, 'the price, not the bill again');

    await deliver(messageEvent('I want add more', 'grow1'));
    lead = await sales.loadLead('grow1');
    assert.equal(lead.stage, 'models');
    assert.deepEqual(closed, ['qr_Grow0001'], 'the old QR can no longer be paid');
    const old = (await fake.db.collection('shops').doc('ownerUid000001').collection('bills').doc(first).get()).data();
    assert.equal(old.status, 'void');
    const more = out().pop();
    assert.match(more.text, /Sure! 👍 Send the model and boxes[\s\S]*Trending boxes/);
    assert.deepEqual(more.quick_replies.map(q => q.title), sales.ASK_BILL);

    await deliver(messageEvent('Oppo F19 5 boxes', 'grow1'));
    await deliver(messageEvent('Make bill', 'grow1'));
    lead = await sales.loadLead('grow1');
    assert.equal(lead.stage, 'billed', 'the address is known, so the new bill comes at once');
    assert.notEqual(lead.billId, first);
    assert.equal(lead.qrId, 'qr_Grow0002');
    assert.equal(lead.totalPaise, 9 * 29900 + 6000);
  } finally { n.restore(); Object.assign(shopSettings, { orderQr: realQr, qrStatus: realStatus, closeQr: realClose }); }
});
