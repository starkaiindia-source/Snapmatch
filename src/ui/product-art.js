/* ============================================================================
   Mobile Parts Finder · product-art.js
   ----------------------------------------------------------------------------
   ONE centralised visual mapping, reused everywhere a category or a brand is
   shown. Nothing else hardcodes an image path.

       categoryId  ->  product render   SM.art.category('battery')
       brandId     ->  brand logo       SM.art.brand(brand)

   Category renders are drawn as vector product cutouts (transparent ground,
   soft shading) and mounted once as an SVG sprite, so a card only costs a
   <use> reference. Swapping in photographed renders later means registering a
   path in SM.art.registerCategory — no component changes.

   Brand logos: SM.art.registerBrand(id, url) points a brand at a real logo
   file; until one is registered the existing monogram chip is used. No
   trademarked artwork is redrawn or approximated here.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ------------------------------------------------------------- gradients */
  var DEFS =
    '<linearGradient id="agGlass" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#EAF6FB"/><stop offset="45%" stop-color="#CFE6F0"/>' +
    '<stop offset="100%" stop-color="#EDF7FA"/></linearGradient>' +

    '<linearGradient id="agShine" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#fff" stop-opacity=".9"/>' +
    '<stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient>' +

    '<linearGradient id="agCover" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#3F5B7A"/><stop offset="52%" stop-color="#22364C"/>' +
    '<stop offset="100%" stop-color="#4A6786"/></linearGradient>' +

    '<linearGradient id="agScreen" x1="0" y1="0" x2="0.6" y2="1">' +
    '<stop offset="0%" stop-color="#1B2733"/><stop offset="55%" stop-color="#0C1219"/>' +
    '<stop offset="100%" stop-color="#16212C"/></linearGradient>' +

    '<linearGradient id="agGlow" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#4EC8F5" stop-opacity=".55"/>' +
    '<stop offset="60%" stop-color="#1E6FA8" stop-opacity=".12"/>' +
    '<stop offset="100%" stop-color="#0B1219" stop-opacity="0"/></linearGradient>' +

    /* black li-ion pouch, matching a real replacement cell */
    '<linearGradient id="agCell" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#12181D"/><stop offset="18%" stop-color="#39434B"/>' +
    '<stop offset="45%" stop-color="#1B2228"/><stop offset="100%" stop-color="#0C1114"/></linearGradient>' +

    '<linearGradient id="agMetal" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#D7DEE4"/><stop offset="40%" stop-color="#98A6B2"/>' +
    '<stop offset="70%" stop-color="#C9D3DA"/><stop offset="100%" stop-color="#8B99A6"/></linearGradient>' +

    /* dark matte PCB with gold pads, as on real charging / CC boards */
    '<linearGradient id="agPcb" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#25292E"/><stop offset="55%" stop-color="#14181C"/>' +
    '<stop offset="100%" stop-color="#22272C"/></linearGradient>' +

    '<linearGradient id="agGold" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#F2D188"/><stop offset="100%" stop-color="#C79A3C"/></linearGradient>' +

    '<linearGradient id="agKapton" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#F5A65A"/><stop offset="100%" stop-color="#D97A25"/></linearGradient>' +

    '<radialGradient id="agShadow" cx="0.5" cy="0.5" r="0.5">' +
    '<stop offset="0%" stop-color="#0A1512" stop-opacity=".30"/>' +
    '<stop offset="100%" stop-color="#0A1512" stop-opacity="0"/></radialGradient>';

  var SHADOW = '<ellipse cx="24" cy="43.6" rx="15" ry="2.6" fill="url(#agShadow)"/>';

  /* --------------------------------------------------------------- symbols */
  /* Every symbol is a 48×48 product cutout on a transparent ground. */
  var SYMBOLS = {

    /* two screen-protector sheets, fanned and tilted, with a heavy glossy
       edge and a bright sweep — reads as glass, not as a phone */
    'tempered-glass':
      SHADOW +
      '<g transform="rotate(-15 24 24)">' +
      '<rect x="9.5" y="8" width="19" height="32" rx="3" fill="#CFE2EA" stroke="#8FA7B3" stroke-width="1.2" opacity=".75"/>' +
      '<rect x="16" y="6" width="20" height="34" rx="3.2" fill="url(#agGlass)" stroke="#161C22" stroke-width="2.3"/>' +
      '<rect x="18.4" y="8.4" width="15.2" height="29.2" rx="1.8" fill="#fff" fill-opacity=".5"/>' +
      '<circle cx="26" cy="11.4" r="1.7" fill="#141A20" fill-opacity=".62"/>' +
      '<path d="M19 36.6 32.4 10.2h3L22 36.6Z" fill="#fff" fill-opacity=".85"/>' +
      '<path d="M16.9 30.6 23.4 17.6" stroke="#fff" stroke-opacity=".95" stroke-width="1.7" stroke-linecap="round"/>' +
      '</g>',

    /* moulded shell seen at an angle: visible side wall gives it depth, and
       the oversized camera island identifies it instantly */
    'back-cover':
      SHADOW +
      '<g transform="rotate(-12 24 24)">' +
      '<path d="M33 7.5c2 0 3.4 1.5 3.4 3.4v26.6c0 1.9-1.4 3.4-3.4 3.4l3.6-2.4c1-.7 1.6-1.7 1.6-3V12.4c0-1.2-.6-2.3-1.6-3Z" fill="#16222E"/>' +
      '<rect x="13" y="7.5" width="20.4" height="33.4" rx="4.4" fill="url(#agCover)"/>' +
      '<rect x="14.4" y="8.9" width="17.6" height="30.6" rx="3.4" fill="#fff" fill-opacity=".08"/>' +
      '<rect x="15.8" y="10.6" width="12.6" height="14.4" rx="3.4" fill="#0E1720"/>' +
      '<circle cx="19.9" cy="14.6" r="2.7" fill="#05090D"/><circle cx="19.9" cy="14" r="1.15" fill="#4E86AE"/>' +
      '<circle cx="19.9" cy="21" r="2.7" fill="#05090D"/><circle cx="19.9" cy="20.4" r="1.15" fill="#4E86AE"/>' +
      '<circle cx="25.2" cy="17.8" r="1.7" fill="#05090D"/>' +
      '<rect x="24.4" y="11.6" width="2.4" height="2.4" rx="1.2" fill="#F5E2AE"/>' +
      '<path d="M14.9 12.4v24" stroke="#fff" stroke-opacity=".32" stroke-width="1.2" stroke-linecap="round"/>' +
      '</g>',

    /* display assembly: the large kapton flex ribbon folding out of the panel
       is the identifying feature, so it gets real size here */
    'combo-display':
      SHADOW +
      '<path d="M30 28c5.6.6 9.4 3 11.4 7.2.7 1.5.2 2.9-1.3 3.5-1.5.6-2.8 0-3.6-1.5-1.3-2.5-3.6-3.9-7-4.2Z" fill="url(#agKapton)"/>' +
      '<rect x="36.8" y="35.4" width="6.6" height="4.4" rx="1.2" fill="#8C4E12"/>' +
      '<path d="M38.2 36.6v2M39.8 36.6v2M41.4 36.6v2" stroke="#F3C68C" stroke-width=".8" stroke-linecap="round"/>' +
      '<g transform="rotate(-8 24 24)">' +
      '<rect x="9" y="5" width="24" height="35" rx="3.2" fill="url(#agScreen)"/>' +
      '<rect x="10.6" y="6.6" width="20.8" height="31.8" rx="2" fill="#04070B"/>' +
      '<rect x="10.6" y="6.6" width="20.8" height="31.8" rx="2" fill="url(#agGlow)"/>' +
      '<circle cx="21" cy="10" r="1.4" fill="#04070A"/>' +
      '<path d="M11.8 35 17.6 8" stroke="#fff" stroke-opacity=".2" stroke-width="2.6" stroke-linecap="round"/>' +
      '</g>',

    /* pouch cell with an unmistakable 3-pin connector on a kapton tab */
    'battery':
      SHADOW +
      '<g transform="rotate(-10 24 24)">' +
      '<path d="M27 8.6h5.6a1.4 1.4 0 0 1 1.4 1.4v2.6h-7Z" fill="url(#agKapton)"/>' +
      '<rect x="30.4" y="5.2" width="8" height="5.2" rx="1.3" fill="#F2F6F8" stroke="#8C9BA7" stroke-width=".8"/>' +
      '<path d="M32.2 6.6v2.4M34.4 6.6v2.4M36.6 6.6v2.4" stroke="#6B7C89" stroke-width="1" stroke-linecap="round"/>' +
      '<rect x="10.6" y="11" width="22" height="29.4" rx="2.4" fill="url(#agCell)" stroke="#05080A" stroke-width=".9"/>' +
      '<path d="M13.4 19.6h16.6" stroke="#8A97A1" stroke-opacity=".7" stroke-width=".9"/>' +
      '<path d="M13.4 16h11.6M13.4 23.4h16M13.4 26.2h13.4M13.4 29h8.6" stroke="#E3EAEF" stroke-opacity=".8" stroke-width="1.1" stroke-linecap="round"/>' +
      '<path d="M12.4 13.2v25" stroke="#fff" stroke-opacity=".35" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>',

    /* chassis: a genuinely hollow machined frame — the open middle is what
       separates it from a solid phone shape */
    'middle-frame':
      SHADOW +
      '<g transform="rotate(-12 24 24)">' +
      '<path d="M14.4 5.4h19.2a3.2 3.2 0 0 1 3.2 3.2v30.8a3.2 3.2 0 0 1-3.2 3.2H14.4a3.2 3.2 0 0 1-3.2-3.2V8.6a3.2 3.2 0 0 1 3.2-3.2Zm.8 5a1.2 1.2 0 0 0-1.2 1.2v25a1.2 1.2 0 0 0 1.2 1.2h17.6a1.2 1.2 0 0 0 1.2-1.2v-25a1.2 1.2 0 0 0-1.2-1.2Z" fill="url(#agMetal)" fill-rule="evenodd" stroke="#6F7E8A" stroke-width=".7" stroke-linejoin="round"/>' +
      '<rect x="14" y="19.6" width="20" height="2" rx="1" fill="url(#agMetal)" stroke="#7A8894" stroke-width=".4"/>' +
      '<rect x="14" y="28.4" width="20" height="2" rx="1" fill="url(#agMetal)" stroke="#7A8894" stroke-width=".4"/>' +
      '<rect x="36.6" y="14" width="2.2" height="5" rx="1.1" fill="#8A98A4"/>' +
      '<rect x="36.6" y="21" width="2.2" height="8" rx="1.1" fill="#8A98A4"/>' +
      '<rect x="9.2" y="16" width="2.2" height="6" rx="1.1" fill="#8A98A4"/>' +
      '<path d="M12.6 9.6v29" stroke="#fff" stroke-opacity=".7" stroke-width="1.2" stroke-linecap="round"/>' +
      '</g>',

    /* CC board: small PCB, IC, gold contact pads */
    'cc-board':
      SHADOW +
      '<rect x="7.5" y="14" width="33" height="20.4" rx="2.2" fill="url(#agPcb)"/>' +
      '<rect x="8.9" y="15.4" width="30.2" height="17.6" rx="1.6" fill="#fff" fill-opacity=".07"/>' +
      '<rect x="17.4" y="18.6" width="13.4" height="9.6" rx="1.2" fill="#1B2026"/>' +
      '<rect x="19" y="20.2" width="10.2" height="3" rx=".6" fill="#3A434C"/>' +
      '<path d="M17.4 21.2h-2.6M17.4 23.6h-2.6M17.4 26h-2.6M30.8 21.2h2.6M30.8 23.6h2.6M30.8 26h2.6" stroke="#C9CFD5" stroke-width=".9" stroke-linecap="round"/>' +
      '<rect x="11" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="16" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="21" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="26" y="30.4" width="3.4" height="3.6" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="33.4" y="17" width="4" height="2.6" rx=".6" fill="#D8C089"/>' +
      '<circle cx="12.6" cy="18.6" r="1.5" fill="#0E1F18"/>',

    /* charging board: PCB strip with USB-C receptacle */
    'charging-board':
      SHADOW +
      '<rect x="9" y="11.5" width="30" height="25" rx="2.2" fill="url(#agPcb)"/>' +
      '<rect x="10.4" y="12.9" width="27.2" height="22.2" rx="1.6" fill="#fff" fill-opacity=".07"/>' +
      '<rect x="16.6" y="27.8" width="14.8" height="6.4" rx="3.2" fill="url(#agMetal)" stroke="#6E7E8B" stroke-width=".7"/>' +
      '<rect x="19" y="29.9" width="10" height="2.2" rx="1.1" fill="#2B343C"/>' +
      '<rect x="12.4" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="17.2" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="22" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="26.8" y="13.8" width="3.2" height="3.4" rx=".5" fill="url(#agGold)"/>' +
      '<rect x="13" y="20.4" width="8.6" height="4.4" rx="1" fill="#1B2026"/>' +
      '<circle cx="33.4" cy="22.6" r="2.4" fill="#0E1F18"/><circle cx="33.4" cy="22.6" r="1" fill="#4C5A63"/>' +
      '<circle cx="26.6" cy="21.6" r="1.4" fill="#8A5A24"/>',

    /* assorted spares: speaker, screw, flex cable */
    'spare-parts':
      SHADOW +
      '<path d="M9 33.6c5-6.4 12-9.4 20.4-8.6l.5 3.6c-7.2-.7-13 1.7-17.4 7.1Z" fill="url(#agKapton)"/>' +
      '<rect x="27.4" y="23.2" width="5.6" height="4" rx="1" fill="#8C4E12"/>' +
      '<rect x="7.5" y="8" width="18" height="12.4" rx="2" fill="#2B333B"/>' +
      '<rect x="9.2" y="9.7" width="14.6" height="9" rx="1.2" fill="#495661"/>' +
      '<path d="M11 12h11M11 14.2h11M11 16.4h11" stroke="#2B333B" stroke-width="1" stroke-linecap="round"/>' +
      '<circle cx="34.5" cy="13.5" r="6" fill="url(#agMetal)" stroke="#7B8994" stroke-width=".8"/>' +
      '<path d="M34.5 10.2v6.6M31.2 13.5h6.6" stroke="#5E6C77" stroke-width="1.5" stroke-linecap="round"/>' +
      '<circle cx="16.5" cy="33.5" r="4.6" fill="url(#agMetal)" stroke="#7B8994" stroke-width=".8"/>' +
      '<circle cx="16.5" cy="33.5" r="1.8" fill="#6E7C87"/>',

    /* all categories: a fanned collection — glass, cover, battery, board */
    'all':
      SHADOW +
      '<g transform="rotate(-26 24 24)">' +
      '<rect x="5.5" y="10" width="15" height="26" rx="2.6" fill="url(#agGlass)" stroke="#161C22" stroke-width="1.7"/>' +
      '<path d="M8 32.6 16.4 13.4" stroke="#fff" stroke-opacity=".9" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g>' +
      '<g transform="rotate(-7 24 24)">' +
      '<rect x="14.6" y="7" width="15.4" height="27" rx="3.2" fill="url(#agCover)"/>' +
      '<rect x="16.4" y="9" width="7.6" height="9.4" rx="2.2" fill="#0E1720"/>' +
      '<circle cx="18.8" cy="11.6" r="1.6" fill="#05090D"/><circle cx="18.8" cy="15.6" r="1.6" fill="#05090D"/>' +
      '</g>' +
      '<g transform="rotate(13 24 24)">' +
      '<rect x="25.6" y="9.4" width="13.6" height="23" rx="2" fill="url(#agCell)" stroke="#748796" stroke-width=".8"/>' +
      '<rect x="27.2" y="16.6" width="10.4" height="8" rx="1.1" fill="#123243" fill-opacity=".92"/>' +
      '<path d="M27.2 11.4v19" stroke="#fff" stroke-opacity=".8" stroke-width="1.3" stroke-linecap="round"/>' +
      '</g>' +
      '<g transform="rotate(9 24 24)">' +
      '<rect x="17" y="30.4" width="19" height="10.6" rx="1.8" fill="url(#agPcb)"/>' +
      '<rect x="22.6" y="33" width="8" height="5.2" rx="1" fill="#1B2026"/>' +
      '<rect x="18.6" y="38.4" width="2.8" height="2.2" rx=".4" fill="url(#agGold)"/>' +
      '<rect x="22.6" y="38.4" width="2.8" height="2.2" rx=".4" fill="url(#agGold)"/>' +
      '<rect x="26.6" y="38.4" width="2.8" height="2.2" rx=".4" fill="url(#agGold)"/>' +
      '</g>'
  };

  /* ------------------------------------------------------------- registries */
  var catImages = Object.create(null);   /* categoryId -> image url (optional) */
  var brandLogos = Object.create(null);  /* brandId    -> logo url  (optional) */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  SM.art = {
    /* inject the sprite once */
    mount: function () {
      if (document.getElementById('sm-art-sprite')) return;
      var svg = '<svg id="sm-art-sprite" aria-hidden="true" focusable="false" ' +
        'style="position:absolute;width:0;height:0;overflow:hidden"><defs>' + DEFS + '</defs>' +
        Object.keys(SYMBOLS).map(function (k) {
          return '<symbol id="art-' + k + '" viewBox="0 0 48 48">' + SYMBOLS[k] + '</symbol>';
        }).join('') + '</svg>';
      var holder = document.createElement('div');
      holder.innerHTML = svg;
      document.body.appendChild(holder.firstChild);
    },

    /* swap a drawn render for a photographed one, without touching components */
    registerCategory: function (id, url) { catImages[id] = url; },
    registerBrand: function (id, url) { SM.brandFiles[id] = url; },

    /* categoryId -> product render, wrapped in a light product thumbnail */
    category: function (categoryId, cls) {
      var id = SYMBOLS[categoryId] ? categoryId : (categoryId === 'all' ? 'all' : 'spare-parts');
      var inner = catImages[categoryId]
        ? '<img class="pimg" src="' + esc(catImages[categoryId]) + '" alt="" loading="lazy" ' +
          'onerror="this.replaceWith(SM.art.svgOnly(\'' + esc(id) + '\'))" />'
        : this.svgMarkup(id);
      return '<span class="pthumb ' + (cls || '') + '">' + inner + '</span>';
    },

    svgMarkup: function (id) {
      return '<svg class="pimg" viewBox="0 0 48 48" role="img" aria-hidden="true"><use href="#art-' + id + '"></use></svg>';
    },
    /* DOM node version used by the <img> onerror fallback */
    svgOnly: function (id) {
      var d = document.createElement('div');
      d.innerHTML = SM.art.svgMarkup(id);
      return d.firstChild;
    },

    /* Delegates to SM.brandLogo, which owns the file -> vector -> wordmark
       order. Kept as an alias because callers and docs already use it. */
    brand: function (brand, cls) { return SM.brandLogo(brand, cls); }
  };
})(window);
