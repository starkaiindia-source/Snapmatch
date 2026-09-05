/* ============================================================================
   Mobile Parts Finder · admin-ui.js — rendering helpers
   ----------------------------------------------------------------------------
   Formatting, escaping and the small building blocks every admin page shares.

   ----------------------------------------------------------------------------
   THE ONE RULE THAT MATTERS HERE: ABSENT IS ABSENT

   `text(null)` renders an em dash, not "N/A", not "Unknown", not a guess and
   never a plausible-looking default. A shop that has not given us their city
   has no city, and an admin looking at that row must be able to tell it apart
   from a shop whose city is genuinely blank — which is why the server sends
   null and this renders a dash rather than inventing a fallback.

   The same rule governs numbers. `count(null)` is a dash; `count(0)` is a
   bold zero. "We could not count this" and "this is zero" are different
   statements and the UI keeps them apart.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});
  var ADM = (SM.adm = SM.adm || {});

  var DASH = '—';

  /* Every value that reaches innerHTML goes through this. The admin area
     displays user-supplied text — shop names, proprietor names, search terms —
     and a shop called `<img onerror=...>` must render as those characters. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** A string, or an em dash when there is nothing. Always escaped. */
  function text(value) {
    if (value === null || value === undefined || value === '') {
      return '<span class="adm__none">' + DASH + '</span>';
    }
    return esc(value);
  }

  /**
   * A count.
   *
   * null means the server could not produce the figure; 0 means it counted
   * zero. Rendering both as "0" is the single easiest way to make a dashboard
   * lie, so they are drawn differently.
   */
  function count(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '<span class="adm__none">' + DASH + '</span>';
    }
    return Number(value).toLocaleString('en-IN');
  }

  /**
   * Paise to rupees.
   *
   * Everything server-side is paise, because that is what Razorpay charges in.
   * The conversion happens once, here, at the point of display.
   */
  function money(paise) {
    if (paise === null || paise === undefined || !Number.isFinite(Number(paise))) {
      return '<span class="adm__none">' + DASH + '</span>';
    }
    return '₹' + (Number(paise) / 100).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "14 Mar 2026". An epoch that is not one renders as a dash. */
  function date(ms) {
    if (!Number.isFinite(Number(ms))) return '<span class="adm__none">' + DASH + '</span>';
    var d = new Date(Number(ms));
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  /** "14 Mar 2026, 18:42" — for a timeline, where the hour matters. */
  function dateTime(ms) {
    if (!Number.isFinite(Number(ms))) return '<span class="adm__none">' + DASH + '</span>';
    var d = new Date(Number(ms));
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + hh + ':' + mm;
  }

  /** "3 days ago". Relative time is what "last active" is actually read as. */
  function ago(ms) {
    if (!Number.isFinite(Number(ms))) return '<span class="adm__none">' + DASH + '</span>';
    var seconds = Math.round((Date.now() - Number(ms)) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' hr ago';
    var days = Math.floor(seconds / 86400);
    if (days < 31) return days + (days === 1 ? ' day ago' : ' days ago');
    if (days < 365) return Math.floor(days / 30) + ' mo ago';
    return Math.floor(days / 365) + ' yr ago';
  }

  /** A coloured status pill. Unknown states render neutral rather than wrong. */
  var PILL_TONE = {
    active: 'ok', subscription_active: 'ok', profile_complete: 'ok',
    captured: 'ok', approved: 'ok', published: 'ok',
    expired: 'bad', failed: 'bad', cancelled: 'bad', disabled: 'bad',
    not_a_valid_model: 'bad', rejected: 'bad',
    pending: 'warn', profile_incomplete: 'warn', cancelling: 'warn',
    under_review: 'warn', researching: 'warn', draft: 'warn', pending_review: 'warn',
    new: 'info', draft_found: 'info', subscription_inactive: '', none: '', free: ''
  };

  function pill(value, label) {
    if (value === null || value === undefined || value === '') {
      return '<span class="adm__none">' + DASH + '</span>';
    }
    var tone = PILL_TONE[value];
    var cls = 'adm__pill' + (tone ? ' adm__pill--' + tone : '');
    return '<span class="' + cls + '">' + esc(label || String(value).replace(/_/g, ' ')) + '</span>';
  }

  /** Initials for an account with no picture. Never a generated avatar. */
  function avatar(user) {
    if (user.photoURL) {
      /* referrerpolicy: Google's picture URLs 403 when a referrer is sent from
         a host they do not expect, which is what turns every avatar into a
         broken image icon. */
      return '<img class="adm__avatar" src="' + esc(user.photoURL) + '" alt="" ' +
             'loading="lazy" referrerpolicy="no-referrer" />';
    }
    var source = user.mobileShopName || user.displayName || user.email || '?';
    var initials = String(source).trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w[0]; }).join('').toUpperCase();
    return '<div class="adm__avatar adm__avatar--txt">' + esc(initials || '?') + '</div>';
  }

  /** An empty state that says what is actually going on. */
  function emptyState(title, body) {
    return '<div class="adm__state"><b>' + esc(title) + '</b>' +
           (body ? '<p>' + esc(body) + '</p>' : '') + '</div>';
  }

  function banner(tone, html) {
    return '<div class="adm__banner adm__banner--' + tone + '">' + html + '</div>';
  }

  /** Placeholder rows while a table loads. */
  function skeletonRows(rows, cols) {
    var cells = new Array(cols).fill('<td><div class="adm__skel"></div></td>').join('');
    return new Array(rows).fill('<tr>' + cells + '</tr>').join('');
  }

  /**
   * A bar chart from a real series.
   *
   * An all-zero series draws a flat row of one-pixel bars, which is the honest
   * picture of a month with no signups. It does not draw a placeholder curve.
   */
  function barChart(points) {
    if (!points || !points.length) return emptyState('No data yet');

    var max = points.reduce(function (m, p) { return Math.max(m, Number(p.value) || 0); }, 0);
    var bars = points.map(function (p) {
      var value = Number(p.value) || 0;
      var height = max > 0 ? Math.round((value / max) * 100) : 0;
      return '<div style="height:' + Math.max(height, value > 0 ? 3 : 0) + '%" ' +
             'title="' + esc(p.date) + ': ' + value + '"></div>';
    }).join('');

    return '<div class="adm__chart">' + bars + '</div>' +
      '<div class="adm__chartfoot"><span>' + esc(points[0].date) + '</span>' +
      '<span>peak ' + count(max) + '</span>' +
      '<span>' + esc(points[points.length - 1].date) + '</span></div>';
  }

  /** A "top ten" list, or an honest note when nothing has been recorded. */
  function rankList(items, emptyMessage) {
    if (!items || !items.length) {
      return '<p class="adm__none" style="font-size:13px;margin:8px 0 0">' +
             esc(emptyMessage || 'No data yet') + '</p>';
    }
    return '<ul class="adm__rank">' + items.map(function (i) {
      return '<li><span>' + esc(i.key) + '</span><span>' + count(i.count) + '</span></li>';
    }).join('') + '</ul>';
  }

  ADM.ui = {
    DASH: DASH,
    esc: esc, text: text, count: count, money: money,
    date: date, dateTime: dateTime, ago: ago,
    pill: pill, avatar: avatar,
    emptyState: emptyState, banner: banner, skeletonRows: skeletonRows,
    barChart: barChart, rankList: rankList
  };
})(window);
