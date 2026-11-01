/* ============================================================================
   Mobile Parts Finder · shop-offers.js — which offers a bill gets
   ----------------------------------------------------------------------------
   One file, loaded by BOTH halves, like shop-money.js. The cart shows what this
   works out, and the server works it out again from its own copy of the offers
   and the products when the bill is confirmed. Only the server's answer is saved.

   WHICH OFFER WINS

     A line gets one offer. The most specific offer that qualifies wins: a variant
     offer beats a product offer, and a product offer beats a category offer.
     Within a level the lower priority number wins, then the larger discount.

     The shop can change two things. `order: 'priority'` puts the priority number
     first, whatever the level. `stacking: true` lets offers marked stackable
     combine: each is taken off what the one before left, in the same order.

   EVERY AMOUNT IS AN INTEGER NUMBER OF PAISE. A percentage is taken off one unit
   and rounded once, so ₹299 at 10% is ₹29.90 off each however many are bought. A
   maximum discount caps the line. A fixed amount larger than what it comes off is
   not applied at all: capping it would quietly give the product away.

   Pure: no storage, no clock of its own, no network.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopOffers = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var LEVELS = { variant: 3, product: 2, category: 1 };

  /** Basis points of an amount, half-up, as shop-money rounds a percentage. */
  function pctOf(paise, bp) { return Math.floor((paise * bp + 5000) / 10000); }

  /** What an offer is at this moment. An end date that has passed outranks a pause. */
  function offerStatus(o, now) {
    if (o.status === 'archived') return 'archived';
    if (o.status === 'expired') return 'expired';
    if (o.endAt && now > o.endAt) return 'expired';
    if (o.status === 'paused') return 'paused';
    if (o.startAt && now < o.startAt) return 'scheduled';
    return 'active';
  }

  /** The level at which an offer reaches a line, or null when it does not. */
  function levelOn(o, line) {
    if (!line.productId) return null;
    if (o.target === 'variant') {
      var hit = (o.variants || []).some(function (v) { return v.productId === line.productId && v.variantId === line.variantId; });
      return hit ? 'variant' : null;
    }
    if (o.target === 'product') return (o.productIds || []).indexOf(line.productId) > -1 ? 'product' : null;
    if (o.target === 'category') return (o.categoryIds || []).indexOf(line.categoryId) > -1 ? 'category' : null;
    return null;
  }

  /** Does an offer reach this product at all, on any of its variants? */
  function covers(o, product) {
    if (o.target === 'variant') return (o.variants || []).some(function (v) { return v.productId === product.id; });
    if (o.target === 'product') return (o.productIds || []).indexOf(product.id) > -1;
    return (o.categoryIds || []).indexOf(product.categoryId) > -1;
  }

  /**
   * What an offer takes off a line.
   *
   * @param {number} left  what is left of the line, when offers are combined
   * @returns {number|null} paise, or null when a fixed amount is larger than what
   *                        it would come off
   */
  function amountOn(o, unit, qty, left) {
    var full = unit * qty;
    var base = left == null ? full : left;
    var amount;
    if (o.kind === 'percent') {
      amount = base === full ? pctOf(unit, o.percentBp) * qty : pctOf(base, o.percentBp);
      if (o.maxPaise) amount = Math.min(amount, o.maxPaise);
    } else if (o.fixedMode === 'line') {
      if (o.amountPaise > full) return null;
      amount = o.amountPaise;
    } else {
      if (o.amountPaise > unit) return null;
      amount = o.amountPaise * qty;
    }
    return Math.min(amount, base);
  }

  function ranker(order) {
    return function (a, b) {
      var level = LEVELS[b.level] - LEVELS[a.level];
      var priority = (a.offer.priority || 100) - (b.offer.priority || 100);
      var first = order === 'priority' ? priority || level : level || priority;
      return first || (b.full - a.full) || String(a.offer.id).localeCompare(String(b.offer.id));
    };
  }

  function snapshot(c, discountPaise) {
    var o = c.offer;
    return {
      id: o.id, name: o.name, level: c.level, kind: o.kind,
      percentBp: o.kind === 'percent' ? o.percentBp : null,
      amountPaise: o.kind === 'fixed' ? o.amountPaise : null,
      fixedMode: o.kind === 'fixed' ? (o.fixedMode || 'unit') : null,
      maxPaise: o.maxPaise || null,
      discountPaise: discountPaise
    };
  }

  function priceLine(line, active, ctx) {
    var full = line.unitPaise * line.qty;
    var key = line.productId + '|' + (line.variantId || '');
    var usable = [], options = [];

    active.forEach(function (o) {
      var level = levelOn(o, line);
      if (!level) return;
      var c = { offer: o, level: level, full: amountOn(o, line.unitPaise, line.qty) };
      var why = '';
      if (c.full == null) why = 'too-large';
      else if (o.minQty > 1 && ctx.qtyOf[key] < o.minQty) why = 'min-qty';
      else if (o.minBillPaise && ctx.originalPaise < o.minBillPaise) why = 'min-bill';
      else if (!c.full) why = 'no-value';
      if (why) { options.push({ id: o.id, name: o.name, level: level, discountPaise: 0, state: 'blocked', why: why }); return; }
      usable.push(c);
    });
    usable.sort(ranker(ctx.order));

    /* What this line gets: the shop's own choice if it still qualifies, otherwise
       what the rules give. A choice is never a way round them: it can only name
       an offer that is usable here, and the server asks the same question. */
    var chosen = [];
    var picked = line.pick && line.pick !== 'none' ? usable.filter(function (c) { return c.offer.id === line.pick; })[0] : null;
    if (picked) chosen = [picked];
    else if (ctx.auto && line.pick !== 'none') {
      var open = usable.filter(function (c) { return c.offer.autoApply !== false; });
      if (open.length) {
        chosen = [open[0]];
        if (ctx.stacking && open[0].offer.stackable) {
          chosen = open.filter(function (c) { return c.offer.stackable; });
        }
      }
    }

    var left = full;
    var applied = chosen.map(function (c) {
      var amount = amountOn(c.offer, line.unitPaise, line.qty, left) || 0;
      left -= amount;
      return snapshot(c, amount);
    });
    var offerPaise = full - left;

    var winner = chosen[0];
    usable.forEach(function (c) {
      var on = applied.filter(function (a) { return a.id === c.offer.id; })[0];
      var why = '';
      if (!on) {
        if (line.pick === 'none') why = 'removed';
        else if (picked) why = 'other-chosen';
        else if (!ctx.auto) why = 'bill-auto-off';
        else if (c.offer.autoApply === false) why = 'offer-auto-off';
        else if (winner) why = 'lost';
      }
      options.push({
        id: c.offer.id, name: c.offer.name, level: c.level, discountPaise: on ? on.discountPaise : c.full,
        state: on ? 'applied' : 'available', why: why, beatenBy: why === 'lost' ? winner.offer.name : ''
      });
    });

    return {
      key: line.key, offerPaise: offerPaise, linePaise: full - offerPaise,
      finalUnitPaise: Math.round((full - offerPaise) / line.qty),
      applied: applied, options: options
    };
  }

  /**
   * Prices every line of a bill.
   *
   * @param {{offers:Array, now:number, auto?:boolean,
   *          settings?:{stacking?:boolean, order?:string},
   *          lines:Array<{key?:string, productId:?string, variantId:?string,
   *                       categoryId:?string, unitPaise:number, qty:number, pick?:string}>}} input
   *        `auto` is this bill's Auto Apply. `pick` is an offer the shop chose for
   *        the line, or 'none' to take the line's offer off.
   * @returns {{lines:Array, offerPaise:number, originalPaise:number}}
   */
  function applyOffers(input) {
    var settings = input.settings || {};
    var active = (input.offers || []).filter(function (o) { return offerStatus(o, input.now) === 'active'; });
    var qtyOf = {}, originalPaise = 0;
    input.lines.forEach(function (l) {
      originalPaise += l.unitPaise * l.qty;
      var k = l.productId + '|' + (l.variantId || '');
      qtyOf[k] = (qtyOf[k] || 0) + l.qty;
    });
    var ctx = {
      auto: input.auto !== false, stacking: !!settings.stacking, order: settings.order,
      qtyOf: qtyOf, originalPaise: originalPaise
    };
    var lines = input.lines.map(function (l) { return priceLine(l, active, ctx); });
    return {
      lines: lines, originalPaise: originalPaise,
      offerPaise: lines.reduce(function (n, l) { return n + l.offerPaise; }, 0)
    };
  }

  /** "10% OFF", "₹50 OFF each", "₹50 OFF the line", with any cap. */
  function valueText(o, inr) {
    if (o.kind === 'percent') {
      return (o.percentBp / 100) + '% OFF' + (o.maxPaise ? ' (max ' + inr(o.maxPaise) + ')' : '');
    }
    return inr(o.amountPaise) + ' OFF ' + (o.fixedMode === 'line' ? 'the line' : 'each');
  }

  /**
   * The six figures at the top of the Discounts & Offers page. Coverage counts
   * only what is running now, each product and category once however many offers
   * reach it. A category is covered by an offer on the category: an offer on one
   * product in it covers that product, not the category.
   *
   * @param {Array} offers    the shop's offers
   * @param {Array} products  its products on sale
   */
  function offerTally(offers, products, now) {
    var t = { total: offers.length, active: 0, scheduled: 0, expired: 0, paused: 0, products: 0, categories: 0 };
    var running = [];
    offers.forEach(function (o) {
      var st = offerStatus(o, now);
      if (st in t) t[st] += 1;
      if (st === 'active') running.push(o);
    });
    var cats = {};
    running.forEach(function (o) {
      if (o.target === 'category') (o.categoryIds || []).forEach(function (id) { cats[id] = 1; });
    });
    t.categories = Object.keys(cats).length;
    t.products = products.filter(function (p) {
      return running.some(function (o) { return covers(o, p); });
    }).length;
    return t;
  }

  return {
    LEVELS: LEVELS, offerStatus: offerStatus, levelOn: levelOn, covers: covers,
    amountOn: amountOn, applyOffers: applyOffers, valueText: valueText, offerTally: offerTally
  };
});
