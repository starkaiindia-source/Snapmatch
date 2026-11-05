/* ============================================================================
   Mobile Parts Finder · cloudflare/functions/api/firebase-config.js
   ----------------------------------------------------------------------------
   GET /api/firebase-config on Cloudflare Pages: the same answer
   api/_public/firebase-config.js gives on Vercel, from the same variable
   names, set in the Pages project's environment. None of these values is a
   secret — every one of them reaches every visitor's browser by design.
   ========================================================================== */
export function onRequestGet({ env }) {
  const projectId = env.FIREBASE_PROJECT_ID || '';
  const config = {
    apiKey: env.FIREBASE_API_KEY || '',
    authDomain: env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: env.FIREBASE_APP_ID || ''
  };
  if (env.FIREBASE_MEASUREMENT_ID) config.measurementId = env.FIREBASE_MEASUREMENT_ID;

  const body = (!config.apiKey || !config.appId)
    ? { configured: false, missing: ['FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_APP_ID'].filter(k => !env[k]) }
    : { configured: true, config };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': body.configured ? 'public, max-age=300, s-maxage=3600' : 'no-store'
    }
  });
}
