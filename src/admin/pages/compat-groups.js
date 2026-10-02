/* ============================================================================
   Mobile Parts Finder · admin/pages/compat-groups.js
   ----------------------------------------------------------------------------
   COMPATIBILITY MANAGEMENT — Mobile Parts Finder's own.

     category  →  group  →  master model  →  compatible models

   The final groups, as the live compatibility data holds them — not what any
   post said, and not a queue. A scan changes them directly (Instagram
   Intelligence); a person changes them here: add or remove a model, change
   the master, merge two groups, create one, delete one; create, rename or
   delete a category.

   ----------------------------------------------------------------------------
   WHAT IS ABOVE THE GROUPS, AND ONLY WHEN THERE IS SOMETHING TO SAY

     Needs attention   lists a scan would NOT apply on its own, with the reason
     Recent changes    what was added, created, merged, removed — newest first,
                       each automatic one with Undo

   ----------------------------------------------------------------------------
   WHAT THE SERVER DECIDES, NOT THIS PAGE

   Every button here is a request. One category + one model = one group, "the
   master is one of the group's own models", "a model is never created or
   deleted here" — all of it is enforced in the transaction on the server
   (api/_services/compat/management.js), and a refusal is shown as it came.

   Everything is written to Mobile Parts Finder's own data and nowhere else.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = global.SM, ADM = SM.adm, ui = ADM.ui;

  function api(params) { return ADM.api.instagram(params); }
  function act(body) { return ADM.api.instagramAction(body); }
  function skel(h) { return '<div class="adm__skel" style="height:' + (h || 60) + 'px"></div>'; }
  function link(url, label) {
    return url && /^https:\/\//i.test(url)
      ? '<a href="' + ui.esc(url) + '" target="_blank" rel="noopener noreferrer">' + ui.esc(label || url) + '</a>' : ui.esc(label || '');
  }

  var state = null;

  function render(host, ctx) {
    host.innerHTML = '';
    var root = document.createElement('div');
    host.appendChild(root);
    var params = new URLSearchParams(location.search);
    state = {
      root: root, ctx: ctx, categories: [], canEdit: ctx.can('compat.approve'),
      categoryId: params.get('category') || '', q: params.get('q') || '',
      changed: params.get('changed') === '1', view: params.get('view') === 'grid' ? 'grid' : 'table',
      groups: [], next: null, model: null, loading: false, editing: null, draft: null
    };
    root.innerHTML = '<div class="adm__head"><div><h1>Compatibility Management</h1>' +
      '<p>The final compatibility groups of Mobile Parts Finder. A scan updates them directly; you can change any of them here.</p></div></div>' +
      '<div id="cgTop"></div>' +
      '<div id="cgEditor"></div>' +
      '<div class="adm__card"><div id="cgControls">' + skel(40) + '</div><div id="cgList" style="margin-top:14px"></div></div>' +
      '<div class="adm__card"><h2>Categories</h2><div id="cgCats">' + skel(50) + '</div></div>' +
      '<div class="adm__card"><h2>Recent changes</h2><div id="cgRecent">' + skel(60) + '</div></div>';

    loadCategories(true);
    loadChanges();

    root.addEventListener('click', onClick);
    root.addEventListener('change', function (e) {
      if (e.target.name === 'category') { state.categoryId = e.target.value; state.changed = false; state.q = ''; sync(); controls(); load(true); }
    });
    root.addEventListener('submit', onSubmit);
  }

  function toast(msg, tone) { state.ctx.toast(msg, tone); }
  function failed(err) { toast((err && err.message) || 'That could not be done', 'bad'); }

  function loadCategories(first) {
    api({ view: 'categories' }).then(function (d) {
      state.categories = d.categories || [];
      state.creatable = d.creatable || [];
      if (first && !state.changed && !state.q && !state.categoryId && state.categories.length) {
        state.categoryId = (state.categories.filter(function (c) { return c.groupCount; })[0] || state.categories[0]).id;
      }
      controls();
      categoriesCard();
      if (first) load(true);
    }, function (err) { state.root.querySelector('#cgControls').innerHTML = ui.banner('bad', ui.esc(err.message || 'Could not load the categories')); });
  }

  function loadChanges() {
    api({ view: 'changes', limit: 40 }).then(top, function (err) {
      state.root.querySelector('#cgRecent').innerHTML = ui.banner('bad', ui.esc(err.message || 'Could not load the changes'));
    });
  }

  function refresh() { load(true); loadChanges(); }

  function sync() {
    var p = [];
    if (state.changed) p.push('changed=1');
    else if (state.q) p.push('q=' + encodeURIComponent(state.q));
    if (state.categoryId && !state.changed) p.push('category=' + encodeURIComponent(state.categoryId));
    if (state.view === 'grid') p.push('view=grid');
    history.replaceState(null, '', '/admin/instagram/groups' + (p.length ? '?' + p.join('&') : ''));
  }

  function category(id) { return state.categories.filter(function (x) { return x.id === id; })[0] || null; }
  function categoryName(id) { var c = category(id); return c ? c.name : id || ''; }

  function controls() {
    var box = state.root.querySelector('#cgControls');
    if (!box) return;
    box.innerHTML = '<div class="cg__controls">' +
      '<label>Category<select name="category">' + state.categories.map(function (c) {
        return '<option value="' + ui.esc(c.id) + '"' + (c.id === state.categoryId ? ' selected' : '') + '>' + ui.esc(c.name) +
          (c.groupCount ? ' (' + c.groupCount + ')' : '') + (c.kind === 'run_time' ? ' — not on the public site yet' : '') + '</option>';
      }).join('') + '</select></label>' +
      '<form id="cgSearch"><label>Find the group a model is in<input name="q" type="search" placeholder="Realme C25, Vivo Y20…" value="' + ui.esc(state.q) + '"></label>' +
      '<button class="adm__btn" type="submit">Find</button></form>' +
      '<div class="cg__toggles">' +
        (state.canEdit ? '<button type="button" class="adm__btn adm__btn--primary" data-new-group="1">New group</button>' : '') +
        '<button type="button" class="ig__tab' + (state.changed ? ' is-on' : '') + '" data-changed="1" aria-pressed="' + state.changed + '">Recently updated</button>' +
        '<span class="cg__views" role="group" aria-label="View">' +
          '<button type="button" class="ig__tab' + (state.view === 'table' ? ' is-on' : '') + '" data-view="table">Table</button>' +
          '<button type="button" class="ig__tab' + (state.view === 'grid' ? ' is-on' : '') + '" data-view="grid">Grid</button></span>' +
      '</div></div>';
  }

  function load(reset) {
    if (state.loading) return;
    state.loading = true;
    var list = state.root.querySelector('#cgList');
    if (reset) { state.groups = []; state.next = null; state.model = null; list.innerHTML = skel(120); }
    var params = { view: 'groups', limit: 40 };
    if (state.changed) params.changed = '1';
    else if (state.q) { params.q = state.q; }
    else { params.categoryId = state.categoryId; if (!reset && state.next) params.after = state.next; }
    api(params).then(function (d) {
      state.loading = false;
      state.groups = reset ? d.groups : state.groups.concat(d.groups);
      state.next = d.next || null;
      state.model = d.model || null;
      paint();
      if (state.editing) editor();
    }, function (err) {
      state.loading = false;
      list.innerHTML = ui.banner('bad', '<b>Could not load the groups.</b> ' + ui.esc(err.message || 'request failed'));
    });
  }

  var CHANGE_WORD = { created: 'created', added: 'models added', merged: 'a group merged in', removed: 'a model removed', master_changed: 'master changed' };

  function changeLine(g) {
    var ch = g.lastChange;
    if (!ch) return '';
    var by = ch.source === 'instagram-intelligence' ? 'Instagram Intelligence' : ch.source === 'undo' ? 'an undo' : ch.source === 'admin' ? 'an admin' : 'an admin, from Instagram';
    return '<span class="cg__stamp" title="' + ui.esc(CHANGE_WORD[ch.type] || ch.type || '') + '">Updated by ' + by + '</span>';
  }

  function membersHTML(g, max) {
    var list = g.members || [];
    var fresh = {};
    ((g.lastChange && g.lastChange.type !== 'created' && g.lastChange.addedModelIds) || []).forEach(function (id) { fresh[id] = 1; });
    var chip = function (m) {
      return '<span class="ig__chip' + (fresh[m.id] ? ' ig__chip--ok' : '') + '">' + ui.esc(m.name) + (fresh[m.id] ? ' <span class="adm__none">new</span>' : '') + '</span>';
    };
    var rest = list.slice(max);
    return '<div class="ig__chips">' + list.slice(0, max).map(chip).join('') + '</div>' +
      (rest.length ? '<details class="ig__details"><summary>+ ' + rest.length + ' more</summary><div class="ig__chips">' + rest.map(chip).join('') + '</div></details>' : '');
  }

  function paint() {
    var list = state.root.querySelector('#cgList');
    if (!list) return;
    var note = '';
    if (state.q && state.model) {
      note = state.model.status !== 'matched'
        ? ui.banner('warn', '“' + ui.esc(state.q) + '” is not one catalogue model' + (state.model.status === 'ambiguous' ? ' — it fits several. Type more of the name.' : '.'))
        : '<p class="adm__hint">Groups that hold <b>' + ui.esc(state.model.modelName) + '</b>:</p>';
    } else if (state.changed) {
      note = '<p class="adm__hint">Groups changed most recently — every category.</p>';
    }
    if (!state.groups.length) {
      list.innerHTML = note + ui.emptyState(state.changed ? 'No group has been changed yet' : state.q ? 'No group holds that model' : 'No groups in this category',
        state.changed ? 'Scan a source from the Instagram Data Importer.' : '');
      return;
    }
    var last = function (g) { return g.lastChange ? ui.date(g.lastChange.at) : '<span class="adm__none">' + ui.DASH + '</span>'; };
    var source = function (g) {
      var ch = g.lastChange;
      if (!ch) return '<span class="adm__none">baseline</span>';
      if (!ch.sourceUsername) return '<span class="adm__none">' + (ch.source === 'admin' ? 'edited here' : ui.esc(ch.source || '')) + '</span>';
      return ch.permalink ? link(ch.permalink, '@' + ch.sourceUsername) : ui.esc('@' + ch.sourceUsername);
    };
    var change = function (g) {
      var ch = g.lastChange;
      if (!ch) return '';
      if (ch.type === 'created') return ui.pill('created', 'Created');
      if (ch.type === 'merged') return '<span class="adm__pill adm__pill--info">Merged</span>';
      if (ch.type === 'removed') return '<span class="adm__pill">Removed ' + (ch.removedModelIds || []).length + '</span>';
      if (ch.type === 'master_changed') return '<span class="adm__pill">Master changed</span>';
      return '<span class="adm__pill adm__pill--ok">+' + (ch.addedModelIds || []).length + ' added</span>';
    };
    var edit = function (g) { return state.canEdit ? '<button type="button" class="adm__btn" data-edit="' + ui.esc(g.groupId) + '">Edit</button>' : ''; };
    var body;
    if (state.view === 'grid') {
      body = '<div class="cg__grid">' + state.groups.map(function (g) {
        return '<article class="cg__card"><header><span class="adm__pill">' + ui.esc(categoryName(g.categoryId)) + '</span>' +
          '<span class="mono adm__none">' + ui.esc(g.partCode || g.groupNo) + '</span></header>' +
          '<h3>' + ui.esc(g.masterModelName || '—') + '</h3>' +
          '<p class="adm__hint" style="margin:0 0 8px">Master model · ' + ui.count(g.memberCount) + ' compatible model(s)' + '</p>' +
          membersHTML(g, 10) +
          '<footer><div>' + (g.lastChange ? changeLine(g) + ' · ' + last(g) + ' · ' + source(g) : '<span class="adm__none">From the baseline</span>') + '</div>' + edit(g) + '</footer></article>';
      }).join('') + '</div>';
    } else {
      body = '<div class="adm__scroll"><table class="adm__table cg__table"><thead><tr><th>Category</th><th>Group</th><th>Master model</th><th>Compatible models</th>' +
        '<th class="num">Count</th><th>Last updated</th><th>Last source</th><th>Change</th><th></th></tr></thead><tbody>' +
        state.groups.map(function (g) {
          return '<tr style="cursor:default"><td>' + ui.esc(categoryName(g.categoryId)) + '</td>' +
            '<td class="mono" style="white-space:nowrap">' + ui.esc(g.partCode || g.groupNo) + '</td>' +
            '<td><b>' + ui.esc(g.masterModelName || '—') + '</b></td>' +
            '<td class="cg__members">' + membersHTML(g, 6) + '</td>' +
            '<td class="num">' + ui.count(g.memberCount) + '</td>' +
            '<td style="white-space:nowrap">' + last(g) + (g.lastChange ? '<div style="font-size:11px">' + changeLine(g) + '</div>' : '') + '</td>' +
            '<td>' + source(g) + '</td><td>' + change(g) + '</td><td>' + edit(g) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    list.innerHTML = note + body +
      (state.next ? '<div style="margin-top:12px"><button type="button" class="adm__btn" data-more="1">Load more</button></div>' : '') +
      '<p class="adm__hint" style="margin-top:12px">A change made here is live in the compatibility data at once. The public search bundle and the generated pages pick it up at the next catalogue build.</p>';
  }

  /* ================================================================ editing */

  function current() { return state.groups.filter(function (g) { return g.groupId === state.editing; })[0] || null; }

  function editor() {
    var box = state.root.querySelector('#cgEditor');
    if (!box) return;
    if (state.draft) { box.innerHTML = draftHTML(); return; }
    var g = current();
    if (!g) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="adm__card cg__editor" data-group="' + ui.esc(g.groupId) + '">' +
      '<div class="ig__jobhead"><div><h2>Edit ' + ui.esc(g.partCode || g.groupNo) + ' <span class="adm__pill">' + ui.esc(categoryName(g.categoryId)) + '</span></h2>' +
      '<p class="adm__hint" style="margin:2px 0 0">Master model: <b>' + ui.esc(g.masterModelName || '—') + '</b> · ' + ui.count(g.memberCount) + ' compatible model(s)</p></div>' +
      '<div class="ig__actions"><button type="button" class="adm__btn" data-close="1">Close</button></div></div>' +

      '<h3 class="ig__h3">Compatible models</h3><ul class="cg__members-edit">' + (g.members || []).map(function (m) {
        var master = m.id === g.masterModelId;
        return '<li><span>' + ui.esc(m.name) + (master ? ' <span class="adm__pill adm__pill--info">master</span>' : '') + '</span>' +
          (master ? '' : '<span class="ig__minis"><button type="button" class="ig__mini" data-master="' + ui.esc(m.id) + '">Make master</button>' +
            '<button type="button" class="ig__mini" data-remove="' + ui.esc(m.id) + '" data-name="' + ui.esc(m.name) + '">Remove</button></span>') + '</li>';
      }).join('') + '</ul>' +

      '<h3 class="ig__h3">Add a model</h3>' +
      '<form class="cg__find" data-find="add"><input name="q" type="search" placeholder="Type a model name from All Brands &amp; Models…" autocomplete="off">' +
      '<button class="adm__btn" type="submit">Search</button></form><div class="cg__results" data-results="add"></div>' +

      '<h3 class="ig__h3">Merge another group into this one</h3>' +
      '<p class="adm__hint" style="margin:0 0 6px">For two groups that are the same part. Find the other group by one of its models; its models move here and this group keeps its master.</p>' +
      '<form class="cg__find" data-find="merge"><input name="q" type="search" placeholder="A model of the other group…" autocomplete="off">' +
      '<button class="adm__btn" type="submit">Find group</button></form><div class="cg__results" data-results="merge"></div>' +

      '<h3 class="ig__h3">Delete this group</h3>' +
      '<p class="adm__hint" style="margin:0 0 6px">Removes the compatibility relationship. The ' + ui.count(g.memberCount) + ' model(s) stay in All Brands &amp; Models and are free to be grouped again.</p>' +
      '<button type="button" class="adm__btn cg__danger" data-delete="' + ui.esc(g.groupId) + '">Delete ' + ui.esc(g.groupNo) + '…</button>' +
      '</div>';
  }

  function draftHTML() {
    var d = state.draft;
    return '<div class="adm__card cg__editor"><div class="ig__jobhead"><div><h2>New group <span class="adm__pill">' + ui.esc(categoryName(d.categoryId)) + '</span></h2>' +
      '<p class="adm__hint" style="margin:2px 0 0">Every model must be in All Brands &amp; Models and must not already have a ' + ui.esc(categoryName(d.categoryId)) + ' group.</p></div>' +
      '<div class="ig__actions"><button type="button" class="adm__btn" data-close="1">Cancel</button></div></div>' +
      '<ul class="cg__members-edit">' + (d.members.length ? d.members.map(function (m, i) {
        return '<li><span>' + ui.esc(m.name) + (i === 0 ? ' <span class="adm__pill adm__pill--info">master</span>' : '') + '</span><span class="ig__minis">' +
          (i === 0 ? '' : '<button type="button" class="ig__mini" data-draft-master="' + i + '">Make master</button>') +
          '<button type="button" class="ig__mini" data-draft-remove="' + i + '">Remove</button></span></li>';
      }).join('') : '<li class="adm__none">No models yet. The first one you add is the master.</li>') + '</ul>' +
      '<form class="cg__find" data-find="draft"><input name="q" type="search" placeholder="Type a model name…" autocomplete="off"><button class="adm__btn" type="submit">Search</button></form>' +
      '<div class="cg__results" data-results="draft"></div>' +
      '<div style="margin-top:12px"><button type="button" class="adm__btn adm__btn--primary" data-create="1"' + (d.members.length < 2 ? ' disabled' : '') + '>Create group</button>' +
      ' <span class="adm__hint">A group needs at least two models.</span></div></div>';
  }

  function results(kind, html) {
    var box = state.root.querySelector('[data-results="' + kind + '"]');
    if (box) box.innerHTML = html;
  }

  function onSubmit(e) {
    if (e.target.closest('#cgSearch')) {
      e.preventDefault();
      state.q = String(new FormData(e.target).get('q') || '').trim();
      state.changed = false;
      sync(); load(true);
      return;
    }
    if (e.target.closest('#cgNewCat')) {
      e.preventDefault();
      var name = String(new FormData(e.target).get('name') || '').trim();
      if (!name) return;
      act({ action: 'category_create', name: name }).then(function (r) {
        toast('Category ' + r.category.name + ' created (' + r.category.code + ')');
        loadCategories(false);
        loadChanges();
      }, failed);
      return;
    }
    var find = e.target.closest('form[data-find]');
    if (!find) return;
    e.preventDefault();
    var kind = find.getAttribute('data-find');
    var q = String(new FormData(find).get('q') || '').trim();
    if (q.length < 2) return;
    results(kind, skel(40));
    if (kind === 'merge') {
      var g = current();
      api({ view: 'groups', q: q, categoryId: g.categoryId }).then(function (d) {
        var others = d.groups.filter(function (x) { return x.groupId !== g.groupId; });
        results('merge', others.length ? '<ul class="cg__members-edit">' + others.map(function (x) {
          return '<li><span><b>' + ui.esc(x.partCode || x.groupNo) + '</b> · master ' + ui.esc(x.masterModelName || '—') + ' · ' + ui.count(x.memberCount) + ' model(s)</span>' +
            '<button type="button" class="ig__mini" data-merge="' + ui.esc(x.groupId) + '" data-label="' + ui.esc(x.groupNo + ' (' + x.memberCount + ' models, master ' + (x.masterModelName || '—') + ')') + '">Merge into ' + ui.esc(g.groupNo) + '</button></li>';
        }).join('') + '</ul>' : '<p class="adm__none">' + (d.model && d.model.status === 'matched'
          ? ui.esc(d.model.modelName) + ' has no other ' + ui.esc(categoryName(g.categoryId)) + ' group.' : 'That is not one catalogue model.') + '</p>');
      }, function (err) { results('merge', ui.banner('bad', ui.esc(err.message || 'search failed'))); });
      return;
    }
    api({ view: 'models', q: q }).then(function (d) {
      results(kind, d.models.length ? '<ul class="cg__members-edit">' + d.models.map(function (m) {
        return '<li><span>' + ui.esc(m.modelName) + '</span><button type="button" class="ig__mini" data-pick="' + ui.esc(m.modelId) + '" data-name="' + ui.esc(m.modelName) + '" data-kind="' + kind + '">Add</button></li>';
      }).join('') + '</ul>' : '<p class="adm__none">No model in All Brands &amp; Models matches that. A model is never created here.</p>');
    }, function (err) { results(kind, ui.banner('bad', ui.esc(err.message || 'search failed'))); });
  }

  function onClick(e) {
    var t = e.target;
    var v = t.closest('[data-view]');
    if (v) { state.view = v.getAttribute('data-view'); sync(); controls(); paint(); return; }
    if (t.closest('[data-more]')) { load(false); return; }
    if (t.closest('[data-changed]')) { state.changed = !state.changed; state.q = ''; sync(); controls(); load(true); return; }
    var u = t.closest('[data-undo]');
    if (u) { undo(u.getAttribute('data-undo'), u.getAttribute('data-what')); return; }

    var ed = t.closest('[data-edit]');
    if (ed) { state.draft = null; state.editing = ed.getAttribute('data-edit'); editor(); state.root.querySelector('#cgEditor').scrollIntoView({ block: 'start' }); return; }
    if (t.closest('[data-close]')) { state.editing = null; state.draft = null; editor(); return; }
    if (t.closest('[data-new-group]')) {
      var c = category(state.categoryId);
      if (!c) return toast('Choose a category first', 'warn');
      state.editing = null; state.draft = { categoryId: c.id, members: [] }; editor();
      state.root.querySelector('#cgEditor').scrollIntoView({ block: 'start' });
      return;
    }

    var g = current();
    var pick = t.closest('[data-pick]');
    if (pick) {
      var mid = pick.getAttribute('data-pick'), mname = pick.getAttribute('data-name');
      if (pick.getAttribute('data-kind') === 'draft') {
        if (state.draft.members.some(function (m) { return m.id === mid; })) return;
        state.draft.members.push({ id: mid, name: mname });
        editor();
        return;
      }
      act({ action: 'group_add_model', groupId: g.groupId, modelId: mid }).then(function (r) {
        toast(r.addedModelName + ' added to ' + r.groupNo); refresh();
      }, failed);
      return;
    }
    var rm = t.closest('[data-remove]');
    if (rm) {
      if (!global.confirm('Remove ' + rm.getAttribute('data-name') + ' from ' + g.groupNo + '?\n\nOnly the compatibility relationship is removed. The model stays in All Brands & Models.')) return;
      act({ action: 'group_remove_model', groupId: g.groupId, modelId: rm.getAttribute('data-remove') }).then(function (r) {
        toast(r.removedModelName + ' removed from ' + r.groupNo); refresh();
      }, failed);
      return;
    }
    var ms = t.closest('[data-master]');
    if (ms) {
      act({ action: 'group_set_master', groupId: g.groupId, modelId: ms.getAttribute('data-master') }).then(function (r) {
        toast(r.masterModelName + ' is now the master of ' + r.groupNo); refresh();
      }, failed);
      return;
    }
    var mg = t.closest('[data-merge]');
    if (mg) {
      if (!global.confirm('Merge ' + mg.getAttribute('data-label') + ' into ' + g.groupNo + '?\n\nIts models move into ' + g.groupNo + ', which keeps its master and its part code. The other group stops being a group.')) return;
      act({ action: 'group_merge', intoGroupId: g.groupId, fromGroupId: mg.getAttribute('data-merge') }).then(function (r) {
        toast(r.mergedGroupNo + ' merged into ' + r.groupNo + ' (' + r.newMemberCount + ' models)'); refresh();
      }, failed);
      return;
    }
    var del = t.closest('[data-delete]');
    if (del) {
      var typed = global.prompt('Delete ' + g.groupNo + ' and its ' + g.memberCount + ' compatibility relationship(s)?\n\nThe models stay in All Brands & Models. Type the group number to confirm:', '');
      if (typed === null) return;
      act({ action: 'group_delete', groupId: g.groupId, confirm: String(typed).trim() }).then(function (r) {
        toast('Group ' + r.groupNo + ' deleted'); state.editing = null; editor(); refresh(); loadCategories(false);
      }, failed);
      return;
    }

    var dm = t.closest('[data-draft-master]');
    if (dm) { var i = Number(dm.getAttribute('data-draft-master')); state.draft.members.unshift(state.draft.members.splice(i, 1)[0]); editor(); return; }
    var dr = t.closest('[data-draft-remove]');
    if (dr) { state.draft.members.splice(Number(dr.getAttribute('data-draft-remove')), 1); editor(); return; }
    if (t.closest('[data-create]')) {
      var d = state.draft;
      act({ action: 'group_create', categoryId: d.categoryId, masterModelId: d.members[0].id, memberIds: d.members.slice(1).map(function (m) { return m.id; }) }).then(function (r) {
        toast('Group ' + r.groupNo + ' created'); state.draft = null; editor(); state.changed = true; sync(); controls(); refresh(); loadCategories(false);
      }, failed);
      return;
    }

    var cr = t.closest('[data-cat-rename]');
    if (cr) {
      var nm = global.prompt('New name for ' + cr.getAttribute('data-name') + ':', cr.getAttribute('data-name'));
      if (!nm) return;
      act({ action: 'category_rename', categoryId: cr.getAttribute('data-cat-rename'), name: nm }).then(function () { toast('Category renamed'); loadCategories(false); }, failed);
      return;
    }
    var cd = t.closest('[data-cat-delete]');
    if (cd) {
      if (!global.confirm('Delete the category ' + cd.getAttribute('data-name') + '?\n\nOnly an empty category can be deleted.')) return;
      act({ action: 'category_delete', categoryId: cd.getAttribute('data-cat-delete') }).then(function () { toast('Category deleted'); loadCategories(false); }, failed);
    }
  }

  /* ============================================================== categories */

  function categoriesCard() {
    var box = state.root.querySelector('#cgCats');
    if (!box) return;
    box.innerHTML = '<div class="adm__scroll"><table class="adm__table"><thead><tr><th>Category</th><th>Part-code prefix</th><th class="num">Groups</th><th>Where</th><th></th></tr></thead><tbody>' +
      state.categories.map(function (c) {
        var run = c.kind === 'run_time';
        return '<tr style="cursor:default"><td><b>' + ui.esc(c.name) + '</b></td><td class="mono">' + ui.esc(c.code || '') + '</td>' +
          '<td class="num">' + (run ? '<span class="adm__none">see the list</span>' : ui.count(c.groupCount)) + '</td>' +
          '<td>' + (run ? '<span class="adm__pill adm__pill--warn">compatibility data only</span> <span class="adm__none">not on the public site until it is added to the catalogue build</span>'
            : '<span class="adm__pill adm__pill--ok">public site</span>' + (c.comingSoon ? ' <span class="adm__none">no groups yet</span>' : '')) + '</td>' +
          '<td style="white-space:nowrap">' + (run && state.canEdit
            ? '<button type="button" class="ig__mini" data-cat-rename="' + ui.esc(c.id) + '" data-name="' + ui.esc(c.name) + '">Rename</button> ' +
              '<button type="button" class="ig__mini" data-cat-delete="' + ui.esc(c.id) + '" data-name="' + ui.esc(c.name) + '">Delete</button>'
            : '<span class="adm__none" title="Declared in the catalogue build: its name, prefix and pages are changed there.">site category</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      (state.canEdit ? '<form id="cgNewCat" class="cg__find" style="margin-top:12px"><input name="name" type="text" maxlength="40" placeholder="New category name, e.g. Camera Glass">' +
        '<button class="adm__btn" type="submit">Create category</button></form>' : '') +
      '<p class="adm__hint" style="margin-top:8px">A scan creates a category by itself when a post is about one of these part types and there is none yet: ' +
        (state.creatable || []).map(ui.esc).join(', ') + '.</p>';
  }

  /* ---------------------------------------- needs attention, recent changes */

  function top(d) {
    var box = state.root.querySelector('#cgTop');
    if (!box) return;
    var html = '';
    if (d.attention.length) {
      html += '<div class="adm__card" id="attention"><h2>Needs attention <span class="adm__pill adm__pill--warn">' + d.attention.length + '</span></h2>' +
        '<p class="adm__hint">Lists a scan did not apply on its own. Nothing was written for them.</p><ul class="cg__list">' +
        d.attention.map(function (a) {
          return '<li><div><b>' + ui.esc(a.productName || 'a compatibility list') + '</b> · ' + ui.count((a.counts || {}).extracted) + ' models · ' +
            (a.permalink ? link(a.permalink, '@' + (a.sourceUsername || 'post')) : ui.esc('@' + (a.sourceUsername || ''))) +
            '<div class="adm__none" style="font-size:12px">' + (a.reasons || []).map(ui.esc).join(' · ') + '</div>' +
            '<div class="adm__none" style="font-size:12px">' + (a.models || []).map(ui.esc).join(', ') + ((a.counts || {}).extracted > (a.models || []).length ? ', …' : '') + '</div></div>' +
            '<a class="adm__btn" href="/admin/instagram/review?section=' + encodeURIComponent(a.reviewSection || 'review') + (a.jobId ? '&job=' + encodeURIComponent(a.jobId) : '') + '">Open</a></li>';
        }).join('') + '</ul></div>';
    }
    var queued = d.queued.filter(function (q) { return q.merge; });
    if (queued.length) {
      html += '<div class="adm__card"><h2>Lands with the next catalogue build <span class="adm__pill adm__pill--info">' + queued.length + '</span></h2>' +
        '<p class="adm__hint">Merges too large to make in one step. Both groups stay as they are until the build folds them into one.</p><ul class="cg__list">' +
        queued.map(function (q) {
          return '<li><div><b>' + ui.esc(q.merge.from.groupNo || q.merge.from.groupId) + '</b> merges into <b>' + ui.esc(q.merge.into.groupNo || q.merge.into.groupId) + '</b> · ' +
            ui.esc(categoryName(q.categoryId)) + '</div><time>' + ui.date(q.approvedAt) + '</time></li>';
        }).join('') + '</ul></div>';
    }
    box.innerHTML = html;
    if (location.hash === '#attention' && document.getElementById('attention')) document.getElementById('attention').scrollIntoView();

    var recent = state.root.querySelector('#cgRecent');
    if (!d.recent.length) { recent.innerHTML = ui.emptyState('No changes yet', 'Scan a source from the Instagram Data Importer, or edit a group above.'); return; }
    recent.innerHTML = '<ul class="adm__timeline">' + d.recent.map(function (e) {
      var up = function (x) { return ui.esc(String(x || '').toUpperCase()); };
      var what = e.created ? 'Created <b>' + ui.esc(e.created.groupNo) + '</b> — master ' + ui.esc(e.created.masterModelName) + ': ' + (e.created.memberNames || []).map(ui.esc).join(', ')
        : e.merge ? (e.merge.live ? 'Merged <b>' : 'Decided: merge <b>') + ui.esc(e.merge.from.groupNo || e.merge.from.groupId) + '</b> into <b>' + ui.esc(e.merge.into.groupNo || e.merge.into.groupId) + '</b>' +
            (e.merge.from.memberCount ? ' (' + ui.count(e.merge.from.memberCount) + ' model(s) moved)' : '')
        : e.removed ? 'Removed <b>' + ui.esc(e.removed.modelName) + '</b> from <b>' + up(e.removed.groupId) + '</b>'
        : e.master ? '<b>' + ui.esc(e.master.modelName) + '</b> made master of <b>' + up(e.master.groupId) + '</b>' + (e.master.previousName ? ' (was ' + ui.esc(e.master.previousName) + ')' : '')
        : e.deleted ? 'Deleted group <b>' + ui.esc(e.deleted.groupNo) + '</b> (' + ui.count(e.deleted.memberCount) + ' model(s) released)'
        : e.added ? 'Added <b>' + ui.esc(e.added.modelName) + '</b> to <b>' + up(e.added.groupId) + '</b> (' + ui.count(e.added.previousMemberCount) + ' → ' + ui.count(e.added.newMemberCount) + ')'
        : ui.esc(String(e.kind).replace(/_/g, ' ') + ' · ' + String(e.status).replace(/_/g, ' '));
      var gone = e.status === 'reverted' || e.status === 'cancelled';
      var undoable = !gone && e.proposalId && state.canEdit && (e.created || e.added || e.merge);
      return '<li' + (gone ? ' class="cg__undone"' : '') + '><time>' + ui.dateTime(e.approvedAt) + '</time><div>' + what +
        (gone ? ' <span class="adm__pill">undone</span>' : '') +
        (undoable ? ' <button type="button" class="ig__mini" data-undo="' + ui.esc(e.proposalId) + '" data-what="' +
          ui.esc(e.created ? 'the new group ' + e.created.groupNo : e.merge ? 'what this list did, including this merge' : 'what this list added to ' + String(e.added.groupId).toUpperCase()) + '">Undo</button>' : '') +
        '<div class="adm__none" style="font-size:12px">' + ui.esc(categoryName(e.categoryId)) + ' · ' +
        (e.automatic ? 'Instagram Intelligence' : e.proposalId ? 'approved by an admin' : 'an admin, in Compatibility Management') +
        ((e.sources || []).length ? ' · ' + e.sources.map(function (s) { return ui.esc('@' + String(s).replace(/^ig_/, '')); }).join(', ') : '') + '</div></div></li>';
    }).join('') + '</ul>';
  }

  /** One list's change, undone as a whole. */
  function undo(candidateId, what) {
    if (!global.confirm('Undo ' + what + '?\n\nEverything that one Instagram list changed is taken back: the models it added are removed from the group again, ' +
        'a group it created is removed, and a group it merged is a group again. Nothing else is touched, and no model is deleted from the catalogue.')) return;
    act({ action: 'undo_change', candidateId: candidateId }).then(function (r) {
      toast(r.deletedGroup ? 'Group ' + r.deletedGroup + ' removed' : r.removedModelIds.length + ' model(s) taken out of ' + String(r.groupId || 'the group').toUpperCase() +
        ((r.restoredGroups || []).length ? '; ' + r.restoredGroups.join(', ') + ' restored' : ''));
      refresh();
    }, failed);
  }

  ADM.pages.igGroups = { render: render };
})(window);
