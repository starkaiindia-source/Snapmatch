/* ============================================================================
   Mobile Parts Finder · scripts/instagram-verify-providers.js
   ----------------------------------------------------------------------------
   Calls every configured provider of the Instagram pipeline FOR REAL and says
   which ones work.

     node scripts/instagram-verify-providers.js

   Keys are read from the environment (GEMINI_API_KEY, ANTHROPIC_API_KEY,
   INSTAGRAM_GRAPH_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ACCOUNT_ID). Nothing is
   printed about a key except whether it is set and whether the provider
   accepted it. Each check costs a few tokens.

   Exit code 0 only when the primary media reader (Gemini) is verified.
   ========================================================================== */
'use strict';

const { verifyProviders } = require('../api/_services/instagram/provider-check');

const usd = micro => (micro == null ? 'price unknown' : '$' + (micro / 1e6).toFixed(6));

(async () => {
  const report = await verifyProviders();
  console.log('\n  Instagram pipeline — provider check   ' + new Date(report.checkedAt).toISOString());
  console.log('  ' + '-'.repeat(64));
  Object.keys(report.providers).forEach(name => {
    const p = report.providers[name];
    console.log(`  ${name.padEnd(10)} ${String(p.status).padEnd(14)} ${p.code ? '[' + p.code + '] ' : ''}${p.detail || ''}`);
    console.log(`  ${' '.repeat(10)} ${p.role}`);
    (p.calls || []).forEach(c => console.log(`  ${' '.repeat(10)} called ${c.model}: ${c.inputTokens} in / ${c.outputTokens} out tokens, ${usd(c.costMicroUsd)}` +
      (c.imageInput ? ', image input accepted' : '') + (c.thinkingLevel ? ', thinking ' + c.thinkingLevel : '')));
    if (p.available) console.log(`  ${' '.repeat(10)} models this key can use: ${p.available.join(', ')}`);
    if (p.notProven) console.log(`  ${' '.repeat(10)} not proven: ${p.notProven}`);
  });
  console.log('  ' + '-'.repeat(64));
  console.log('  ' + (report.providers.gemini.status === 'VERIFIED'
    ? 'Gemini is VERIFIED: media can be read.'
    : 'Gemini is NOT VERIFIED: no image or video can be read by the pipeline until it is.'));
  console.log();
  process.exit(report.providers.gemini.status === 'VERIFIED' ? 0 : 2);
})().catch(err => { console.error('\n  provider check failed:', err && err.message, '\n'); process.exit(1); });
