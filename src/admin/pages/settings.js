/* ============================================================================
   Mobile Parts Finder · admin/pages/settings.js
   ----------------------------------------------------------------------------
   Administrator accounts, and the audit trail of what they did.

   ----------------------------------------------------------------------------
   GRANTING BY EMAIL

   Nobody knows anyone's Firebase uid, so the form takes an email address and
   the server resolves it through Firebase Authentication. That means the
   person must have signed in to the site at least once — which is correct: a
   role is granted to an account that exists, not to an address that might one
   day become one. The server says so in its 404 rather than failing vaguely.

   ----------------------------------------------------------------------------
   THE TWO REFUSALS

   You cannot change your own role, and the last super_admin cannot be removed.
   Both are enforced on the server; this page simply does not offer the first,
   because a disabled button explains itself better than a 409 does.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  var ROLE_HELP = {
    super_admin: 'Everything, including granting and revoking roles.',
    admin: 'All business data and every approval action. Cannot change roles.',
    support: 'Users and subscriptions, including contact details. No revenue figures.',
    analyst: 'Aggregate analytics and revenue. No individual user records.',
    user: 'No admin access. Choosing this revokes the role.'
  };

  function render(host, ctx) {
    host.innerHTML =
      '<div class="adm__head"><div><h1>Settings</h1>' +
      '<p>Administrator accounts and the audit trail.</p></div></div>' +
      '<div class="adm__card"><div class="adm__skel" style="height:60px"></div></div>';

    host.addEventListener('submit', function (e) {
      var form = e.target.closest('#admGrantForm');
      if (!form) return;
      e.preventDefault();
      grant(form, ctx, host);
    });

    host.addEventListener('click', function (e) {
      var revoke = e.target.closest('[data-revoke]');
      if (!revoke) return;
      var uid = revoke.getAttribute('data-revoke');
      var label = revoke.getAttribute('data-label') || uid;
      if (!global.confirm('Revoke admin access for ' + label + '?')) return;
      submit({ uid: uid, role: 'user' }, ctx, host);
    });

    load(host, ctx);
  }

  function load(host, ctx) {
    var canManage = ctx.can('admins.write');
    var canRead = ctx.can('admins.read');
    var canAudit = ctx.can('audit.read');

    Promise.all([
      canRead ? ADM.api.admins() : Promise.resolve(null),
      canAudit ? ADM.api.audit({ limit: 60 }) : Promise.resolve(null)
    ]).then(function (results) {
      host.innerHTML = paint(results[0], results[1], ctx, canManage);
    }, function (err) {
      host.innerHTML = '<div class="adm__head"><h1>Settings</h1></div>' +
        ui.banner('bad', '<b>Could not load.</b> ' + ui.esc(err.message || 'request failed'));
    });
  }

  function paint(adminsData, auditData, ctx, canManage) {
    var out = '<div class="adm__head"><div><h1>Settings</h1>' +
      '<p>Administrator accounts and the audit trail.</p></div></div>';

    /* ---- who has access ---- */
    if (adminsData) {
      out += '<div class="adm__card"><h2>Administrators</h2>' +
        '<p class="adm__hint">Roles are checked on the server on every request. ' +
        'A revoked account loses access on its next request, not when its token expires.</p>';

      /* The owner first, and always. Their access comes from their Google
         identity rather than from a registry row, so without this the person
         reading the page would see an empty table — which reads as "nobody has
         access" while they are looking at it. */
      if (adminsData.owner) {
        out += '<dl class="adm__defs" style="margin-bottom:14px">' +
          '<dt>Owner</dt><dd><b>' + ui.esc(adminsData.owner.email) + '</b> ' +
            ui.pill('active', 'super admin') + '</dd>' +
          '<dt>Set in</dt><dd class="mono">api/_schema/roles.js</dd>' +
          '<dt>Access</dt><dd>Recognised from the verified Google sign-in, not from ' +
            'this list — so it cannot be revoked here, and cannot be lost to a ' +
            'missing record.</dd>' +
          '</dl>';
      }

      if (adminsData.ownerOnly) {
        out += ui.banner('info',
          '<b>Owner-only mode.</b> The owner account is the only identity with admin ' +
          'access. Granting a staff role is refused while this is on, because the ' +
          'role would be written and then ignored by every request. Turn it off by ' +
          'setting <code>OWNER_ONLY</code> to <code>false</code> in ' +
          '<code>api/_schema/roles.js</code>.');
      }

      out += !adminsData.admins.length
        ? '<p class="adm__hint" style="margin:0">No additional staff accounts.</p></div>'
        : '<div class="adm__scroll"><table class="adm__table"><thead><tr>' +
        '<th>Account</th><th>Role</th><th>Granted</th><th>State</th>' +
        (canManage ? '<th></th>' : '') + '</tr></thead><tbody>' +
        adminsData.admins.map(function (a) {
          var isMe = a.uid === ctx.admin.uid;
          return '<tr style="cursor:default">' +
            '<td><b>' + ui.text(a.email) + '</b>' +
              '<div class="mono adm__none">' + ui.esc(a.uid) + '</div></td>' +
            '<td>' + ui.pill(a.role, a.role.replace(/_/g, ' ')) + '</td>' +
            '<td>' + ui.date(a.grantedAt) + '</td>' +
            '<td>' + (a.disabled ? ui.pill('cancelled', 'revoked') : ui.pill('active')) + '</td>' +
            (canManage
              ? '<td>' + (isMe
                  /* Not offered, because the server refuses it — and an
                     explanation beats a 409 the moment it is clicked. */
                  ? '<span class="adm__none">your own account</span>'
                  : (a.disabled ? '' :
                     '<button class="adm__btn" data-revoke="' + ui.esc(a.uid) +
                     '" data-label="' + ui.esc(a.email || a.uid) + '">Revoke</button>')) + '</td>'
              : '') +
            '</tr>';
        }).join('') + '</tbody></table></div></div>';

      /* The form is not offered in owner-only mode, because the server refuses
         the grant — and a form that always fails is worse than no form. */
      if (canManage && !adminsData.ownerOnly) {
        out += '<div class="adm__card"><h2>Grant a role</h2>' +
          '<p class="adm__hint">The account must have signed in to the site with Google at ' +
          'least once, so Firebase Authentication has a record for the address.</p>' +
          '<form class="adm__filters" id="admGrantForm">' +
          '<input type="search" name="email" placeholder="name@example.com" required ' +
          'style="flex:1 1 260px" />' +
          '<select name="role">' +
          adminsData.roles.map(function (r) {
            return '<option value="' + r + '"' + (r === 'support' ? ' selected' : '') + '>' +
              ui.esc(r.replace(/_/g, ' ')) + '</option>';
          }).join('') + '</select>' +
          '<button class="adm__btn adm__btn--primary" type="submit">Grant</button>' +
          '</form>' +
          '<dl class="adm__defs" style="margin-top:12px">' +
          adminsData.roles.map(function (r) {
            return '<dt class="mono">' + ui.esc(r) + '</dt><dd>' +
              ui.esc(ROLE_HELP[r] || '') + '</dd>';
          }).join('') + '</dl></div>';
      }
    }

    /* ---- audit ---- */
    if (auditData) {
      out += '<div class="adm__card"><h2>Audit trail</h2>' +
        '<p class="adm__hint">Append-only. Records who did what and to which record — ' +
        'never a copy of the data that was read.</p>';

      out += auditData.entries.length
        ? '<div class="adm__scroll"><table class="adm__table"><thead><tr>' +
          '<th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th>' +
          '</tr></thead><tbody>' + auditData.entries.map(function (e) {
            var detail = e.detail && Object.keys(e.detail).length
              ? Object.keys(e.detail).map(function (k) { return k + ': ' + e.detail[k]; }).join(' · ')
              : null;
            return '<tr style="cursor:default">' +
              '<td>' + ui.dateTime(e.at) + '</td>' +
              '<td class="mono">' + ui.text(e.actorUid) +
                '<div class="adm__none" style="font-size:11px">' + ui.text(e.actorRole) + '</div></td>' +
              '<td>' + ui.text(String(e.action || '').replace(/[._]/g, ' ')) + '</td>' +
              '<td class="mono">' + ui.text(e.targetId) + '</td>' +
              '<td class="adm__none">' + ui.text(detail) + '</td>' +
              '</tr>';
          }).join('') + '</tbody></table></div>'
        : ui.emptyState('Nothing recorded yet',
            'Entries appear as administrators view user records and change data.');
      out += '</div>';
    }

    if (!adminsData && !auditData) {
      out += ui.emptyState('Nothing to show',
        'Your role does not include administrator management or the audit trail.');
    }

    return out;
  }

  function grant(form, ctx, host) {
    var data = new FormData(form);
    submit({
      email: String(data.get('email') || '').trim(),
      role: String(data.get('role') || '')
    }, ctx, host);
  }

  function submit(body, ctx, host) {
    ADM.api.setAdminRole(body).then(function (r) {
      ctx.toast((r.email || r.uid) + ' → ' + r.role);
      load(host, ctx);
    }, function (err) {
      /* The server's own detail line where there is one: "Ask them to sign in
         to the site with Google once" is the actionable half of a 404 here. */
      var detail = err.data && err.data.detail;
      ctx.toast((err.message || 'Could not change the role') + (detail ? ' — ' + detail : ''), 'bad');
    });
  }

  ADM.pages = ADM.pages || {};
  ADM.pages.settings = { render: render };
})(window);
