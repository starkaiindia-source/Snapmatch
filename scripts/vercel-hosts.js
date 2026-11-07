/* ============================================================================
   Mobile Parts Finder · scripts/vercel-hosts.js
   ----------------------------------------------------------------------------
   The site runs on two Vercel accounts, so that when one is paused (Hobby's
   fair-use limit paused the first on 3 November 2026) the other takes over.
   Which accounts, projects and domains is local configuration in
   .vercel/hosts.json, never committed: this repository is public, and which
   accounts host the site is nobody else's business.

   A host is one Vercel login. Its CLI login lives in its own config folder
   (`globalConfig`; null means the default login), so the two never overwrite
   each other. Each host has a project per app, and exactly one host at a time
   (`active`) holds the custom domains.

   Used by deploy.js and switch-host.js.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, '.vercel', 'hosts.json');

function load() {
  if (!fs.existsSync(FILE)) {
    throw new Error('.vercel/hosts.json is missing: it names the Vercel accounts this site deploys to');
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function save(conf) {
  fs.writeFileSync(FILE, JSON.stringify(conf, null, 2) + '\n');
}

/** Runs the Vercel CLI as one host, linked to one of its projects. */
function vercel(host, projectId, args, opts = {}) {
  const full = [...args];
  if (host.globalConfig) full.push('--global-config', host.globalConfig);
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vercel', ...full], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    /* The two ids override whatever .vercel/project.json links this folder to,
       so one folder deploys to either account. */
    env: { ...process.env, VERCEL_ORG_ID: host.teamId, VERCEL_PROJECT_ID: projectId, MSYS_NO_PATHCONV: '1' }
  });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

/** A REST call as that host. Returns the parsed JSON, or null. */
function api(host, endpoint, method, body, inherit) {
  const args = ['api', endpoint, '--scope', host.teamId];
  if (method) args.push('-X', method);
  for (const [k, v] of Object.entries(body || {})) args.push('-F', `${k}=${v}`);
  const r = vercel(host, '', args, { inherit });
  const at = r.out.indexOf('{');
  try { return at >= 0 ? JSON.parse(r.out.slice(at, r.out.lastIndexOf('}') + 1)) : null; } catch (e) { return null; }
}

module.exports = { ROOT, load, save, vercel, api };
