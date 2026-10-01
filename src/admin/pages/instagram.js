/* ============================================================================
   Mobile Parts Finder · admin/pages/instagram.js
   ----------------------------------------------------------------------------
   Instagram Compatibility Data Intelligence: the importer, sources, import
   jobs, extraction results and import history. The review queue is in
   compat-review.js.

   ----------------------------------------------------------------------------
   WHAT THESE PAGES WILL AND WILL NOT SAY

   A number on these pages is one the server counted, or an em dash. A job
   that could not reach Instagram says "Unable to collect" and why — it never
   shows zero posts as if the page were empty. An image nobody could OCR says
   so. "Imported" means approved by a person, not extracted by a machine.

   ----------------------------------------------------------------------------
   LIVE PROGRESS IS THIS PAGE DRIVING THE JOB

   A Vercel function cannot run for minutes, so while the importer is open it
   asks the server to advance the job one tick at a time and redraws the
   counters after each. Close the page and the job simply waits, resumable;
   scripts/instagram-worker.js drives the same ticks without a browser.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var RUNNING = ['queued', 'discovering', 'processing'];

  function api(params) { return ADM.api.instagram(params); }

  /* Every page draws into a FRESH element inside #admPage. The shell reuses
     #admPage across routes, so a listener attached to it would outlive the
     page and fire again on the next one — twice-approved candidates are not
     a bug this page is allowed to have. Navigating away removes the element
     and its listeners with it. */
  function mount(host) {
    host.innerHTML = '';
    var root = document.createElement('div');
    host.appendChild(root);
    return root;
  }

  function skel(h) { return '<div class="adm__skel" style="height:' + (h || 60) + 'px"></div>'; }
  function act(body) { return ADM.api.instagramAction(body); }

  function head(title, sub) {
    return '<div class="adm__head"><div><h1>' + ui.esc(title) + '</h1>' +
      (sub ? '<p>' + ui.esc(sub) + '</p>' : '') + '</div></div>';
  }

  function failBanner(err, what) {
    return ui.banner('bad', '<b>Could not load ' + ui.esc(what) + '.</b> ' + ui.esc((err && err.message) || 'request failed'));
  }

  function username(u) {
    return u ? '<a href="https://www.instagram.com/' + encodeURIComponent(u) + '/" target="_blank" rel="noopener noreferrer">@' + ui.esc(u) + '</a>' : ui.text(null);
  }

  /* https only: a permalink comes from the Graph API or a validated URL, but
     a link built from stored data must never be able to carry javascript:. */
  function link(url, label) {
    return url && /^https:\/\//i.test(url)
      ? '<a href="' + ui.esc(url) + '" target="_blank" rel="noopener noreferrer">' + ui.esc(label || url) + '</a>'
      : ui.text(url ? label || null : null);
  }

  function statusLabel(s) {
    return {
      queued: 'Queued', discovering: 'Discovering content', processing: 'Processing',
      paused: 'Paused', rate_limited: 'Rate limited (paused)', quota_exhausted: 'Daily cap reached (paused)',
      budget_reached: 'AI budget reached (paused)',
      completed: 'Completed', completed_with_errors: 'Completed with errors', failed: 'Failed',
      cancelled: 'Cancelled', unable_to_collect: 'Unable to collect'
    }[s] || s;
  }

  function methodLabel(m) {
    return {
      graph_own_account: 'Graph API · own account',
      graph_business_discovery: 'Graph API · Business Discovery',
      manual_admin_entry: 'Manual entry by an admin'
    }[m] || (m ? m.replace(/_/g, ' ') : '—');
  }

  /** An "evidence" job is an admin attaching screenshots or text to one post. */
  function jobKind(job) {
    return job.mode === 'evidence' ? 'Evidence added by an admin' : methodLabel(job.collectionMethod);
  }

  /* ========================================================= integration */

  function integrationBanners(i) {
    var out = '';
    if (!i.graph.configured) {
      out += ui.banner('warn', '<b>The Instagram Graph API is not configured.</b> Set ' +
        i.graph.missing.map(function (m) { return '<code>' + ui.esc(m) + '</code>'; }).join(' and ') +
        ' in the Vercel environment. Until then an import reports <b>Unable to collect</b> — nothing is scraped, ' +
        'nothing is invented. Manual entry of text you have read yourself still works.');
    }
    var vision = i.vision || {}, validator = i.validator || {}, video = i.video || {}, budget = i.budget || {};
    var who = function (p) { return { gemini: 'Gemini', anthropic: 'Claude', gateway: 'AI gateway', google_vision: 'Google Vision' }[p] || p; };
    var parts = [];
    parts.push('Graph API ' + (i.graph.configured ? '<b>connected</b> (' + ui.esc(i.graph.version) + (i.graph.appSecretProof ? ', appsecret_proof on' : '') + ')' : '<b>off</b>'));
    parts.push('Media reader ' + (vision.configured ? '<b>' + ui.esc(who(vision.provider)) + '</b> <span class="mono">' + ui.esc(vision.model || '') + '</span>' +
      (vision.screenModel ? ', screening with <span class="mono">' + ui.esc(vision.screenModel) + '</span>' : '') : '<b>off</b>'));
    parts.push('Video ' + (video.configured ? (video.native ? '<b>read natively by Gemini</b>' : '<b>frames via the gateway</b>') : '<b>off</b>'));
    parts.push('Second opinion ' + (validator.configured ? '<b>' + ui.esc(who(validator.provider)) + '</b> <span class="mono">' + ui.esc(validator.model || '') + '</span>, only for doubtful lists' : '<b>off</b> — doubtful lists go to manual review'));
    parts.push('OCR ' + (i.ocr.configured ? '<b>' + ui.esc(who(i.ocr.provider)) + '</b>' : '<b>off</b> (optional)'));
    if (!vision.configured && !i.ocr.configured) {
      out += ui.banner('warn', '<b>Nothing can read an image or a reel yet.</b> Set <code>GEMINI_API_KEY</code> in the Vercel environment (the primary media reader). ' +
        'Until then a post whose caption decides nothing is listed as <b>Insufficient evidence</b>, never guessed at — or attach screenshots to it under Extraction Results.');
    }
    out += ui.banner('info', parts.join(' · ') + '.<br>Cheap first: the caption filter and a low-cost visual screen decide which posts get a deep read. ' +
      'Budget per import: <b>' + ui.count(budget.maxAiItemsPerSync) + '</b> posts with AI, <b>' + ui.count(budget.maxGeminiCallsPerSync) + '</b> Gemini calls, <b>' +
      ui.count(budget.maxClaudeCallsPerSync) + '</b> Claude calls, <b>' + ui.count(budget.maxVideoMinutesPerSync) + '</b> video minutes; ' +
      i.limits.maxItemsPerJob + ' posts per job, ' + i.limits.dailyAiCalls + ' AI calls a day. ' +
      '<button type="button" class="ig__link" data-verify="1">Verify the providers with a real call</button><div id="igVerify"></div>');
    return out;
  }

  function usd(micro) {
    return micro === null || micro === undefined ? ui.DASH : '$' + (Number(micro) / 1e6).toFixed(Number(micro) < 10000 ? 4 : 2);
  }

  /** The real-call provider check, drawn where it was asked for. */
  function verifyProviders(box, ctx) {
    box.innerHTML = '<div class="adm__skel" style="height:40px;margin-top:8px"></div>';
    act({ action: 'verify_providers' }).then(function (r) {
      var names = { gemini: 'Gemini', claude: 'Claude', instagram: 'Instagram Graph API', ocr: 'OCR' };
      box.innerHTML = '<div class="adm__scroll" style="margin-top:8px"><table class="adm__table"><thead><tr><th>Provider</th><th>Result of a real call</th><th>Detail</th></tr></thead><tbody>' +
        Object.keys(r.providers).map(function (k) {
          var pr = r.providers[k];
          return '<tr style="cursor:default"><td><b>' + ui.esc(names[k] || k) + '</b><div class="adm__none" style="font-size:11px">' + ui.esc(pr.role || '') + '</div></td>' +
            '<td>' + ui.pill(pr.status, String(pr.status).replace(/_/g, ' ')) + (pr.code ? ' <span class="mono adm__none">' + ui.esc(pr.code) + '</span>' : '') + '</td>' +
            '<td style="font-size:12px">' + ui.esc(pr.detail || '') +
            (pr.calls || []).map(function (c) { return '<br><span class="mono">' + ui.esc(c.model) + '</span>: ' + ui.count(c.inputTokens) + ' in / ' + ui.count(c.outputTokens) + ' out tokens, ' + usd(c.costMicroUsd); }).join('') +
            (pr.available ? '<br>This key can use: ' + pr.available.map(ui.esc).join(', ') : '') +
            (pr.notProven ? '<br><span class="adm__none">Not proven: ' + ui.esc(pr.notProven) + '</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      ctx.toast(r.ready ? 'Gemini and Instagram answered real calls' : 'Not verified — see the table', r.ready ? '' : 'warn');
    }, function (err) { box.innerHTML = ui.banner('bad', ui.esc(err.message || 'The check could not run')); });
  }

  /* ============================================================ progress */

  function tile(label, value, small) {
    return '<div class="adm__tile"><dt>' + ui.esc(label) + '</dt><dd' + (value === null || value === undefined ? ' class="is-none"' : '') + '>' +
      ui.count(value) + '</dd>' + (small ? '<small>' + small + '</small>' : '') + '</div>';
  }

  function progressHTML(job) {
    var c = job.counts || {};
    var u = job.usage || {};
    var found = c.postsFound || 0;
    var done = (c.processed || 0) + (c.failed || 0);
    var pct = found ? Math.min(100, Math.round(done / found * 100)) : (job.status === 'completed' ? 100 : 0);
    var running = RUNNING.indexOf(job.status) > -1;

    var line = running
      ? (job.status === 'discovering' || !(job.discovery && job.discovery.done)
          ? 'Discovering content… ' + found + ' found so far'
          : 'Analyzing source… ' + done + ' / ' + found + ' posts processed')
      : statusLabel(job.status);

    var out = '<div class="adm__card" id="igJob" data-job="' + ui.esc(job.jobId) + '">' +
      '<div class="ig__jobhead"><div><h2>' + username(job.username) + ' ' + ui.pill(job.status, statusLabel(job.status)) + '</h2>' +
      '<p class="adm__hint" style="margin:2px 0 0">' + ui.esc(jobKind(job)) + ' · started ' + ui.dateTime(job.createdAt) +
      (job.postUrl ? ' · post ' + link(job.postUrl, job.postUrl.replace('https://www.instagram.com', '')) : '') +
      ' · job <span class="mono">' + ui.esc(job.jobId) + '</span></p></div>' +
      '<div class="ig__actions">' + jobButtons(job) + '</div></div>';

    if (job.statusReason) {
      out += ui.banner(job.status === 'unable_to_collect' || job.status === 'failed' ? 'bad' : 'warn', ui.esc(job.statusReason));
    }

    out += '<div class="ig__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<div style="width:' + pct + '%"></div></div>' +
      '<p class="ig__progressline">' + ui.esc(line) + (running && job.leaseActive ? ' <span class="adm__none">· a worker is on it</span>' : '') + '</p>';

    /* the cost funnel: what each stage let through */
    out += '<p class="ig__funnel">' + [
      '<b>' + ui.count(c.postsFound) + '</b> collected',
      '<b>' + ui.count(c.cheapRejected) + '</b> rejected by the free filter',
      '<b>' + ui.count(c.screened) + '</b> screened',
      '<b>' + ui.count(c.deepAnalysed) + '</b> deep analysis',
      '<b>' + ui.count(c.extracted) + '</b> extracted',
      '<b>' + ui.count(c.pendingReview) + '</b> ready for review'
    ].join(' <span class="adm__none">→</span> ') + (c.aiDeferred ? ' · <b style="color:var(--warn)">' + ui.count(c.aiDeferred) + ' queued for AI</b>' : '') + '</p>';

    out += '<dl class="adm__tiles">' +
      tile('Posts found', c.postsFound, (job.discovery ? ui.count(job.discovery.pages) + ' API pages' : '')) +
      tile('Reels / videos', c.videosFound) +
      tile('Images', c.imagesFound) +
      tile('Carousels', c.carouselsFound) +
      tile('Relevant — compatibility', c.relevant, 'the only posts that reach review') +
      tile('Ignored', c.ignored, 'repair and general posts, kept for audit') +
      tile('Could not be judged', c.insufficient, ui.count(c.videoUnavailable) + ' reel(s) with no video from Instagram') +
      tile('Stopped by the free filter', c.cheapRejected, 'repair captions — no call made') +
      tile('Visual screening', c.screened, ui.count(c.screenRejected) + ' stopped there') +
      tile('Deep analysis', c.deepAnalysed, ui.count(c.videosUnderstood) + ' video(s) read natively') +
      tile('Second opinions', c.validated, ui.count(c.validationFailed) + ' could not be obtained') +
      '<div class="adm__tile"><dt>Estimated AI cost</dt><dd>' + usd(u.costMicroUsd || 0) + '</dd><small>' +
        (u.costUnknownCalls ? ui.count(u.costUnknownCalls) + ' call(s) at an unknown price' : 'list prices, from reported tokens') + '</small></div>' +
      tile('Group proposals', c.groupProposals, ui.count(c.groupUpdates) + ' updates · ' + ui.count(c.newGroups) + ' new') +
      tile('Captions processed', c.captionsProcessed) +
      tile('Images OCR\'d', c.imagesOcrd, ui.count(c.imagesUnderstood) + ' read by AI vision') +
      tile('Frames processed', c.framesProcessed, ui.count(c.transcripts) + ' transcripts') +
      tile('Model references', c.modelReferences) +
      tile('Matched to catalogue', c.matched, ui.count(c.unmatched) + ' unmatched · ' + ui.count(c.ambiguous) + ' ambiguous') +
      tile('Relationships detected', c.relationships) +
      tile('Requiring review', c.pendingReview, ui.count(c.readyForApproval) + ' ready for approval') +
      tile('Duplicates', c.duplicates) +
      tile('Conflicts', c.conflicts) +
      tile('Rejected', c.rejected) +
      tile('Imported (approved)', c.approved, ui.count(c.appliedToProduction) + ' written to production') +
      tile('Unchanged, skipped', c.unchanged, 'no OCR or AI spent') +
      tile('Failed', c.failed) +
      '</dl>';

    var b = job.budget || {};
    out += '<p class="adm__hint" style="margin:12px 0 0">Usage: ' + ui.count(u.graphCalls) + ' Instagram API · ' + ui.count(u.ocrCalls) + ' OCR · ' +
      '<b>Gemini</b> ' + ui.count(u.geminiCalls) + ' calls (' + ui.count(u.screenCalls) + ' screening), ' + ui.count(u.geminiInputTokens) + ' in / ' + ui.count(u.geminiOutputTokens) + ' out tokens · ' +
      '<b>Claude</b> ' + ui.count(u.claudeCalls) + ' calls, ' + ui.count(u.claudeInputTokens) + ' in / ' + ui.count(u.claudeOutputTokens) + ' out tokens · ' +
      ui.count(u.videoSeconds) + ' s of video · ' + ui.count(u.cacheHits) + ' cache hits</p>' +
      '<p class="adm__hint" style="margin:4px 0 0">This import\'s AI budget so far: ' + ui.count(b.aiItems) + ' posts · ' + ui.count(b.geminiCalls) + ' Gemini · ' +
      ui.count(b.claudeCalls) + ' Claude · ' + ui.count(Math.round((b.videoSeconds || 0) / 60)) + ' video min' + (job.forceDeep ? ' · <b>analysis requested by an admin</b>' : '') + '</p>';

    out += '<div id="igErrors" hidden>' + errorsHTML(job) + '</div></div>';
    return out;
  }

  function jobButtons(job) {
    var b = [];
    var can = ADM.currentCan || function () { return true; };
    if (can('instagram.import')) {
      if (['paused', 'rate_limited', 'quota_exhausted', 'budget_reached', 'failed'].indexOf(job.status) > -1 ||
          (RUNNING.indexOf(job.status) > -1 && !job.leaseActive)) {
        b.push('<button class="adm__btn adm__btn--primary" data-job-act="resume">' + (job.status === 'budget_reached' ? 'Resume — spend another AI budget' : 'Resume job') + '</button>');
      }
      if ((job.counts && job.counts.failed) || job.status === 'completed_with_errors') {
        b.push('<button class="adm__btn" data-job-act="retry_failed">Retry failed</button>');
      }
      if (['completed', 'completed_with_errors', 'cancelled', 'unable_to_collect'].indexOf(job.status) < 0) {
        b.push('<button class="adm__btn" data-job-act="cancel">Cancel job</button>');
      }
    }
    b.push('<button class="adm__btn" data-job-act="errors">View errors (' + (job.errorCount || 0) + ')</button>');
    b.push('<a class="adm__btn" href="/admin/instagram/extractions?job=' + encodeURIComponent(job.jobId) + '">Extraction results</a>');
    b.push('<a class="adm__btn" href="/admin/instagram/review?job=' + encodeURIComponent(job.jobId) + '">Review candidates</a>');
    return b.join('');
  }

  function errorsHTML(job) {
    var errs = (job.errors || []).slice().reverse();
    if (!errs.length) return '<p class="adm__none" style="font-size:13px;margin:12px 0 0">No errors recorded.</p>';
    return '<ul class="adm__timeline" style="margin-top:12px">' + errs.map(function (e) {
      return '<li><time>' + ui.dateTime(e.at) + '</time><div><b>' + ui.esc(e.stage || 'error') + '</b> ' +
        (e.itemKey ? '<code>' + ui.esc(e.itemKey) + '</code> ' : '') + ui.esc(e.message) + '</div></li>';
    }).join('') + '</ul>';
  }

  /** Buttons on a job panel. Returns a promise so the caller can redraw. */
  function jobAction(jobId, action, ctx) {
    if (action === 'errors') {
      var box = document.getElementById('igErrors');
      if (box) box.hidden = !box.hidden;
      return Promise.resolve(false);
    }
    if (action === 'cancel' && !global.confirm('Cancel this import? Items already processed are kept; queued items are cancelled.')) {
      return Promise.resolve(false);
    }
    if (action === 'resume' && /budget/i.test((document.querySelector('#igJob .adm__banner') || {}).textContent || '') &&
        !global.confirm('The AI budget of this import is spent.\n\nResuming starts a new budget and sends the queued posts to the model. Continue?')) {
      return Promise.resolve(false);
    }
    return act({ action: action, jobId: jobId }).then(function (r) {
      ctx.toast({ resume: 'Job resumed' + (r.requeued ? ' · ' + r.requeued + ' item(s) put back in the queue' : ''),
                  retry_failed: r.requeued + ' failed item(s) queued again', cancel: 'Job cancelled' }[action]);
      return true;
    }, function (err) {
      ctx.toast(err.message || 'Could not do that', 'bad');
      return false;
    });
  }

  /**
   * Drives a running job: tick, redraw, tick again, until it stops running
   * or the panel leaves the page. A tick another worker holds comes back
   * "busy"; then this only watches.
   */
  function drive(host, jobId, ctx, onUpdate) {
    var stopped = false;
    function alive() { return !stopped && host.isConnected && document.getElementById('igJob'); }
    function step() {
      if (!alive()) return;
      act({ action: 'tick', jobId: jobId }).then(function (r) {
        if (!alive()) return;
        onUpdate(r.job);
        if (RUNNING.indexOf(r.job.status) > -1) setTimeout(step, r.busy ? 3000 : 600);
      }, function (err) {
        if (!alive()) return;
        ctx.toast('Processing paused: ' + (err.message || 'request failed') + '. Use Resume job to continue.', 'warn');
      });
    }
    step();
    return function () { stopped = true; };
  }

  /* ============================================================ importer */

  function renderImporter(host, ctx) {
    host = mount(host);
    ADM.currentCan = ctx.can;
    host.innerHTML = head('Instagram Data Importer',
      'Instagram is a source of claims, never an authority. Every model is matched to the catalogue, and nothing reaches production without approval.') +
      '<div class="adm__card"><div class="adm__skel" style="height:60px"></div></div>';

    var params = new URLSearchParams(location.search);
    api({ view: 'overview' }).then(function (data) {
      var i = data.integration;
      var html = head('Instagram Data Importer',
        'Instagram is a source of claims, never an authority. Every model is matched to the catalogue, and nothing reaches production without approval.') +
        integrationBanners(i) +
        '<div class="adm__card"><h2>Analyze a source</h2>' +
        '<p class="adm__hint">Only content the configured Instagram API is permitted to return is collected — public professional (Business/Creator) accounts, or your own. Private and personal accounts are reported as unable to collect.</p>' +
        (ctx.can('instagram.import') ? formHTML(i, params) : ui.banner('info', 'Your role can read imports but not start them.')) +
        '</div><div id="igActive"></div>' +
        '<div class="adm__card"><h2>Recent imports</h2><div id="igRecent">' + jobsTable(data.recentJobs, true) + '</div></div>';
      host.innerHTML = html;
      wireForm(host, ctx);
      var jobId = params.get('job');
      if (jobId) showJob(host, jobId, ctx);
    }, function (err) {
      host.innerHTML = head('Instagram Data Importer') + failBanner(err, 'the importer');
    });

    host.addEventListener('click', function (e) {
      if (e.target.closest('[data-verify]')) {
        if (!ctx.can('instagram.import')) return ctx.toast('Your role cannot run the provider check', 'warn');
        return verifyProviders(host.querySelector('#igVerify'), ctx);
      }
      var row = e.target.closest('tr[data-job-row]');
      if (row && !e.target.closest('a,button')) ctx.go('/admin/instagram/jobs/' + encodeURIComponent(row.getAttribute('data-job-row')));
      var btn = e.target.closest('[data-job-act]');
      if (!btn) return;
      var panel = document.getElementById('igJob');
      if (!panel) return;
      var jobId = panel.getAttribute('data-job');
      jobAction(jobId, btn.getAttribute('data-job-act'), ctx).then(function (changed) {
        if (changed) showJob(host, jobId, ctx);
      });
    });
  }

  function formHTML(i, params) {
    return '<form id="igForm" class="ig__form" autocomplete="off">' +
      '<label>Instagram page / profile URL<input name="profileUrl" type="url" inputmode="url" required ' +
        'placeholder="https://www.instagram.com/shopname/" value="' + ui.esc(params.get('profile') || '') + '"></label>' +
      '<label><span>Specific post or reel URL <span class="adm__none">(optional)</span></span><input name="postUrl" type="url" inputmode="url" ' +
        'placeholder="https://www.instagram.com/p/…/"></label>' +
      '<label>Posts to read<input name="maxItems" type="number" min="1" max="' + i.limits.maxItemsPerJob + '" value="' +
        Math.min(25, i.limits.maxItemsPerJob) + '"></label>' +
      '<fieldset class="ig__mode"><legend>How</legend>' +
        '<label><input type="radio" name="mode" value="api" checked> Official Instagram API' + (i.graph.configured ? '' : ' <span class="adm__none">(not configured)</span>') + '</label>' +
        '<label><input type="radio" name="mode" value="manual"> Manual entry — paste text you read yourself</label>' +
      '</fieldset>' +
      '<label id="igManual" hidden>Post text (caption, or the text shown in its images)<textarea name="manualText" rows="5" maxlength="5000" ' +
        'placeholder="Samsung A15 4G Tempered Glass&#10;Compatible: A15 4G / A15 5G"></textarea></label>' +
      '<div><button class="adm__btn adm__btn--primary" type="submit">Analyze Source</button></div>' +
      '</form>';
  }

  function wireForm(host, ctx) {
    var form = host.querySelector('#igForm');
    if (!form) return;
    form.addEventListener('change', function (e) {
      if (e.target.name === 'mode') host.querySelector('#igManual').hidden = e.target.value !== 'manual';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      var button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Creating import job…';
      act({
        action: 'analyze',
        profileUrl: String(data.get('profileUrl') || ''),
        postUrl: String(data.get('postUrl') || ''),
        maxItems: Number(data.get('maxItems')) || undefined,
        mode: String(data.get('mode') || 'api'),
        manualText: String(data.get('manualText') || '')
      }).then(function (r) {
        button.disabled = false;
        button.textContent = 'Analyze Source';
        history.replaceState(null, '', '/admin/instagram?job=' + encodeURIComponent(r.job.jobId));
        paintJob(host, r.job, ctx);
        refreshRecent(host);
      }, function (err) {
        button.disabled = false;
        button.textContent = 'Analyze Source';
        ctx.toast(err.message || 'Could not start the import', 'bad');
      });
    });
  }

  var stopDriving = null;

  /* The list was drawn once, when the page loaded, so a job started on this
     page was missing from it until a manual refresh. */
  function refreshRecent(host) {
    api({ view: 'jobs', limit: 5 }).then(function (d) {
      var box = host.querySelector('#igRecent');
      if (box) box.innerHTML = jobsTable(d.jobs, true);
    }, function () { /* the job panel above is still correct */ });
  }

  function showJob(host, jobId, ctx) {
    api({ view: 'job', jobId: jobId, itemLimit: 1 }).then(function (r) { paintJob(host, r.job, ctx); },
      function (err) { var box = host.querySelector('#igActive'); if (box) box.innerHTML = failBanner(err, 'the job'); });
  }

  function paintJob(host, job, ctx) {
    var box = host.querySelector('#igActive');
    if (!box) return;
    box.innerHTML = progressHTML(job);
    if (stopDriving) stopDriving();
    stopDriving = null;
    if (RUNNING.indexOf(job.status) > -1 && ctx.can('instagram.import')) {
      stopDriving = drive(host, job.jobId, ctx, function (next) {
        var b = host.querySelector('#igActive');
        var open = document.getElementById('igErrors') && !document.getElementById('igErrors').hidden;
        if (b) b.innerHTML = progressHTML(next);
        if (open) document.getElementById('igErrors').hidden = false;
        if (RUNNING.indexOf(next.status) < 0) {
          ctx.toast('Import ' + statusLabel(next.status).toLowerCase(), next.status === 'completed' ? '' : 'warn');
          refreshRecent(host);
        }
      });
    }
  }

  /* ============================================================= sources */

  function renderSources(host, ctx) {
    host = mount(host);
    host.innerHTML = head('Instagram Sources', 'Every page an import has touched: what Instagram allowed us to read, and what its content turned out to be.') +
      '<div class="adm__card" id="igSrc">' + skel() + '</div>';
    load();
    function load() {
      api({ view: 'sources' }).then(function (d) {
        var card = host.querySelector('#igSrc');
        if (!d.sources.length) { card.innerHTML = ui.emptyState('No sources yet', 'A source is added when an import is started for it.'); return; }
        card.innerHTML = '<p class="adm__hint">Each post is counted once, in one column: <b>Relevant</b> makes a compatibility claim, <b>Ignored</b> is repair or general content (kept, under Extraction Results → Ignored), ' +
          '<b>Needs review</b> could not be read or decided. Follower counts are metadata only — they never raise the confidence of a claim.</p>' +
          '<div class="adm__scroll"><table class="adm__table"><thead><tr><th>Source</th><th>Status</th><th>Last scan</th><th>Last successful scan</th>' +
          '<th class="num">Content processed</th><th class="num">Relevant</th><th class="num">Ignored</th><th class="num">Needs review</th><th class="num">Errors</th>' +
          '<th class="num">AI calls</th><th class="num">Est. AI cost</th><th class="num">Approved</th><th class="num">Rejected</th><th></th></tr></thead><tbody>' +
          d.sources.map(function (s) {
            var rep = s.reputation || {};
            var use = s.usage || null;
            var st = s.stats || null;
            var n = function (k) { return '<td class="num">' + (st ? ui.count(Math.max(0, st[k] || 0)) : ui.text(null)) + '</td>'; };
            var filter = function (id, k) {
              var v = st ? Math.max(0, st[k] || 0) : 0;
              return '<td class="num">' + (st ? (v ? '<a href="/admin/instagram/extractions?source=' + encodeURIComponent(s.sourceKey) + '&filter=' + id + '">' + ui.count(v) + '</a>' : ui.count(0)) : ui.text(null)) + '</td>';
            };
            return '<tr style="cursor:default"><td><b>' + username(s.username) + '</b>' +
                (s.displayName ? '<div class="adm__none" style="font-size:12px">' + ui.esc(s.displayName) + '</div>' : '') +
                '<div class="adm__none" style="font-size:11px">' + ui.esc(s.accountType || '') + (s.followersCount != null ? ' · ' + ui.count(s.followersCount) + ' followers' : '') + '</div></td>' +
              '<td>' + (s.ignored ? ui.pill('ignored', 'ignored') + ' ' : '') + ui.pill(s.accessStatus || 'unknown', String(s.accessStatus || 'unknown').replace(/_/g, ' ')) +
                (s.accessReason ? '<div class="adm__none" style="font-size:11px;max-width:260px">' + ui.esc(s.accessReason) + '</div>' : '') + '</td>' +
              '<td>' + ui.ago(s.lastScanAt || s.lastImportAt) + (s.lastScanStatus ? '<div class="adm__none" style="font-size:11px">' + ui.esc(statusLabel(s.lastScanStatus)) + '</div>' : '') + '</td>' +
              '<td>' + ui.ago(s.lastSuccessfulScanAt) + '</td>' +
              n('content') + filter('relevant', 'relevant') + filter('ignored', 'ignored') + filter('needs_review', 'needsReview') + n('errors') +
              '<td class="num">' + (use ? ui.count((use.geminiCalls || 0) + (use.claudeCalls || 0)) +
                '<div class="adm__none" style="font-size:11px">' + ui.count(use.geminiCalls || 0) + ' Gemini · ' + ui.count(use.claudeCalls || 0) + ' Claude · ' + ui.count(use.cacheHits || 0) + ' cached</div>' : ui.text(null)) + '</td>' +
              '<td class="num">' + (use ? usd(use.costMicroUsd || 0) + (use.costUnknownCalls ? '<div class="adm__none" style="font-size:11px">+' + ui.count(use.costUnknownCalls) + ' unpriced</div>' : '') : ui.text(null)) + '</td>' +
              '<td class="num">' + ui.count(rep.approved || 0) + '</td><td class="num">' + ui.count(rep.rejected || 0) + '</td>' +
              '<td style="white-space:nowrap">' +
                (ctx.can('instagram.import') && !s.ignored ? '<a class="adm__btn" href="/admin/instagram?profile=' + encodeURIComponent(s.profileUrl || '') + '">Import again</a> ' : '') +
                (ctx.can('compat.review') ? (s.ignored
                  ? '<button class="adm__btn" data-src="' + ui.esc(s.sourceKey) + '" data-ignore="0">Un-ignore</button>'
                  : '<button class="adm__btn" data-src="' + ui.esc(s.sourceKey) + '" data-ignore="1">Ignore source</button>') : '') +
              '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }, function (err) { host.querySelector('#igSrc').innerHTML = failBanner(err, 'sources'); });
    }
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ignore]');
      if (!b) return;
      var ignore = b.getAttribute('data-ignore') === '1';
      var reason = ignore ? global.prompt('Why ignore this source? Its open candidates leave the review queue and new imports are refused.') : '';
      if (ignore && reason === null) return;
      act({ action: ignore ? 'ignore_source' : 'unignore_source', sourceKey: b.getAttribute('data-src'), reason: reason || '' })
        .then(function (r) { ctx.toast((ignore ? 'Ignored' : 'Un-ignored') + ' · ' + r.candidatesMoved + ' candidate(s) moved'); load(); },
              function (err) { ctx.toast(err.message || 'Could not change the source', 'bad'); });
    });
  }

  /* ================================================================ jobs */

  function jobsTable(jobs, compact) {
    if (!jobs || !jobs.length) return ui.emptyState('No imports yet', 'Start one from the Instagram Data Importer.');
    return '<div class="adm__scroll"><table class="adm__table"><thead><tr><th>Source</th><th>Date</th><th>Status</th>' +
      '<th class="num">Content</th><th class="num">Relevant</th><th class="num">Ignored</th><th class="num">Models extracted</th><th class="num">Matched</th>' +
      '<th class="num">Review required</th><th class="num">Approved</th><th class="num">Rejected</th><th class="num">Duplicates</th>' +
      (compact ? '' : '<th>Method</th>') + '</tr></thead><tbody>' +
      jobs.map(function (j) {
        var c = j.counts || {};
        return '<tr data-job-row="' + ui.esc(j.jobId) + '"><td><b>@' + ui.esc(j.username) + '</b>' +
          (j.mode === 'evidence' ? '<div class="adm__none" style="font-size:11px">evidence added</div>' : j.postUrl ? '<div class="adm__none" style="font-size:11px">one post</div>' : '') + '</td>' +
          '<td>' + ui.dateTime(j.createdAt) + '</td>' +
          '<td>' + ui.pill(j.status, statusLabel(j.status)) + '</td>' +
          '<td class="num">' + ui.count(c.postsFound) + '</td><td class="num">' + ui.count(c.relevant) + '</td><td class="num">' + ui.count(c.ignored) + '</td>' +
          '<td class="num">' + ui.count(c.modelReferences) + '</td>' +
          '<td class="num">' + ui.count(c.matched) + '</td><td class="num">' + ui.count(c.pendingReview) + '</td>' +
          '<td class="num">' + ui.count(c.approved) + '</td><td class="num">' + ui.count(c.rejected) + '</td>' +
          '<td class="num">' + ui.count(c.duplicates) + '</td>' +
          (compact ? '' : '<td>' + ui.esc(jobKind(j)) + '</td>') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderJobs(host, ctx) {
    host = mount(host);
    host.innerHTML = head('Import Jobs', 'Every import, newest first. Open one for its items, errors and controls.') +
      '<div class="adm__card" id="igJobs">' + skel() + '</div>';
    api({ view: 'jobs', limit: 100 }).then(function (d) {
      host.querySelector('#igJobs').innerHTML = jobsTable(d.jobs, false);
    }, function (err) { host.querySelector('#igJobs').innerHTML = failBanner(err, 'jobs'); });
    host.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-job-row]');
      if (row) ctx.go('/admin/instagram/jobs/' + encodeURIComponent(row.getAttribute('data-job-row')));
    });
  }

  function renderJob(host, ctx, jobId) {
    host = mount(host);
    ADM.currentCan = ctx.can;
    host.innerHTML = head('Import job') + '<div id="igActive"><div class="adm__card"><div class="adm__skel" style="height:80px"></div></div></div>' +
      '<div class="adm__card" id="igItems"></div>';
    var showIgnored = false;
    function load() {
      api({ view: 'job', jobId: jobId, itemLimit: 200 }).then(function (d) {
        paintJob(host, d.job, ctx);
        var isIgnored = function (i) { return ['IRRELEVANT_REPAIR', 'IRRELEVANT_GENERAL', 'DUPLICATE_SOURCE'].indexOf((i.result || {}).relevance) > -1; };
        var hidden = d.items.filter(isIgnored).length;
        var rows = showIgnored ? d.items : d.items.filter(function (i) { return !isIgnored(i); });
        host.querySelector('#igItems').innerHTML = '<h2>Content items</h2>' +
          '<p class="adm__hint">In discovery order. A done item is never processed again; a failed one is retried up to the limit, then "Retry failed" re-queues it.' +
          (hidden ? ' <b>' + hidden + '</b> repair or general post(s) were classified and set aside. <button type="button" class="ig__link" data-toggle-ignored="1">' +
            (showIgnored ? 'Hide them' : 'Show them') + '</button>' : '') + '</p>' +
          (rows.length ? '<div class="adm__scroll"><table class="adm__table"><thead><tr><th class="num">#</th><th>Content</th><th>Type</th><th>Status</th><th>Classified as</th>' +
            '<th class="num">Attempts</th><th>Result</th></tr></thead><tbody>' +
            rows.map(function (i) {
              var r = i.result || {};
              return '<tr style="cursor:default"><td class="num">' + (i.order + 1) + '</td>' +
                '<td>' + link(i.permalink, i.permalink ? i.permalink.replace('https://www.instagram.com', '') : 'manual entry') +
                  '<div class="adm__none" style="font-size:12px;max-width:420px">' + ui.esc(i.captionPreview || '') + '</div>' +
                  (i.mediaUrlOmitted ? '<div class="adm__none" style="font-size:11px">Instagram withheld the media (copyright); read from the caption only</div>' : '') + '</td>' +
                '<td>' + ui.text(i.contentType) + '</td><td>' + ui.pill(i.status, String(i.status).replace(/_/g, ' ')) + '</td>' +
                '<td>' + (r.relevance ? relevancePill(r.relevance) + (r.relevanceReason ? '<div class="adm__none" style="font-size:11px;max-width:300px">' + ui.esc(r.relevanceReason) + '</div>' : '') : ui.text(null)) + '</td>' +
                '<td class="num">' + ui.count(i.attempts) + '</td>' +
                '<td style="font-size:12px">' + (i.lastError ? '<span style="color:var(--bad)">' + ui.esc(i.lastError) + '</span>'
                  : r.extractionId ? (r.proposals ? ui.count(r.proposals) + ' group proposal(s) · ' : '') + ui.count(r.relationships) + ' relationships · ' + ui.count(r.references) + ' refs · v' + ui.esc(r.version) + (r.aiUsed ? ' · AI' : '')
                  : r.note ? ui.esc(r.note) : ui.text(null)) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : ui.emptyState(hidden ? 'Nothing actionable' : 'No items', hidden ? 'Every post of this job was classified as repair or general content.' : 'Nothing has been discovered for this job.'));
      }, function (err) { host.querySelector('#igActive').innerHTML = failBanner(err, 'the job'); });
    }
    host.addEventListener('click', function (e) {
      if (e.target.closest('[data-toggle-ignored]')) { showIgnored = !showIgnored; load(); return; }
      var btn = e.target.closest('[data-job-act]');
      if (!btn) return;
      jobAction(jobId, btn.getAttribute('data-job-act'), ctx).then(function (changed) { if (changed) load(); });
    });
    load();
  }

  /* ========================================================= extractions

     ONLY WHAT IS ACTIONABLE, BY DEFAULT

     The first tab is "Relevant": posts that make a compatibility claim. A
     repair or jumper post is still here — classified, with the words that
     decided it — but under "Ignored", where nobody has to wade through it.
     Each tab is one query on the tags the server stored with the extraction. */

  var RELEVANCE_LABEL = {
    RELEVANT_COMPATIBILITY: 'Relevant — compatibility', PARTIALLY_RELEVANT: 'Partially relevant', NEEDS_REVIEW: 'Needs review',
    INSUFFICIENT_EVIDENCE: 'Insufficient evidence', IRRELEVANT_REPAIR: 'Ignored — repair / technical',
    IRRELEVANT_GENERAL: 'Ignored — no compatibility claim', DUPLICATE_SOURCE: 'Ignored — duplicate post'
  };
  var PROPOSAL_ACTION = {
    NO_CHANGE: 'No change', UPDATE_EXISTING_GROUP: 'Update existing group', CREATE_NEW_GROUP: 'Create new group',
    MERGE_REQUIRED: 'Merge required', CONFLICT_REVIEW: 'Conflict review', MODEL_REVIEW: 'Model review',
    PRODUCT_CATEGORY_REVIEW: 'Product category review', REJECT: 'Reject'
  };

  function relevancePill(r) {
    return r ? ui.pill(r, RELEVANCE_LABEL[r] || r) : '<span class="adm__pill">not classified</span>';
  }

  function matchChip(r) {
    var m = r.match || {};
    var tone = m.status === 'matched' ? (m.requiresVariantConfirmation ? 'warn' : 'ok') : m.status === 'ambiguous' ? 'warn' : 'bad';
    return '<span class="ig__chip ig__chip--' + tone + '" title="' + ui.esc((m.notes || []).join('; ')) + '">' +
      ui.esc(r.text) + ' → ' + (m.modelName ? '<b>' + ui.esc(m.modelName) + '</b> <span class="mono">' + ui.esc(m.method || '') + '</span>'
        : '<b>' + ui.esc(m.status || 'unmatched') + '</b>') + (r.fromHashtag ? ' <span class="adm__none">#</span>' : '') + '</span>';
  }

  function textsHTML(x) {
    var t = x.texts || {};
    var block = function (title, list) {
      return (list || []).length ? '<h3 class="ig__h3">' + title + '</h3>' + list.map(function (o) {
        var manual = String(o.ref || '').indexOf('evidence:') === 0;
        return '<pre class="ig__quote">' + ui.esc(o.text) + '</pre><div class="adm__none" style="font-size:11px">' +
          (manual ? 'added by an admin' : ui.esc(o.ref || '')) +
          (o.confidence != null ? ' · confidence ' + Math.round(o.confidence * 100) + '%' : '') + '</div>'; }).join('') : '';
    };
    var unread = (x.mediaItems || []).filter(function (m) { return m.ocrStatus !== 'ok'; });
    return '<h3 class="ig__h3">Caption</h3><pre class="ig__quote">' + ui.esc(t.caption || '—') + '</pre>' +
      block('Text in images (OCR)', t.ocr) + block('Read by AI vision', t.vision) + block('Key frames', t.frames) + block('Entered by an admin', t.manual) +
      (t.transcript ? '<h3 class="ig__h3">Transcript</h3><pre class="ig__quote">' + ui.esc(t.transcript) + '</pre>' : '') +
      (unread.length ? '<p class="adm__none" style="font-size:12px">' + unread.map(function (m) {
        return ui.esc((m.kind || 'media') + ' ' + m.mediaId + ': ' + (m.code ? '[' + m.code + '] ' : '') + (m.reason || m.ocrStatus)); }).join('<br>') + '</p>' : '') +
      (function () {
        var lines = (x.mediaItems || []).map(mediaReadLine).filter(Boolean);
        return lines.length ? '<p class="adm__none" style="font-size:11px">' + lines.join('<br>') + '</p>' : '';
      })();
  }

  /** Which rungs one medium climbed: the screen's verdict, who read it, how surely. */
  function mediaReadLine(m) {
    var v = m.vision || {};
    var engine = v.engine || (m.readBy === 'vision' ? m.engine : null);
    var parts = [];
    if (m.screen && m.screen.verdict) {
      parts.push('screened ' + ui.esc(String(m.screen.verdict).replace(/_/g, ' ').toLowerCase()) + (m.screen.reason ? ' (' + ui.esc(m.screen.reason) + ')' : ''));
    }
    if (engine && !v.screenedOnly) {
      parts.push((m.kind === 'video' ? 'video read by ' : 'read by ') + ui.esc(engine) + (v.confidence != null ? ' at ' + Math.round(v.confidence * 100) + '%' : '') +
        (m.passes ? ', ' + m.passes + (m.passes === 1 ? ' pass' : ' passes') : '') + (m.seconds ? ', ' + ui.count(m.seconds) + ' s' : ''));
    }
    return parts.length ? ui.esc(m.mediaId) + ': ' + parts.join(' · ') : '';
  }

  function proposalsTable(x) {
    var status = x.proposalStatus || {};
    return '<div class="adm__scroll"><table class="adm__table"><thead><tr><th>Product</th><th>Proposed action</th><th>Group</th><th>Master</th>' +
      '<th class="num">Listed</th><th class="num">Matched</th><th class="num">Add</th><th class="num">Conflict</th><th class="num">Unmatched</th><th>Confidence</th><th>Status</th></tr></thead><tbody>' +
      x.proposals.map(function (p) {
        var c = p.counts || {};
        var st = status[p.candidateId] || p.status;
        return '<tr style="cursor:default"><td>' + ui.esc(p.productName || p.categoryId || 'not named') + '</td>' +
          '<td><b>' + ui.esc(PROPOSAL_ACTION[p.proposedAction] || p.proposedAction) + '</b></td>' +
          '<td>' + (p.targetGroupNo ? ui.esc(p.targetGroupNo) : '<span class="adm__none">new</span>') + '</td>' +
          '<td>' + (p.masterModelName ? ui.esc(p.masterModelName) : p.masterReviewRequired ? '<span style="color:var(--warn)">review required</span>' : ui.text(null)) + '</td>' +
          '<td class="num">' + ui.count(c.extracted) + '</td><td class="num">' + ui.count(c.matched) + '</td><td class="num">' + ui.count(c.add) + '</td>' +
          '<td class="num">' + ui.count(c.conflict) + '</td><td class="num">' + ui.count((c.unmatched || 0) + (c.needsReview || 0)) + '</td>' +
          '<td>' + ui.pill(p.confidence, p.confidence) + '</td><td>' + ui.pill(st, String(st).replace(/_/g, ' ')) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function evidenceForm(x) {
    return '<details class="ig__details ig__evidencebox"' + (x.relevance === 'INSUFFICIENT_EVIDENCE' ? ' open' : '') + '><summary>Add evidence — screenshots of the post, or its text</summary>' +
      '<form class="ig__form" data-evidence="' + ui.esc(x.contentKey) + '">' +
      '<p class="adm__hint" style="margin:0">For a reel Instagram would not hand over: open it, screenshot the frames that show the list, and attach them. ' +
      'They are read by the same OCR and vision, stored as <b>added by an admin</b>, and the post is analysed again. Nothing reaches production without approval.</p>' +
      '<label>Screenshots (JPEG / PNG, up to 4)<input type="file" name="shots" accept="image/jpeg,image/png,image/webp" multiple></label>' +
      '<label>…or type the text shown in the post<textarea name="text" rows="4" maxlength="8000" placeholder="Vivo Y20 Combo&#10;Compatible with:&#10;Vivo Y20&#10;Vivo Y20a"></textarea></label>' +
      '<div><button class="adm__btn adm__btn--primary" type="submit">Add and analyse again</button></div></form></details>';
  }

  function extractionCard(x, ctx) {
    var ignored = (x.filters || []).indexOf('ignored') > -1;
    var sig = x.signals || {};
    var h = '<div class="adm__card' + (ignored ? ' ig__ignored' : '') + '"><div class="ig__jobhead"><div><h2>' + username(x.username) + ' · ' + ui.esc(x.contentType || '') +
      ' · v' + ui.esc(x.version) + ' ' + relevancePill(x.relevance) + '</h2>' +
      '<p class="adm__hint" style="margin:2px 0 0">' + link(x.permalink, 'open post') + ' · ' + ui.dateTime(x.extractedAt) +
      ' · <span class="mono">' + ui.esc(x.processingVersion) + '</span></p></div>' +
      ((x.candidateIds || []).length ? '<a class="adm__btn" href="/admin/instagram/review?job=' + encodeURIComponent(x.jobId) + '&section=' +
        ((x.filters || []).indexOf('conflicts') > -1 ? 'conflicts' : (x.filters || []).indexOf('group_updates') > -1 ? 'group_updates' : (x.filters || []).indexOf('new_groups') > -1 ? 'new_groups' : 'review') + '">Review</a>' : '') + '</div>';

    var pl = x.pipeline || null;
    if (pl) {
      var cand = pl.candidate || {};
      h += '<p class="ig__pipeline"><span class="adm__pill">' + ui.esc(String(pl.state || '').replace(/_/g, ' ')) + '</span> ' +
        (pl.trace || []).map(function (t) { return '<span title="' + ui.esc(t.detail || '') + '">' + ui.esc(String(t.stage).replace(/_/g, ' ').toLowerCase()) + '</span>'; }).join(' <span class="adm__none">›</span> ') +
        (cand.tier ? ' <span class="adm__none">· free filter: ' + ui.esc(cand.tier) + ' (' + ui.esc(cand.score) + ')' +
          ((cand.reasons || []).length ? ' — ' + cand.reasons.map(function (r) { return ui.esc(r.signal) + ' ' + (r.weight > 0 ? '+' : '') + r.weight; }).join(', ') : '') + '</span>' : '') +
        (pl.aiConfidence != null ? ' <span class="adm__none">· reader confidence ' + Math.round(pl.aiConfidence * 100) + '%</span>' : '') + '</p>';
    }
    if (x.relevanceReason) {
      h += '<p class="ig__reason">' + ui.esc(x.relevanceReason) +
        ((sig.repairTerms || []).length ? ' <span class="adm__none">repair words: ' + ui.esc(sig.repairTerms.slice(0, 5).join(', ')) + '</span>' : '') +
        ((sig.compatTerms || []).length ? ' <span class="adm__none">compatibility words: ' + ui.esc(sig.compatTerms.slice(0, 5).join(', ')) + '</span>' : '') + '</p>';
    }

    if (ignored) {
      /* kept for audit, and deliberately small */
      h += '<details class="ig__details"><summary>' + ui.esc(String((x.texts || {}).caption || '').slice(0, 140) || 'no caption') + '</summary>' + textsHTML(x) + '</details>';
      /* the safety net: a person can overrule the free filter for one post */
      if (ctx.can('instagram.import') && x.permalink && /^https:\/\/www\.instagram\.com\//.test(x.permalink)) {
        h += '<div class="ig__minis"><button type="button" class="ig__mini" data-force="' + ui.esc(x.permalink) + '" data-user="' + ui.esc(x.username || '') + '">Analyse anyway — send this post to the model</button></div>';
      }
      if (ctx.can('instagram.import')) h += evidenceForm(x);
      return h + '</div>';
    }

    if ((x.proposals || []).length) h += '<h3 class="ig__h3">Compatibility lists compared with existing groups</h3>' + proposalsTable(x);

    var cat = x.category || {};
    h += '<div class="adm__grid2" style="margin-top:12px"><div>' + textsHTML(x) + '</div><div>' +
      '<h3 class="ig__h3">Category</h3><p>' + (cat.categoryId ? '<b>' + ui.esc(cat.categoryId) + '</b> from “' + ui.esc(cat.term) + '” (' + ui.esc(cat.method) + ')'
        : cat.unmappedTerm ? '<span style="color:var(--bad)">“' + ui.esc(cat.unmappedTerm) + '” has no category in the catalogue</span>' : '<span class="adm__none">none named</span>') + '</p>' +
      '<h3 class="ig__h3">Model references (' + (x.references || []).length + ')</h3><div class="ig__chips">' +
        ((x.references || []).map(matchChip).join('') || '<span class="adm__none">none</span>') + '</div>' +
      ((x.relationships || []).length && !(x.proposals || []).length ? '<h3 class="ig__h3">Relationships (' + x.relationships.length + ')</h3><ul class="ig__rels">' + x.relationships.map(function (r) {
        return '<li>' + ui.esc(r.sourceText) + ' <b>' + (r.polarity === 'negative' ? '≠' : '↔') + '</b> ' + ui.esc(r.compatibleText) +
          ' ' + ui.pill(r.compatibilityType, r.compatibilityType) + (r.extractedBy === 'ai' ? ' ' + ui.pill('draft', 'AI') : '') +
          (r.aiAgrees ? ' <span class="adm__none" style="font-size:11px">AI agrees</span>' : '') + '</li>';
      }).join('') + '</ul>' : '') +
      '<h3 class="ig__h3">AI</h3><p style="font-size:12px">' + (x.ai && x.ai.used
        ? 'Used' + (x.ai.model ? ' (' + ui.esc(x.ai.model) + ')' : '') + (x.ai.cached ? ', from cache' : '') + ': ' + ui.count(x.ai.valid) + ' valid, ' + ui.count(x.ai.rejected) + ' refused by validation'
        : ui.esc((x.ai && x.ai.reason) || 'not used')) + '</p>' +
      ((x.warnings || []).length ? '<p class="adm__none" style="font-size:12px">' + x.warnings.map(ui.esc).join('<br>') + '</p>' : '') +
      '</div></div>';
    if (ctx.can('instagram.import')) h += evidenceForm(x);
    return h + '</div>';
  }

  /** A screenshot, shrunk in the browser before it travels: the server reads
      text, and a 12-megapixel phone screenshot is a 4 MB request for nothing. */
  function shrink(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('“' + file.name + '” is not an image this browser can read')); };
      img.src = url;
    });
  }

  function submitEvidence(form, ctx, reload) {
    var contentKey = form.getAttribute('data-evidence');
    var files = Array.prototype.slice.call(form.querySelector('input[name="shots"]').files || [], 0, 4);
    var text = form.querySelector('textarea[name="text"]').value.trim();
    var button = form.querySelector('button[type="submit"]');
    if (!files.length && text.length < 3) { ctx.toast('Attach a screenshot or type the text first', 'warn'); return; }
    button.disabled = true;
    button.textContent = 'Reading…';
    /* one image per request: each stays far below the request size limit */
    var steps = files.map(function (f) { return { file: f }; });
    if (!steps.length) steps.push({ file: null });
    var summary = { read: 0, unread: 0, last: null };
    var next = function (i) {
      if (i >= steps.length) return Promise.resolve();
      var f = steps[i].file;
      var prep = f ? Promise.all([shrink(f, 1800, 0.88), shrink(f, 420, 0.6)]) : Promise.resolve(null);
      return prep.then(function (r) {
        return act({ action: 'add_evidence', contentKey: contentKey,
          images: r ? [{ data: r[0].split(',')[1], preview: r[1] }] : [],
          text: i === steps.length - 1 ? text : '' });
      }).then(function (out) {
        (out.added || []).forEach(function (a) { summary[a.status === 'read' ? 'read' : 'unread']++; if (a.status !== 'read' && a.reason) summary.reason = a.reason; });
        summary.last = out;
        return next(i + 1);
      });
    };
    next(0).then(function () {
      var o = summary.last || {};
      ctx.toast(summary.read + ' piece(s) of evidence read' + (summary.unread ? ', ' + summary.unread + ' could not be read' + (summary.reason ? ' (' + summary.reason + ')' : '') : '') +
        (o.analysed ? ' · now ' + (RELEVANCE_LABEL[o.relevance] || o.relevance) + ', ' + (o.proposals || 0) + ' group proposal(s)' : ''),
        summary.unread && !summary.read ? 'warn' : '');
      reload();
    }, function (err) {
      button.disabled = false;
      button.textContent = 'Add and analyse again';
      ctx.toast(err.message || 'Could not add the evidence', 'bad');
    });
  }

  function renderExtractions(host, ctx) {
    host = mount(host);
    var params = new URLSearchParams(location.search);
    var state = { filter: params.get('filter') || 'relevant', jobId: params.get('job') || '', sourceKey: params.get('source') || '' };
    host.innerHTML = head('Extraction Results', 'What each post said and what was read out of it. Only posts that make a compatibility claim are listed by default; repair and general posts are kept under Ignored.') +
      '<div class="adm__card">' +
      (state.jobId ? '<span class="adm__pill adm__pill--info">job ' + ui.esc(state.jobId) + '</span> ' : '') +
      (state.sourceKey ? '<span class="adm__pill adm__pill--info">' + ui.esc(state.sourceKey.replace(/^ig_/, '@')) + '</span> ' : '') +
      (state.jobId || state.sourceKey ? '<a href="/admin/instagram/extractions" class="adm__btn">Show every source</a>' : '') +
      '<div class="ig__tabs" role="tablist" id="igExTabs" style="margin-top:' + (state.jobId || state.sourceKey ? '10px' : '0') + '"></div></div>' +
      '<div id="igEx"><div class="adm__card">' + skel() + '</div></div>';

    function load() {
      var q = { view: 'extractions', filter: state.filter, limit: 40 };
      if (state.jobId) q.jobId = state.jobId;
      if (state.sourceKey) q.sourceKey = state.sourceKey;
      api(q).then(function (d) {
        if (!host.isConnected) return;
        host.querySelector('#igExTabs').innerHTML = (d.filters || []).map(function (f) {
          var n = d.counts ? d.counts[f.id] : null;
          return '<button type="button" role="tab" class="ig__tab' + (f.id === d.filter ? ' is-on' : '') + '" data-filter="' + f.id + '" aria-selected="' + (f.id === d.filter) + '">' +
            ui.esc(f.label) + (n === null || n === undefined ? '' : ' <span class="ig__count">' + n + '</span>') + '</button>';
        }).join('');
        var box = host.querySelector('#igEx');
        if (!d.extractions.length) {
          box.innerHTML = '<div class="adm__card">' + ui.emptyState('Nothing under “' + ((d.filters || []).filter(function (f) { return f.id === d.filter; })[0] || {}).label + '”', {
            relevant: 'Posts that make a compatibility claim appear here as an import processes them. Repair and general posts are under Ignored.',
            ignored: 'Repair, jumper and general posts are kept here with the reason each was set aside.',
            needs_review: 'Posts that talk about compatibility but whose list could not be read, and lists with unresolved models.',
            errors: 'Posts whose media could not be read at all.'
          }[d.filter] || 'No extraction carries this tag yet.') + '</div>';
          return;
        }
        box.innerHTML = (d.indexMissing ? ui.banner('warn', '<b>The Firestore index for these tabs is not deployed yet.</b> Showing matches among the 300 most recent extractions. ' +
            'Run <code>firebase deploy --only firestore:indexes</code> to make every tab a single indexed query.') : '') +
          d.extractions.map(function (x) { return extractionCard(x, ctx); }).join('') +
          (d.approximate ? '<p class="adm__hint">Showing matches among this source\'s 300 most recent extractions.</p>' : '');
      }, function (err) { host.querySelector('#igEx').innerHTML = failBanner(err, 'extractions'); });
    }

    host.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-filter]');
      if (!tab) return;
      state.filter = tab.getAttribute('data-filter');
      var qs = new URLSearchParams();
      qs.set('filter', state.filter);
      if (state.jobId) qs.set('job', state.jobId);
      if (state.sourceKey) qs.set('source', state.sourceKey);
      history.replaceState(null, '', '/admin/instagram/extractions?' + qs.toString());
      load();
    });
    host.addEventListener('click', function (e) {
      var f = e.target.closest('[data-force]');
      if (!f) return;
      if (!global.confirm('Send this post to the model even though the free filter set it aside?\n\nIt costs one deep read (and counts against the AI budget). Only this post is read.')) return;
      act({ action: 'analyze', profileUrl: 'https://www.instagram.com/' + f.getAttribute('data-user') + '/', postUrl: f.getAttribute('data-force'), force: true })
        .then(function (r) { ctx.go('/admin/instagram?job=' + encodeURIComponent(r.job.jobId)); },
              function (err) { ctx.toast(err.message || 'Could not start the analysis', 'bad'); });
    });
    host.addEventListener('submit', function (e) {
      var form = e.target.closest('form[data-evidence]');
      if (!form) return;
      e.preventDefault();
      submitEvidence(form, ctx, load);
    });
    load();
  }

  /* ============================================================= history */

  function renderHistory(host, ctx) {
    host = mount(host);
    var filter = { sourceKey: '', from: '', to: '', status: '', categoryId: '', modelQuery: '', band: '', reviewStatus: '' };
    host.innerHTML = head('Import History', 'Every import and what came of it. Filter by page, date and status — or by category, model, confidence and review status to find the candidates themselves.') +
      '<div class="adm__card"><form class="adm__filters" id="igHistF">' +
        '<select name="sourceKey"><option value="">Every page</option></select>' +
        '<label>From <input type="date" name="from"></label><label>To <input type="date" name="to"></label>' +
        '<select name="status"><option value="">Every status</option>' +
          ['completed', 'completed_with_errors', 'processing', 'paused', 'rate_limited', 'quota_exhausted', 'failed', 'cancelled', 'unable_to_collect']
            .map(function (s) { return '<option value="' + s + '">' + ui.esc(statusLabel(s)) + '</option>'; }).join('') + '</select>' +
        '<select name="categoryId"><option value="">Every category</option></select>' +
        '<input type="search" name="modelQuery" placeholder="Model (matched against the catalogue)">' +
        '<select name="band"><option value="">Any confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>' +
        '<select name="reviewStatus"><option value="">Any review status</option>' +
          ['pending', 'approved', 'rejected', 'duplicate', 'ignored', 'superseded', 'resolved'].map(function (s) { return '<option value="' + s + '">' + s + '</option>'; }).join('') + '</select>' +
        '<button class="adm__btn adm__btn--primary" type="submit">Apply</button></form>' +
      '<div id="igHist">' + skel() + '</div></div><div id="igHistC"></div>';

    Promise.all([api({ view: 'sources' }), api({ view: 'overview' })]).then(function (r) {
      var f = host.querySelector('#igHistF');
      f.sourceKey.innerHTML += r[0].sources.map(function (s) { return '<option value="' + ui.esc(s.sourceKey) + '">@' + ui.esc(s.username) + '</option>'; }).join('');
      f.categoryId.innerHTML += r[1].catalogue.categories.map(function (c) { return '<option value="' + ui.esc(c.id) + '">' + ui.esc(c.name) + '</option>'; }).join('');
    }).catch(function () { /* the filters still work by typing */ });

    host.querySelector('#igHistF').addEventListener('submit', function (e) {
      e.preventDefault();
      var d = new FormData(e.target);
      Object.keys(filter).forEach(function (k) { filter[k] = String(d.get(k) || ''); });
      load();
    });
    host.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-job-row]');
      if (row) ctx.go('/admin/instagram/jobs/' + encodeURIComponent(row.getAttribute('data-job-row')));
    });

    function load() {
      var q = { view: 'history', limit: 100 };
      Object.keys(filter).forEach(function (k) { if (filter[k]) q[k] = filter[k]; });
      if (q.from) q.from = new Date(q.from + 'T00:00:00').getTime();
      if (q.to) q.to = new Date(q.to + 'T23:59:59').getTime();
      api(q).then(function (d) {
        host.querySelector('#igHist').innerHTML = jobsTable(d.jobs, false) +
          (d.approximate ? '<p class="adm__hint" style="margin-top:10px">Date and combined filters are applied to the most recent imports; older matches may exist.</p>' : '');
        var cs = d.candidateSearch;
        host.querySelector('#igHistC').innerHTML = cs ? '<div class="adm__card"><h2>Matching candidates</h2>' +
          (cs.model ? '<p class="adm__hint">Model “' + ui.esc(cs.model.query) + '” → ' + (cs.model.modelName ? '<b>' + ui.esc(cs.model.modelName) + '</b>' : ui.esc(cs.model.status) + ' (no single catalogue record; not filtered by model)') + '</p>' : '') +
          (cs.candidates.length ? '<div class="adm__scroll"><table class="adm__table"><thead><tr><th>Relationship</th><th>Category</th><th>Confidence</th><th>Status</th><th>Section</th><th>Source</th><th>Date</th></tr></thead><tbody>' +
            cs.candidates.map(function (c) {
              var a = c.sourceMatch || c.referenceMatch || {}, b = c.compatibleMatch || {};
              return '<tr style="cursor:default"><td>' + ui.esc(a.modelName || c.sourceText || c.referenceText || '') + (c.kind === 'relationship' ? ' ' + (c.polarity === 'negative' ? '≠' : '↔') + ' ' + ui.esc(b.modelName || c.compatibleText || '') : '') + '</td>' +
                '<td>' + ui.text(c.categoryId) + '</td><td>' + ui.pill(c.confidence && c.confidence.band, c.confidence && c.confidence.band) + '</td>' +
                '<td>' + ui.pill(c.status) + '</td><td>' + ui.text(c.reviewSection) + '</td><td>@' + ui.esc(c.sourceUsername || '') + '</td><td>' + ui.date(c.createdAt) + '</td></tr>';
            }).join('') + '</tbody></table></div>' + (cs.approximate ? '<p class="adm__hint" style="margin-top:10px">Searched the 300 most recent candidates.</p>' : '')
            : ui.emptyState('No candidates match', 'Try fewer filters.')) + '</div>' : '';
      }, function (err) { host.querySelector('#igHist').innerHTML = failBanner(err, 'history'); });
    }
    load();
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.igImporter = { render: renderImporter };
  ADM.pages.igSources = { render: renderSources };
  ADM.pages.igJobs = { render: renderJobs };
  ADM.pages.igJob = { render: renderJob };
  ADM.pages.igExtractions = { render: renderExtractions };
  ADM.pages.igHistory = { render: renderHistory };
  ADM.ig = { statusLabel: statusLabel, username: username, link: link, head: head, failBanner: failBanner, relevancePill: relevancePill };
})(window);
