/* ============================================================================
   Mobile Parts Finder · icons.js — inline stroke icon set + the brand mark
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    arrowRight: '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
    check: '<path d="m4 12.5 5 5L20 6.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.6-4.9"/>',
    filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h9M17 18h3"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    phone: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 5.5h3"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20c.9-3.6 3.7-5.4 7.2-5.4s6.3 1.8 7.2 5.4"/>',
    crown: '<path d="M3.5 8.5 7 12l5-6.5 5 6.5 3.5-3.5-1.6 9.5H5.1L3.5 8.5Z"/>',
    lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
    unlock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 7.5-2"/>',
    bolt: '<path d="M13.5 2.5 5 13.2h5.4L9.8 21.5 19 10.6h-5.5l0-8.1Z"/>',
    sparkle: '<path d="M12 3.2 13.9 9 20 10.9 13.9 12.8 12 18.6 10.1 12.8 4 10.9 10.1 9 12 3.2Z"/><path d="M18.6 3v3.2M17 4.6h3.2"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5h-9a2.5 2.5 0 0 0-2.5 2.5v9"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
    moon: '<path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.9v.1"/>',
    alert: '<path d="M12 3.5 21 19.5H3L12 3.5Z"/><path d="M12 9.5v4M12 16.6v.1"/>',
    inbox: '<path d="M3.5 13.5h4l1.5 3h6l1.5-3h4"/><path d="M5.4 5h13.2l2 8.5v4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-4L5.4 5Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    logout: '<path d="M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5"/><path d="M15 8.5 18.5 12 15 15.5M18 12H9.5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4.5h-4.5"/>',
    history: '<path d="M3.6 9.5A8.5 8.5 0 1 1 3 12"/><path d="M3.2 4.6v5h5"/><path d="M12 7.6V12l3.2 1.9"/>',
    linkOut: '<path d="M9 5H5.5A1.5 1.5 0 0 0 4 6.5v12A1.5 1.5 0 0 0 5.5 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M14 4h6v6"/><path d="m20 4-8.5 8.5"/>',
    shop: '<path d="M4 9.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19V9.5"/><path d="M3 9.5 5 4h14l2 5.5a3 3 0 0 1-5.4 1.8A3 3 0 0 1 12 12a3 3 0 0 1-3.6-.7A3 3 0 0 1 3 9.5Z"/>',
    tag: '<path d="M4 11.5V5a1 1 0 0 1 1-1h6.5L20 12.5 12.5 20 4 11.5Z"/><circle cx="8.2" cy="8.2" r="1.3"/>',
    /* --- part categories --- */
    glass: '<rect x="5.5" y="2.5" width="13" height="19" rx="3"/><path d="m8 17 8-11"/><path d="M8 11.5 12.5 5"/>',
    cover: '<rect x="5.5" y="2.5" width="13" height="19" rx="3"/><circle cx="9.6" cy="7" r="1.6"/><circle cx="9.6" cy="11" r="1.6"/>',
    display: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 7.5h16"/><path d="M8 17.5h8"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8v4M16 2.8v4"/>',
    signal: '<path d="M4 20v-4M9 20v-8M14 20v-12M19 20V4"/>',
    cpu: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>',
    camera: '<path d="M3.5 8.5a2 2 0 0 1 2-2h1.7l1.3-2h7l1.3 2h1.7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/>',
    ruler: '<rect x="2.5" y="7.5" width="19" height="9" rx="2"/><path d="M7 7.5v3M11 7.5v4.5M15 7.5v3M19 7.5v4.5"/>',
    shield: '<path d="M12 2.8l7.5 3v5.6c0 4.4-3 8.2-7.5 9.8-4.5-1.6-7.5-5.4-7.5-9.8V5.8z"/><path d="M9 12l2.2 2.2L15.4 10"/>',
    battery: '<rect x="3" y="7" width="16" height="10" rx="2.5"/><path d="M21 10.5v3"/><path d="M6.5 10.5v3M10 10.5v3"/>',
    frame: '<rect x="5" y="2.5" width="14" height="19" rx="3.5"/><rect x="8" y="6" width="8" height="12" rx="1.5"/>',
    board: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9 9h6v6H9z"/><path d="M9 2.5v1.5M15 2.5v1.5M9 20v1.5M15 20v1.5M2.5 9H4M2.5 15H4M20 9h1.5M20 15h1.5"/>',
    charge: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M13 8.2 9.8 12.6h3.1L12.2 16l3.4-4.6h-3.2L13 8.2Z"/>',
    parts: '<circle cx="7" cy="7" r="3"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><path d="M4 20.5h7l-3.5-6-3.5 6Z"/><circle cx="17" cy="17" r="3.5"/>'
  };

  SM.icon = function (name, cls) {
    var d = P[name] || P.info;
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
      (cls ? ' class="' + cls + '"' : '') + '>' + d + '</svg>';
  };

  /* ---- Mobile Parts Finder mark: a magnifier closing on a phone part.
     The lens holds the part; the amber body keeps the brand accent.        */
  SM.logoMark = function (size, cls) {
    size = size || 36;
    var uid = 'mpf' + Math.random().toString(36).slice(2, 8);
    return '' +
      '<svg class="' + (cls || 'logo__mark') + '" width="' + size + '" height="' + size + '" viewBox="0 0 48 48" role="img" aria-label="Mobile Parts Finder">' +
      '<defs>' +
      '<linearGradient id="' + uid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0%" stop-color="#0F766E"/><stop offset="55%" stop-color="#12A08C"/><stop offset="100%" stop-color="#10D0A8"/>' +
      '</linearGradient>' +
      '<linearGradient id="' + uid + 'b" x1="0" y1="1" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#FF8A3D"/><stop offset="100%" stop-color="#FFC46B"/>' +
      '</linearGradient>' +
      '</defs>' +
      '<rect width="48" height="48" rx="14" fill="url(#' + uid + ')"/>' +
      /* lens glass */
      '<circle cx="20.5" cy="20.5" r="11.6" fill="#fff" fill-opacity=".18"/>' +
      /* the part being found */
      '<rect x="16.6" y="13.2" width="7.8" height="14.6" rx="2.2" fill="url(#' + uid + 'b)"/>' +
      '<path d="M18.5 15.4h4" stroke="#8A4A12" stroke-opacity=".55" stroke-width="1.1" stroke-linecap="round"/>' +
      /* lens ring + handle */
      '<circle cx="20.5" cy="20.5" r="11.6" fill="none" stroke="#fff" stroke-width="3.2"/>' +
      '<path d="M29.4 29.4 37 37" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>' +
      '</svg>';
  };

  /* Two-letter monogram on the brand's own gradient. Previously Apple used the
     U+F8FF private-use glyph, which renders as a blank box off Apple platforms. */
  /* ------------------------------------------------------------ brand marks
     ONE resolution path for every brand mark on the site, in priority order:

       1. a licensed file the owner registered   SM.art.registerBrand(id, url)
       2. the inlined official vector mark       SM.brandMarks (CC0, bundled)
       3. a typeset wordmark                     no official mark exists

     Every call site goes through here — the brand rail, the finder panel, the
     models grid, the search dropdown — so a brand looks the same everywhere and
     a newly registered logo appears in all of them at once. SM.art.brand()
     delegates to this rather than duplicating the order.

     The wordmark is reached ONLY for a brand with no official mark, never as a
     stand-in for one that failed to load: a wrong logo is worse than a name. */
  SM.brandFiles = SM.brandFiles || {};

  /* HTML-escape. Brand names are catalogue data, and a name with an ampersand
     in it must not be able to close an attribute. */
  function be(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* The chip's paint job, decided once in src/data/brand-assets.js and applied
     here as a class plus one custom property. Every treatment is defined for
     BOTH themes in assets/styles.css, so a logo can never come out invisible in
     one of them. `--bmk` is the brand's own official colour and is the only
     value the three treatments are derived from. */
  function chipAttrs(brand, kind, klass) {
    var A = SM.brandAssets;
    var mode = A ? A.mode(brand.id) : 'tint';
    var hex = A ? A.hex(brand) : String(brand.color || '#0E7A6C').replace(/^#/, '');
    return {
      cls: 'blogo blogo--' + kind + ' blogo--' + mode + (klass ? ' ' + klass : ''),
      style: '--bmk:#' + hex
    };
  }

  SM.brandLogo = function (brand, cls) {
    var b = brand || {};
    var name = String(b.name || '');
    var klass = cls || '';

    var file = SM.brandFiles[b.id];
    if (file) {
      /* The id and class ride on the element rather than being interpolated
         into the handler — nesting quotes inside an inline onerror is how you
         ship a broken attribute that only fails when the image 404s. */
      var a = chipAttrs(b, 'img', klass);
      return '<span class="' + a.cls + '" style="' + a.style + '">' +
        '<img src="' + be(file) + '" alt="' + be(name) + '" loading="lazy" decoding="async" ' +
        'data-brand="' + be(b.id) + '" data-cls="' + be(klass) + '" ' +
        'onerror="SM.brandImgFailed(this)" /></span>';
    }

    var mark = SM.brandMarks && SM.brandMarks[b.id];
    if (mark) {
      /* No width/height on the <svg>: the CSS box is the bounding box, and the
         default preserveAspectRatio="xMidYMid meet" contains the mark inside it.
         A wide mark stays wide, a square one stays square, and nothing is ever
         stretched to fill. `fill` comes from the treatment, not from the path,
         so the same vector reads correctly in both themes. */
      var m = chipAttrs(b, 'mark', klass);
      return '<span class="' + m.cls + '" style="' + m.style + '">' +
        '<svg viewBox="0 0 24 24" role="img" aria-label="' + be(name) + '">' +
        '<path d="' + mark.p + '"/></svg></span>';
    }

    return SM.brandWordmark(b, klass);
  };

  /* A registered logo file failed to load. Fall back to the wordmark rather
     than leaving a broken image — but keep it out of the mark registry, so a
     transient network failure does not permanently demote the brand.

     A brand whose file came from Firebase Storage gets one retry against the
     copy deployed with the site before it gives up: that is the SAME logo, so
     a slow bucket costs a request, not a downgrade. */
  SM.brandImgFailed = function (img) {
    var id = img.getAttribute('data-brand');
    var cls = img.getAttribute('data-cls') || '';
    var fb = SM.brandFileFallbacks && SM.brandFileFallbacks[id];
    if (fb && !img.dataset.fb && img.getAttribute('src') !== fb) {
      img.dataset.fb = '1';
      img.src = fb;
      return;
    }
    var brand = (SM.db && SM.db.brandById && SM.db.brandById[id]) || { id: id, name: id };
    var span = img.parentNode;
    if (span && span.parentNode) span.outerHTML = SM.brandWordmark(brand, cls);
  };

  /* A brand's actual name, set as a proper wordmark — not a two-letter monogram,
     which reads as a logo we invented, and not 8px of body text, which reads as
     a bug. Several of these brands' real logos ARE wordmarks, so a well-set name
     in the brand's own colour is an honest representation rather than a
     stand-in for artwork we do not have.

     Drawn as SVG text rather than HTML so it behaves exactly like a vector mark:
     the viewBox is sized to the name, the browser scales it to the chip's
     bounding box, and it is therefore as large as the box allows at every size
     the chip is used at — 28px in a dropdown, 56px on a model card — with no
     per-size font-size table to keep in step. */
  SM.brandWordmark = function (brand, cls) {
    var b = brand || {};
    var name = String(b.name || '');
    if (!name) return '';

    /* Advance width per character in the display face at font-size 26, bold and
       slightly tightened. Only an estimate — textLength pins the final width
       exactly, so an estimate a little out costs a hair of tracking, not a
       clipped or floating wordmark. */
    var W = Math.max(30, Math.round(name.length * 15.4));
    var a = chipAttrs(b, 'word', cls || '');
    return '<span class="' + a.cls + '" style="' + a.style + '" title="' + be(name) + '">' +
      '<svg viewBox="0 0 ' + W + ' 34" role="img" aria-label="' + be(name) + '">' +
      '<text x="' + (W / 2) + '" y="26" text-anchor="middle" ' +
      'textLength="' + (W - 4) + '" lengthAdjust="spacingAndGlyphs">' + be(name) + '</text>' +
      '</svg></span>';
  };
})(window);
