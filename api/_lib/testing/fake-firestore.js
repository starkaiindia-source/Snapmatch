/* ============================================================================
   api/_lib/testing/fake-firestore.js — an in-memory Firestore for tests
   ----------------------------------------------------------------------------
   Just enough of the Admin SDK surface for the Instagram services: documents,
   subcollections, where / orderBy / limit / count, merge semantics, dotted
   update paths, increment / arrayUnion, batches and transactions.

   Transactions enforce Firestore's own rule that every read comes before the
   first write — the rule an approval transaction is most likely to break, and
   the one a looser fake would hide. Writes are applied only when the callback
   resolves, so a thrown error leaves the store untouched, as it would.

   Not shipped: nothing under api/*.js requires this file.
   ========================================================================== */
'use strict';

const OP = Symbol('fieldValueOp');

const FieldValue = {
  increment: n => ({ [OP]: 'inc', n }),
  arrayUnion: (...els) => ({ [OP]: 'union', els }),
  arrayRemove: (...els) => ({ [OP]: 'remove', els }),
  serverTimestamp: () => ({ [OP]: 'ts' }),
  delete: () => ({ [OP]: 'delete' })
};

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isPlain = v => v && typeof v === 'object' && !Array.isArray(v) && !v[OP];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolve(value, existing) {
  if (value && value[OP]) {
    switch (value[OP]) {
      case 'inc': return (Number(existing) || 0) + value.n;
      case 'union': {
        const out = Array.isArray(existing) ? existing.slice() : [];
        value.els.forEach(e => { if (!out.some(x => same(x, e))) out.push(clone(e)); });
        return out;
      }
      case 'remove': return (Array.isArray(existing) ? existing : []).filter(x => !value.els.some(e => same(x, e)));
      case 'ts': return Date.now();
      case 'delete': return undefined;
    }
  }
  if (isPlain(value)) {
    const out = {};
    Object.keys(value).forEach(k => { const r = resolve(value[k], undefined); if (r !== undefined) out[k] = r; });
    return out;
  }
  return clone(value);
}

function mergeInto(target, data) {
  Object.keys(data).forEach(k => {
    const v = data[k];
    if (v === undefined) return;
    if (isPlain(v)) {
      target[k] = isPlain(target[k]) ? target[k] : {};
      mergeInto(target[k], v);
    } else {
      const r = resolve(v, target[k]);
      if (r === undefined) delete target[k]; else target[k] = r;
    }
  });
  return target;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach(k => { if (!isPlain(o[k])) o[k] = {}; o = o[k]; });
  const last = keys[keys.length - 1];
  const r = resolve(value, o[last]);
  if (r === undefined) delete o[last]; else o[last] = r;
}

