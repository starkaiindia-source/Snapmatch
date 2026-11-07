/* ============================================================================
   api/_lib/web-bundle.test.js
   ----------------------------------------------------------------------------
   The pages load two files, assets/app.js and assets/app.css, joined from the
   boot scripts and stylesheets. Vercel's free plan counts every request, and
   twenty-one per page view is what paused the site.

     · the bundle matches its sources, so an edit to a script is never
       deployed without the bundle that carries it
     · no page still loads the boot scripts one by one
     · the bundle keeps the scripts in the order their globals need
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const web = require('../../scripts/build-web-bundle');

const ROOT = path.join(__dirname, '..', '..');

test('the bundle and every page are up to date with the sources', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-web-bundle.js'), '--check'], { stdio: 'pipe' });
});

test('the boot scripts run in their order, each one whole', () => {
  const js = fs.readFileSync(path.join(ROOT, web.OUT_JS), 'utf8');
  let at = -1;
  for (const f of web.BOOT_JS) {
    const next = js.indexOf(`/* === ${f} === */`);
    assert.ok(next > at, f + ' is out of order');
    at = next;
  }
  assert.ok(js.trimEnd().endsWith('})(window);') || js.trimEnd().endsWith('})(this);'), 'app.js ends whole');
});

test('a page that ran the boot scripts now loads the one bundle', () => {
  const page = fs.readFileSync(path.join(ROOT, 'finder', 'index.html'), 'utf8');
  assert.ok(page.includes(web.SCRIPT_TAG));
  assert.ok(page.includes(web.STYLE_TAG));
  assert.ok(!page.includes('/src/data/debug.js'));
});
