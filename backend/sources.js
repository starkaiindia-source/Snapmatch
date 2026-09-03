/* ============================================================================
   Mobile Parts Finder · backend/sources.js
   ----------------------------------------------------------------------------
   The source registry, and the gate every fetch goes through.

   Each entry records what the source is, whether we are permitted to read it
   automatically, and HOW that was established. `allowed: false` is enforced —
   fetchAllowed() throws rather than fetching — so a future adapter cannot
   quietly start pulling from a source that said no.

   Verdicts below were established on 2026-09-03 by reading each site's own
   robots.txt and licence declaration. Re-check with:

       node scripts/check-sources.js

   ----------------------------------------------------------------------------
   WHY GSMARENA IS NOT FETCHED

   gsmarena.com/robots.txt names our crawler and refuses it outright:

       User-agent: ClaudeBot        Disallow: /
       User-agent: Claude-SearchBot Disallow: /
       User-agent: anthropic-ai     Disallow: /

   and its RSL licence (gsmarena.com/license.xml) permits only `ai-summarize`
   and `search-index` while prohibiting `ai-inference`, `ai-train` and
   `train-genai`.

   That applies to automated fetching from this project. It does NOT affect the
   GSMArena-derived data already in the repo: that was supplied by the project
   owner from their own export, and it stays. The licence asks for attribution
   (CC BY 4.0), which is why every affected record carries sourceRefs.gsmarena
   and the UI must credit GSMArena wherever those fields are shown.

   To refresh that data, the owner must use their own licensed access and drop
   a new export into data/raw/ — the ETL will pick it up.
   ========================================================================== */
'use strict';

const USER_AGENT =
  'MobilePartsFinder/1.0 (+https://www.mobilepartsfinder.com; catalogue ingestion)';

