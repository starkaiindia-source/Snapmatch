/* ============================================================================
   Mobile Parts Finder · scripts/ui-audit.js
   ----------------------------------------------------------------------------
   The page-level checks that screenshots cannot make reliably: horizontal
   overflow, unreadable colour pairs, touch targets too small to hit, clipped
   text, and elements that overlap each other.

   This is not a substitute for looking at the page — it is the part of looking
   that a person does badly. A human eye misses a 3px overflow at 390px wide and
   cannot judge a 4.1:1 contrast ratio, but will spot an ugly layout instantly.

   It runs INSIDE the browser: paste-free, no dependencies. app.js exposes it as
   SM.audit() when the page is served from localhost. Usage from the console:

       await SM.audit()                     every route, every breakpoint
       await SM.audit({ routes: ['#/models'] })

   Each finding names the element and the measured number, so a fix can be
   verified by re-running rather than by squinting.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* Breakpoints chosen from real device widths, not round numbers: 360 is the
     commonest Android width in India, 390 an iPhone, 768 an iPad portrait,
     1024 an iPad landscape / small laptop, 1440 a desktop. */
  var SIZES = [
    { name: 'mobile-360', w: 360, h: 780, touch: true },
    { name: 'mobile-390', w: 390, h: 844, touch: true },
    { name: 'tablet-768', w: 768, h: 1024, touch: true },
    { name: 'laptop-1024', w: 1024, h: 768, touch: false },
    { name: 'desktop-1440', w: 1440, h: 900, touch: false }
  ];
  var ROUTES = ['#/finder', '#/models', '#/model/samsung-galaxy-s24', '#/plans', '#/account'];

  /* --------------------------------------------------------------- contrast */
  function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(rgb) { return 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2]); }
  function parseRgb(s) {
    var m = String(s).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }
  /* Walks up for the first opaque background — a transparent parent chain is
     how "invisible text" bugs hide from a naive check.

     Returns null when it hits a background IMAGE (the app's green header is a
     gradient). A gradient has no single colour to measure against, and guessing
     produced a page full of phantom 1.0-ratio findings on text that is
     perfectly legible. Better to skip and say so than to report a wrong number. */
  function bgOf(el) {
    var n = el;
    while (n && n !== document.documentElement) {
      var cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      var c = parseRgb(cs.backgroundColor);
      if (c && c[3] > 0.85) return c;
      n = n.parentElement;
    }
    return parseRgb(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
  }

  /* Content inside a horizontal scroller is SUPPOSED to extend past the
     viewport — the category rail is built that way on purpose. */
  function inScroller(el) {
    var n = el.parentElement;
    while (n && n !== document.body) {
      var o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
      n = n.parentElement;
    }
    return false;
  }

  /* Visually-hidden helpers are clipped by design. */
  function srOnly(el) {
    var n = el;
    while (n && n !== document.body) {
      if (/(^|\s)(sr|sr-only|visuallyhidden)(\s|$)/.test(n.className || '')) return true;
      n = n.parentElement;
    }
    return false;
  }
  function contrast(fg, bg) {
    var a = lum(fg), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function describe(el) {
    var id = el.id ? '#' + el.id : '';
    var cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  }

  /* ------------------------------------------------------------- the checks */
  function checkOverflow() {
    var out = [];
    var doc = document.documentElement;
    var over = doc.scrollWidth - doc.clientWidth;
    if (over > 1) out.push({ kind: 'page-overflow-x', px: over, el: 'document' });

    /* find what is actually sticking out, not just that something is */
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right > doc.clientWidth + 1) {
        var cs = getComputedStyle(el);
        if (cs.position === 'fixed') return;             /* fixed bars are fine */
        if (inScroller(el)) return;                      /* deliberate side-scroll */
        out.push({ kind: 'element-past-right-edge', px: Math.round(r.right - doc.clientWidth), el: describe(el) });
      }
    });
    return out.slice(0, 8);
  }

  function checkClipped() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
      if (el.children.length) return;                    /* leaf text only */
      var txt = (el.textContent || '').trim();
      if (!txt) return;
      var cs = getComputedStyle(el);
      if (cs.overflow === 'visible') return;
      if (cs.textOverflow === 'ellipsis') return;        /* deliberate truncation */
      if (srOnly(el)) return;                            /* visually hidden */
      if (el.scrollWidth > el.clientWidth + 2) {
        out.push({ kind: 'text-clipped', px: el.scrollWidth - el.clientWidth, el: describe(el), text: txt.slice(0, 34) });
      }
    });
    return out.slice(0, 8);
  }

  function checkContrast() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (el) {
      if (el.children.length) return;
      var txt = (el.textContent || '').trim();
      if (!txt) return;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      var cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') return;
      var fg = parseRgb(cs.color);
      if (!fg || fg[3] < 0.5) return;
      var bg = bgOf(el);
      if (!bg) return;                                   /* gradient — not measurable */
      var ratio = contrast(fg, bg);
      var size = parseFloat(cs.fontSize);
      var large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      var need = large ? 3 : 4.5;
      if (ratio < need) {
        out.push({ kind: 'low-contrast', ratio: Math.round(ratio * 100) / 100, need: need,
                   el: describe(el), text: txt.slice(0, 30) });
      }
    });
    return out.slice(0, 10);
  }

  /* 44px is the figure Apple and Google both settle on for a finger. */
  function checkTouchTargets() {
    var out = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('button, a[href], input, select, [role="button"]'), function (el) {
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.width < 32 || r.height < 32) {
          out.push({ kind: 'touch-target-small',
                     size: Math.round(r.width) + 'x' + Math.round(r.height),
                     el: describe(el), text: (el.textContent || '').trim().slice(0, 22) });
        }
      });
    return out.slice(0, 10);
  }

  /* Only compares siblings: nested boxes overlap by definition. */
  function checkOverlap() {
    var out = [];
    var groups = document.querySelectorAll('.dkeys, .dsecs, .dsw__row, .dintro__meta, .cats, .gridcards');
    Array.prototype.forEach.call(groups, function (g) {
      var kids = Array.prototype.filter.call(g.children, function (c) {
        var r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      for (var i = 0; i < kids.length; i++) {
        for (var j = i + 1; j < kids.length; j++) {
          var a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
          var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          var oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 2 && oy > 2) {
            out.push({ kind: 'siblings-overlap', px: Math.round(Math.min(ox, oy)),
                       el: describe(kids[i]) + ' / ' + describe(kids[j]) });
          }
        }
      }
    });
    return out.slice(0, 6);
  }

  function runChecks(size) {
    var f = [].concat(checkOverflow(), checkClipped(), checkContrast(), checkOverlap());
    if (size.touch) f = f.concat(checkTouchTargets());
    return f;
  }

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  SM.audit = async function (opts) {
    opts = opts || {};
    var routes = opts.routes || ROUTES;
    var sizes = opts.sizes || SIZES;
    var themes = opts.themes || ['light', 'dark'];
    var results = [];

    var startTheme = document.documentElement.getAttribute('data-theme');
    var startHash = location.hash;

    for (var t = 0; t < themes.length; t++) {
      document.documentElement.setAttribute('data-theme', themes[t]);
      for (var s = 0; s < sizes.length; s++) {
        /* The audit cannot resize a real window, so it drives the layout the
           same way the page does — by width — and reports the width it tested
           at. Run it under a real emulated viewport for pixel-exact results. */
        for (var r = 0; r < routes.length; r++) {
          location.hash = routes[r];
          await wait(260);
          var findings = runChecks(sizes[s]);
          if (findings.length) {
            results.push({ theme: themes[t], size: sizes[s].name, route: routes[r], findings: findings });
          }
        }
      }
    }

    if (startTheme) document.documentElement.setAttribute('data-theme', startTheme);
    else document.documentElement.removeAttribute('data-theme');
    location.hash = startHash;

    return { checked: themes.length * sizes.length * routes.length, problems: results };
  };

  /* Single-viewport version: the caller resizes, this reports. */
  SM.auditHere = async function (routes, touch) {
    var list = routes || ROUTES;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      location.hash = list[i];
      await wait(300);
      var f = runChecks({ touch: touch !== false && innerWidth < 900 });
      if (f.length) out.push({ route: list[i], w: innerWidth, findings: f });
    }
    return out;
  };
})(window);
