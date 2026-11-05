/* /__/auth/* — Firebase Auth's sign-in helper, served from the site's own
   origin so mobile browsers keep the sign-in (the same proxy vercel.json
   declares). */
export function onRequest({ request, env }) {
  const url = new URL(request.url);
  const authHost = env.FIREBASE_AUTH_DOMAIN || 'mobilepartsfindercom.firebaseapp.com';
  return fetch(new Request(`https://${authHost}${url.pathname}${url.search}`, request));
}
