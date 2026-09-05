/* ============================================================================
   Local preview server — `node scripts/dev-server.js`, then open
   http://localhost:4321

   Serves the static site AND runs the api/*.js functions in-process, so a
   local run exercises the same code Vercel does. Without the API half,
   /api/firebase-config 404s, the browser concludes Firebase is unconfigured,
   and sign-in cannot be tested locally at all — which is how a bug in the
   sign-in path reaches production unnoticed.

   Configuration comes from .env.local (git-ignored). Use TEST Razorpay keys
   only: this file has no idea whether a key is live, and neither does Razorpay
   until it charges someone.

   Deliberately NOT at the repo root: Vercel auto-detects a root server.js as a
   Node entrypoint and routes the entire site through it as a serverless
   function, which breaks the deployment. scripts/ is also in .vercelignore.
   ========================================================================== */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4321;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2'
};

/* ------------------------------------------------------------------- env
   A minimal .env reader: KEY=VALUE, # comments, optional quotes. Enough for
   local work, and one less dependency than dotenv. Existing environment
   variables win, so `RAZORPAY_KEY_ID=x node scripts/dev-server.js` overrides
   the file rather than being silently ignored. */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || /^\s*#/.test(line)) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v === '') return;
    if (process.env[m[1]] === undefined) { process.env[m[1]] = v; n++; }
  });
  return n;
}

/* ------------------------------------------------------------------- api
   The shape a Vercel Node function is handed. `res.status()` chains, and the
   body is parsed unless the route opted out — the webhook does, because its
   signature covers the exact bytes Razorpay sent. */
function shimResponse(res) {
  res.status = function (code) { res.statusCode = code; return res; };
  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {string} name   the file under api/, without .js
 * @param {object} [extraQuery]  values a vercel.json rewrite would have added,
 *                               such as the admin dispatcher's `section`
 */
async function runApi(name, req, res, extraQuery) {
  const file = path.join(ROOT, 'api', name + '.js');
  if (!file.startsWith(path.join(ROOT, 'api')) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such route', route: '/api/' + name }));
    return;
  }

  /* Vercel parses the query string onto req.query before a function runs, and
     this did not — so every route that filters, searches or pages read
     undefined locally and silently returned an unfiltered first page. It
     looked like it worked, which is the worst way for a gap like this to
     behave. Rewrite parameters are merged in on top, the same way a dest
     query string is merged in production. */
  req.query = Object.assign(
    Object.fromEntries(new URL(req.url, 'http://localhost').searchParams),
    extraQuery || {}
  );

  /* Cleared every request so an edit to a route takes effect on reload. The
     module graph under api/ is small; re-requiring it costs nothing. */
  Object.keys(require.cache)
    .filter(k => k.startsWith(path.join(ROOT, 'api')))
    .forEach(k => { delete require.cache[k]; });

  const mod = require(file);
  const handler = mod.default || mod;
  const raw = await readBody(req);

  if (!(mod.config && mod.config.api && mod.config.api.bodyParser === false)) {
    const text = raw.toString('utf8');
    req.body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  } else {
    /* The route reads the stream itself. Replay the bytes we already consumed. */
    const { Readable } = require('stream');
    const replay = Readable.from([raw]);
    req.on = replay.on.bind(replay);
    req.destroy = () => {};
  }

  try {
    await handler(req, shimResponse(res));
  } catch (err) {
    console.error('[dev-server] /api/' + name + ' threw:', err && err.stack || err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server error', context: name }));
    }
  }
}

/* ---------------------------------------------------------------- server */
const loaded = loadEnvLocal();

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let p = decodeURIComponent(url);

  /* /api/admin/<section> goes to the single dispatcher, exactly as the rewrite
     in vercel.json does it. Keeping the two in step matters: the admin API is
     eight sections behind ONE function, and a dev server that called the
     section files directly would not exercise the dispatcher at all. */
  const adminApi = /^\/api\/admin\/([A-Za-z0-9_-]+)\/?$/.exec(p);
  if (adminApi) { runApi('admin', req, res, { section: adminApi[1] }); return; }

  /* The same rewrites vercel.json performs, kept in step by hand because there
     is no way to execute that file locally. Several endpoints share one
     function to stay inside the platform's 12-function limit, and a dev server
     that called the section files directly would not exercise the dispatchers
     at all — the shape that broke in production twice already. */
  const DISPATCHED = {
    'firebase-config': 'public', plans: 'public', health: 'public',
    access: 'access', 'device-parts': 'access'
  };

  const api = /^\/api\/([A-Za-z0-9_-]+)\/?$/.exec(p);
  if (api) {
    const target = DISPATCHED[api[1]];
    if (target) runApi(target, req, res, { section: api[1] });
    else runApi(api[1], req, res);
    return;
  }

  if (p === '/') p = '/index.html';
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }

  /* Directory -> its index.html, which is how the pre-rendered SEO pages are
     addressed: /models/apple is models/apple/index.html on disk. */
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      /* Clean URLs the app owns but that have no file — /model/samsung-galaxy-a11,
         /group/bt-0001 — are served the app shell, the same fallback Vercel is
         configured to do. Without it a refresh on any deep link is a 404. */
      if (!path.extname(p)) {
        /* The admin app has its own shell. Serving the customer index.html for
           /admin/users would paint the Finder at an /admin URL — the same
           mistake vercel.json's /admin route exists to prevent in production. */
        const shell = fs.readFileSync(path.join(
          ROOT, /^\/admin(\/|$)/.test(p) ? 'admin/index.html' : 'index.html'
        ));
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(shell);
        return;
      }
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('Mobile Parts Finder dev server on http://localhost:' + PORT);
  console.log(loaded
    ? `loaded ${loaded} variables from .env.local`
    : 'no .env.local — sign-in and payments will report themselves unconfigured');
  console.log('configuration check: http://localhost:' + PORT + '/api/health');
});
