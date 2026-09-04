/* ============================================================================
   POST /api/profile-sync
   ----------------------------------------------------------------------------
   Makes users/{uid} exist, and stamps lastLoginAt. Called once on every
   sign-in and on every page load that restores a session.

   WHY A SERVER ROUTE FOR SOMETHING THE CLIENT CAN WRITE

     The browser can write its own profile — the security rules allow it — and
     it still does, because that keeps the account screen instant. But a write
     the client owns is a write that can silently not happen: a rules change,
     an offline moment, a blocked request, and the user is signed in with no
     record anywhere. That is exactly the state this project was in — an
     account under Authentication -> Users, and nothing in Firestore.

     This route closes that gap. It runs on the Admin SDK, so security rules
     cannot swallow it, and it is the only place allowed to set the fields the
     rules keep away from clients: the opening subscriptionStatus of a brand new
     account, and accountStatus.

   IDENTITY COMES FROM THE TOKEN, NEVER FROM THE BODY

     uid, email and emailVerified are read from the verified Firebase ID token.
     The body may carry shop details — name, proprietor, phone, address — and
     nothing else; store.sanitiseProfile drops everything outside that list, so
     a request that posts `{ subscriptionStatus: "active" }` writes no such
     field. Granting yourself a plan has to go through a payment, and there is
     no other door.

   SAFE TO CALL REPEATEDLY. It is an upsert: the first call creates, later ones
   refresh lastLoginAt and Google's display fields. createdAt is written once.
   ========================================================================== */
'use strict';

const { syncProfile, prefillFrom } = require('./_lib/store');
const { ok, fail, requireMethod, requireUser, body } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  try {
    const user = await requireUser(req, res);
    if (!user) return;                                   /* reply already sent */

    const payload = body(req);
    const now = Date.now();

    const { created, profile } = await syncProfile({
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.name,
      /* Google's picture URL is not in the ID token's standard claims on every
         provider, so the client may pass it. It is display-only — it names no
         permission and grants no access — and is stored under its own key. */
      photoURL: typeof payload.photoURL === 'string' ? payload.photoURL.slice(0, 500) : null,
      authProvider: 'google',
      profile: payload.profile,
      now
    });

    /* The same verdict create-order will reach, returned here so the app can
       ask for a missing phone number at sign-in rather than at the moment
       someone is trying to pay. */
    const pre = prefillFrom(profile, user);

    console.log('[profile-sync]', user.uid, created ? 'created' : 'updated',
                pre.complete ? 'complete' : `missing:${pre.missing.join(',')}`);

    return ok(res, {
      uid: user.uid,
      created,
      profileCompleted: pre.complete,
      missing: pre.missing,
      profile: {
        uid: profile.uid || user.uid,
        email: profile.email || null,
        displayName: profile.displayName || null,
        googleDisplayName: profile.googleDisplayName || null,
        profilePhotoURL: profile.profilePhotoURL || null,
        googlePhotoURL: profile.googlePhotoURL || null,
        mobileShopName: profile.mobileShopName || '',
        proprietorName: profile.proprietorName || '',
        mobileNumber: profile.mobileNumber || '',
        mobileNumberE164: profile.mobileNumberE164 || '',
        country: profile.country || '',
        countryCode: profile.countryCode || '',
        address: profile.address || null,
        authProvider: profile.authProvider || 'google',
        accountStatus: profile.accountStatus || 'active',
        /* Server-owned, and reported so the client never has to guess. */
        subscriptionStatus: profile.subscriptionStatus || 'none',
        subscriptionPlan: profile.subscriptionPlan || profile.currentPlanId || null,
        subscriptionStartedAt: profile.subscriptionStartedAt ?? null,
        subscriptionExpiresAt: profile.subscriptionExpiresAt ?? null,
        createdAt: profile.createdAt ?? null,
        updatedAt: profile.updatedAt ?? null,
        lastLoginAt: profile.lastLoginAt ?? null
      }
    });
  } catch (err) {
    return fail(res, err, 'profile-sync');
  }
};
