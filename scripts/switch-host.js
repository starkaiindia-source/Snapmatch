/* ============================================================================
   Mobile Parts Finder · scripts/switch-host.js
   ----------------------------------------------------------------------------
   Moves every app's domains to another Vercel account in .vercel/hosts.json,
   for when the active one is paused or broken.

       node scripts/switch-host.js stark
       node scripts/switch-host.js stark --status   only show where things are

   For each domain: remove it from the project that holds it (the CLI asks to
   confirm each removal; answer y), add it to the new host's project, verify.
   DNS at GoDaddy does not change: both accounts answer the same A and CNAME
   records, and the _vercel TXT records that prove ownership stay in place
   for both.

   Run `node scripts/deploy.js` first if the new host's production build may
   be old: the domains go to whatever is in production there.
   ========================================================================== */
'use strict';

const hosts = require('./vercel-hosts');

const [target, flag] = process.argv.slice(2);
const conf = hosts.load();
if (!conf.hosts[target]) {
  console.error(`usage: node scripts/switch-host.js <${Object.keys(conf.hosts).join('|')}> [--status]`);
  process.exit(1);
}

const domainsOf = (host, project) =>
  ((hosts.api(host, `/v9/projects/${project}/domains`) || {}).domains || []).map(d => d.name);

let trouble = 0;
for (const [appName, app] of Object.entries(conf.apps)) {
  const to = conf.hosts[target];
  const toProject = to.projects[appName];
  for (const domain of app.domains) {
    const holder = Object.entries(conf.hosts).find(([, h]) => h.projects[appName] && domainsOf(h, h.projects[appName]).includes(domain.name));
    const where = holder ? holder[0] : 'nowhere';
    if (flag === '--status' || where === target) {
      console.log(`${domain.name}: on ${where}`);
      continue;
    }
    if (holder) {
      console.log(`${domain.name}: removing from ${where}`);
      hosts.api(holder[1], `/v9/projects/${holder[1].projects[appName]}/domains/${domain.name}`, 'DELETE', null, true);
    }
    const body = { name: domain.name };
    if (domain.redirect) Object.assign(body, { redirect: domain.redirect, redirectStatusCode: 308 });
    const added = hosts.api(to, `/v10/projects/${toProject}/domains`, 'POST', body) || {};
    let verified = added.verified;
    if (verified === false) verified = (hosts.api(to, `/v9/projects/${toProject}/domains/${domain.name}/verify`, 'POST') || {}).verified;
    if (verified) {
      console.log(`${domain.name}: now on ${target}`);
    } else {
      trouble++;
      console.log(`${domain.name}: NOT moved. ${added.error ? added.error.message : ''}`);
      for (const v of added.verification || []) console.log(`  add at GoDaddy: ${v.type} ${v.domain} = ${v.value}`);
    }
  }
}
if (flag !== '--status' && !trouble) {
  conf.active = target;
  hosts.save(conf);
  console.log(`\n${target} is now the active host.`);
}
process.exit(trouble ? 1 : 0);
