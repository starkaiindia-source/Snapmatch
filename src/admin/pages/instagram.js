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

  /* ========================================================= integration */

  function integrationBanners(i) {
    var out = '';
    if (!i.graph.configured) {
      out += ui.banner('warn', '<b>The Instagram Graph API is not configured.</b> Set ' +
        i.graph.missing.map(function (m) { return '<code>' + ui.esc(m) + '</code>'; }).join(' and ') +
        ' in the Vercel environment. Until then an import reports <b>Unable to collect</b> — nothing is scraped, ' +
        'nothing is invented. Manual entry of text you have read yourself still works.');
    }
    var parts = [];
    parts.push('Graph API ' + (i.graph.configured ? '<b>connected</b> (' + ui.esc(i.graph.version) + (i.graph.appSecretProof ? ', appsecret_proof on' : '') + ')' : '<b>off</b>'));
    parts.push('OCR ' + (i.ocr.configured ? '<b>' + ui.esc(i.ocr.provider.replace(/_/g, ' ')) + '</b>' : '<b>off</b> — images are read from their captions only'));
    parts.push('Video frames &amp; speech ' + (i.video.configured ? '<b>on</b>' : '<b>off</b> — reels are read from captions and cover images'));
    parts.push('AI extraction ' + (i.ai.configured ? '<b>' + ui.esc(i.ai.mode) + '</b>' : '<b>off</b> — rules only'));
    out += ui.banner('info', parts.join(' · ') + '. Limits: ' + i.limits.maxItemsPerJob + ' posts per job, ' +
      i.limits.dailyGraphCalls + ' API / ' + i.limits.dailyOcrCalls + ' OCR / ' + i.limits.dailyAiCalls + ' AI calls a day.');
    return out;
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
      '<p class="adm__hint" style="margin:2px 0 0">' + ui.esc(methodLabel(job.collectionMethod)) + ' · started ' + ui.dateTime(job.createdAt) +
      (job.postUrl ? ' · post ' + link(job.postUrl, job.postUrl.replace('https://www.instagram.com', '')) : '') +
      ' · job <span class="mono">' + ui.esc(job.jobId) + '</span></p></div>' +
      '<div class="ig__actions">' + jobButtons(job) + '</div></div>';

    if (job.statusReason) {
      out += ui.banner(job.status === 'unable_to_collect' || job.status === 'failed' ? 'bad' : 'warn', ui.esc(job.statusReason));
    }

    out += '<div class="ig__progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<div style="width:' + pct + '%"></div></div>' +
      '<p class="ig__progressline">' + ui.esc(line) + (running && job.leaseActive ? ' <span class="adm__none">· a worker is on it</span>' : '') + '</p>';

    out += '<dl class="adm__tiles">' +
      tile('Posts found', c.postsFound, (job.discovery ? ui.count(job.discovery.pages) + ' API pages' : '')) +
      tile('Reels / videos', c.videosFound) +
      tile('Images', c.imagesFound) +
      tile('Carousels', c.carouselsFound) +
      tile('Captions processed', c.captionsProcessed) +
      tile('Images OCR\'d', c.imagesOcrd) +
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

    out += '<p class="adm__hint" style="margin:12px 0 0">Usage: ' + ui.count(u.graphCalls) + ' API · ' + ui.count(u.ocrCalls) + ' OCR · ' +
      ui.count(u.videoCalls) + ' video · ' + ui.count(u.aiCalls) + ' AI calls · ' + ui.count(u.cacheHits) + ' cache hits</p>';

    out += '<div id="igErrors" hidden>' + errorsHTML(job) + '</div></div>';
    return out;
  }

  function jobButtons(job) {
    var b = [];
    var can = ADM.currentCan || function () { return true; };
    if (can('instagram.import')) {
      if (['paused', 'rate_limited', 'quota_exhausted', 'failed'].indexOf(job.status) > -1 ||
          (RUNNING.indexOf(job.status) > -1 && !job.leaseActive)) {
        b.push('<button class="adm__btn adm__btn--primary" data-job-act="resume">Resume job</button>');
      }
      if ((job.counts && job.counts.failed) || job.status === 'completed_with_errors') {
        b.push('<button class="adm__btn" data-job-act="retry_failed">Retry failed</button>');
      }
      if (['completed', 'completed_with_errors', 'cancelled', 'unable_to_collect'].indexOf(job.status) < 0) {
        b.push('<button class="adm__btn" data-job-act="cancel">Cancel job</button>');
      }
    }
    b.push('<button class="adm__btn" data-job-act="errors">View errors (' + (job.errorCount || 0) + ')</button>');
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
        '<div class="adm__card"><h2>Recent imports</h2>' + jobsTable(data.recentJobs, true) + '</div>';
      host.innerHTML = html;
      wireForm(host, ctx);
      var jobId = params.get('job');
      if (jobId) showJob(host, jobId, ctx);
    }, function (err) {
      host.innerHTML = head('Instagram Data Importer') + failBanner(err, 'the importer');
    });

    host.addEventListener('click', function (e) {
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
      }, function (err) {
        button.disabled = false;
        button.textContent = 'Analyze Source';
        ctx.toast(err.message || 'Could not start the import', 'bad');
      });
    });
  }

  var stopDriving = null;

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
        if (RUNNING.indexOf(next.status) < 0) ctx.toast('Import ' + statusLabel(next.status).toLowerCase(), next.status === 'completed' ? '' : 'warn');
      });
    }
  }

  /* ============================================================= sources */

  function renderSources(host, ctx) {
    host = mount(host);
    host.innerHTML = head('Instagram Sources', 'Every page an import has touched, with what Instagram allowed us to read.') +
      '<div class="adm__card" id="igSrc">' + skel() + '</div>';
    load();
    function load() {
      api({ view: 'sources' }).then(function (d) {
        var card = host.querySelector('#igSrc');
        if (!d.sources.length) { card.innerHTML = ui.emptyState('No sources yet', 'A source is added when an import is started for it.'); return; }
        card.innerHTML = '<p class="adm__hint">Follower counts are stored as metadata only. They never raise the confidence of a claim — evidence does. Reputation is the count of this page\'s claims that people approved or rejected.</p>' +
          '<div class="adm__scroll"><table class="adm__table"><thead><tr><th>Source</th><th>Account</th><th>Access</th>' +
          '<th class="num">Followers</th><th class="num">Approved</th><th class="num">Rejected</th><th>Last import</th><th></th></tr></thead><tbody>' +
          d.sources.map(function (s) {
            var rep = s.reputation || {};
            return '<tr style="cursor:default"><td><b>' + username(s.username) + '</b>' + (s.displayName ? '<div class="adm__none" style="font-size:12px">' + ui.esc(s.displayName) + '</div>' : '') + '</td>' +
              '<td>' + ui.text(s.accountType) + '</td>' +
              '<td>' + ui.pill(s.accessStatus || 'unknown', String(s.accessStatus || 'unknown').replace(/_/g, ' ')) +
                (s.accessReason ? '<div class="adm__none" style="font-size:11px;max-width:320px">' + ui.esc(s.accessReason) + '</div>' : '') + '</td>' +
              '<td class="num">' + ui.count(s.followersCount) + '</td>' +
              '<td class="num">' + ui.count(rep.approved || 0) + '</td><td class="num">' + ui.count(rep.rejected || 0) + '</td>' +
              '<td>' + ui.ago(s.lastImportAt) + '</td>' +
              '<td style="white-space:nowrap">' +
                (s.ignored ? ui.pill('ignored', 'ignored') + ' ' : '') +
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
      '<th class="num">Content</th><th class="num">Models extracted</th><th class="num">Matched</th>' +
      '<th class="num">Review required</th><th class="num">Approved</th><th class="num">Rejected</th><th class="num">Duplicates</th>' +
      (compact ? '' : '<th>Method</th>') + '</tr></thead><tbody>' +
      jobs.map(function (j) {
        var c = j.counts || {};
        return '<tr data-job-row="' + ui.esc(j.jobId) + '"><td><b>@' + ui.esc(j.username) + '</b>' +
          (j.postUrl ? '<div class="adm__none" style="font-size:11px">one post</div>' : '') + '</td>' +
          '<td>' + ui.dateTime(j.createdAt) + '</td>' +
          '<td>' + ui.pill(j.status, statusLabel(j.status)) + '</td>' +
          '<td class="num">' + ui.count(c.postsFound) + '</td><td class="num">' + ui.count(c.modelReferences) + '</td>' +
          '<td class="num">' + ui.count(c.matched) + '</td><td class="num">' + ui.count(c.pendingReview) + '</td>' +
          '<td class="num">' + ui.count(c.approved) + '</td><td class="num">' + ui.count(c.rejected) + '</td>' +
          '<td class="num">' + ui.count(c.duplicates) + '</td>' +
          (compact ? '' : '<td>' + ui.esc(methodLabel(j.collectionMethod)) + '</td>') + '</tr>';
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
    function load() {
      api({ view: 'job', jobId: jobId, itemLimit: 200 }).then(function (d) {
        paintJob(host, d.job, ctx);
        host.querySelector('#igItems').innerHTML = '<h2>Content items</h2>' +
          '<p class="adm__hint">In discovery order. A done item is never processed again; a failed one is retried up to the limit, then "Retry failed" re-queues it.</p>' +
          (d.items.length ? '<div class="adm__scroll"><table class="adm__table"><thead><tr><th class="num">#</th><th>Content</th><th>Type</th><th>Status</th>' +
            '<th class="num">Attempts</th><th>Result</th></tr></thead><tbody>' +
            d.items.map(function (i) {
              var r = i.result || {};
              return '<tr style="cursor:default"><td class="num">' + (i.order + 1) + '</td>' +
                '<td>' + link(i.permalink, i.permalink ? i.permalink.replace('https://www.instagram.com', '') : 'manual entry') +
                  '<div class="adm__none" style="font-size:12px;max-width:420px">' + ui.esc(i.captionPreview || '') + '</div>' +
                  (i.mediaUrlOmitted ? '<div class="adm__none" style="font-size:11px">Instagram withheld the media (copyright); read from the caption only</div>' : '') + '</td>' +
                '<td>' + ui.text(i.contentType) + '</td><td>' + ui.pill(i.status, String(i.status).replace(/_/g, ' ')) + '</td>' +
                '<td class="num">' + ui.count(i.attempts) + '</td>' +
                '<td style="font-size:12px">' + (i.lastError ? '<span style="color:var(--bad)">' + ui.esc(i.lastError) + '</span>'
                  : r.extractionId ? ui.count(r.relationships) + ' relationships · ' + ui.count(r.references) + ' refs · v' + ui.esc(r.version) + (r.aiUsed ? ' · AI' : '')
                  : r.note ? ui.esc(r.note) : ui.text(null)) + '</td></tr>';
            }).join('') + '</tbody></table></div>' : ui.emptyState('No items', 'Nothing has been discovered for this job.'));
      }, function (err) { host.querySelector('#igActive').innerHTML = failBanner(err, 'the job'); });
    }
    host.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-job-act]');
      if (!btn) return;
      jobAction(jobId, btn.getAttribute('data-job-act'), ctx).then(function (changed) { if (changed) load(); });
    });
    load();
  }

  /* ========================================================= extractions */

  function matchChip(r) {
    var m = r.match || {};
    var tone = m.status === 'matched' ? (m.requiresVariantConfirmation ? 'warn' : 'ok') : m.status === 'ambiguous' ? 'warn' : 'bad';
    return '<span class="ig__chip ig__chip--' + tone + '" title="' + ui.esc((m.notes || []).join('; ')) + '">' +
      ui.esc(r.text) + ' → ' + (m.modelName ? '<b>' + ui.esc(m.modelName) + '</b> <span class="mono">' + ui.esc(m.method || '') + '</span>'
        : '<b>' + ui.esc(m.status || 'unmatched') + '</b>') + (r.fromHashtag ? ' <span class="adm__none">#</span>' : '') + '</span>';
  }

  function renderExtractions(host, ctx) {
    host = mount(host);
    var params = new URLSearchParams(location.search);
    host.innerHTML = head('Extraction Results', 'What each post said, what the rules and the AI read out of it, and how every model reference matched the catalogue.') +
      '<div id="igEx"><div class="adm__card">' + skel() + '</div></div>';
    api({ view: 'extractions', jobId: params.get('job') || undefined, limit: 40 }).then(function (d) {
      var box = host.querySelector('#igEx');
      if (!d.extractions.length) { box.innerHTML = '<div class="adm__card">' + ui.emptyState('No extractions yet', 'They appear as an import processes content.') + '</div>'; return; }
      box.innerHTML = d.extractions.map(function (x) {
        var t = x.texts || {};
        var cat = x.category || {};
        return '<div class="adm__card"><div class="ig__jobhead"><div><h2>' + username(x.username) + ' · ' + ui.esc(x.contentType || '') +
          ' · v' + ui.esc(x.version) + '</h2><p class="adm__hint" style="margin:2px 0 0">' + link(x.permalink, 'open post') + ' · ' + ui.dateTime(x.extractedAt) +
          ' · <span class="mono">' + ui.esc(x.processingVersion) + '</span></p></div>' +
          '<a class="adm__btn" href="/admin/instagram/review?job=' + encodeURIComponent(x.jobId) + '">Review</a></div>' +
          '<div class="adm__grid2" style="margin-top:12px"><div>' +
            '<h3 class="ig__h3">Caption</h3><pre class="ig__quote">' + ui.esc(t.caption || '—') + '</pre>' +
            ((t.ocr || []).length ? '<h3 class="ig__h3">Text in images (OCR)</h3>' + t.ocr.map(function (o) {
              return '<pre class="ig__quote">' + ui.esc(o.text) + '</pre><div class="adm__none" style="font-size:11px">' + ui.esc(o.ref) +
                (o.confidence != null ? ' · OCR confidence ' + Math.round(o.confidence * 100) + '%' : '') + '</div>'; }).join('') : '') +
            ((t.frames || []).length ? '<h3 class="ig__h3">Key frames</h3>' + t.frames.map(function (f) {
              return '<pre class="ig__quote">' + ui.esc(f.text) + '</pre><div class="adm__none" style="font-size:11px">' + ui.esc(f.ref) + '</div>'; }).join('') : '') +
            (t.transcript ? '<h3 class="ig__h3">Transcript</h3><pre class="ig__quote">' + ui.esc(t.transcript) + '</pre>' : '') +
            ((x.mediaItems || []).some(function (m) { return m.ocrStatus !== 'ok'; })
              ? '<p class="adm__none" style="font-size:12px">' + x.mediaItems.filter(function (m) { return m.ocrStatus !== 'ok'; })
                  .map(function (m) { return ui.esc(m.mediaId + ': ' + (m.reason || m.ocrStatus)); }).join('<br>') + '</p>' : '') +
          '</div><div>' +
            '<h3 class="ig__h3">Category</h3><p>' + (cat.categoryId ? '<b>' + ui.esc(cat.categoryId) + '</b> from “' + ui.esc(cat.term) + '” (' + ui.esc(cat.method) + ')'
              : cat.unmappedTerm ? '<span style="color:var(--bad)">“' + ui.esc(cat.unmappedTerm) + '” has no category in the catalogue</span>' : '<span class="adm__none">none named</span>') + '</p>' +
            '<h3 class="ig__h3">Model references (' + (x.references || []).length + ')</h3><div class="ig__chips">' +
              ((x.references || []).map(matchChip).join('') || '<span class="adm__none">none</span>') + '</div>' +
            '<h3 class="ig__h3">Relationships (' + (x.relationships || []).length + ')</h3>' +
              ((x.relationships || []).length ? '<ul class="ig__rels">' + x.relationships.map(function (r) {
                return '<li>' + ui.esc(r.sourceText) + ' <b>' + (r.polarity === 'negative' ? '≠' : '↔') + '</b> ' + ui.esc(r.compatibleText) +
                  ' ' + ui.pill(r.compatibilityType, r.compatibilityType) + (r.extractedBy === 'ai' ? ' ' + ui.pill('draft', 'AI') : '') +
                  (r.aiAgrees ? ' <span class="adm__none" style="font-size:11px">AI agrees</span>' : '') + '</li>';
              }).join('') + '</ul>' : '<p class="adm__none">none</p>') +
            '<h3 class="ig__h3">AI</h3><p style="font-size:12px">' + (x.ai && x.ai.used
              ? 'Used' + (x.ai.model ? ' (' + ui.esc(x.ai.model) + ')' : '') + (x.ai.cached ? ', from cache' : '') + ': ' + ui.count(x.ai.valid) + ' valid, ' + ui.count(x.ai.rejected) + ' refused by validation'
              : ui.esc((x.ai && x.ai.reason) || 'not used')) + '</p>' +
            ((x.warnings || []).length ? '<p class="adm__none" style="font-size:12px">' + x.warnings.map(ui.esc).join('<br>') + '</p>' : '') +
          '</div></div></div>';
      }).join('');
    }, function (err) { host.querySelector('#igEx').innerHTML = failBanner(err, 'extractions'); });
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
  ADM.ig = { statusLabel: statusLabel, username: username, link: link, head: head, failBanner: failBanner };
})(window);
