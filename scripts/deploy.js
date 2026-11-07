/* ============================================================================
   Mobile Parts Finder · scripts/deploy.js
   ----------------------------------------------------------------------------
   Deploys to production on every Vercel account in .vercel/hosts.json, the
   one holding the domains first. Keeping the standby account on the same
   build is what makes switch-host.js instant: the domains move to a
   deployment that is already there and current.

       node scripts/deploy.js                 the site, on every account
       node scripts/deploy.js dashboard       the DashBoard app
       node scripts/deploy.js mpf --only stark   one account

   The site is uploaded as one archive: its 8,000+ pre-rendered pages would
   otherwise pass the free plan's 5,000 file uploads a day. Before uploading,
   the web bundle is rebuilt, so a script edit is never deployed without it.

   DashBoard deploys the commit at its `ref` (origin/main), exported to a
   temporary folder, never its working tree: other sessions keep unfinished
   work there.

   A paused standby account fails its deploy; that is reported and is not an
   error. The active one failing is.
   ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const hosts = require('./vercel-hosts');

const argv = process.argv.slice(2);
const appName = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--only') || 'mpf';
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const conf = hosts.load();
const app = conf.apps[appName];
if (!app) throw new Error(`no app "${appName}" in .vercel/hosts.json`);

function source() {
  if (!app.git) {
    if (appName === 'mpf') execFileSync(process.execPath, [path.join(__dirname, 'build-web-bundle.js')], { stdio: 'inherit' });
    return { dir: path.resolve(hosts.ROOT, app.dir), done() {} };
  }
  execFileSync('git', ['-C', app.git, 'fetch', '-q', 'origin'], { stdio: 'inherit' });
  const sha = execFileSync('git', ['-C', app.git, 'rev-parse', app.ref], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${appName}-`));
  const tar = path.join(dir, '..', path.basename(dir) + '.tar');
  execFileSync('git', ['-C', app.git, 'archive', '-o', tar, sha]);
  execFileSync('tar', ['-xf', tar, '-C', dir]);
  fs.rmSync(tar);
  console.log(`${appName}: deploying ${app.ref} at ${sha.slice(0, 9)}`);
  return { dir, done() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

const order = Object.keys(conf.hosts)
  .filter(h => !only || h === only)
  .sort((a, b) => (b === conf.active) - (a === conf.active));

const src = source();
let failed = false;
try {
  for (const name of order) {
    const host = conf.hosts[name];
    const project = host.projects[appName];
    if (!project) continue;
    const role = name === conf.active ? 'active' : 'standby';
    process.stdout.write(`${appName} → ${name} (${role}) … `);
    const r = hosts.vercel(host, project, ['deploy', '--prod', '--yes', '--archive=tgz'], { cwd: src.dir });
    const url = (r.out.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g) || [])[0];
    if (r.ok) {
      console.log(`ready ${url || ''}`);
    } else {
      const why = /paused|exceeded|fair use|402/i.test(r.out) ? 'account paused' : r.out.trim().split('\n').slice(-3).join(' | ');
      console.log(`FAILED: ${why}`);
      if (role === 'active') failed = true;
    }
  }
} finally {
  src.done();
}
if (failed) {
  console.log('\nThe active account did not deploy. If it is paused, move the domains: node scripts/switch-host.js <other host>');
  process.exit(1);
}