const SOURCES = {

  /* ---------------------------------------------------------------- allowed */
  'apple-compare-in': {
    id: 'apple-compare-in',
    name: 'Apple India — iPhone compare',
    baseUrl: 'https://www.apple.com/in/iphone/compare/',
    kind: 'specs',
    region: 'IN',
    allowed: true,
    accessMethod: 'robots',
    robotsVerdict:
      'apple.com/robots.txt has no Claude/anthropic rule; User-agent: * blocks ' +
      'only shop overlays and some regional paths. Compare pages are permitted.',
    robotsCheckedAt: '2026-09-03',
    attributionRequired: true,
    requiresCredentials: false,
    rateLimitPerMin: 10,
    notes: 'Official manufacturer data — highest confidence for specs and colours.'
  },

  'apple-support-specs': {
    id: 'apple-support-specs',
    name: 'Apple Support — tech specs',
    baseUrl: 'https://support.apple.com/en-in/',
    kind: 'specs',
    region: 'IN',
    allowed: true,
    accessMethod: 'robots',
    robotsVerdict:
      'support.apple.com/robots.txt: the "Disallow: /" belongs to Baiduspider. ' +
      'User-agent: * blocks only /kb search, src=support_app, /docs/product/* ' +
      'and manual PDFs. Numeric tech-spec articles are permitted.',
    robotsCheckedAt: '2026-09-03',
    attributionRequired: true,
    requiresCredentials: false,
    rateLimitPerMin: 10,
    /* Enforced by fetchAllowed() — these are the paths Apple disallows. */
    denyPaths: [/\/docs\/product\//, /\/kb\/index\?.*page=search/, /src=support_app/, /\/MANUALS\/.*\.pdf$/i],
    notes: 'Permanent archive covering discontinued models the marketing site drops.'
  },

  /* ------------------------------------------------------------ not allowed */
  'gsmarena': {
    id: 'gsmarena',
    name: 'GSMArena',
    baseUrl: 'https://www.gsmarena.com/',
    kind: 'specs',
    allowed: false,
    accessMethod: 'blocked',
    robotsVerdict:
      'robots.txt explicitly disallows ClaudeBot, Claude-SearchBot and ' +
      'anthropic-ai for the entire site. RSL licence prohibits ai-inference.',
    robotsCheckedAt: '2026-09-03',
    licenceUrl: 'https://www.gsmarena.com/license.xml',
    attributionRequired: true,
    attributionLicence: 'https://creativecommons.org/licenses/by/4.0/',
    requiresCredentials: false,
    notes:
      'Do not fetch. Existing GSMArena-derived rows in data/raw/ came from the ' +
      "owner's own export and are retained with attribution. Refresh only by " +
      'replacing that export.'
  },

  'flipkart': {
    id: 'flipkart',
    name: 'Flipkart',
    baseUrl: 'https://www.flipkart.com/',
    kind: 'price',
    region: 'IN',
    allowed: false,
    accessMethod: 'api-required',
    robotsVerdict:
      'robots.txt itself returns HTTP 403 behind a reCAPTCHA challenge — the ' +
      'site refuses automated clients at the door.',
    robotsCheckedAt: '2026-09-03',
    requiresCredentials: true,
    credentialEnvVar: 'FLIPKART_AFFILIATE_ID / FLIPKART_AFFILIATE_TOKEN',
    apiDocs: 'https://affiliate.flipkart.com/api-docs',
    notes:
      'Prices only via the Flipkart Affiliate API. Adapter is written and will ' +
      'activate the moment those two variables are set; until then it reports ' +
      'unavailable rather than inventing a price.'
  },

  'amazon-in': {
    id: 'amazon-in',
    name: 'Amazon India',
    baseUrl: 'https://www.amazon.in/',
    kind: 'price',
    region: 'IN',
    allowed: false,
    accessMethod: 'api-required',
    robotsVerdict:
      'robots.txt permits some product paths, but the Conditions of Use ' +
      'separately prohibit data mining and scraping. The sanctioned route is ' +
      'the Product Advertising API.',
    robotsCheckedAt: '2026-09-03',
    requiresCredentials: true,
    credentialEnvVar: 'AMAZON_PAAPI_KEY / AMAZON_PAAPI_SECRET / AMAZON_PARTNER_TAG',
    apiDocs: 'https://webservices.amazon.com/paapi5/documentation/',
    notes:
      'Requires an approved Amazon Associates account. Adapter activates when ' +
      'the three variables are set; otherwise it reports unavailable.'
  }
};

/* ---------------------------------------------------------------------------
   The gate. Every adapter fetch goes through this, and it throws rather than
   returning a soft failure — a disallowed fetch is a bug to fix, not a
   condition to handle at the call site.
   ------------------------------------------------------------------------- */
function fetchAllowed(sourceId, url) {
  const s = SOURCES[sourceId];
  if (!s) throw new Error(`unknown source "${sourceId}" — add it to backend/sources.js first`);

  if (!s.allowed) {
    throw new Error(
      `refusing to fetch ${sourceId}: ${s.robotsVerdict}` +
      (s.requiresCredentials ? `\n  Sanctioned route: ${s.apiDocs} (set ${s.credentialEnvVar})` : '')
    );
  }
  if (url && s.denyPaths && s.denyPaths.some(re => re.test(url))) {
    throw new Error(`refusing to fetch ${url}: matches a path ${s.name} disallows in robots.txt`);
  }
  if (url && s.baseUrl) {
    const host = new URL(url).host;
    const base = new URL(s.baseUrl).host;
    if (host !== base) throw new Error(`${url} is not on ${base} — declare a separate source`);
  }
  return true;
}

/* True when a credentialed source actually has its credentials present. */
function isConfigured(sourceId) {
  const s = SOURCES[sourceId];
  if (!s) return false;
  if (!s.requiresCredentials) return !!s.allowed;
  return String(s.credentialEnvVar || '')
    .split('/')
    .map(v => v.trim())
    .filter(Boolean)
    .every(v => !!process.env[v]);
}

module.exports = { SOURCES, USER_AGENT, fetchAllowed, isConfigured };
