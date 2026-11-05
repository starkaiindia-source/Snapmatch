/* ============================================================================
   Mobile Parts Finder · cloudflare/functions/_backend.js
   ----------------------------------------------------------------------------
   The serverless half of the site (api/*.js) needs Node and runs on Vercel.
   On Cloudflare Pages the static half is served directly, and every request
   for the serverless half is forwarded, unchanged, to API_ORIGIN — the Vercel
   deployment's own address. With API_ORIGIN unset the request is answered
   503, as JSON, so the app shows its "unavailable" state instead of a page.
   ========================================================================== */
export async function forward({ request, env }) {
  const origin = String(env.API_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) {
    return new Response(JSON.stringify({ error: 'backend-unavailable', message: 'This feature is temporarily unavailable.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3600' }
    });
  }
  const url = new URL(request.url);
  const target = origin + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', url.host);
  /* the body is passed through untouched: webhook signatures are computed
     over the exact bytes */
  return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
}
