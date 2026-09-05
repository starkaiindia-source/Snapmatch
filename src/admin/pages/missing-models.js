/* ============================================================================
   Mobile Parts Finder · admin/pages/missing-models.js
   ----------------------------------------------------------------------------
   The review queue: handsets people looked for and did not find, ranked by how
   many asked.

   Ordered by demand rather than by date, because the question this page exists
   to answer is "which model should we add next" — and forty shops asking for
   one handset is a stronger answer than one shop asking for a handset today.

   Every status change goes to the server, which checks the transition table
   before writing. This page cannot skip a step even if a request were crafted
   by hand: `new -> published` is refused server-side, and the drop-down here
   only offers what the current status allows because the same table informs
   both.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  /* Mirrors ALLOWED_TRANSITIONS in api/_schema/missing-model-request.js.
     The server is the authority — it refuses an illegal move whatever this
     offers — but showing only legal options avoids an error message for a
     choice the UI should not have presented. */
  var NEXT = {
    new: ['under_review', 'researching', 'not_a_valid_model', 'duplicate'],
    under_review: ['researching', 'draft_found', 'not_a_valid_model', 'duplicate', 'new'],
    researching: ['draft_found', 'under_review', 'not_a_valid_model', 'duplicate'],
    draft_found: ['approved', 'researching', 'not_a_valid_model', 'duplicate'],
    approved: ['published', 'draft_found'],
    published: [],
    not_a_valid_model: ['new'],
    duplicate: ['new']
  };

  var filter = { status: '', sort: 'demand' };

  function render(host, ctx) {
    host.innerHTML =
      '<div class="adm__head"><div>' +
      '<h1>Missing model requests</h1>' +
      '<p>Aggregated per handset — one row per model, not one per search.</p>' +
      '</div></div>' +
      '<div class="adm__card">' +
      '<form class="adm__filters" id="admMmFilters">' +
      '<select name="status">' +
        '<option value="">Every status</option>' +
        ['new', 'under_review', 'researching', 'draft_found', 'approved', 'published',
         'not_a_valid_model', 'duplicate'].map(function (s) {
          return '<option value="' + s + '"' + (filter.status === s ? ' selected' : '') + '>' +
            ui.esc(s.replace(/_/g, ' ')) + '</option>';
        }).join('') +
      '</select>' +
      '<select name="sort">' +
        '<option value="demand"' + (filter.sort === 'demand' ? ' selected' : '') + '>Most requested</option>' +
        '<option value="recent"' + (filter.sort === 'recent' ? ' selected' : '') + '>Recently asked</option>' +
        '<option value="newest"' + (filter.sort === 'newest' ? ' selected' : '') + '>First seen</option>' +
      '</select>' +
      '<button class="adm__btn adm__btn--primary" type="submit">Apply</button>' +
      '</form>' +
      '<div id="admMmBody">' + shell(ui.skeletonRows(6, 6)) + '</div></div>';

    host.querySelector('#admMmFilters').addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(e.target);
      filter.status = String(data.get('status') || '');
      filter.sort = String(data.get('sort') || 'demand');
      load(ctx);
    });

    host.addEventListener('change', function (e) {
      var select = e.target.closest('select[data-key]');
      if (!select || !select.value) return;
      move(select.getAttribute('data-key'), select.value, ctx);
    });

    load(ctx);
  }

  function shell(rows) {
    return '<div class="adm__scroll"><table class="adm__table">' +
      '<thead><tr><th>Model asked for</th><th class="num">Requests</th>' +
      '<th>First seen</th><th>Last asked</th><th>Status</th><th>Move to</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function load(ctx) {
    var body = document.getElementById('admMmBody');
    if (!body) return;
    body.innerHTML = shell(ui.skeletonRows(6, 6));

    ADM.api.missingModels({ status: filter.status, sort: filter.sort }).then(function (data) {
      if (!data.requests.length) {
        body.innerHTML = ui.emptyState(
          filter.status ? 'Nothing with that status' : 'No requests yet',
          'A request is recorded when a search or a chatbot question finds no ' +
          'matching handset. Nothing is created until that actually happens.');
        return;
      }
      body.innerHTML = shell(data.requests.map(rowHTML).join('')) +
        (data.hasMore ? '<p class="adm__hint" style="margin-top:12px">More rows exist — ' +
          'narrow the status filter to see them.</p>' : '');
    }, function (err) {
      body.innerHTML = ui.banner('bad', '<b>Could not load the queue.</b> ' +
        ui.esc(err.message || 'request failed'));
    });
  }

  function rowHTML(r) {
    var options = NEXT[r.status] || [];
    var variants = r.searchVariants && r.searchVariants.length > 1
      ? '<div class="adm__none" style="font-size:11px">also typed: ' +
        ui.esc(r.searchVariants.slice(1, 5).join(', ')) + '</div>'
      : '';

    return '<tr style="cursor:default">' +
      '<td><b>' + ui.text(r.requestedName) + '</b>' +
        '<div class="mono adm__none">' + ui.esc(r.normalisedName) + '</div>' + variants + '</td>' +
      '<td class="num"><b>' + ui.count(r.requestCount) + '</b>' +
        (r.signedInRequesters
          ? '<div class="adm__none" style="font-size:11px">' + ui.count(r.signedInRequesters) +
            ' signed in</div>' : '') + '</td>' +
      '<td>' + ui.date(r.firstRequestedAt) + '</td>' +
      '<td>' + ui.ago(r.lastRequestedAt) + '</td>' +
      '<td>' + ui.pill(r.status) + '</td>' +
      '<td>' + (options.length
        ? '<select data-key="' + ui.esc(r.key) + '">' +
          '<option value="">Move to…</option>' +
          options.map(function (s) {
            return '<option value="' + s + '">' + ui.esc(s.replace(/_/g, ' ')) + '</option>';
          }).join('') + '</select>'
        : '<span class="adm__none">final</span>') + '</td>' +
      '</tr>';
  }

  function move(key, status, ctx) {
    /* Publishing is the step that changes what shops see. It gets a
       confirmation because it is the only irreversible one in the list — the
       transition table has no way back out of `published`. */
    if (status === 'published' &&
        !global.confirm('Mark "' + key + '" as published?\n\n' +
                        'This is the final status and cannot be undone from here.')) {
      load(ctx);
      return;
    }

    ADM.api.updateMissingModel({ key: key, status: status }).then(function () {
      ctx.toast('Moved to ' + status.replace(/_/g, ' '));
      load(ctx);
    }, function (err) {
      /* The server's own sentence. A 409 says exactly which transition was
         refused and from what, which is the useful half. */
      ctx.toast(err.message || 'Could not change the status', 'bad');
      load(ctx);
    });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.missingModels = { render: render };
})(window);
