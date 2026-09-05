/* ============================================================================
   POST /api/chat
   ----------------------------------------------------------------------------
   The assistant. Database first; the model, if there is one, only ever writes
   the sentence around an answer this server already knows.

   See _services/chatbot-service.js for the pipeline and for what the model is
   structurally prevented from supplying. The short version: `facts` in the
   response come from the catalogue, `message` is prose, and the client renders
   facts for anything a shop would act on.

   ----------------------------------------------------------------------------
   RATE LIMITED HARDER THAN /api/events

   A chat message can reach an AI gateway, and a GPU costs money per call. Ten
   a minute is a conversation; a hundred is a script.

   ----------------------------------------------------------------------------
   SIGN-IN IS OPTIONAL

   A visitor who has not signed in can ask whether a handset is in the
   catalogue — that is a question the public site already answers, and refusing
   it would only push them to the search box. A verified token, when present,
   attributes the question so the missing-model queue knows a real shop asked.
   ========================================================================== */
'use strict';

const { ok, bad, fail, unavailable, requireMethod, body } = require('./_lib/http');
const { auth } = require('./_lib/firebase');
const { adminConfigured } = require('./_lib/config');
const { consume } = require('./_lib/rate-limit');
const chatbot = require('./_services/chatbot-service');
const analytics = require('./_services/analytics-service');
const v = require('./_lib/validate');

/** Per caller, per minute. */
const CHAT_LIMIT = 10;

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    /* The search half of this route needs no database — the catalogue is a
       bundled file — but recording a missing-model request does, and that is
       the one thing an unanswered question must not lose. So an unconfigured
       deployment says so rather than answering questions whose "I have added
       it for review" would be untrue. */
    if (!adminConfigured()) {
      return unavailable(res, 'chat-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
    }

    const payload = body(req);
    const message = v.searchTerm(payload.message, 500);
    if (!message) return bad(res, 'message is required');

    const sessionId = /^[A-Za-z0-9_-]{12,64}$/.test(String(payload.sessionId || ''))
      ? String(payload.sessionId)
      : null;

    const userId = await resolveUser(req);
    const now = Date.now();

    const limit = await consume({
      key: 'chat:' + (userId || sessionId || 'anon'),
      limit: CHAT_LIMIT,
      now
    });
    if (!limit.allowed) {
      res.setHeader('Retry-After', Math.ceil((limit.resetAt - now) / 1000));
      return ok(res, {
        intent: 'rate_limited',
        answeredFrom: 'template',
        facts: null,
        message: 'One moment — too many questions at once. Try again in a few seconds.',
        suggestions: [],
        resetAt: limit.resetAt
      });
    }

    const reply = await chatbot.respond({ message, userId, now });

    /* Recorded as analytics, not as a transcript. The event carries the
       INTENT and the length of the question, never its text — a chat log is a
       place customer phone numbers end up, and the business question here is
       "what are people asking about", which the missing-model queue and the
       search events already answer with the parts that matter. */
    analytics.recordEvents({
      events: [
        { eventType: 'chatbot_question',
          metadata: { intent: reply.intent, queryLength: message.length } },
        reply.facts
          ? { eventType: 'chatbot_answered',
              metadata: { intent: reply.intent, answeredFrom: reply.answeredFrom } }
          : { eventType: 'chatbot_no_answer', metadata: { intent: reply.intent } }
      ],
      userId,
      sessionId,
      source: 'chatbot',
      now
    }).catch(err => console.warn('[chat] analytics failed', err && err.message));

    return ok(res, reply);
  } catch (err) {
    return fail(res, err, 'chat');
  }
};

async function resolveUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) return null;
  try {
    const decoded = await auth().verifyIdToken(match[1], false);
    return decoded.uid;
  } catch {
    return null;
  }
}
