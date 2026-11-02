# Meta App Review: Advanced Access for Instagram messages and comments

App: **Mobile Parts Finder** (id 1988105655209076), business portfolio **ProGlide** (667698955602759).
Instagram account: **@proglide_9h_screenguard**.

## Why

With Standard Access, Meta sends webhooks only for people who have a role on the
app, so customers' messages reach the server only when it reads the account
(every 15 seconds). Advanced Access makes Meta deliver every comment and message
at once, so replies go out in a few seconds. The webhook endpoint is already live:
`https://www.mobilepartsfinder.com/api/instagram-webhook`.

## Where things stand (checked 3 Nov 2026)

| Item | State |
|---|---|
| Business verification | Done, verified since 10 Feb 2026 |
| App published (Live) | Done |
| Webhook and account subscription | Done |
| `instagram_manage_messages` | Standard Access (Ready for testing) |
| `instagram_manage_comments` | Standard Access (Ready for testing) |
| Tech Provider | Not chosen; Meta requires it before App Review |

## Steps

1. **Become a Tech Provider** (owner only, cannot be undone). Use cases → Instagram
   API → Permissions and features → `instagram_manage_messages` → Actions → Add
   to App Review → Continue. Being a Tech Provider adds a yearly data-use check
   and stricter data-handling rules; it does not cost money.
2. Add these to App Review the same way: `instagram_manage_messages`,
   `instagram_manage_comments`, and any permission Meta says they depend on
   (usually `instagram_basic`, `pages_show_list`, `pages_manage_metadata`,
   `business_management`).
3. App settings → Basic: check that these are filled in.
   - Privacy policy URL: `https://www.mobilepartsfinder.com/privacy`
   - User data deletion: instructions URL
     `https://www.mobilepartsfinder.com/privacy#your-data`
   - Category: Business and pages. App icon: 1024 × 1024.
4. App Review → Requests: paste the text below for each permission and attach the
   screen recording.
5. Data handling questions: answers below.
6. Submit. Meta usually answers within a few days to two weeks.

## Text to paste

### instagram_manage_messages

> ProGlide sells 9H tempered glass screen guards wholesale to mobile phone shop
> owners in India through the Instagram account @proglide_9h_screenguard. Shop
> owners message us to ask the price, order boxes for specific phone models and
> pay. Our app reads the messages sent to our own Instagram business account and
> replies on our behalf: it sends the price list, records the phone models and
> number of boxes ordered, asks for the delivery address, sends the bill with a
> UPI payment QR code, and confirms the payment once our payment provider reports
> it. It also sends the link to our Android app to people who ask for it. Replies
> are sent only within 24 hours of the customer's last message, and a team member
> can take over any conversation from our admin page. We only access the
> messages of the Instagram account our business owns.

### instagram_manage_comments

> Our reels and posts ask shop owners to comment a keyword such as "9H" or "App".
> Our app reads the comments on our own Instagram business account's posts and
> answers each one once: a short public reply and a private reply in Direct
> Messages with the price list or the app link. This lets us answer every
> interested shop owner quickly. We only read and reply to comments on posts of
> the Instagram account our business owns, and we never post on anyone else's
> content.

### instagram_basic / pages_show_list / business_management (if asked)

> Used to identify our own Instagram business account and the Facebook Page and
> business portfolio it belongs to, so our app can read and answer that
> account's comments and messages. No other account is accessed.

## Screen recording (one video, 1–2 minutes, phone or desktop)

Show it in English, with no passwords on screen.

1. Open Instagram on a second account and send `9H` to @proglide_9h_screenguard.
   Show the automatic price reply arriving.
2. Send `Realme 5 4 boxes`. Show the reply with the Make bill / Add more buttons.
   Tap **Make bill** and show the address form arriving.
3. Fill in the form and send it. Show the bill message and the card with the QR
   code and Pay now.
4. Open `https://www.mobilepartsfinder.com/admin/#/auto-reply` and show the same
   messages listed with their replies (this is where a person can take over).
5. Comment `App` on one of the account's reels. Show the public reply and the
   private reply in Direct Messages with the Download the app card.

## Data handling answers

- **Data processors or service providers who receive the data:** Vercel (hosting),
  Google Firebase (database), Google Gemini (reads order messages and drafts
  answers), Razorpay (UPI payment for the bill). All are used only to answer the
  customer and complete their order.
- **Responsible entity:** JEEVANANTHAM SATHIYARAJ (ProGlide), India.
- **Requests from public authorities in the last 12 months:** none.
- **Policies on such requests:** we review their legality, challenge unlawful
  ones and disclose only the minimum required.
- **What is stored:** the message text, Instagram username and id, the order and
  delivery address the customer sends, for as long as the order needs; customers
  can ask for deletion as described at `/privacy#your-data`.
