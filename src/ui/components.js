/* ============================================================================
   Mobile Parts Finder · components.js
   Reusable render functions. Every one takes plain data and returns an HTML
   string — no framework, no duplicated markup across pages.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});
  var icon = SM.icon;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function mark(text, q) {
    if (!q) return esc(text);
    var i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }
  function nf(n) { return Number(n).toLocaleString('en-IN'); }

  var C = {};
  C.esc = esc;
  C.mark = mark;
  C.nf = nf;

  /* ------------------------------------------------------------- skeletons */
  C.skelPlate = function () {
    return '<div class="skelplate" aria-hidden="true">' +
      '<div class="skel" style="height:14px;width:62%"></div>' +
      '<div class="skel" style="height:26px;width:80%"></div>' +
      '<div class="skel" style="height:44px;width:100%"></div>' +
      '<div style="display:flex;gap:6px"><div class="skel" style="height:22px;width:88px"></div><div class="skel" style="height:22px;width:104px"></div><div class="skel" style="height:22px;width:70px"></div></div>' +
      '</div>';
  };
  C.skelPlates = function (n) {
    var out = '';
    for (var i = 0; i < (n || 6); i++) out += C.skelPlate();
    return '<div class="gridcards">' + out + '</div>';
  };
  C.skelRows = function (n) {
    var out = '';
    for (var i = 0; i < (n || 8); i++) out += '<div class="skel" style="height:66px;border-radius:15px"></div>';
    return '<div class="modelgrid">' + out + '</div>';
  };

  /* ------------------------------------------------------------- states */
  C.state = function (o) {
    return '<div class="state">' +
      '<div class="state__art ' + (o.brand ? 'state__art--brand' : '') + '">' + icon(o.icon || 'search') + '</div>' +
      '<h3>' + esc(o.title) + '</h3>' +
      (o.text ? '<p>' + esc(o.text) + '</p>' : '') +
      (o.action || '') +
      '</div>';
  };

  /* ------------------------------------------------------------- search UI */
  C.suggestion = function (m, q, cursor, opts) {
    opts = opts || {};
    var b = SM.db.brandById[m.brandId];
    return '<button class="sug' + (cursor ? ' is-cursor' : '') + '" data-act="pick-model" data-id="' + m.id + '" type="button">' +
      /* history items are marked with a clock so they read as past searches */
      (opts.recent ? '<span class="sug__hist">' + icon('history') + '</span>' : SM.brandLogo(b)) +
      '<span class="sug__body">' +
      '<span class="sug__name">' + mark(m.fullName, q) + '</span>' +
      '<span class="sug__meta">' +
        [ esc(b.name),
          m.displaySize ? esc(m.displaySize) + '&Prime;' + (m.screenType ? ' ' + esc(m.screenType) : '') : null,
          m.releaseYear ? esc(String(m.releaseYear)) : null
        ].filter(Boolean).join(' <i></i> ') + '</span>' +
      '</span>' +
      '<span class="sug__go">' + icon('arrowRight') + '</span>' +
      '</button>';
  };

  /* ------------------------------------------------------- category pieces */
  C.categoryCard = function (cat, count, opts) {
    opts = opts || {};
    var off = opts.dim && !count;
    return '<button type="button" class="cat' + (opts.active ? ' is-on' : '') + (off ? ' is-off' : '') + '" ' +
      'data-act="' + (opts.act || 'pick-cat') + '" data-id="' + cat.id + '" style="--c:' + cat.color + '"' + (off ? ' disabled' : '') + '>' +
      '<span class="cat__tick">' + icon('checkCircle') + '</span>' +
      SM.art.category(cat.id, 'pthumb--cat') +
      '<span class="cat__name">' + esc(cat.name) + '</span>' +
      '<span class="cat__n">' + (count == null ? cat.groupCount + ' groups' : count ? count + (count === 1 ? ' group' : ' groups') : 'No group yet') + '</span>' +
      '</button>';
  };


  /* --------------------------------------------------- compatibility plate */
  function bars(count) {
    var out = '', base = Math.min(1, Math.log(count + 1) / Math.log(280));
    for (var i = 0; i < 5; i++) {
      var h = 5 + Math.round(base * 17 * ((i + 2) / 6) + (i * 1.4));
      out += '<span style="height:' + Math.min(22, h) + 'px"></span>';
    }
    return out;
  }

  C.plate = function (row, opts) {
    opts = opts || {};
    var g = row.group, cat = row.category, master = row.master;
    /* row.devices is null only when a group's member list is genuinely absent
       from the catalogue. It is no longer the normal case: the bundle carries
       all 12,239 fitments. */
    var locked = !row.devices;
    var others = locked ? [] : row.devices.filter(function (d) { return d.id !== master.id; });
    var preview = others.slice(0, 3);
    var hidden = locked ? Math.max(0, (row.deviceCount || 1) - 1) : others.length - preview.length;
    var b = SM.db.brandById[master.brandId];

    return '<article class="plate" style="--c:' + cat.color + '" data-act="open-group" data-id="' + g.groupId + '" ' +
      'tabindex="0" role="button" aria-label="Open group ' + esc(g.groupNumber) + ' — ' + esc(master.fullName) + '">' +
      /* Our part code leads: it is what a shop writes down. The manufacturer's
         code takes its place where the catalogue has one, because that is the
         string a supplier recognises. */
      '<div class="plate__strip">' +
      '<span>' + esc(g.groupNumber) + '</span><span class="sep">/</span>' +
      '<span>' + esc(g.oemPartNo || g.partCode || '—') + '</span>' +
      '<span class="plate__catbadge">' + esc(cat.short) + '</span>' +
      '</div>' +
      '<div class="plate__body">' +
      /* the category render carries the visual identity — which part this is */
      '<div class="plate__master">' + SM.art.category(cat.id, 'pthumb--plate') +
      '<div class="grow">' +
      '<span class="masterflag">' + icon('crown') + 'Master model</span>' +
      '<h3 class="plate__mname">' + esc(master.fullName) + '</h3>' +
      /* screenType is recorded for 260 of 4,933 devices, so the separators are
         built from what is actually there. Printing "6.4″ <i></i>  <i></i> 2020"
         left a floating divider with nothing on either side of it. */
      '<div class="plate__mmeta">' +
      [ master.displaySize ? esc(master.displaySize) + '&Prime;' : null,
        master.screenType ? esc(master.screenType) : null,
        master.releaseYear ? esc(String(master.releaseYear)) : null
      ].filter(Boolean).join(' <i></i> ') + '</div>' +
      '</div></div>' +

      '<div class="fitline">' +
      '<span class="fitline__n">' + g.compatibleCount + '</span>' +
      '<span class="fitline__t">' + (g.compatibleCount === 1
        ? 'model-specific part<br>no shared fitment'
        : 'devices in this<br>' + esc(cat.short) + ' group') + '</span>' +
      '<span class="fitline__bar">' + bars(g.compatibleCount) + '</span>' +
      '</div>' +

      '<div class="devchips">' +
      (others.length
        ? preview.map(function (d) {
          var hit = opts.highlightId && d.id === opts.highlightId;
          return '<span class="devchip' + (hit ? ' devchip--hit' : '') + '">' + esc(d.fullName) + '</span>';
        }).join('') + (hidden > 0 ? '<span class="devchip devchip--more">+' + hidden + ' more</span>' : '')
        : locked
          /* No member list for this group at all. Saying "fits X only" would
             contradict the count printed directly above it, so the card says
             what is true: how many, and that the names are not recorded. */
          ? (hidden > 0
              ? '<span class="devchip devchip--more">' + hidden +
                ' more ' + (hidden === 1 ? 'device' : 'devices') + ' — not listed</span>'
              : '<span class="devchip devchip--more">Fits ' + esc(master.modelName) + ' only</span>')
          : '<span class="devchip devchip--more">Fits ' + esc(master.modelName) + ' only</span>') +
      '</div>' +
      '</div>' +
      '<div class="plate__foot">' +
      '<span class="mono">' + esc(g.serialNumber) + '</span>' +
      '<button class="plate__cta" type="button" data-act="open-group" data-id="' + g.groupId + '">' +
      'Open group ' + icon('arrowRight') + '</button>' +
      '</div>' +
      '</article>';
  };

  /* ------------------------------------------------------ identifier strip */
  /* The four identifiers a counter actually uses, plus the manufacturer's own
     code when the catalogue has one.

     Three of these are ISSUED BY THIS CATALOGUE — group number, serial number
     and part code — and the fourth, when present, is the manufacturer's. The
     distinction matters at the counter: MPF-BT-0001 identifies the group in
     this app, EB-BA115ABY is what a supplier recognises. They used to render
     as one undifferentiated block, all three showing the same value. */
  C.idGrid = function (g) {
    var cat = SM.db.categoryById[g.categoryId];
    return '<div class="idgrid">' +
      '<div class="idcell"><span>Part code</span><b>' + esc(g.partCode || '—') + '</b></div>' +
      '<div class="idcell"><span>Group number</span><b>' + esc(g.groupNumber) + '</b></div>' +
      '<div class="idcell"><span>Serial number</span><b>' + esc(g.serialNumber) + '</b></div>' +
      (g.oemPartNo
        ? '<div class="idcell"><span>Manufacturer part no.</span><b>' + esc(g.oemPartNo) + '</b></div>'
        : '<div class="idcell"><span>Category</span><b style="font-family:var(--f-ui);color:' + cat.color + '">' + esc(cat.name) + '</b></div>') +
      '</div>';
  };

  /* --------------------------------------------------------- master banner */
  C.masterCard = function (master, cat) {
    var b = SM.db.brandById[master.brandId];
    return '<div class="mastercard"><div class="mastercard__in">' +
      '<div class="row" style="gap:9px">' + SM.brandLogo(b, 'blogo--sm') +
      '<span class="t-lab" style="color:rgba(214,255,244,.72)">Master model</span></div>' +
      '<h3>' + esc(master.fullName) + '</h3>' +
      /* Only chips that have a value. screenType and screenResolution are null
         for most devices, and esc(null) rendered an empty chip — a run of
         blank pills that looked like a loading state that never finished. */
      /* Escaped first, entity appended after — esc() turns the & of &Prime;
         into &amp;Prime; and the card reads 6.4&Prime; in plain text. */
      '<div class="mspecs">' +
      [ master.displaySize ? esc(master.displaySize) + '&Prime; display' : null,
        master.screenType ? esc(master.screenType) : null,
        master.screenResolution ? esc(master.screenResolution) : null,
        master.releaseDate ? esc(master.releaseDate) : null,
        cat ? esc(cat.name) : null
      ].filter(Boolean)
       .map(function (t) { return '<span class="mspec">' + t + '</span>'; }).join('') +
      '</div></div></div>';
  };

  /* ---------------------------------------------------- compatible devices */
  /* Renders in chunks — a 268-device group stays instant on a phone. */
  C.deviceRows = function (devices, opts) {
    opts = opts || {};
    return devices.map(function (d, i) {
      var cls = 'dev';
      if (d.id === opts.masterId) cls += ' is-master';
      else if (d.id === opts.hitId) cls += ' is-hit';
      return '<button class="' + cls + '" type="button" data-act="open-model" data-id="' + d.id + '">' +
        '<span class="dev__i">' + String((opts.offset || 0) + i + 1).padStart(3, '0') + '</span>' +
        '<span class="dev__n">' + esc(d.fullName) + '</span>' +
        (d.id === opts.masterId ? '<span class="pill pill--amber" style="height:20px;font-size:10px">MASTER</span>'
          : d.id === opts.hitId ? '<span class="pill pill--brand" style="height:20px;font-size:10px">YOUR MODEL</span>' : '') +
        '<span class="dev__b">' + d.displaySize + '&Prime;</span>' +
        '</button>';
    }).join('');
  };

  /* ---------------------------------------------------------- brand/model */
  /* A brand tile is a small dashboard, not a label.
     The counts are ordered by how much they matter to someone pricing a
     repair: phones first and largest, split into flat and curved because that
     split decides which glass and which back cover fit, then tablets and
     watches, then the total.

     The split is drawn as a proportional bar as well as written as numbers.
     "32 flat, 13 curved" needs reading; the bar is comparable at a glance
     across a grid of 27 brands, which is how the page is actually used. */
  C.brandCard = function (b) {
    var c = b.counts || { total: b.modelCount, phones: b.modelCount, flat: 0, curved: 0, tablets: 0, watches: 0 };
    var phones = c.phones || 0;
    /* The flat/curved split only exists when the dataset carries curvature.
       The current export does not, so the bar and its labels are omitted
       rather than drawn from nulls — a bar at 0% would read as "every phone is
       curved", which is a claim the data cannot support. */
    var hasCurve = c.flat != null && c.curved != null;
    var flatPct = hasCurve && phones ? Math.round((c.flat / phones) * 100) : 0;

    /* Only the classes this brand actually sells get a chip — a row of
       "0 tablets · 0 watches" is noise on the brands that make neither. */
    var extras = [];
    if (c.tablets) extras.push('<span class="bcs"><b>' + c.tablets + '</b> tablet' + (c.tablets === 1 ? '' : 's') + '</span>');
    if (c.watches) extras.push('<span class="bcs"><b>' + c.watches + '</b> watch' + (c.watches === 1 ? '' : 'es') + '</span>');

    return '<button type="button" class="brandcard" data-act="open-brand" data-id="' + b.id + '" ' +
      'style="--b1:' + b.color + '" aria-label="' + esc(b.name) + ', ' + c.total + ' devices">' +

      '<span class="brandcard__top">' +
        SM.brandLogo(b, 'blogo--lg') +
        '<span class="brandcard__id">' +
          '<span class="brandcard__n">' + esc(b.name) + '</span>' +
          '<span class="brandcard__c">' + c.total + ' device' + (c.total === 1 ? '' : 's') + '</span>' +
        '</span>' +
      '</span>' +

      (phones
        ? '<span class="brandcard__lead">' +
            '<b>' + phones + '</b><span>phone' + (phones === 1 ? '' : 's') + '</span>' +
          '</span>' +
          (hasCurve
            ? '<span class="curvebar" role="img" aria-label="' +
                c.flat + ' flat, ' + c.curved + ' curved">' +
                '<span class="curvebar__flat" style="width:' + flatPct + '%"></span>' +
              '</span>' +
              '<span class="brandcard__split">' +
                '<span class="bcs bcs--flat"><b>' + c.flat + '</b> flat</span>' +
                '<span class="bcs bcs--curved"><b>' + c.curved + '</b> curved</span>' +
              '</span>'
            : '')
        : '') +

      (extras.length ? '<span class="brandcard__extra">' + extras.join('') + '</span>' : '') +
      '</button>';
  };

  C.modelCard = function (m, q) {
    var b = SM.db.brandById[m.brandId];
    var gc = (SM.db.groupsByModel[m.id] || []).length;
    return '<button type="button" class="mcard" data-act="open-model" data-id="' + m.id + '">' +
      SM.brandLogo(b) +
      '<span class="grow">' +
      '<span class="mcard__n" style="display:block">' + mark(m.fullName, q) + '</span>' +
      '<span class="mcard__m">' + m.displaySize + '&Prime; <i></i> ' + esc(String(m.releaseYear)) + (gc ? ' <i></i> ' + gc + ' part groups' : '') + '</span>' +
      '</span>' +
      '<span class="mcard__go">' + icon('chevronRight') + '</span>' +
      '</button>';
  };

  C.specSheet = function (m) {
    var rows = [
      ['Brand', m.brand], ['Model name', m.modelName], ['Release date', m.releaseDate],
      ['Display size', m.displaySize + '"'], ['Resolution', m.screenResolution],
      ['Screen ratio', m.screenRatio], ['Screen type', m.screenType],
      ['Refresh rate', m.refreshRate], ['Pixel density', m.ppi], ['Protection', m.protection],
      ['Height', m.height], ['Width', m.width], ['Thickness', m.thickness], ['Weight', m.weight],
      ['SIM', m.sim]
    ];
    return '<dl class="specs">' + rows.map(function (r) {
      return '<div class="spec"><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>';
    }).join('') + '</dl>';
  };

  /* ------------------------------------------------------------- paywall */
  C.paywall = function (o) {
    o = o || {};
    return '<div class="paywall">' +
      '<div class="paywall__lock">' + icon(o.icon || 'lock') + '</div>' +
      '<h3>' + esc(o.title || 'Device Finder is a Pro feature') + '</h3>' +
      '<p>' + esc(o.text || 'Browsing every phone model stays free forever. Matching a model to its compatibility group, part code and full fitment list needs an active plan.') + '</p>' +
      '<div class="paywall__acts">' +
      '<button class="btn btn--amber" data-act="go-plans">' + icon('crown') + 'See plans from ₹99</button>' +
      '</div></div>';
  };

  /* ---------------------------------------------------------------- plans */
  C.planCard = function (plan, opts) {
    opts = opts || {};
    var hero = plan.id === 'yearly';
    return '<div class="plan' + (hero ? ' plan--hero' : '') + '">' +
      (plan.badge ? '<span class="plan__tag">' + esc(plan.badge) + '</span>' : '') +
      '<div class="plan__in">' +
      '<div class="plan__name">' + esc(plan.name) + '</div>' +
      '<div class="plan__price"><b>₹' + plan.price + '</b><span>/ ' + esc(plan.per) + '</span></div>' +
      '<div class="plan__note">' + esc(plan.cadence) + ' · ' + esc(plan.note) + '</div>' +
      '<ul class="plan__feats">' + plan.feats.map(function (f) {
        return '<li>' + icon('checkCircle') + '<span>' + esc(f) + '</span></li>';
      }).join('') + '</ul>' +
      (opts.current
        ? '<button class="btn btn--block ' + (hero ? 'btn--outline' : 'btn--soft') + '" disabled>' + icon('check') + 'Your current plan</button>'
        : '<button class="btn btn--block ' + (hero ? 'btn--amber' : 'btn--primary') + '" data-act="subscribe" data-id="' + plan.id + '">' +
        icon('bolt') + 'Choose ' + esc(plan.name) + '</button>') +
      '</div></div>';
  };

  SM.C = C;
})(window);
