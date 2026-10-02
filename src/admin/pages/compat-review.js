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
   A LIST IS ONE CARD, NOT SIXTY

   A compatibility list ("this display fits these 68 models") is a GROUP
   PROPOSAL: the existing group beside what the post lists, and the
   difference — ADD, REMOVE (always none), UNMATCHED, NEEDS REVIEW, CONFLICT.
   A model that already belongs to another group in the category is shown as
   "BLOCKED — MODEL ALREADY ASSIGNED"; the server refuses the approval until a
   person has dealt with each one.

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
      group_updates: 'A compatibility list that matches an existing group and names models the group does not hold yet. Approving adds them; nothing is removed.',
      new_groups: 'A compatibility list none of whose models has a group in the category. Proposed only after every existing group was checked.',
      ready: 'Candidates land here only with exact catalogue matches, a clear category, an explicit compatibility statement and strong evidence.',
      review: 'Medium- and low-confidence candidates, with the reasons named on each card.',
      unmatched: 'Model references with no catalogue record. They are never created automatically.',
      ambiguous: 'References that fit more than one record.',
      conflicts: 'Sources that disagree with each other or with production — and lists that name a model already assigned to another group.',
      duplicates: 'Claims already in production or already approved — kept as extra evidence.',
      rejected: 'Rejected by a person, or refused by validation.'
    }[section] || '';
  }

  /* ================================================================ card */

  function cardHTML(c, ctx) {
    if (c.kind === 'group_proposal') return proposalHTML(c, ctx);
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
      (ev.confidence != null ? ' · ' + confidenceWord(ev) + ' ' + Math.round(ev.confidence * 100) + '%' : '') + '</p>' +
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
    h += '<section><h4>Catalogue match</h4>';
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
    return { group_updates: 'group update', new_groups: 'new group', ready: 'ready', review: 'review required', unmatched: 'unmatched model', ambiguous: 'ambiguous model',
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

  /* ====================================================== group proposals

     A compatibility LIST against an existing group. The card is the
     comparison itself:

       the group production has now  |  what the Instagram source lists
       ADD · REMOVE · UNMATCHED · NEEDS REVIEW · CONFLICT

     and every entry can be opened to the frame, the line and the OCR text
     it was read from. Nothing on it is editable in the browser alone: each
     button is a server call, and the server recomputes the whole proposal
     against production before the card is drawn again. */

  var ACTION_LABEL = {
    NO_CHANGE: 'No change', UPDATE_EXISTING_GROUP: 'Update Existing Group', CREATE_NEW_GROUP: 'Create Group',
    MERGE_REQUIRED: 'Merge required', CONFLICT_REVIEW: 'Conflict review', MODEL_REVIEW: 'Model review',
    PRODUCT_CATEGORY_REVIEW: 'Product category review', REJECT: 'Reject'
  };

  function where(e) {
    if (!e) return '';
    var src = SOURCE_LABEL[e.source] || e.source || 'the post';
    var ref = e.ref ? String(e.ref) : '';
    if (ref.indexOf('evidence:') === 0) return 'a screenshot added by an admin';
    var at = /@(\d+)ms$/.exec(ref);
    return src + (at ? ' at ' + (Number(at[1]) / 1000).toFixed(1) + 's' : (ref ? ' ' + ref : ''));
  }

  /* a model that read the picture reports its own confidence; that is not an OCR score */
  function confidenceWord(ev) {
    return ev && ev.source === 'vision' ? 'AI reading confidence' : 'OCR confidence';
  }

  function memberTitle(m) {
    var e = (m.evidence || [])[0];
    return [
      'As written: ' + (m.texts || [m.text]).join(' · '),
      e ? 'Source: ' + where(e) + (e.line ? ' — “' + e.line + '”' : '') : '',
      e && e.confidence != null ? confidenceWord(e) + ': ' + Math.round(e.confidence * 100) + '%' : '',
      'Database match: ' + (m.matchStatus || '') + (m.match && m.match.modelId ? ' (' + m.match.modelId + ')' : ''),
      m.occurrences > 1 ? 'Seen ' + m.occurrences + ' times' : ''
    ].filter(Boolean).join('\n');
  }

  function memberChip(m, tone, tail) {
    var name = m.match && m.match.modelName ? m.match.modelName : m.text;
    return '<span class="ig__chip ig__chip--' + tone + '" title="' + ui.esc(memberTitle(m)) + '">' + ui.esc(name) +
      (m.match && m.match.modelName && m.match.modelName.toLowerCase() !== String(m.text).toLowerCase()
        ? ' <span class="adm__none">“' + ui.esc(m.text) + '”</span>' : '') + (tail || '') + '</span>';
  }

  function mbtn(act, m, label, extra) {
    return '<button type="button" class="ig__mini" data-pact="' + act + '" data-key="' + ui.esc(m.key) + '"' + (extra || '') + '>' + ui.esc(label) + '</button>';
  }

  function memberRows(list, kind, editable) {
    return list.map(function (m) {
      var h = '<li class="ig__member ig__member--' + kind + '" data-key="' + ui.esc(m.key) + '">';
      if (kind === 'conflict') {
        h += '<b>' + ui.esc(m.match.modelName) + '</b> <span class="ig__blocked">BLOCKED — MODEL ALREADY ASSIGNED</span>' +
          '<div class="ig__sub">Existing group: <button type="button" class="ig__link" data-group="' + ui.esc(m.currentGroupId || '') + '">' +
          ui.esc(String(m.currentGroupId || '').toUpperCase()) + '</button>' +
          (m.currentGroupMaster ? ' (master ' + ui.esc(m.currentGroupMaster) + ')' : '') +
          (m.decision === 'reassign_request' ? ' · <b>reassignment requested</b> — recorded; move it in Compatibility Management (remove it from that group, then add it here)' : '') + '</div>';
        if (editable) {
          h += '<div class="ig__minis">' + mbtn('exclude', m, 'Keep it where it is') +
            (m.decision === 'reassign_request' ? mbtn('clear', m, 'Withdraw the request') : mbtn('reassign', m, 'Request reassignment')) + '</div>';
        }
      } else if (kind === 'review' || kind === 'unmatched') {
        var mm = m.match || {};
        h += '<b>' + ui.esc(m.text) + '</b> <span class="adm__none">' + ui.esc(m.matchStatus || '') + '</span>' +
          (mm.modelName ? '<div class="ig__sub">Closest record: ' + ui.esc(mm.modelName) + (mm.variantNote ? ' — ' + ui.esc(mm.variantNote) : '') + '</div>' : '') +
          ((mm.notes || []).length && !mm.variantNote ? '<div class="ig__sub">' + ui.esc(mm.notes.join('; ')) + '</div>' : '');
        if (m.suggestion) {
          h += '<div class="ig__sub ig__suggest">Second opinion: ' + (m.suggestion.modelName ? 'suggests <b>' + ui.esc(m.suggestion.modelName) + '</b>' : '') +
            (m.suggestion.printedText ? (m.suggestion.modelName ? ' — ' : '') + 'reads it as “' + ui.esc(m.suggestion.printedText) + '”' : '') +
            (m.disputed && !m.suggestion.printedText && !m.suggestion.modelName ? 'disputes this entry' : '') +
            (m.suggestion.note ? ' <span class="adm__none">(' + ui.esc(m.suggestion.note) + ')</span>' : '') + '</div>';
        }
        if (editable) {
          var alts = (m.suggestion && m.suggestion.modelId ? [{ modelId: m.suggestion.modelId, modelName: m.suggestion.modelName, note: 'suggested by the second opinion' }] : [])
            .concat(mm.modelId ? [{ modelId: mm.modelId, modelName: mm.modelName }] : []).concat(mm.alternatives || [])
            .filter(function (a, i, all) { return all.findIndex(function (b) { return b.modelId === a.modelId; }) === i; }).slice(0, 6);
          h += '<div class="ig__minis">' + alts.map(function (a) {
            return '<button type="button" class="ig__alt" data-pact="pick" data-key="' + ui.esc(m.key) + '" data-model="' + ui.esc(a.modelId) +
              '" title="' + ui.esc(a.note || 'Use this catalogue record') + '">' + ui.esc(a.modelName) + '</button>';
          }).join('') + mbtn('search', m, 'Find the record…') + mbtn('exclude', m, 'Exclude') + '</div>';
        }
      } else if (kind === 'excluded') {
        h += '<span class="adm__none">' + ui.esc(m.match && m.match.modelName ? m.match.modelName : m.text) + '</span>' +
          (m.currentGroupId ? ' <span class="ig__sub" style="display:inline">stays in ' + ui.esc(String(m.currentGroupId).toUpperCase()) + '</span>' : '') +
          (editable ? ' ' + mbtn('clear', m, 'Put back') : '');
      }
      return h + '</li>';
    }).join('');
  }

  function proposalBlock(p) {
    var ms = p.members || [];
    var by = function (s) { return ms.filter(function (m) { return m.state === s; }); };
    if (p.status !== 'pending') return 'closed';
    if (!p.categoryId) return 'Choose a catalogue category first';
    if (by('conflict').filter(function (m) { return !m.decision; }).length) return 'Resolve every BLOCKED model first: keep it where it is, or request a reassignment';
    if (p.target && p.target.mode === 'undecided') return 'Choose the group this list describes';
    if (p.proposedAction === 'CREATE_NEW_GROUP' && p.masterReviewRequired) return 'MASTER MODEL REVIEW REQUIRED: choose the master model';
    if (['UPDATE_EXISTING_GROUP', 'CREATE_NEW_GROUP', 'NO_CHANGE'].indexOf(p.proposedAction) < 0) return (p.actionReasons || [])[0] || 'Not approvable as it stands';
    return '';
  }

  function proposalHTML(p, ctx) {
    var ms = p.members || [];
    var by = function (s) { return ms.filter(function (m) { return m.state === s; }); };
    var t = p.target || {};
    var conf = p.confidence || {};
    var post = p.sourcePost || {};
    var pending = p.status === 'pending';
    var editable = pending && ctx.can('compat.review');
    var existing = by('existing'), add = by('add'), conflict = by('conflict'), review = by('needs_review'), unmatched = by('unmatched'), excluded = by('excluded');
    var title = !p.categoryId ? 'PRODUCT CATEGORY REVIEW'
      : p.conflict && p.conflict.active ? 'CATEGORY CONFLICT'
      : t.mode === 'existing' ? 'EXISTING GROUP FOUND' : t.mode === 'new' ? 'NEW COMPATIBILITY GROUP' : 'GROUP REVIEW';

    var h = '<article class="ig__card ig__card--proposal" data-cid="' + ui.esc(p.candidateId) + '">';
    h += '<header class="ig__cardhead"><b class="ig__ptitle">' + title + '</b> ' +
      ui.pill(p.reviewSection, sectionName(p.reviewSection)) + ' ' +
      (conf.band ? ui.pill(conf.band, conf.band + ' confidence') : '') + ' ' +
      (p.status !== 'pending' ? ui.pill(p.status) : '') +
      (p.extractedBy === 'ai' ? ' ' + ui.pill('draft', 'read by AI vision') : '') +
      '<span class="adm__none" style="margin-left:auto;font-size:12px">' + ui.dateTime(p.createdAt) + '</span></header>';

    h += '<div class="ig__cols">';

    /* PRODUCT + MASTER */
    var master = p.proposedMaster;
    h += '<section><h4>Product</h4><dl class="ig__dl">' +
      '<dt>Category</dt><dd>' + (p.categoryId ? '<b>' + ui.esc(categoryName(p.categoryId)) + '</b>' +
        (p.categoryText ? ' <span class="adm__none">from “' + ui.esc(p.categoryText) + '”' + (p.categoryMethod ? ', ' + ui.esc(p.categoryMethod) : '') + '</span>' : '')
        : '<span style="color:var(--bad)">' + (p.unmappedCategoryText ? '“' + ui.esc(p.unmappedCategoryText) + '” is not a catalogue category' : 'not named in the post') + '</span>') + '</dd>' +
      '<dt>Named as</dt><dd>' + (p.productName ? ui.esc(p.productName) : '<span class="adm__none">no product title in the post</span>') + '</dd>' +
      '<dt>Master model</dt><dd>' + (master ? '<b>' + ui.esc(master.modelName) + '</b> <span class="adm__none">' + ui.esc(master.reason || '') + '</span>'
        : p.masterReviewRequired ? '<b style="color:var(--warn)">MASTER MODEL REVIEW REQUIRED</b>' : ui.text(null)) + '</dd>' +
      '</dl>';
    if (editable && t.mode === 'new' && add.length) {
      h += '<div class="ig__minis"><select class="ig__sel" data-master>' + '<option value="">Choose the master model…</option>' +
        add.map(function (m) { return '<option value="' + ui.esc(m.match.modelId) + '"' + (master && master.modelId === m.match.modelId ? ' selected' : '') + '>' + ui.esc(m.match.modelName) + '</option>'; }).join('') +
        '</select></div>';
    }
    h += '</section>';

    /* THE EXISTING GROUP */
    h += '<section><h4>' + (t.mode === 'existing' ? 'Existing group' : 'Group') + '</h4>';
    if (t.mode === 'existing') {
      h += '<p><b>' + ui.esc(t.groupNo || String(t.groupId).toUpperCase()) + '</b>' + (t.partCode ? ' · <span class="mono">' + ui.esc(t.partCode) + '</span>' : '') +
        '<br>Master: <b>' + ui.esc(t.masterModelName || '—') + '</b> · ' + ui.count(t.memberCount) + ' models' +
        '<br><span class="adm__none">' + ui.esc(t.reason || '') + '</span></p>' +
        '<details class="ig__details"><summary>CURRENT MODELS (' + ui.count((t.memberNames || []).length || t.memberCount) + ')</summary><div class="ig__chips">' +
        ((t.memberNames || []).map(function (n) { return '<span class="ig__chip">' + ui.esc(n) + '</span>'; }).join('') || '<span class="adm__none">not loaded</span>') +
        '</div></details>';
    } else if (t.mode === 'new') {
      h += '<p><b>No existing group.</b><br><span class="adm__none">' + ui.esc(t.reason || '') + '</span><br>' +
        'Duplicate check: <b>' + ui.esc(p.duplicateCheck || '—') + '</b> · Category conflict: <b>' + (conflict.length ? conflict.length + ' model(s)' : 'NONE') + '</b></p>';
    } else {
      h += '<p style="color:var(--bad)"><b>No group chosen.</b><br>' + ui.esc(t.reason || '') + '</p>';
    }
    var others = p.otherGroups || [];
    if (others.length || (t.mode !== 'new' && editable)) {
      h += '<details class="ig__details"' + (t.mode === 'undecided' ? ' open' : '') + '><summary>' + (t.mode === 'new' ? 'Potential existing groups' : 'Other groups this list reaches into') + ' (' + others.length + ')</summary><ul class="ig__rels">' +
        others.map(function (g) {
          return '<li><button type="button" class="ig__link" data-group="' + ui.esc(g.groupId) + '">' + ui.esc(g.groupNo) + '</button> — master ' + ui.esc(g.masterModelName || '—') + ', ' +
            g.overlap + ' of its ' + ui.count(g.memberCount) + ' models are in this list' +
            (editable ? ' <button type="button" class="ig__mini" data-pact="target" data-group-id="' + ui.esc(g.groupId) + '">Use as the target</button>' : '') + '</li>';
        }).join('') +
        (editable && t.mode !== 'new' ? '<li><button type="button" class="ig__mini" data-pact="target" data-group-id="new">Treat as a NEW group instead</button></li>' : '') +
        (editable && p.targetOverride ? '<li><button type="button" class="ig__mini" data-pact="target" data-group-id="">Back to the automatic choice</button></li>' : '') +
        '</ul></details>';
    }
    h += '</section>';

    /* SOURCE + EVIDENCE */
    var ev = p.evidence || {};
    h += '<section><h4>Instagram source</h4><p><b>' + ADM.ig.username(p.sourceUsername) + '</b> · ' +
      (post.permalink ? ADM.ig.link(post.permalink, post.contentType ? 'open the ' + post.contentType : 'open the post') : '<span class="adm__none">no link</span>') +
      (post.publishedAt ? ' · <span class="adm__none">' + ui.date(post.publishedAt) + '</span>' : '') + '</p>' +
      '<blockquote class="ig__quote">' + (p.evidenceLines || []).slice(0, 5).map(ui.esc).join('<br>') + ((p.evidenceLines || []).length > 5 ? '<br>…' : '') + '</blockquote>' +
      '<p class="adm__none" style="font-size:11px;margin:4px 0 0">From ' + ui.esc(where(ev)) +
      (ev.confidence != null ? ' · ' + confidenceWord(ev) + ' ' + Math.round(ev.confidence * 100) + '%' : '') +
      ((p.sourceMedia || []).length > 1 ? ' · ' + p.sourceMedia.length + ' images / frames' : '') + '</p>' +
      '<details class="ig__details"><summary>INSTAGRAM SOURCE (' + (p.sourceModels || []).length + ' models as written)</summary><div class="ig__chips">' +
      (p.sourceModels || []).map(function (n) { return '<span class="ig__chip">' + ui.esc(n) + '</span>'; }).join('') + '</div></details>' +
      '<button type="button" class="ig__link" data-detail="1">Show media and all evidence</button></section>';
    h += '</div>';

    /* PROPOSED CHANGES */
    h += '<section class="ig__changes"><h4>Proposed changes</h4>';
    (p.actionReasons || []).forEach(function (r) { h += '<p class="ig__reason">' + ui.esc(r) + '</p>'; });
    h += '<div class="ig__diff">';
    h += '<div><h5>ADD <span class="ig__count">' + add.length + '</span></h5>' + (add.length ? '<div class="ig__chips">' + add.map(function (m) {
      return memberChip(m, 'ok', editable ? ' <button type="button" class="ig__x" data-pact="exclude" data-key="' + ui.esc(m.key) + '" title="Do not add this model" aria-label="Exclude ' + ui.esc(m.text) + '">×</button>' : '');
    }).join('') + '</div>' : '<p class="adm__none">None</p>') +
      (editable ? '<div class="ig__minis"><button type="button" class="ig__mini" data-pact="addmodel">+ Add a catalogue model</button></div>' : '') + '</div>';
    h += '<div><h5>REMOVE <span class="ig__count">0</span></h5><p class="adm__none">None — a post never removes a model from a group. A person removes one, in Compatibility Management.</p></div>';
    h += '<div><h5>' + (t.mode === 'existing' ? 'ALREADY IN THE GROUP' : 'EXISTING') + ' <span class="ig__count">' + existing.length + '</span></h5>' +
      (existing.length ? '<div class="ig__chips">' + existing.map(function (m) { return memberChip(m, 'plain'); }).join('') + '</div>' : '<p class="adm__none">None</p>') + '</div>';
    h += '<div><h5>CONFLICT <span class="ig__count">' + conflict.length + '</span></h5>' +
      (conflict.length ? '<ul class="ig__members">' + memberRows(conflict, 'conflict', editable) + '</ul>' : '<p class="adm__none">None</p>') + '</div>';
    h += '<div><h5>NEEDS REVIEW <span class="ig__count">' + review.length + '</span></h5>' +
      (review.length ? '<ul class="ig__members">' + memberRows(review, 'review', editable) + '</ul>' : '<p class="adm__none">None</p>') + '</div>';
    h += '<div><h5>UNMATCHED <span class="ig__count">' + unmatched.length + '</span></h5>' +
      (unmatched.length ? '<ul class="ig__members">' + memberRows(unmatched, 'unmatched', editable) + '</ul><p class="adm__none" style="font-size:11px">Not in All Brands &amp; Models. Never created from a post.</p>' : '<p class="adm__none">None</p>') + '</div>';
    h += '</div>';
    if (excluded.length) h += '<details class="ig__details"><summary>Set aside by an admin (' + excluded.length + ')</summary><ul class="ig__members">' + memberRows(excluded, 'excluded', editable) + '</ul></details>';
    h += '<details class="ig__details"><summary>Evidence for every model (' + ms.length + ')</summary><div class="adm__scroll"><table class="adm__table ig__evtable"><thead><tr>' +
      '<th>As written</th><th>Read from</th><th>OCR text</th><th>Database match</th><th>Catalogue record</th><th>State</th></tr></thead><tbody>' +
      ms.map(function (m) {
        var e = (m.evidence || [])[0] || {};
        return '<tr style="cursor:default"><td>' + ui.esc((m.texts || [m.text]).join(' · ')) + '</td><td>' + ui.esc(where(e)) +
          (m.occurrences > 1 ? ' <span class="adm__none">+' + (m.occurrences - 1) + '</span>' : '') + '</td>' +
          '<td>' + (e.line ? '“' + ui.esc(e.line) + '”' : ui.text(null)) + (e.confidence != null ? ' <span class="adm__none">' + Math.round(e.confidence * 100) + '%</span>' : '') + '</td>' +
          '<td>' + ui.esc(m.matchStatus || '') + (m.match && m.match.method ? ' <span class="mono adm__none">' + ui.esc(m.match.method) + '</span>' : '') + '</td>' +
          '<td>' + (m.match && m.match.modelName ? ui.esc(m.match.modelName) : ui.text(null)) + '</td>' +
          '<td>' + ui.pill(m.state, String(m.state || '').replace(/_/g, ' ')) + '</td></tr>';
      }).join('') + '</tbody></table></div></details>';
    h += '</section>';

    /* CONFIDENCE + OUTCOME */
    h += '<section class="ig__evidence"><h4>Evidence and confidence</h4>';
    if (conf.reasons && conf.reasons.length) h += '<ul>' + conf.reasons.map(function (r) { return '<li>' + ui.esc(r) + '</li>'; }).join('') + '</ul>';
    else h += '<p style="margin:0">A clear product, a compatibility heading, strong evidence, and every model resolved.</p>';
    if (p.corroborations) h += '<p style="margin:6px 0 0">' + ui.count(p.corroborations) + ' other post(s) listed the same models.</p>';
    var val = p.validation;
    if (val) {
      h += '<p style="margin:6px 0 0"><b>Second opinion:</b> ' + ({
        confirmed: 'agreed with the reading', disputed: 'disputed part of it', failed: 'VALIDATION FAILED — the extraction is kept as it was',
        queued: 'wanted, but its budget for this import is spent', not_configured: 'wanted, but no validator is configured'
      }[val.status] || ui.esc(val.status)) + (val.model ? ' <span class="mono adm__none">' + ui.esc(val.model) + '</span>' : '') +
        (val.checked ? ' · ' + ui.count(val.checked) + ' entr' + (val.checked === 1 ? 'y' : 'ies') + ' checked' + (val.visual ? ' against the image' : ' from the text') +
          ', ' + ui.count(val.suggested) + ' suggested, ' + ui.count(val.disputed) + ' disputed' : '') +
        ((val.reasons || []).length ? '<br><span class="adm__none">Asked because ' + val.reasons.map(ui.esc).join('; ') + '.</span>' : '') +
        (val.note ? '<br><span class="adm__none">' + ui.esc(val.note) + '</span>' : '') +
        (val.categorySuggestion ? '<br>It suggests the category <b>' + ui.esc(categoryName(val.categorySuggestion)) + '</b> — use "Change category" to apply it.' : '') + '</p>';
    }
    if (p.conflict && p.conflict.active) h += ui.banner('bad', '<b>' + ui.esc(p.conflict.note || 'Category conflict.') + '</b> A model may belong to only one group per category; the server refuses the approval until each is resolved.');
    if (p.status === 'duplicate') h += ui.banner('info', '<b>' + (p.duplicateReason === 'already_existing' ? 'Already Existing' : 'Duplicate') + '.</b> ' +
      ui.esc(String(p.duplicateReason || '').replace(/_/g, ' ')) + (p.duplicateOf ? ' — <span class="mono">' + ui.esc(p.duplicateOf) + '</span>' : '') + '. Kept as additional evidence.');
    if (p.productionOutcome) h += '<p style="margin:6px 0 0"><b>Outcome:</b> ' + ui.esc(p.productionOutcome.replace(/_/g, ' ')) +
      (p.appliedChange ? ' — ' + (p.appliedChange.addedModelNames || []).length + ' model(s) added to ' + ui.esc(String(p.appliedChange.groupId).toUpperCase()) +
        ' (' + p.appliedChange.previousMemberCount + ' → ' + p.appliedChange.newMemberCount + '): ' + ui.esc((p.appliedChange.addedModelNames || []).join(', ')) : '') +
      (p.productionNote ? ' — ' + ui.esc(p.productionNote) : '') + '</p>';
    if (p.rejectReason) h += '<p style="margin:6px 0 0"><b>Rejected:</b> ' + ui.esc(p.rejectReason.replace(/_/g, ' ')) + (p.rejectNote ? ' — ' + ui.esc(p.rejectNote) : '') + '</p>';
    h += '</section>';

    /* ACTION */
    var b = [];
    var why = proposalBlock(p);
    if (pending && ctx.can('compat.approve')) {
      var label = p.proposedAction === 'CREATE_NEW_GROUP' ? 'Approve — Create Group'
        : p.proposedAction === 'UPDATE_EXISTING_GROUP' ? 'Approve — Update Existing Group (' + add.length + ')'
        : 'Approve';
      b.push('<button type="button" class="adm__btn adm__btn--primary" data-pact="approve"' + (why ? ' disabled title="' + ui.esc(why) + '"' : '') + '>' + label + '</button>');
    }
    if (ctx.can('compat.review')) {
      if (pending) {
        b.push('<button type="button" class="adm__btn" data-act="reject">Reject</button>');
        b.push('<button type="button" class="adm__btn" data-act="category">Change category</button>');
        b.push('<button type="button" class="adm__btn" data-pact="refresh" title="Compare again with production as it is now">Re-check production</button>');
      } else if (['rejected', 'duplicate', 'ignored', 'resolved'].indexOf(p.status) > -1) {
        b.push('<button type="button" class="adm__btn" data-act="reopen">Reopen</button>');
      }
    }
    h += '<footer class="ig__actions"><span class="ig__actionlabel">ACTION: <b>' + ui.esc(ACTION_LABEL[p.proposedAction] || p.proposedAction) + '</b></span>' + b.join('') +
      (pending && why ? '<span class="adm__none" style="font-size:12px">' + ui.esc(why) + '</span>' : '') + '</footer>';
    h += '<div class="ig__inline"></div><div class="ig__detail"></div></article>';
    return h;
  }

  function onProposalAct(el, card, c, host, ctx) {
    var id = c.candidateId;
    var key = el.getAttribute('data-key');
    var inline = card.querySelector('.ig__inline');
    switch (el.getAttribute('data-pact')) {
      case 'exclude': return run(host, ctx, { action: 'proposal_member_decision', candidateId: id, memberKey: key, decision: 'exclude' }, 'Set aside');
      case 'clear': return run(host, ctx, { action: 'proposal_member_decision', candidateId: id, memberKey: key, decision: null }, 'Put back');
      case 'reassign':
        if (!global.confirm('Request that this model be moved to the target group?\n\nNothing is moved by this. The request is recorded with the approval; move the model yourself in Compatibility Management.')) return;
        return run(host, ctx, { action: 'proposal_member_decision', candidateId: id, memberKey: key, decision: 'reassign_request' }, 'Reassignment requested');
      case 'pick': return run(host, ctx, { action: 'proposal_select_model', candidateId: id, memberKey: key, modelId: el.getAttribute('data-model'),
        rememberAlias: !!(card.querySelector('input[name="remember"]') || {}).checked }, 'Match updated');
      case 'padd': return run(host, ctx, { action: 'proposal_add_model', candidateId: id, modelId: el.getAttribute('data-model') }, 'Model added');
      case 'target': return run(host, ctx, { action: 'proposal_set_target', candidateId: id, groupId: el.getAttribute('data-group-id') || null }, 'Target group changed');
      case 'refresh': return run(host, ctx, { action: 'proposal_refresh', candidateId: id }, 'Compared with production again');
      case 'search':
      case 'addmodel': {
        var adding = el.getAttribute('data-pact') === 'addmodel';
        var m = adding ? null : (c.members || []).filter(function (x) { return x.key === key; })[0];
        inline.innerHTML = '<div class="ig__picker" data-pmode="' + (adding ? 'padd' : 'pick') + '" data-key="' + ui.esc(key || '') + '">' +
          '<label>' + (adding ? 'Add a model the post did not list — from the catalogue only' : 'Find the catalogue record for “' + ui.esc(m ? m.text : '') + '”') +
          '<input type="search" name="modelSearch" placeholder="Type a model name" autocomplete="off" value="' + ui.esc(m ? m.text : '') + '"></label>' +
          (adding ? '' : '<label class="ig__check"><input type="checkbox" name="remember"> Remember this spelling as an alias (written to /aliases, audited)</label>') +
          '<div class="ig__results"><span class="adm__none" style="font-size:12px">Only records already in All Brands &amp; Models can be chosen. New models are never created here.</span></div></div>';
        var box = inline.querySelector('input[name="modelSearch"]');
        box.focus();
        if (box.value) box.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      case 'approve': {
        var add = (c.members || []).filter(function (x) { return x.state === 'add'; });
        var low = c.confidence && c.confidence.band === 'low';
        var t = c.target || {};
        var msg = (low ? 'LOW-CONFIDENCE proposal.\n' + (c.confidence.reasons || []).join('\n') + '\n\n' : '') +
          (t.mode === 'new'
            ? 'Approve a NEW group of ' + add.length + ' models, master ' + (c.proposedMaster ? c.proposedMaster.modelName : '?') + '?\n\nIt is recorded in the approved ledger. The group itself is created in Compatibility Management — it needs a part code and a serial — so nothing changes on the site yet.'
            : add.length
              ? 'Approve and write to production?\n\nThis ADDS ' + add.length + ' model(s) to ' + String(t.groupId).toUpperCase() + ':\n' + add.map(function (x) { return '  + ' + x.match.modelName; }).join('\n') +
                '\n\nNothing is removed. The server checks again that none of them belongs to another group.'
              : 'Nothing to add. Record this post as supporting evidence for the group?');
        if (!global.confirm(msg)) return;
        return run(host, ctx, { action: 'approve_proposal', candidateId: id, acknowledgeLowConfidence: low, expectedAdd: add.length }, 'Approved');
      }
    }
  }

  function showGroup(card, groupId) {
    var box = card.querySelector('.ig__inline');
    box.innerHTML = '<div class="adm__skel" style="height:40px;margin-top:10px"></div>';
    api({ view: 'group', groupId: groupId }).then(function (d) {
      var g = d.group;
      box.innerHTML = '<div class="ig__groupbox"><h4>' + ui.esc(g.groupNo) + (g.partCode ? ' · <span class="mono">' + ui.esc(g.partCode) + '</span>' : '') + '</h4>' +
        '<p style="margin:0 0 6px">' + ui.esc(categoryName(g.categoryId)) + ' · master <b>' + ui.esc(g.masterModelName || '—') + '</b> · ' + ui.count(g.memberCount) + ' models</p>' +
        '<div class="ig__chips">' + (g.memberNames || []).map(function (n) { return '<span class="ig__chip">' + ui.esc(n) + '</span>'; }).join('') + '</div>' +
        '<p class="adm__none" style="font-size:11px;margin:8px 0 0">As the live data has it now. Its master, a removal or a merge is changed in Compatibility Management.</p></div>';
    }, function (err) { box.innerHTML = ui.banner('bad', ui.esc(err.message || 'Could not load the group')); });
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

    var grp = e.target.closest('[data-group]');
    if (grp && grp.getAttribute('data-group')) return showGroup(card, grp.getAttribute('data-group'));
    var pact = e.target.closest('[data-pact]');
    if (pact) return onProposalAct(pact, card, c, host, ctx);

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
        /* a proposal's picker resolves one list entry, or adds a model */
        var picker = e.target.closest('.ig__picker[data-pmode]');
        results.innerHTML = d.models.length ? d.models.map(function (m) {
          return '<button type="button" class="ig__alt" ' + (picker
            ? 'data-pact="' + ui.esc(picker.getAttribute('data-pmode')) + '" data-key="' + ui.esc(picker.getAttribute('data-key')) + '" data-model="' + ui.esc(m.modelId) + '"'
            : 'data-pick="' + ui.esc(m.modelId) + '" data-side="' + ui.esc(side) + '"') + '>' + ui.esc(m.modelName) +
            ' <span class="mono adm__none">' + ui.esc(m.modelId) + '</span></button>';
        }).join('') : '<span class="adm__none" style="font-size:12px">No catalogue record matches. It cannot be added from here — use Missing models.</span>';
      });
    }, 250);
  }

  function onChange(e, host, ctx) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-master')) {
      var pc = e.target.closest('.ig__card');
      if (!e.target.value || !pc) return;
      run(host, ctx, { action: 'proposal_set_master', candidateId: pc.getAttribute('data-cid'), modelId: e.target.value }, 'Master model chosen');
      return;
    }
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
      run(host, ctx, { action: 'change_category', candidateId: id, categoryId: String(d.get('categoryId')), kind: (cache[id] || {}).kind }, 'Category changed');
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
      var added = (d.content && d.content.manualEvidence) || [];
      if (added.length) {
        h += '<h4>Evidence added by an admin (' + added.length + ')</h4><div class="ig__media">' + added.map(function (x) {
          return '<figure>' + (x.hasPreview ? '<img alt="" data-evidence="' + ui.esc(x.id) + '">' : '<span class="adm__none">' + (x.kind === 'text' ? 'typed text' : 'no preview') + '</span>') +
            '<figcaption>' + ui.esc(x.kind) + ' · ' + ui.esc(x.status) + (x.readBy ? ' by ' + ui.esc(x.readBy) : '') + ' · ' + ui.esc(x.addedByEmail || '') + ' · ' + ui.dateTime(x.addedAt) +
            (x.reason ? '<br>' + ui.esc(x.reason) : '') + '</figcaption></figure>';
        }).join('') + '</div>' + added.filter(function (x) { return x.text; }).map(function (x) { return '<pre class="ig__quote">' + ui.esc(x.text) + '</pre>'; }).join('');
      }
      if (d.candidate.ocrText) h += '<h4>Text read from the media</h4><pre class="ig__quote">' + ui.esc(d.candidate.ocrText) + '</pre>';
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
      /* previews of admin screenshots are fetched only when a card is opened */
      Array.prototype.forEach.call(box.querySelectorAll('img[data-evidence]'), function (img) {
        api({ view: 'evidence_preview', id: img.getAttribute('data-evidence') }).then(function (r) {
          if (/^data:image\/jpeg;base64,/.test(r.preview)) img.src = r.preview;
        }, function () { img.replaceWith(Object.assign(document.createElement('span'), { className: 'adm__none', textContent: 'preview not stored' })); });
      });
    }, function (err) { box.innerHTML = ui.banner('bad', ui.esc(err.message || 'Could not load the detail')); });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.igReview = { render: function (host, ctx) { currentCtx = ctx; render(host, ctx); } };
})(window);
