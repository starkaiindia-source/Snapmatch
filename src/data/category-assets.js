/* ============================================================================
   Mobile Parts Finder · category-assets.js — the official category logos
   ----------------------------------------------------------------------------
   GENERATED. Do not edit by hand.

       python scripts/build-category-assets.py --src "<folder of masters>"
       node scripts/upload-category-assets.js --project mobilepartsfinder

   ONE MAPPING, EVERY SURFACE

     Category logos are resolved here and nowhere else. Registering them into
     SM.art means every existing call site — the finder rail, the category
     tiles, group cards, group sheets, category headers, search results — shows
     the same official picture for the same category, because they all already
     go through SM.art.category(). No component picks its own icon.

   ALIASES

     The same category is spelled several ways across the source data and the
     SEO pages: "screen-guards", "screen guard", "tempered glass". They all
     resolve to one asset, so a naming variation can never produce a different
     logo for the same part.

   TWO URLS PER CATEGORY, AND WHY

     storage  Firebase Storage — the system of record, and what the site loads.
     bundled  the identical file deployed with the site.

     The bundled copy is the fallback, and it is the SAME OFFICIAL LOGO, not a
     generic stand-in. If Storage is slow, blocked or misconfigured the category
     still shows its own picture rather than a drawn icon that means something
     else.

   Generated 2026-09-04T19:53:23.052Z
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var ASSETS = {
    'screen-guards': {
      label: "Screen Guards",
      storage: "https://firebasestorage.googleapis.com/v0/b/mobilepartsfinder.firebasestorage.app/o/category-assets%2Fscreen-guards%2Flogo-256.png?alt=media",
      bundled: "/assets/categories/screen-guards.png",
      focus: { iw: 1.2516, il: -0.1258, it: 0.0417 }
    },
    'back-cover': {
      label: "Back Cover",
      storage: "https://firebasestorage.googleapis.com/v0/b/mobilepartsfinder.firebasestorage.app/o/category-assets%2Fback-cover%2Flogo-256.png?alt=media",
      bundled: "/assets/categories/back-cover.png",
      focus: { iw: 1.3174, il: -0.1484, it: 0.0214 }
    },
    'combo-display': {
      label: "Combo/Display",
      storage: "https://firebasestorage.googleapis.com/v0/b/mobilepartsfinder.firebasestorage.app/o/category-assets%2Fcombo-display%2Flogo-256.png?alt=media",
      bundled: "/assets/categories/combo-display.png",
      focus: { iw: 1.221, il: -0.1105, it: 0.0457 }
    },
    'middle-frame': {
      label: "Middle Frame",
      storage: "https://firebasestorage.googleapis.com/v0/b/mobilepartsfinder.firebasestorage.app/o/category-assets%2Fmiddle-frame%2Flogo-256.png?alt=media",
      bundled: "/assets/categories/middle-frame.png",
      focus: { iw: 1.2412, il: -0.1182, it: 0.0345 }
    },
    'cc-board': {
      label: "CC Board",
      storage: "https://firebasestorage.googleapis.com/v0/b/mobilepartsfinder.firebasestorage.app/o/category-assets%2Fcc-board%2Flogo-256.png?alt=media",
      bundled: "/assets/categories/cc-board.png",
      focus: { iw: 1.0478, il: -0.0219, it: 0.1853 }
    },
    'battery': {
      label: "Battery",
      storage: "https://firebasestorage.googleapis.com/v0/b/mobilepartsfinder.firebasestorage.app/o/category-assets%2Fbattery%2Flogo-256.png?alt=media",
      bundled: "/assets/categories/battery.png",
      focus: { iw: 1.2947, il: -0.1448, it: 0.0183 }
    }
  };

  /* Spellings that mean the same category. The app's own ids are the keys of
     ASSETS above; these are the variants that appear in source data, URLs and
     copy. Normalised the same way on both sides, so case and punctuation do not
     matter. */
  var ALIASES = {
    'screen-guards': ['screen', 'screens', 'screen guard', 'screen guards', 'screenguard',
                      'tempered glass', 'temperedglass', 'glass', 'universal tempered glass',
                      'sg'],
    'back-cover':    ['back cover', 'backcover', 'cover', 'universal back cover', 'bc'],
    'combo-display': ['combo display', 'combodisplay', 'combo/display', 'display', 'combo',
                      'folder', 'lcd', 'cd'],
    'middle-frame':  ['middle frame', 'middleframe', 'frame', 'mid frame', 'mf'],
    'cc-board':      ['cc board', 'ccboard', 'charging board', 'charging connector board',
                      'connector board', 'cc'],
    'battery':       ['battery', 'batteries', 'bt']
  };

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  var LOOKUP = Object.create(null);
  Object.keys(ASSETS).forEach(function (id) {
    LOOKUP[norm(id)] = id;
    LOOKUP[norm(ASSETS[id].label)] = id;
    (ALIASES[id] || []).forEach(function (a) { LOOKUP[norm(a)] = id; });
  });

  SM.categoryAssets = {
    /** Canonical category id for any spelling, or null. */
    resolve: function (nameOrId) {
      return LOOKUP[norm(nameOrId)] || null;
    },

    /** { storage, bundled, label, focus } for a category, or null. */
    get: function (nameOrId) {
      var id = this.resolve(nameOrId);
      return id ? ASSETS[id] : null;
    },

    /**
     * Where the PART sits inside its canvas, as CSS custom properties.
     *
     * The masters are square canvases with the part standing in a lot of
     * white — a back cover is 45% of its own picture. `object-fit: contain`
     * fits the CANVAS, so the part renders at 45% of the tile however large
     * the tile is; enlarging the card alone cannot change that. These three
     * numbers scale and offset the image so the PART fills the tile instead,
     * with the width set and the height left auto so it cannot be distorted.
     *
     * Measured by scripts/build-category-focus.py for the tile's aspect
     * ratio. Only .pthumb--tile consumes them, so every other surface keeps
     * plain contain behaviour.
     */
    focusVars: function (nameOrId) {
      var e = this.get(nameOrId);
      var f = e && e.focus;
      if (!f) return '';
      return '--iw:' + (f.iw * 100) + '%;--il:' + (f.il * 100) + '%;--it:' + (f.it * 100) + '%';
    },

    /** Every category that has an official logo. */
    ids: function () { return Object.keys(ASSETS); },

    /**
     * Registers every logo with SM.art, which is what the whole UI already
     * calls. One call, and every surface is correct at once.
     */
    install: function () {
      if (!SM.art || !SM.art.registerCategory) return false;
      Object.keys(ASSETS).forEach(function (id) {
        SM.art.registerCategory(id, ASSETS[id].storage, ASSETS[id].bundled);
      });
      return true;
    }
  };
})(window);
