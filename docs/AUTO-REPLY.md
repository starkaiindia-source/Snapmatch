# Auto Reply

AI answers to comments and direct messages on the owner's Instagram account. It is
owner-only (`/admin/auto-reply`, permission `autoreply.manage`) and is not a feature
of the site: it reads and writes nothing belonging to a shop or a user.

WhatsApp and Facebook come next. Each will be a channel beside Instagram with its
own document in `autoReply/`.

## The path of one comment

```
Meta  ─POST─▶ /api/instagram-webhook        vercel.json → api/razorpay-webhook.js
              signature (X-Hub-Signature-256, app secret)
              claimed once        autoReplyEvents/{hash of the event}
              limits              per person per hour, per day
              facts               phones found in the text, looked up in the catalogue
              draft               Gemini, from the training text and those facts only
              guard               blocked words, unknown links, length, confidence
              review → waits on the page        auto → sent
```

The webhook lives in `api/razorpay-webhook.js` because it needs the unparsed body and
the project is at the 12-function limit.

## The rules it keeps

- **The catalogue answers, the model only writes.** A question with no recorded answer
  goes to a person.
- **One reply per event.** The claim is a transaction made before anything is spent, so
  Meta delivering again changes nothing. An event cut short stays `queued`, and only the
  page runs it again.
- **It starts in Review.** Auto is the owner's choice on the page. Off spends nothing.
- **Limited names.** A reply carries at most `maxNames` phone names and no part code.
  The full fitment list is what the site sells.
- **Two brands stay two.** The blocked words stop any reply naming the other business.
- **Customer text is data.** It reaches the model quoted, and the guard reads the reply
  itself. A phone number or email is removed before the model or the record sees it.

## Environment

| Variable | Use |
| --- | --- |
| `INSTAGRAM_GRAPH_ACCESS_TOKEN` | Used if no separate token is set |
| `INSTAGRAM_REPLY_ACCESS_TOKEN` | Optional token just for replies. `IG…` means Instagram Login |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | The account, unless `INSTAGRAM_REPLY_ACCOUNT_ID` is set |
| `INSTAGRAM_APP_SECRET` | Checks Meta's signature, and derives the verify token |
| `INSTAGRAM_REPLY_APP_SECRET` | Instagram Login signs with its own secret. Set it for that login |
| `GEMINI_API_KEY` | The model. `AUTO_REPLY_MODEL` overrides the model id |

## What Meta needs

Meta sends nothing until all of this is true. The page's Connection card asks Meta about
everything except the app's Live state, which a token cannot see.

1. The app is **published (Live)**. It needs a Privacy Policy URL first.
2. Permissions on the app and on the token: `instagram_basic`, `instagram_manage_comments`,
   `instagram_manage_messages`. A system-user token acts as the Instagram account and needs
   no Page. Instagram Login uses `instagram_business_basic`,
   `instagram_business_manage_comments` and `instagram_business_manage_messages`.
3. A webhook on the app's `instagram` object, subscribed to `comments` and `messages`, and
   the account subscribed. **Connect webhook** on the page does both through Meta's API,
   using the app's own token. The Callback URL and Verify token are on the page for doing
   it by hand instead.
5. In the Instagram app, **Allow access to messages** under Message controls.

Meta's own pages disagree on whether a business answering its own account needs Advanced
Access. The webhook setup page asks for it and for business verification. The App Review
page says a business's own account does not. A real comment from a stranger settles it.
