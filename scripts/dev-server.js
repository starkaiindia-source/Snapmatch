/* Local preview server — `node scripts/dev-server.js`, then open
   http://localhost:4321
   Deliberately NOT at the repo root: Vercel auto-detects a root server.js as a
   Node entrypoint and routes the entire site through it as a serverless
   function, which breaks the deployment. scripts/ is also in .vercelignore. */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.svg':'image/svg+xml', '.json':'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(buf);
  });
}).listen(4321, () => console.log('Mobile Parts Finder dev server on http://localhost:4321'));
