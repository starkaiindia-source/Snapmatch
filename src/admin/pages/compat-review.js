/* ============================================================================
   Mobile Parts Finder · admin/pages/compat-review.js
   ----------------------------------------------------------------------------
   The Compatibility Review queue — the only door from an Instagram claim to
   the production fitment data.

   ----------------------------------------------------------------------------
   EACH CARD SHOWS THE WHOLE CHAIN

     SOURCE            which page, which post, how it was collected
     ORIGINAL CONTENT  the exact text the claim came from, and where in the
                       post (caption, OCR of image n, frame at t, transcript)
     EXTRACTED         brand, model, category, compatible model, as written
     PROGLIDE MATCH    the catalogue record each side resolved to, the METHOD
                       that found it, and every note about variants
     EVIDENCE          why the confidence is what it is — named reasons, not
                       a number pretending to be a probability

   ----------------------------------------------------------------------------
   APPROVE IS DISABLED WHERE THE SERVER WOULD REFUSE

   An unmatched side, an ambiguous side, an unconfirmed 4G/5G, a conflict —
   the button says why it cannot be pressed. The server refuses the same
   cases regardless; this only saves a round trip and an error toast.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var state = { section: 'ready', jobId: '', categoryId: '', band: '' };
  var categories = [];
  var rejectReasons = [];
  var cache = {};

  function api(p) { return ADM.api.instagram(p); }
  function act(b) { return ADM.api.instagramAction(b); }

  function mount(host) {
    host.innerHTML = '';
    var root = document.createElement('div');
    host.appendChild(root);
    return root;
  }

  var SOURCE_LABEL = { caption: 'the caption', manual: 'text entered by an admin', ocr: 'text read from an image (OCR)',
    frame: 'a video key frame (OCR)', transcript: 'the audio transcript', ai: 'the AI', hashtag: 'a hashtag' };

  function render(host, ctx) {
    host = mount(host);
    var params = new URLSearchParams(location.search);
    state.section = params.get('section') || 'ready';
    state.jobId = params.get('job') || '';

    host.innerHTML =
      '<div class="adm__head"><div><h1>Compatibility Review</h1>' +
      '<p>Only what is approved here can enter the production compatibility data. The catalogue stays the authority throughout.</p></div>' +
      '<div id="crBulk"></div></div>' +
      '<div class="adm__card"><form class="adm__filters" id="crFilters">' +
        (state.jobId ? '<span class="adm__pill adm__pill--info">job ' + ui.esc(state.jobId) + '</span> <a href="/admin/instagram/review" class="adm__btn">Show every job</a>' : '') +
        '<select name="categoryId"><option value="">Every category</option></select>' +
        '<select name="band"><option value="">Any confidence</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>' +
        '<button class="adm__btn" type="submit">Filter</button></form>' +
        '<div class="ig__tabs" role="tablist" id="crTabs"></div></div>' +
      '<div id="crList"><div class="adm__card"><div class="adm__skel" style="height:120px"></div></div></div>';

    api({ view: 'overview' }).then(function (d) {
      categories = d.catalogue.categories;
      rejectReasons = d.rejectReasons;
      var sel = host.querySelector('#crFilters select[name="categoryId"]');
      if (sel) sel.innerHTML += categories.map(function (c) { return '<option value="' + ui.esc(c.id) + '">' + ui.esc(c.name) + '</option>'; }).join('');
    }).catch(function () { /* the list still loads */ });

    host.querySelector('#crFilters').addEventListener('submit', function (e) {
      e.preventDefault();
      var d = new FormData(e.target);
      state.categoryId = String(d.get('categoryId') || '');
      state.band = String(d.get('band') || '');
      load(host, ctx);
    });

    host.addEventListener('click', function (e) { onClick(e, host, ctx); });
    host.addEventListener('input', function (e) { onInput(e, host); });
    host.addEventListener('change', function (e) { onChange(e, host, ctx); });
    load(host, ctx);
  }

  /* ================================================================ load */

  function load(host, ctx) {
    /* `queue`, not `section` — the admin dispatcher owns that parameter. */
    var q = { view: 'review', queue: state.section, limit: 40 };
    if (state.jobId) q.jobId = state.jobId;
    if (state.categoryId) q.categoryId = state.categoryId;
    if (state.band) q.band = state.band;
    var list = host.querySelector('#crList');
    return api(q).then(function (d) {
      if (!host.isConnected) return;
      rejectReasons = d.rejectReasons || rejectReasons;
      host.querySelector('#crTabs').innerHTML = d.sections.map(function (s) {
        var n = d.sectionCounts[s.id];
        return '<button type="button" role="tab" class="ig__tab' + (s.id === state.section ? ' is-on' : '') + '" data-section="' + s.id + '" aria-selected="' + (s.id === state.section) + '">' +
          ui.esc(s.label) + ' <span class="ig__count">' + (n === null || n === undefined ? ui.DASH : n) + '</span></button>';
      }).join('');

      var ready = d.sectionCounts.ready || 0;
      host.querySelector('#crBulk').innerHTML = state.section === 'ready' && ready && ctx.can('compat.approve')
        ? '<button class="adm__btn adm__btn--primary" data-bulk="1">Approve all valid (' + Math.min(ready, 25) + (ready > 25 ? ' of ' + ready : '') + ')</button>' : '';

      cache = {};
      d.candidates.forEach(function (c) { cache[c.candidateId] = c; });
      list.innerHTML = d.candidates.length
        ? d.candidates.map(function (c) { return cardHTML(c, ctx); }).join('') +
          (d.approximate ? '<p class="adm__hint">Filters were applied to the 300 most recent candidates.</p>' : '')
        : '<div class="adm__card">' + ui.emptyState('Nothing in this section', emptyNote(state.section)) + '</div>';
    }, function (err) {
      list.innerHTML = '<div class="adm__card">' + ui.banner('bad', '<b>Could not load the queue.</b> ' + ui.esc(err.message || '')) + '</div>';
    });
  }

  function emptyNote(section) {
    return {
      ready: 'Candidates land here only with exact catalogue matches, a clear category, an explicit compatibility statement and strong evidence.',
      review: 'Medium- and low-confidence candidates, with the reasons named on each card.',
      unmatched: 'Model references with no catalogue record. They are never created automatically.',
      ambiguous: 'References that fit more than one record.',
      conflicts: 'Sources that disagree with each other, or with production.',
      duplicates: 'Claims already in production or already approved — kept as extra evidence.',
      rejected: 'Rejected by a person, or refused by validation.'
    }[section] || '';
  }

  /* ================================================================ card */

  function cardHTML(c, ctx) {
    var conf = c.confidence || {};
    var post = c.sourcePost || {};
    var h = '<article class="ig__card" data-cid="' + ui.esc(c.candidateId) + '">';

    h += '<header class="ig__cardhead">' +
      ui.pill(c.reviewSection, sectionName(c.reviewSection)) + ' ' +
      (conf.band ? ui.pill(conf.band, conf.band + ' confidence') : '') + ' ' +
      (c.status !== 'pending' ? ui.pill(c.status) : '') +
      (c.extractedBy === 'ai' ? ' ' + ui.pill('draft', 'AI-proposed') : '') +
      '<span class="adm__none" style="margin-left:auto;font-size:12px">' + ui.dateTime(c.createdAt) + '</span></header>';

    h += '<div class="ig__cols">';

    /* SOURCE */
    h += '<section><h4>Source</h4><p><b>' + ADM.ig.username(c.sourceUsername) + '</b><br>' +
      (post.permalink ? ADM.ig.link(post.permalink, post.contentType ? 'open the ' + post.contentType : 'open the post') : '<span class="adm__none">no link</span>') +
      (post.publishedAt ? '<br><span class="adm__none">published ' + ui.date(post.publishedAt) + '</span>' : '') +
      '<br><span class="adm__none">' + ui.esc(({ graph_business_discovery: 'Graph API · Business Discovery', graph_own_account: 'Graph API · own account', manual_admin_entry: 'entered by an admin' })[post.collectionMethod] || '') + '</span></p></section>';

    /* ORIGINAL CONTENT */
    var ev = c.evidence || {};
    h += '<section><h4>Original content</h4><blockquote class="ig__quote">' +
      (c.evidenceLines && c.evidenceLines.length ? c.evidenceLines.map(ui.esc).join('<br>') : ui.esc(c.extractedText || '')) + '</blockquote>' +
      '<p class="adm__none" style="font-size:11px;margin:4px 0 0">From ' + ui.esc(SOURCE_LABEL[ev.source] || ev.source || 'the post') +
      (ev.ref ? ' <span class="mono">' + ui.esc(ev.ref) + '</span>' : '') +
      (ev.confidence != null ? ' · OCR confidence ' + Math.round(ev.confidence * 100) + '%' : '') + '</p>' +
      '<button type="button" class="ig__link" data-detail="1">Show media and all evidence</button></section>';

    /* EXTRACTED */
    h += '<section><h4>Extracted</h4><dl class="ig__dl">';
    if (c.kind === 'model_reference') {
      h += '<dt>Model</dt><dd>' + ui.esc(c.referenceText) + '</dd>';
    } else {
      h += '<dt>Brand</dt><dd>' + ui.text(c.brandId) + '</dd>' +
        '<dt>Model</dt><dd>' + ui.esc(c.sourceText) + '</dd>' +
        '<dt>Category</dt><dd>' + (c.categoryId
          ? '<b>' + ui.esc(categoryName(c.categoryId)) + '</b>' + (c.categoryText ? ' <span class="adm__none">from “' + ui.esc(c.categoryText) + '”, ' + ui.esc(c.categoryMethod || '') + '</span>' : ' <span class="adm__none">' + ui.esc(c.categoryMethod || '') + '</span>')
          : '<span style="color:var(--bad)">' + (c.unmappedCategoryText ? '“' + ui.esc(c.unmappedCategoryText) + '” is not a catalogue category' : 'not named') + '</span>') + '</dd>' +
        '<dt>Compatible</dt><dd>' + ui.esc(c.compatibleText) + '</dd>' +
        '<dt>Statement</dt><dd>' + ui.esc(String(c.compatibilityType || '').replace(/_/g, ' ')) + ', ' + (c.polarity === 'negative' ? '<b style="color:var(--bad)">NOT compatible</b>' : 'compatible') + '</dd>';
    }
    h += '</dl></section>';

    /* PROGLIDE MATCH */
    h += '<section><h4>ProGlide match</h4>';
    if (c.kind === 'model_reference') h += matchHTML(c.referenceMatch, 'reference');
    else h += matchHTML(c.sourceMatch, 'source') + matchHTML(c.compatibleMatch, 'compatible');
    h += '</section></div>';

    /* EVIDENCE */
    h += '<section class="ig__evidence"><h4>Evidence and confidence</h4>';
    if (conf.reasons && conf.reasons.length) {
      h += '<ul>' + conf.reasons.map(function (r) { return '<li>' + ui.esc(r) + '</li>'; }).join('') + '</ul>';
    } else if (c.kind === 'relationship') {
      h += '<p style="margin:0">Exact catalogue matches, a clear category, an explicit statement, strong evidence.</p>';
    }
    if (conf.score != null && c.kind === 'relationship') h += '<p class="adm__none" style="font-size:11px;margin:4px 0 0">Score ' + conf.score + ' — for sorting only; it is not a probability.</p>';
    if (c.corroborations) h += '<p style="margin:6px 0 0">' + ui.count(c.corroborations) + ' other source(s) made the same claim.</p>';
    if (c.conflict && c.conflict.active) h += ui.banner('bad', '<b>Compatibility conflict.</b> ' + ui.esc(c.conflict.note || '') + ' <button type="button" class="ig__link" data-detail="1">Show both sides</button>');
    if (c.status === 'duplicate') h += ui.banner('info', '<b>' + (c.duplicateReason === 'already_existing' ? 'Already Existing' : 'Duplicate') + '.</b> ' +
      ui.esc(String(c.duplicateReason || '').replace(/_/g, ' ')) + (c.duplicateOf ? ' — <span class="mono">' + ui.esc(c.duplicateOf) + '</span>' : '') + '. Kept as additional evidence.');
    if (c.productionState && c.kind === 'relationship') h += '<p class="adm__none" style="font-size:12px;margin:6px 0 0">' + productionNote(c) + '</p>';
    if (c.productionOutcome) h += '<p style="margin:6px 0 0"><b>Outcome:</b> ' + ui.esc(c.productionOutcome.replace(/_/g, ' ')) +
      (c.appliedChange ? ' — ' + ui.esc(c.appliedChange.addedModelName) + ' added to ' + ui.esc(c.appliedChange.groupId) + ' (' + c.appliedChange.previousMemberCount + ' → ' + c.appliedChange.newMemberCount + ')' : '') +
      (c.productionNote ? ' — ' + ui.esc(c.productionNote) : '') + '</p>';
    if (c.rejectReason) h += '<p style="margin:6px 0 0"><b>Rejected:</b> ' + ui.esc(c.rejectReason.replace(/_/g, ' ')) + (c.rejectNote ? ' — ' + ui.esc(c.rejectNote) : '') +
      (c.reviewer ? ' <span class="adm__none">by ' + ui.esc(c.reviewer === 'system' ? 'validation' : 'an admin') + '</span>' : '') + '</p>';
    h += '</section>';

    h += '<footer class="ig__actions">' + actionsHTML(c, ctx) + '</footer><div class="ig__inline"></div><div class="ig__detail"></div></article>';
    return h;
  }

  function sectionName(id) {
    return { ready: 'ready', review: 'review required', unmatched: 'unmatched model', ambiguous: 'ambiguous model',
             conflicts: 'conflict', duplicates: 'duplicate', rejected: 'rejected', closed: 'closed' }[id] || id;
  }

  function categoryName(id) {
    var c = categories.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : id;
  }

  function matchHTML(m, side) {
    m = m || { status: 'unmatched' };
    var label = { source: 'Model', compatible: 'Compatible', reference: 'Reference' }[side];
    var h = '<div class="ig__match ig__match--' + (m.status === 'matched' ? (m.requiresVariantConfirmation ? 'warn' : 'ok') : m.status === 'ambiguous' ? 'warn' : 'bad') + '">' +
      '<div class="adm__none" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">' + label + '</div>';
    if (m.status === 'matched') {
      h += '<b>' + ui.esc(m.modelName) + '</b> <span class="mono adm__none">' + ui.esc(m.modelId) + '</span><br>' +
        '<span style="font-size:12px">by <b>' + ui.esc(String(m.method || '').replace(/_/g, ' ')) + '</b> · ' + ui.esc(m.strength) + '</span>';
    } else {
      h += '<b style="color:' + (m.status === 'ambiguous' ? 'var(--warn)' : 'var(--bad)') + '">' + (m.status === 'ambiguous' ? 'Ambiguous' : 'Unmatched Model Reference') + '</b>' +
        (m.normalizedText ? ' <span class="mono adm__none">' + ui.esc(m.normalizedText) + '</span>' : '');
    }
    if (m.variantNote) h += '<div class="ig__warn">' + ui.esc(m.variantNote) + '</div>';
    (m.notes || []).filter(function (n) { return !m.variantNote || m.variantNote.indexOf(n) < 0; }).forEach(function (n) {
      h += '<div class="adm__none" style="font-size:11px">' + ui.esc(n) + '</div>';
    });
    if (m.alternatives && m.alternatives.length) {
      h += '<div class="ig__alts">' + m.alternatives.map(function (a) {
        return '<button type="button" class="ig__alt" data-pick="' + ui.esc(a.modelId) + '" data-side="' + side + '" title="' + ui.esc(a.note || '') + '">' + ui.esc(a.modelName) + '</button>';
      }).join('') + '</div>';
    }
    if (m.siblings && m.siblings.length) {
      h += '<div class="adm__none" style="font-size:11px">Separate records: ' + m.siblings.map(function (s) { return ui.esc(s.modelName); }).join(', ') + '</div>';
    }
    return h + '</div>';
  }

  function productionNote(c) {
    var p = c.productionState;
    var a = (c.sourceMatch || {}).modelName, b = (c.compatibleMatch || {}).modelName;
    return {
      same_group: 'Production: already in one group — nothing to write.',
      one_grouped: 'Production: ' + ui.esc(p.groupsSource.length ? a : b) + ' is in group ' + ui.esc((p.groupsSource.length ? p.groupsSource : p.groupsCompatible).join(', ')) +
        '; approving adds ' + ui.esc(p.groupsSource.length ? b : a) + ' to it (additive only).',
      different_groups: 'Production: different groups (' + ui.esc(p.groupsSource.join(', ')) + ' / ' + ui.esc(p.groupsCompatible.join(', ')) + ') — never merged here.',
      none: 'Production: neither model has a group in this category — approval is recorded for the catalogue build.',
      unknown: 'Production: ' + ui.esc(p.reason || 'could not be compared') + '.'
    }[p.state] || '';
  }

  function blockReason(c) {
    if (c.kind !== 'relationship') return 'Resolve the reference with "Select correct model"';
    if (c.polarity === 'negative') return 'A "not compatible" claim is evidence; approving it would delete production data';
    if (c.conflict && c.conflict.active) return 'Resolve the conflict first';
    var s = c.sourceMatch || {}, m = c.compatibleMatch || {};
    if (s.status !== 'matched' || m.status !== 'matched') return 'Both models must match catalogue records';
    if (s.requiresVariantConfirmation || m.requiresVariantConfirmation) return 'Confirm the 4G/5G/year variant with "Edit match" first';
    if (!c.categoryId) return 'Choose a catalogue category first';
    return '';
  }

  function actionsHTML(c, ctx) {
    var b = [];
    var pending = c.status === 'pending';
    if (pending && c.kind === 'relationship' && ctx.can('compat.approve')) {
      var why = blockReason(c);
      b.push('<button type="button" class="adm__btn adm__btn--primary" data-act="approve"' + (why ? ' disabled title="' + ui.esc(why) + '"' : '') + '>Approve</button>');
    }
    if (ctx.can('compat.review')) {
      if (pending) {
        b.push('<button type="button" class="adm__btn" data-act="reject">Reject</button>');
        b.push('<button type="button" class="adm__btn" data-act="pick">' + (c.kind === 'model_reference' ? 'Select correct model' : 'Edit match') + '</button>');
        if (c.kind === 'relationship') {
          b.push('<button type="button" class="adm__btn" data-act="category">Change category</button>');
          b.push('<button type="button" class="adm__btn" data-act="mark_duplicate">Mark duplicate</button>');
        } else {
          b.push('<button type="button" class="adm__btn" data-act="send_to_missing_models">Send to Missing models</button>');
        }
      } else if (['rejected', 'duplicate', 'ignored', 'resolved'].indexOf(c.status) > -1) {
        b.push('<button type="button" class="adm__btn" data-act="reopen">Reopen</button>');
      }
      b.push('<button type="button" class="adm__btn" data-act="ignore_source">Ignore source</button>');
    }
    if (c.status === 'approved' && !c.productionOutcome) b.push('<span class="adm__none">approved</span>');
    return b.join('');
  }

  /* ============================================================== events */

  function onClick(e, host, ctx) {
    var tab = e.target.closest('[data-section]');
    if (tab) {
      state.section = tab.getAttribute('data-section');
      history.replaceState(null, '', '/admin/instagram/review?section=' + state.section + (state.jobId ? '&job=' + encodeURIComponent(state.jobId) : ''));
      load(host, ctx);
      return;
    }
    if (e.target.closest('[data-bulk]')) return approveAll(host, ctx);

    var card = e.target.closest('.ig__card');
    if (!card) return;
    var id = card.getAttribute('data-cid');
    var c = cache[id];
    if (!c) return;

    if (e.target.closest('[data-detail]')) return showDetail(card, id);

    var alt = e.target.closest('[data-pick]');
    if (alt) {
      var remember = card.querySelector('input[name="remember"]');
      return run(host, ctx, { action: 'select_model', candidateId: id, side: alt.getAttribute('data-side'), modelId: alt.getAttribute('data-pick'),
        rememberAlias: !!(remember && remember.checked) }, 'Match updated');
    }

    var a = e.target.closest('[data-act]');
    if (!a) return;
    var inline = card.querySelector('.ig__inline');
    switch (a.getAttribute('data-act')) {
      case 'approve': return approve(host, ctx, c);
      case 'reject':
        inline.innerHTML = '<form class="ig__form ig__form--inline" data-form="reject"><label>Reason<select name="reason">' +
          rejectReasons.map(function (r) { return '<option value="' + r + '">' + ui.esc(r.replace(/_/g, ' ')) + '</option>'; }).join('') +
          '</select></label><label>Note <input name="note" maxlength="500" placeholder="optional"></label>' +
          '<button class="adm__btn adm__btn--primary" type="submit">Reject</button></form>';
        return;
      case 'pick':
        inline.innerHTML = '<div class="ig__picker">' +
          (c.kind === 'relationship' ? '<label>Side<select name="side"><option value="source">Model — ' + ui.esc(c.sourceText) + '</option>' +
            '<option value="compatible">Compatible — ' + ui.esc(c.compatibleText) + '</option></select></label>' : '<input type="hidden" name="side" value="reference">') +
          '<label>Find the existing catalogue record<input type="search" name="modelSearch" placeholder="Type a model name" autocomplete="off"></label>' +
          '<label class="ig__check"><input type="checkbox" name="remember"> Remember this spelling as an alias (written to /aliases, audited)</label>' +
          '<div class="ig__results"><span class="adm__none" style="font-size:12px">Only records already in the catalogue can be chosen. New models are never created here.</span></div></div>';
        inline.querySelector('input[name="modelSearch"]').focus();
        return;
      case 'category':
        inline.innerHTML = '<form class="ig__form ig__form--inline" data-form="category"><label>Catalogue category<select name="categoryId">' +
          categories.map(function (x) { return '<option value="' + ui.esc(x.id) + '"' + (x.id === c.categoryId ? ' selected' : '') + '>' + ui.esc(x.name) + '</option>'; }).join('') +
          '</select></label><button class="adm__btn adm__btn--primary" type="submit">Change</button></form>';
        return;
      case 'mark_duplicate':
        if (!global.confirm('Mark this candidate as a duplicate? It leaves the queue and stays as evidence.')) return;
        return run(host, ctx, { action: 'mark_duplicate', candidateId: id }, 'Marked duplicate');
      case 'reopen': return run(host, ctx, { action: 'reopen', candidateId: id }, 'Reopened');
      case 'send_to_missing_models': return run(host, ctx, { action: 'send_to_missing_models', candidateId: id }, 'Sent to Missing models');
      case 'ignore_source': {
        var reason = global.prompt('Ignore @' + c.sourceUsername + '? Every open candidate from this page leaves the queue, and new imports of it are refused.\n\nReason:');
        if (reason === null) return;
        return run(host, ctx, { action: 'ignore_source', sourceKey: c.sourceKey, reason: reason }, 'Source ignored');
      }
    }
  }

  var searchTimer = null;
  function onInput(e, host) {
    if (e.target.name !== 'modelSearch') return;
    var card = e.target.closest('.ig__card');
    var results = card.querySelector('.ig__results');
    var q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) return;
    searchTimer = setTimeout(function () {
      api({ view: 'models', q: q }).then(function (d) {
        if (!card.isConnected) return;
        var side = (card.querySelector('[name="side"]') || {}).value || 'reference';
        results.innerHTML = d.models.length ? d.models.map(function (m) {
          return '<button type="button" class="ig__alt" data-pick="' + ui.esc(m.modelId) + '" data-side="' + ui.esc(side) + '">' + ui.esc(m.modelName) +
            ' <span class="mono adm__none">' + ui.esc(m.modelId) + '</span></button>';
        }).join('') : '<span class="adm__none" style="font-size:12px">No catalogue record matches. It cannot be added from here — use Missing models.</span>';
      });
    }, 250);
  }

  function onChange(e) {
    if (e.target.name !== 'side') return;
    var card = e.target.closest('.ig__card');
    Array.prototype.forEach.call(card.querySelectorAll('.ig__results [data-pick]'), function (b) { b.setAttribute('data-side', e.target.value); });
  }

  /* inline forms */
  document.addEventListener('submit', function (e) {
    var form = e.target.closest && e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    var card = form.closest('.ig__card');
    var host = card && card.closest('#admPage > div');
    if (!card || !host) return;
    var id = card.getAttribute('data-cid');
    var d = new FormData(form);
    var ctx = currentCtx;
    if (form.getAttribute('data-form') === 'reject') {
      run(host, ctx, { action: 'reject', candidateId: id, reason: String(d.get('reason')), note: String(d.get('note') || '') }, 'Rejected');
    } else {
      run(host, ctx, { action: 'change_category', candidateId: id, categoryId: String(d.get('categoryId')) }, 'Category changed');
    }
  });

  var currentCtx = null;

  function run(host, ctx, body, done) {
    return act(body).then(function (r) {
      ctx.toast(r.note || done + (r.alias && r.alias.learned ? ' · alias remembered' : r.alias && r.alias.reason ? ' · alias not saved: ' + r.alias.reason : ''));
      load(host, ctx);
    }, function (err) {
      ctx.toast(err.message || 'That was refused', 'bad');
      load(host, ctx);
    });
  }

  function approve(host, ctx, c) {
    var low = c.confidence && c.confidence.band === 'low';
    var p = c.productionState || {};
    var msg = low
      ? 'LOW-CONFIDENCE candidate.\n\n' + (c.confidence.reasons || []).join('\n') + '\n\nApprove it anyway? Approval cannot be undone from this page.'
      : p.state === 'one_grouped'
        ? 'Approve and write to production?\n\nThis ADDS one model to an existing group (' + (p.groupsSource.concat(p.groupsCompatible)).join(', ') + '). Nothing is removed. It cannot be undone from this page.'
        : 'Approve this relationship?\n\nIt is recorded in the approved ledger with its evidence.';
    if (!global.confirm(msg)) return;
    return run(host, ctx, { action: 'approve', candidateId: c.candidateId, acknowledgeLowConfidence: low }, 'Approved');
  }

  function approveAll(host, ctx) {
    if (!global.confirm('Approve every high-confidence candidate in this section (up to 25)?\n\nEach is approved on its own, in its own transaction. Where production can take it additively it is written; nothing is removed. Medium and low confidence are never included.')) return;
    act({ action: 'approve_all_valid', jobId: state.jobId || undefined }).then(function (r) {
      var ok = r.results.filter(function (x) { return x.ok; }).length;
      ctx.toast(ok + ' approved' + (r.attempted - ok ? ', ' + (r.attempted - ok) + ' refused — see their cards' : ''), r.attempted - ok ? 'warn' : '');
      load(host, ctx);
    }, function (err) { ctx.toast(err.message || 'Could not approve', 'bad'); });
  }

  /* ============================================================== detail */

  function showDetail(card, id) {
    var box = card.querySelector('.ig__detail');
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="adm__skel" style="height:40px;margin-top:10px"></div>';
    api({ view: 'candidate', candidateId: id }).then(function (d) {
      var h = '';
      var media = (d.content && d.content.mediaItems) || [];
      if (media.length) {
        h += '<h4>Media</h4><div class="ig__media">' + media.map(function (m) {
          return '<figure>' + (m.previewUrl && /^https:\/\//i.test(m.previewUrl) ? '<img src="' + ui.esc(m.previewUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
            'onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'adm__none\',textContent:\'Preview link expired — open the post\'}))">' : '<span class="adm__none">no preview</span>') +
            '<figcaption>' + ui.esc(m.kind) + ' <span class="mono">' + ui.esc(m.mediaId) + '</span> · ' + ui.esc(m.ocrStatus) +
            (m.engine ? ' · ' + ui.esc(m.engine) : '') + (m.cached ? ' · cached' : '') + (m.reason ? '<br>' + ui.esc(m.reason) : '') + '</figcaption></figure>';
        }).join('') + '</div>';
      }
      if (d.content && d.content.caption) h += '<h4>Full caption</h4><pre class="ig__quote">' + ui.esc(d.content.caption) + '</pre>';
      if (d.conflicts && d.conflicts.length) {
        h += '<h4>The other side of the conflict</h4>' + d.conflicts.map(function (o) {
          return '<blockquote class="ig__quote">' + ui.esc(o.extractedText) + '</blockquote><p class="adm__none" style="font-size:11px;margin:2px 0 8px">@' +
            ui.esc(o.sourceUsername) + ' · ' + (o.polarity === 'negative' ? 'says NOT compatible' : 'says compatible') + ' · ' + ui.esc(o.status) +
            (o.sourcePost && o.sourcePost.permalink ? ' · ' + ADM.ig.link(o.sourcePost.permalink, 'post') : '') + '</p>';
        }).join('');
      }
      if (d.evidence && d.evidence.length) {
        h += '<h4>All evidence for this relationship (' + d.evidence.length + ')</h4><ul class="ig__rels">' + d.evidence.map(function (x) {
          return '<li>' + (x.polarity === 'negative' ? '<b style="color:var(--bad)">NOT</b> ' : '') + '“' + ui.esc(String(x.evidenceText || '').slice(0, 200)) + '” — @' +
            ui.esc(x.sourceUsername || '') + ' ' + (x.permalink ? ADM.ig.link(x.permalink, 'post') : '') + ' <span class="adm__none">' + ui.esc(x.candidateStatus || '') + '</span></li>';
        }).join('') + '</ul>';
      }
      if (d.ledger) h += '<h4>Approved ledger</h4><p style="font-size:12px">' + ui.esc(d.ledger.status.replace(/_/g, ' ')) + ' · approved ' + ui.dateTime(d.ledger.approvedAt) +
        ' by ' + ui.esc(d.ledger.approvedByEmail || d.ledger.approvedBy) + (d.ledger.appliedChange ? ' · ' + ui.esc(d.ledger.appliedChange.groupId) + ' ' +
        d.ledger.appliedChange.previousMemberCount + ' → ' + d.ledger.appliedChange.newMemberCount + ' members' : '') + '</p>';
      var hist = (d.candidate.history || []).slice().reverse();
      if (hist.length) h += '<h4>History</h4><ul class="adm__timeline">' + hist.map(function (x) {
        return '<li><time>' + ui.dateTime(x.at) + '</time><div><b>' + ui.esc(String(x.action).replace(/_/g, ' ')) + '</b> ' +
          ui.esc(x.byEmail || (x.by === 'system' ? 'system' : x.by)) + (x.note ? ' — ' + ui.esc(x.note) : '') + '</div></li>';
      }).join('') + '</ul>';
      box.innerHTML = h || '<p class="adm__none">Nothing more recorded.</p>';
    }, function (err) { box.innerHTML = ui.banner('bad', ui.esc(err.message || 'Could not load the detail')); });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.igReview = { render: function (host, ctx) { currentCtx = ctx; render(host, ctx); } };
})(window);
