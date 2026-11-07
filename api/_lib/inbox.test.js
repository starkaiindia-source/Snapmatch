/* ============================================================================
   api/_lib/inbox.test.js
   ----------------------------------------------------------------------------
   The owner's inbox on the Leads page.

     · chats from every connected channel in one list, newest first, each with
       the other person (never the account itself) and its channel
     · a channel that cannot be read says so, and the others still show
     · WhatsApp is reported as not connected rather than pretended
     · a chat shows oldest first, marks the AI's replies, knows whether
       Instagram's 24 hours are still open, and finds the customer's bills
     · the owner's notes keep only what is valid, and AI-off is honoured
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../_services/auto-reply/inbox');

const ME = '17841400000000001';
const HOUR = 3600 * 1000;
const iso = ms => new Date(ms).toISOString().replace('Z', '+0000');

function conv(id, them, text, at, fromMe) {
  return {
    id, updated_time: iso(at),
    participants: { data: [{ id: ME, username: 'proglide' }, { id: them.id, username: them.username }] },
    messages: { data: [{ id: 'm' + id, message: text, created_time: iso(at), from: { id: fromMe ? ME : them.id } }] }
  };
}

function fakeDb(store) {
  return () => ({
    collection: () => ({
      doc: id => ({
        get: async () => ({ exists: !!store[id], data: () => store[id] }),
        set: async (v, o) => { store[id] = o && o.merge ? Object.assign({}, store[id], v) : v; }
      }),
      where: (f, op, val) => ({ limit: () => ({ get: async () => ({ docs: Object.keys(store).filter(k => store[k][f] === val).map(k => ({ id: k, data: () => store[k] })) }) }) }),
      limit: () => ({ get: async () => ({ docs: Object.keys(store).map(k => ({ id: k, data: () => store[k] })) }) })
    })
  });
}

test('every channel in one list, newest first, with the other person and the channel', async () => {
  const now = Date.now();
  const meta = {
    igUserId: ME,
    conversations: async () => [conv('c1', { id: '111', username: 'shop_a' }, 'price?', now - HOUR), conv('c2', { id: '222', username: 'shop_b' }, 'ok', now - 60000, true)],
    pageConversations: async () => ({ page: { id: 'P1', name: 'ProGlide' }, data: [{
      id: 'f1', updated_time: iso(now - 30000),
      participants: { data: [{ id: 'P1', name: 'ProGlide' }, { id: '999', name: 'Ravi Kumar' }] },
      messages: { data: [{ id: 'x', message: 'hi', created_time: iso(now - 30000), from: { id: '999' } }] }
    }] })
  };
  const r = await inbox.list({ meta, env: {} });
  assert.deepEqual(r.threads.map(t => t.key), ['messenger_999', 'instagram_222', 'instagram_111']);
  assert.equal(r.threads[1].lastFromMe, true);
  assert.equal(r.threads[2].username, 'shop_a');
  assert.equal(r.threads[0].name, 'Ravi Kumar');
  assert.equal(r.channels.instagram.connected, true);
  assert.equal(r.channels.messenger.connected, true);
  assert.equal(r.channels.whatsapp.connected, false);
  assert.match(r.channels.whatsapp.reason, /WhatsApp Business/);
});

test('a channel that cannot be read says why, and the rest still show', async () => {
  const meta = {
    igUserId: ME,
    conversations: async () => [conv('c1', { id: '111', username: 'shop_a' }, 'hi', Date.now())],
    pageConversations: async () => { throw Object.assign(new Error('(#200) Requires pages_messaging permission'), { kind: 'permission' }); }
  };
  const r = await inbox.list({ meta, env: {} });
  assert.equal(r.threads.length, 1);
  assert.equal(r.channels.messenger.connected, false);
  assert.match(r.channels.messenger.reason, /pages_messaging/);
  const none = await inbox.list({ meta: Object.assign({}, meta, { pageConversations: async () => null }), env: {} });
  assert.match(none.channels.messenger.reason, /No Facebook Page/);
});

test('our own id is found from the threads even when the token names another', () => {
  const convs = [conv('a', { id: '1', username: 'x' }, 'h', 1), conv('b', { id: '2', username: 'y' }, 'h', 2)];
  assert.equal(inbox.selfIdOf(convs, 'some-other-id'), ME);
});

test('a chat: oldest first, the AI marked, the 24 hours, and the customer\'s bills', async () => {
  const now = Date.now();
  const store = {};
  const meta = {
    conversationWith: async () => 'c1',
    messagesOf: async () => [
      { id: '3', message: '🧾 YOUR ORDER total', created_time: iso(now - 2 * HOUR), from: { id: ME } },
      { id: '2', message: 'Realme 5 - 4 boxes', created_time: iso(now - 3 * HOUR), from: { id: '111' } },
      { id: '1', message: 'price?', created_time: iso(now - 4 * HOUR), from: { id: '111' } }
    ],
    profile: async () => ({ username: 'shop_a', name: 'Shop A', profile_pic: 'https://x/p.jpg', follower_count: 120 })
  };
  const sales = { loadLead: async () => ({ stage: 'billed', address: { phone: '9876543210' }, items: [], log: [{ who: 'bot', text: '🧾 YOUR ORDER total' }] }) };
  let asked = null;
  const t = await inbox.thread({ meta, sales, db: fakeDb(store), now, customer: async m => { asked = m; return { customer: { billCount: 3 } }; } },
    { channel: 'instagram', userId: '111' });
  assert.deepEqual(t.messages.map(m => m.id), ['1', '2', '3']);
  assert.equal(t.messages[2].mine, true);
  assert.equal(t.messages[2].ai, true);
  assert.equal(t.messages[0].mine, false);
  assert.equal(t.canReply, true);
  assert.equal(t.profile.picture, 'https://x/p.jpg');
  assert.equal(asked, '9876543210');
  assert.equal(t.customer.customer.billCount, 3);

  const old = await inbox.thread({ meta: Object.assign({}, meta, { messagesOf: async () => [{ id: '1', message: 'hi', created_time: iso(now - 30 * HOUR), from: { id: '111' } }] }),
    sales: { loadLead: async () => null }, db: fakeDb({}), now }, { channel: 'instagram', userId: '111' });
  assert.equal(old.canReply, false, 'past 24 hours Instagram does not allow a reply');
  assert.equal(await inbox.thread({ meta, sales, db: fakeDb({}), now }, { channel: 'telegram', userId: '111' }), null);
});

test('notes keep only what is valid, and AI off is read back', async () => {
  const store = {};
  const db = fakeDb(store);
  const c = await inbox.saveContact(db, { channel: 'instagram', userId: '111', note: ' wants matte ', mobile: '+91 98765 43210', tags: ['VIP', '', 'x'.repeat(40)], aiPaused: true, followUpAt: 123 }, 5);
  assert.equal(c.key, 'instagram_111');
  assert.equal(store.instagram_111.note, 'wants matte');
  assert.equal(store.instagram_111.mobile, '9876543210');
  assert.deepEqual(store.instagram_111.tags, ['VIP', 'x'.repeat(24)]);
  assert.equal(await inbox.paused(db, 'instagram', '111'), true);
  assert.equal(await inbox.paused(db, 'instagram', '222'), false);
  assert.deepEqual(Array.from(await inbox.pausedIds(db, 'instagram')), ['111']);
  await inbox.saveContact(db, { channel: 'instagram', userId: '111', mobile: '123' }, 6);
  assert.equal(store.instagram_111.mobile, '', 'a number that is not one is cleared, not kept');
  assert.equal(store.instagram_111.note, 'wants matte', 'fields not sent are left alone');
  assert.equal(await inbox.saveContact(db, { channel: 'instagram', userId: '../x' }, 7), null);
  assert.equal(await inbox.paused(() => { throw new Error('no db'); }, 'instagram', '1'), false, 'a failed read never stops a reply');
});

test('a reply goes out on the channel the person wrote on, and is kept on the lead', async () => {
  const sent = [];
  const logged = [];
  const meta = { sendMessage: async (id, t) => { sent.push(['ig', id, t]); return 'mid1'; }, pageSend: async (id, t) => { sent.push(['fb', id, t]); return 'mid2'; } };
  const sales = { logOwner: async (id, t) => logged.push([id, t]) };
  assert.deepEqual(await inbox.reply({ meta, sales, now: 1 }, { channel: 'instagram', userId: '111', text: ' hello ' }), { ok: true, id: 'mid1' });
  assert.deepEqual(await inbox.reply({ meta, sales, now: 1 }, { channel: 'messenger', userId: '999', text: 'hi' }), { ok: true, id: 'mid2' });
  assert.deepEqual(sent, [['ig', '111', 'hello'], ['fb', '999', 'hi']]);
  assert.deepEqual(logged, [['111', 'hello']]);
  assert.equal((await inbox.reply({ meta, sales, now: 1 }, { channel: 'whatsapp', userId: '111', text: 'x' })).ok, false);
  assert.equal((await inbox.reply({ meta, sales, now: 1 }, { channel: 'instagram', userId: '111', text: '  ' })).ok, false);
});