function createFakeFirestore() {
  const store = new Map();          /* full path -> data */
  let autoId = 0;
  const stats = { reads: 0, writes: 0 };

  function snapshot(path) {
    stats.reads++;
    const data = store.get(path);
    const id = path.split('/').pop();
    return { id, exists: data !== undefined, ref: docRef(path), data: () => clone(data) };
  }

  function applySet(path, data, opts) {
    stats.writes++;
    if (opts && opts.merge) {
      const cur = clone(store.get(path)) || {};
      store.set(path, mergeInto(cur, data));
    } else {
      store.set(path, mergeInto({}, data));
    }
  }

  function applyUpdate(path, data) {
    if (!store.has(path)) {
      const err = new Error('NOT_FOUND: no document to update: ' + path);
      err.code = 5;
      throw err;
    }
    stats.writes++;
    const cur = clone(store.get(path));
    Object.keys(data).forEach(k => setPath(cur, k, data[k]));
    store.set(path, cur);
  }

  function docRef(path) {
    return {
      id: path.split('/').pop(),
      path,
      get: async () => snapshot(path),
      set: async (data, opts) => applySet(path, data, opts),
      update: async data => applyUpdate(path, data),
      delete: async () => { store.delete(path); },
      collection: name => collectionRef(path + '/' + name)
    };
  }

  function query(colPath, filters, orders, limitN) {
    const q = {
      _colPath: colPath,
      where: (field, op, value) => query(colPath, filters.concat([{ field, op, value }]), orders, limitN),
      orderBy: (field, dir = 'asc') => query(colPath, filters, orders.concat([{ field, dir }]), limitN),
      limit: n => query(colPath, filters, orders, n),
      select: () => q,
      get: async () => run(),
      count: () => ({ get: async () => { const n = run(true).size; return { data: () => ({ count: n }) }; } })
    };
    function run(countOnly) {
      const depth = colPath.split('/').length + 1;
      let rows = [];
      store.forEach((data, path) => {
        if (!path.startsWith(colPath + '/') || path.split('/').length !== depth) return;
        rows.push({ path, data });
      });
      rows = rows.filter(r => filters.every(f => {
        const v = f.field === '__name__' ? r.path.split('/').pop() : getPath(r.data, f.field);
        switch (f.op) {
          case '==': return same(v, f.value);
          case '!=': return v !== undefined && !same(v, f.value);
          case '<': return v < f.value;
          case '<=': return v <= f.value;
          case '>': return v > f.value;
          case '>=': return v >= f.value;
          case 'in': return f.value.some(x => same(x, v));
          case 'array-contains': return Array.isArray(v) && v.some(x => same(x, f.value));
          default: throw new Error('fake firestore: unsupported op ' + f.op);
        }
      }));
      orders.forEach(o => { if (o.field !== '__name__') rows = rows.filter(r => getPath(r.data, o.field) !== undefined); });
      rows.sort((a, b) => {
        for (const o of orders) {
          const av = o.field === '__name__' ? a.path : getPath(a.data, o.field);
          const bv = o.field === '__name__' ? b.path : getPath(b.data, o.field);
          if (av < bv) return o.dir === 'desc' ? 1 : -1;
          if (av > bv) return o.dir === 'desc' ? -1 : 1;
        }
        return 0;
      });
      if (limitN != null) rows = rows.slice(0, limitN);
      if (!countOnly) stats.reads += Math.max(1, rows.length);
      const docs = rows.map(r => ({ id: r.path.split('/').pop(), exists: true, ref: docRef(r.path), data: () => clone(r.data) }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    }
    return q;
  }

  function collectionRef(path) {
    const base = query(path, [], [], null);
    return Object.assign(base, {
      id: path.split('/').pop(),
      doc: id => docRef(path + '/' + (id || ('auto' + String(++autoId).padStart(6, '0')))),
      add: async data => { const ref = docRef(path + '/auto' + String(++autoId).padStart(6, '0')); await ref.set(data); return ref; }
    });
  }

  function batch() {
    const ops = [];
    return {
      set: (ref, data, opts) => { ops.push(() => applySet(ref.path, data, opts)); },
      update: (ref, data) => { ops.push(() => applyUpdate(ref.path, data)); },
      delete: ref => { ops.push(() => store.delete(ref.path)); },
      commit: async () => {
        /* all-or-nothing, like a real batch */
        const before = new Map(Array.from(store.entries()).map(([k, v]) => [k, clone(v)]));
        try { ops.forEach(op => op()); }
        catch (err) { store.clear(); before.forEach((v, k) => store.set(k, v)); throw err; }
      }
    };
  }

  async function runTransaction(fn) {
    const ops = [];
    let wrote = false;
    const tx = {
      get: async refOrQuery => {
        if (wrote) throw new Error('Firestore transactions require all reads to be executed before all writes.');
        return refOrQuery.path ? snapshot(refOrQuery.path) : refOrQuery.get();
      },
      set: (ref, data, opts) => { wrote = true; ops.push(() => applySet(ref.path, data, opts)); return tx; },
      update: (ref, data) => { wrote = true; ops.push(() => applyUpdate(ref.path, data)); return tx; },
      create: (ref, data) => {
        wrote = true;
        ops.push(() => { if (store.has(ref.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } applySet(ref.path, data); });
        return tx;
      },
      delete: ref => { wrote = true; ops.push(() => store.delete(ref.path)); return tx; }
    };
    const result = await fn(tx);
    const before = new Map(Array.from(store.entries()).map(([k, v]) => [k, clone(v)]));
    try { ops.forEach(op => op()); }
    catch (err) { store.clear(); before.forEach((v, k) => store.set(k, v)); throw err; }
    return result;
  }

  const db = { collection: collectionRef, doc: docRef, batch, runTransaction };

  return {
    db,
    FieldValue,
    provider: { db: () => db, FieldValue },
    stats,
    seed(path, data) { store.set(path, mergeInto({}, data)); },
    read(path) { return clone(store.get(path)); },
    paths(prefix) { return Array.from(store.keys()).filter(k => k.startsWith(prefix)); },
    all(colPath) {
      const depth = colPath.split('/').length + 1;
      return Array.from(store.entries())
        .filter(([k]) => k.startsWith(colPath + '/') && k.split('/').length === depth)
        .map(([, v]) => clone(v));
    },
    snapshotAll() { return JSON.stringify(Array.from(store.entries()).sort()); }
  };
}

module.exports = { createFakeFirestore, FieldValue };
