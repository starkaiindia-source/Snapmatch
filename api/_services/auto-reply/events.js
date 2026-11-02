/* ============================================================================
   Mobile Parts Finder · api/_services/auto-reply/events.js
   ----------------------------------------------------------------------------
   What Meta delivered, as one small shape the rest of Auto Reply can use.

   Meta sends the same comment in two shapes, depending on how the app logs in:
   Instagram Login puts `field` and `value` on the entry, Unified and Facebook
   Login wrap them in `changes`, and the comment id is `id` in one and
   `comment_id` in the other. Messages arrive in `messaging` for all of them.
   Which login the account uses is a choice that can change, so all of it is read.

   WHAT IS DROPPED HERE

   Anything the account did itself. A reply this system posts comes back as a new
   comment or an echo, and answering that would be a loop that talks to itself in
   public until a rate limit stopped it. So the sender is compared with the account
   on the entry, not only with the configured id.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

const docId = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);

function comment(value, ownerId) {
  const v = value || {};
  const id = v.id || v.comment_id;
  const from = v.from || {};
  if (!id || !from.id || String(from.id) === String(ownerId)) return null;
  return {
    id: docId('comment:' + id), kind: 'comment', targetId: String(id), senderId: String(from.id),
    username: typeof from.username === 'string' ? from.username.slice(0, 40) : '',
    text: typeof v.text === 'string' ? v.text : '',
    mediaId: v.media && v.media.id ? String(v.media.id) : null,
    parentId: v.parent_id ? String(v.parent_id) : null
  };
}

function message(m, ownerId) {
  const body = m && m.message;
  const from = m && m.sender && m.sender.id;
  if (!body || !body.mid || !from) return null;
  if (body.is_echo || body.is_deleted || String(from) === String(ownerId)) return null;
  return {
    id: docId('dm:' + body.mid), kind: 'dm', targetId: String(from), senderId: String(from), username: '',
    text: typeof body.text === 'string' ? body.text : '', mediaId: null, parentId: null
  };
}

/**
 * @param {object|object[]} payload  the parsed body of one delivery
 * @returns {object[]} comments and messages from other people, oldest first
 */
function parse(payload) {
  const out = [];
  (Array.isArray(payload) ? payload : [payload]).forEach(p => {
    if (!p || p.object !== 'instagram' || !Array.isArray(p.entry)) return;
    p.entry.forEach(entry => {
      const owner = entry && entry.id;
      if (entry && entry.field === 'comments') out.push(comment(entry.value, owner));
      ((entry && entry.changes) || []).forEach(c => {
        if (c && c.field === 'comments') out.push(comment(c.value, owner));
      });
      ((entry && entry.messaging) || []).forEach(m => out.push(message(m, owner)));
    });
  });
  return out.filter(Boolean);
}

module.exports = { parse };
