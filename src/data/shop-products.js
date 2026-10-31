/* ============================================================================
   Mobile Parts Finder · shop-products.js — which of a shop's products to show
   ----------------------------------------------------------------------------
   The Products page's search, filters and column choices, kept apart from the
   screen so the rules can be tested without a browser. The table and the grid
   both draw whatever this returns, so a view can never disagree with the other
   about what matches.

   The products are the ones /api/shop/state returned. Nothing here knows a
   product, a category or a brand of its own.

   `ctx` carries the three things only the page can answer:
     categoryName(id)   the category's name
     brandName(id)      the brand's name
     compatOn(id)       whether the category uses compatibility groups
     rupees(text)       paise from what was typed, or null
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.SM = root.SM || {}).shopProducts = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var DEFAULT_FILTER = {
    q: '', status: 'active', stock: 'all', cat: 'all', compat: 'all', brand: 'all', shelf: 'all', min: '', max: ''
  };

  /* The product's name is always shown, and Actions stays with it, so neither
     can be switched off. */
  var COLUMNS = [
    { key: 'image', label: 'Product image', on: true },
    { key: 'category', label: 'Category', on: true },
    { key: 'sku', label: 'SKU', on: true },
    { key: 'compat', label: 'Compatibility groups', on: true },
    { key: 'price', label: 'Selling price', on: true },
    { key: 'cost', label: 'Purchase price', on: true },
    { key: 'stock', label: 'Stock', on: true },
    { key: 'shelf', label: 'Shelf location', on: true },
    { key: 'status', label: 'Status', on: true },
    { key: 'created', label: 'Created date', on: false }
  ];

  function blankFilter() { return Object.assign({}, DEFAULT_FILTER); }

  /** Everything shown, whatever its status: what Clear All leaves. */
  function clearedFilter() { return Object.assign(blankFilter(), { status: 'all' }); }

  function defaultColumns() {
    var out = {};
    COLUMNS.forEach(function (c) { out[c.key] = c.on; });
    return out;
  }

  /** Column choices saved by an older version keep working, and junk is ignored. */
  function readColumns(text) {
    var out = defaultColumns();
    var saved = null;
    try { saved = JSON.parse(text); } catch (e) { return out; }
    if (!saved || typeof saved !== 'object') return out;
    COLUMNS.forEach(function (c) {
      if (typeof saved[c.key] === 'boolean') out[c.key] = saved[c.key];
    });
    return out;
  }

  /** 'out', 'low' or 'in'. A product with variants is judged on their total. */
  function stockLevel(p) {
    if ((p.qty || 0) <= 0) return 'out';
    return p.qty <= (p.lowStockAt == null ? 1 : p.lowStockAt) ? 'low' : 'in';
  }

  function brandOf(p, ctx) {
    return p.master && p.master.brandId ? ctx.brandName(p.master.brandId) : '';
  }

  function searchText(p, ctx) {
    return [
      p.name, p.shelf, p.sku, ctx.categoryName(p.categoryId), p.master ? p.master.name : '', brandOf(p, ctx)
    ].concat((p.variants || []).map(function (v) {
      return [v.ram, v.storage, v.label, v.sku, v.shelf].filter(Boolean).join(' ');
    })).filter(Boolean).join(' ').toLowerCase();
  }

  /** Every word typed has to appear somewhere on the product. */
  function matches(p, q, ctx) {
    var words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var hay = searchText(p, ctx);
    return words.every(function (w) { return hay.indexOf(w) > -1; });
  }

  function passes(p, f, ctx) {
    if (f.status === 'active' && !p.active) return false;
    if (f.status === 'inactive' && p.active) return false;

    var level = stockLevel(p);
    if (f.stock === 'in' && level === 'out') return false;
    if (f.stock === 'low' && level !== 'low') return false;
    if (f.stock === 'out' && level !== 'out') return false;

    if (f.cat !== 'all' && p.categoryId !== f.cat) return false;

    var groups = (p.groupIds || []).length;
    if (f.compat === 'has' && !groups) return false;
    /* "None" means a gap to fill, so a category with no groups at all, such as
       Mobiles, is not reported as missing them. */
    if (f.compat === 'none' && (groups || !ctx.compatOn(p.categoryId))) return false;

    if (f.brand !== 'all' && !(p.master && p.master.brandId === f.brand)) return false;

    if (f.shelf !== 'all') {
      var shelves = [p.shelf].concat((p.variants || []).map(function (v) { return v.shelf; }));
      if (shelves.indexOf(f.shelf) < 0) return false;
    }

    var min = String(f.min || '').trim() ? ctx.rupees(f.min) : null;
    var max = String(f.max || '').trim() ? ctx.rupees(f.max) : null;
    if (min != null && p.pricePaise < min) return false;
    if (max != null && p.pricePaise > max) return false;
    return true;
  }

  /** The products to show, by name. Search and every filter apply together. */
  function filterProducts(products, f, ctx) {
    return products
      .filter(function (p) { return passes(p, f, ctx) && matches(p, f.q, ctx); })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /**
   * How many filters are narrowing the list beyond the default view. Showing
   * every status narrows nothing, so Clear All leaves this at zero. A price range
   * counts once.
   */
  function activeCount(f) {
    var n = f.status === 'inactive' ? 1 : 0;
    ['stock', 'cat', 'compat', 'brand', 'shelf'].forEach(function (k) {
      if (f[k] !== DEFAULT_FILTER[k]) n++;
    });
    if (String(f.min || '').trim() || String(f.max || '').trim()) n++;
    return n;
  }

  /** The brands and shelves this shop's products actually have, for the filter lists. */
  function options(products) {
    var brands = {}, shelves = {};
    products.forEach(function (p) {
      if (p.master && p.master.brandId) brands[p.master.brandId] = 1;
      if (p.shelf) shelves[p.shelf] = 1;
      (p.variants || []).forEach(function (v) { if (v.shelf) shelves[v.shelf] = 1; });
    });
    return { brands: Object.keys(brands), shelves: Object.keys(shelves).sort() };
  }

  return {
    COLUMNS: COLUMNS, blankFilter: blankFilter, clearedFilter: clearedFilter,
    defaultColumns: defaultColumns, readColumns: readColumns,
    stockLevel: stockLevel, matches: matches, filterProducts: filterProducts,
    activeCount: activeCount, options: options
  };
});
