/* ============================================================================
   Mobile Parts Finder · admin/pages/ai.js
   ----------------------------------------------------------------------------
   The Local LLM: whether it is connected, what it can do, and the queue of
   things it has proposed.

   ----------------------------------------------------------------------------
   THERE IS NO CHAT BOX HERE

   Deliberately. A text field that talks to a model and prints the answer is
   the easy thing to build and the wrong thing to build: it produces prose
   nobody can act on, and it invites treating model output as a finding.

   What this page shows instead is the gateway's connection state and an
   approval queue. Every proposal arrives as a draft with a status, and moving
   it forward is an explicit human decision.

   ----------------------------------------------------------------------------
   APPROVED IS NOT PUBLISHED

   Approving a draft records that an administrator accepts it. It does not
   write anything to the catalogue — that is a separate step through the
   missing-model workflow and the importer. The page says so on the button and
   again in the response, because "approve" is a fast click and "change what
   every shop sees" should not be the same one.

   With no gateway configured the page says exactly which environment variables
   are missing. It does not demo anything.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  function render(host, ctx) {
    host.innerHTML =
      '<div class="adm__head"><div>' +
      '<h1>Local AI</h1>' +
      '<p>The gateway to the Local LLM service, and the queue of changes it has proposed.</p>' +
      '</div></div><div class="adm__card"><div class="adm__skel" style="height:60px"></div></div>';

    host.addEventListener('click', function (e) {
      var button = e.target.closest('[data-decision]');
      if (!button) return;
      decide(button.getAttribute('data-task'), button.getAttribute('data-decision'), ctx, host);
    });

    load(host, ctx);
  }

  function load(host, ctx) {
    ADM.api.ai({}).then(function (data) {
      host.innerHTML = paint(data);
    }, function (err) {
      host.innerHTML = '<div class="adm__head"><h1>Local AI</h1></div>' +
        ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(err.message || 'request failed'));
    });
  }

  function paint(data) {
    var g = data.gateway;
    var out = '<div class="adm__head"><div><h1>Local AI</h1>' +
      '<p>Gateway status and the approval queue. Nothing here writes to the catalogue.</p>' +
      '</div></div>';

    out += g.configured
      ? ui.banner('info', '<b>Gateway connected.</b> Host <code>' + ui.esc(g.host) + '</code>' +
          (g.model ? ', model <code>' + ui.esc(g.model) + '</code>' : '') + '.')
      : ui.banner('warn',
          '<b>No AI service configured.</b> Set ' +
          g.missing.map(function (m) { return '<code>' + ui.esc(m) + '</code>'; }).join(' and ') +
          ' in the Vercel environment and redeploy. Until then every AI feature ' +
          'reports itself unavailable and the chatbot falls back to its ' +
          'database-only answers, which is its normal working mode.');

    /* ---- what the architecture supports ---- */
    out += '<div class="adm__card"><h2>Capabilities</h2>' +
      '<p class="adm__hint">Declared by the gateway contract. A capability is a task the ' +
      'local service is asked to perform; it is never given write access to production data.</p>' +
      '<dl class="adm__defs">' + g.capabilities.map(function (c) {
        return '<dt class="mono">' + ui.esc(c.id) + '</dt><dd>' + ui.esc(c.description) + '</dd>';
      }).join('') + '</dl></div>';

    /* ---- the queue ---- */
    out += '<div class="adm__card"><h2>Approval queue</h2>' +
      '<p class="adm__hint">Every AI proposal lands here as a draft. Approving records the ' +
      'decision; it does not publish. Applying a catalogue change is a separate step.</p>';

    if (!data.tasks.length) {
      out += ui.emptyState('Nothing proposed yet',
        g.configured
          ? 'Tasks appear here when a capability is run against real data.'
          : 'The gateway is not configured, so nothing can be proposed.');
    } else {
      out += '<div class="adm__scroll"><table class="adm__table"><thead><tr>' +
        '<th>Created</th><th>Type</th><th>Capability</th><th>Status</th>' +
        '<th>Summary</th><th>Decision</th></tr></thead><tbody>' +
        data.tasks.map(taskRow).join('') + '</tbody></table></div>';
    }
    out += '</div>';

    return out;
  }

  function taskRow(t) {
    var pending = t.status === 'draft' || t.status === 'pending_review';
    return '<tr style="cursor:default">' +
      '<td>' + ui.date(t.createdAt) + '</td>' +
      '<td>' + ui.text(String(t.type || '').replace(/_/g, ' ')) + '</td>' +
      '<td class="mono">' + ui.text(t.capability) + '</td>' +
      '<td>' + ui.pill(t.status) + '</td>' +
      '<td>' + ui.text(t.promptSummary) +
        (t.reviewNotes ? '<div class="adm__none" style="font-size:11px">' +
          ui.esc(t.reviewNotes) + '</div>' : '') + '</td>' +
      '<td>' + (pending
        ? '<button class="adm__btn adm__btn--primary" data-task="' + ui.esc(t.taskId) +
            '" data-decision="approved">Approve</button> ' +
          '<button class="adm__btn" data-task="' + ui.esc(t.taskId) +
            '" data-decision="rejected">Reject</button>'
        : '<span class="adm__none">' + ui.esc(t.status) + '</span>') + '</td>' +
      '</tr>';
  }

  function decide(taskId, decision, ctx, host) {
    ADM.api.aiAction({ action: 'review', taskId: taskId, decision: decision })
      .then(function (r) {
        ctx.toast(r.note || ('Marked ' + decision));
        load(host, ctx);
      }, function (err) {
        ctx.toast(err.message || 'Could not record the decision', 'bad');
      });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.ai = { render: render };
})(window);
