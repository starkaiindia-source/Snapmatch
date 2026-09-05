/* ============================================================================
   Mobile Parts Finder · brand-assets.js — brand logo files and how they’re shown
   ----------------------------------------------------------------------------
   The brand twin of category-assets.js. One place decides, for every brand,
   WHICH picture is its logo and HOW that logo is presented. No component picks
   a colour, a background or a file path of its own.

   THREE TIERS, IN THIS ORDER  (resolved by SM.brandLogo in src/ui/icons.js)

     1. a licensed logo FILE        this file’s `storage`, else `bundled`
     2. the inlined official vector SM.brandMarks — CC0, zero requests
     3. a typeset wordmark          the brand’s own name, set properly

   Tier 2 is deliberately preferred over shipping the same artwork as a file:
   an inline vector costs no request, paints with the first frame and can be
   RECOLOURED per theme, which an <img> cannot. So `storage` is populated only
   where it adds something tier 2 cannot — a brand Simple Icons does not carry,
   or a licensed logo the owner wants to override a CC0 one with.

   FIREBASE STORAGE

     Objects live at  brand-assets/<brand-id>/logo.<ext>  in the project’s
     EXISTING bucket, alongside category-assets/. Public read, no client write —
     see storage.rules. Upload with:

         node scripts/upload-brand-assets.js --project mobilepartsfinder

     which fills in the `storage` URLs below. Until then a brand with no file
     simply falls through to tier 2 or tier 3 — never to a broken image.

   PRESENTATION  (`mode`)

     Brand colours are published against white, so painting them straight onto a
     dark page misrepresents the brand and sinks the dark marks. Rather than one
     white chip for everyone — which looks like a sticker sheet — each brand gets
     one of three treatments, and each treatment is defined for BOTH themes in
     assets/styles.css. Three, not twenty-two: a rail of saturated colour blocks
     is not a product, it is a bag of sweets.

       'tint'   pale wash of the brand’s own colour, mark in that colour.
                The default, and what most brands should be.
       'solid'  the brand colour fills the chip and the mark reverses to white.
                Reserved for identities that ARE a colour block.
       'mono'   neutral chip, mark in the theme’s ink. For monochrome
                identities, which would otherwise vanish in one theme or the
                other — a black Apple mark on a black page.

     The colour itself is never written here. It comes from the brand’s official
     hex in SM.brandMarks, or from the catalogue’s own brand colour when there is
     no mark — one source of truth either way.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* id: { storage, bundled, mode }
     `storage`  Firebase Storage URL, written by scripts/upload-brand-assets.js.
     `bundled`  the same file deployed with the site — the fallback if Storage
                is slow, blocked or misconfigured, so a brand never degrades to
                a broken image.
     Both null means: no licensed file yet, use the inline vector or wordmark. */
  var ASSETS = {
    apple:    { storage: null, bundled: null, mode: 'mono'  },
    asus:     { storage: null, bundled: null, mode: 'mono'  },
    coolpad:  { storage: null, bundled: null, mode: 'tint'  },
    google:   { storage: null, bundled: null, mode: 'tint'  },
    hmd:      { storage: null, bundled: null, mode: 'tint'  },
    honor:    { storage: null, bundled: null, mode: 'mono'  },
    huawei:   { storage: null, bundled: null, mode: 'solid' },
    infinix:  { storage: null, bundled: null, mode: 'tint'  },
    itel:     { storage: null, bundled: null, mode: 'tint'  },
    lava:     { storage: null, bundled: null, mode: 'tint'  },
    lenovo:   { storage: null, bundled: null, mode: 'tint'  },
    motorola: { storage: null, bundled: null, mode: 'tint'  },
    nokia:    { storage: null, bundled: null, mode: 'solid' },
    nothing:  { storage: null, bundled: null, mode: 'mono'  },
    oneplus:  { storage: null, bundled: null, mode: 'solid' },
    oppo:     { storage: null, bundled: null, mode: 'tint'  },
    realme:   { storage: null, bundled: null, mode: 'tint'  },
    samsung:  { storage: null, bundled: null, mode: 'tint'  },
    tecno:    { storage: null, bundled: null, mode: 'tint'  },
    vivo:     { storage: null, bundled: null, mode: 'tint'  },
    xiaomi:   { storage: null, bundled: null, mode: 'tint'  },
    zte:      { storage: null, bundled: null, mode: 'tint'  },

    /* shipped marks for brands the catalogue may carry again */
    sony:     { storage: null, bundled: null, mode: 'mono'  },
    lg:       { storage: null, bundled: null, mode: 'tint'  },
    htc:      { storage: null, bundled: null, mode: 'tint'  }
  };

  var DEFAULT_MODE = 'tint';

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  var LOOKUP = Object.create(null);
  Object.keys(ASSETS).forEach(function (id) { LOOKUP[norm(id)] = id; });

  SM.brandAssets = {
    /** Canonical brand id for any spelling, or null. */
    resolve: function (idOrName) {
      return LOOKUP[norm(idOrName)] || null;
    },

    /** { storage, bundled, mode } for a brand, or null when unknown. */
    get: function (idOrName) {
      var id = this.resolve(idOrName);
      return id ? ASSETS[id] : null;
    },

    /** How this brand’s chip is painted: 'tint' | 'solid' | 'mono'. */
    mode: function (idOrName) {
      var e = this.get(idOrName);
      return (e && e.mode) || DEFAULT_MODE;
    },

    /**
     * The brand’s own colour, as a hex WITHOUT the leading hash — the official
     * mark’s hex when there is a mark, else the catalogue’s brand colour. The
     * three treatments in assets/styles.css are all derived from this one
     * value, so a brand can never be half one colour and half another.
     */
    hex: function (brand) {
      var b = brand || {};
      var mark = SM.brandMarks && SM.brandMarks[b.id];
      if (mark && mark.h) return String(mark.h).replace(/^#/, '');
      return String(b.color || '#0E7A6C').replace(/^#/, '');
    },

    /** Every brand that has a licensed logo file to load. */
    withFile: function () {
      return Object.keys(ASSETS).filter(function (id) {
        return !!(ASSETS[id].storage || ASSETS[id].bundled);
      });
    },

    /**
     * Registers the licensed files with SM.art, which every logo call site
     * already goes through. Brands without a file are left alone so they keep
     * their inline vector — registering an <img> for artwork we already have
     * inline would trade a first-frame paint for a network request.
     */
    install: function () {
      if (!SM.art || !SM.art.registerBrand) return false;
      var n = 0;
      Object.keys(ASSETS).forEach(function (id) {
        var url = ASSETS[id].storage || ASSETS[id].bundled;
        if (!url) return;
        SM.art.registerBrand(id, url, ASSETS[id].bundled);
        n++;
      });
      return n;
    }
  };
})(window);
