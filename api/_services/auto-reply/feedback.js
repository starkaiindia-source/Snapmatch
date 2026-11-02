/* ============================================================================
   Mobile Parts Finder · api/_services/auto-reply/feedback.js
   ----------------------------------------------------------------------------
   After the app link: one question, and a rating link for a yes.

     link sent by message  ->  next day: "Is ProGlide useful?" [Yes] [No]
                           ->  Yes: the Play Store rating link   No: what to improve

   One person is one document, autoReplyFeedback/{their Instagram id}, and nobody is
   asked twice.

   WHY THE NEXT DAY, AND NOT LATER

   Instagram lets a business message a person only within 24 hours of that person's
   last message. So the question goes ASK_AFTER_MS after the link, and only while
   that window is still open; someone who wrote again later is asked later. A link
   sent by private reply to a comment opens no window, so only a link sent in a
   message is followed up.
   ========================================================================== */
'use strict';

const { db } = require('../../_lib/firebase');
const C = require('../../_schema/collections');

const HOUR_MS = 60 * 60 * 1000;
const ASK_AFTER_MS = 20 * HOUR_MS;
const WINDOW_MS = 23 * HOUR_MS;
/* an answer this long after the question is a new conversation, not an answer */
const ANSWER_WITHIN_MS = 3 * 24 * HOUR_MS;
const ANSWERS = ['Yes 👍', 'No 👎'];

const ref = id => db().collection(C.AUTO_REPLY_FEEDBACK).doc(String(id));

/** A link went to this person by message. Someone already asked is left alone. */
async function linkSent(ev, now) {
  if (ev.kind !== 'dm' || !ev.senderId) return;
  const snap = await ref(ev.senderId).get();
  if (snap.exists && snap.data().state !== 'waiting') return;
  await ref(ev.senderId).set({
    senderId: ev.senderId, username: ev.username || '', state: 'waiting', linkAt: now, lastCustomerAt: now
  });
}

/**
 * A message from someone who may have been asked. Keeps their window up to date,
 * and reads a yes or a no to the question.
 * @returns {Promise<'yes'|'no'|null>}
 */
async function answer(ev, now) {
  if (ev.kind !== 'dm' || !ev.senderId) return null;
  const snap = await ref(ev.senderId).get();
  if (!snap.exists) return null;
  const d = snap.data();
  const t = String(ev.raw || ev.text || '').trim().toLowerCase();
  const said = d.state !== 'asked' || now - (d.askedAt || 0) > ANSWER_WITHIN_MS ? null
    : /^(?:yes|yeah|yep|ya|yup|y|haan|ha|aama|aamam|ஆமா|ஆம்|ஆமாம்)\b|👍/.test(t) ? 'yes'
      : /^(?:no|nope|nah|illa|illai|nahi|இல்லை|இல்ல)\b|👎/.test(t) ? 'no' : null;
  await ref(ev.senderId).set(said ? { lastCustomerAt: now, state: 'answered', answer: said, answeredAt: now } : { lastCustomerAt: now }, { merge: true });
  return said;
}

/** Who to ask now: a day after the link, while Instagram still allows a message. */
async function due(now) {
  const snap = await db().collection(C.AUTO_REPLY_FEEDBACK).where('state', '==', 'waiting').get();
  return snap.docs.map(d => d.data()).filter(d => now - d.linkAt >= ASK_AFTER_MS && now - d.lastCustomerAt < WINDOW_MS);
}

async function asked(senderId, now) {
  await ref(senderId).set({ state: 'asked', askedAt: now }, { merge: true });
}

module.exports = { ANSWERS, ASK_AFTER_MS, linkSent, answer, due, asked };
