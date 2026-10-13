// Tiny in-memory stand-in for the supabase-js query builder (only what the API uses).
export function amFakeAdmin(tables = {}, storage = {}) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const calls = { rpc: [], inserts: [], updates: [] };

  function builder(table) {
    const filters = [];
    let op = 'select';
    let payload;
    let single = null;
    let limit = Infinity;
    let countMode = null;
    let head = false;
    const rows = () => (db[table] ??= []).filter((r) => filters.every((f) => f(r)));
    let upsertOptions = {};
    const api = {
      // `select(cols, { count: 'exact', head: true })` mirrors supabase-js: head queries
      // resolve `{ count, data: null }`, otherwise `count` is returned alongside `data`.
      select(_cols, opts = {}) {
        if (opts.count) countMode = opts.count;
        if (opts.head) head = true;
        return api;
      },
      insert(p) {
        op = 'insert';
        payload = p;
        return api;
      },
      upsert(p, opts = {}) {
        op = 'upsert';
        payload = p;
        upsertOptions = opts;
        return api;
      },
      update(p) {
        op = 'update';
        payload = p;
        return api;
      },
      delete() {
        op = 'delete';
        return api;
      },
      eq(k, v) {
        filters.push((r) => r[k] === v);
        return api;
      },
      neq(k, v) {
        filters.push((r) => r[k] !== v);
        return api;
      },
      is(k, v) {
        filters.push((r) => (r[k] ?? null) === v);
        return api;
      },
      in(k, vs) {
        filters.push((r) => vs.includes(r[k]));
        return api;
      },
      gte(k, v) {
        filters.push((r) => r[k] >= v);
        return api;
      },
      order() {
        return api;
      },
      limit(n) {
        limit = n;
        return api;
      },
      maybeSingle() {
        single = 'maybe';
        return api;
      },
      single() {
        single = 'one';
        return api;
      },
      then(resolve, reject) {
        try {
          let data;
          const extra = {};
          if (op === 'insert') {
            const list = Array.isArray(payload) ? payload : [payload];
            db[table].push(...list.map((r) => ({ ...r })));
            calls.inserts.push({ table, rows: list });
            data = list;
          } else if (op === 'upsert') {
            const list = Array.isArray(payload) ? payload : [payload];
            db[table] ??= [];
            const conflictKeys = String(upsertOptions.onConflict || '')
              .split(',')
              .map((key) => key.trim())
              .filter(Boolean);
            data = list.map((row) => {
              const existing = conflictKeys.length
                ? db[table].find((item) => conflictKeys.every((key) => item[key] === row[key]))
                : undefined;
              if (existing) {
                if (!upsertOptions.ignoreDuplicates) Object.assign(existing, row);
                return existing;
              }
              const copy = { ...row };
              db[table].push(copy);
              return copy;
            });
            calls.inserts.push({ table, rows: list, upsert: true });
          } else if (op === 'update') {
            const hit = rows();
            hit.forEach((r) => Object.assign(r, payload));
            calls.updates.push({ table, payload, count: hit.length });
            data = hit;
          } else if (op === 'delete') {
            const hit = new Set(rows());
            db[table] = db[table].filter((r) => !hit.has(r));
            data = [...hit];
          } else {
            const all = rows();
            if (countMode && head) return resolve({ count: all.length, data: null, error: null });
            data = all.slice(0, limit);
            if (countMode) extra.count = all.length;
          }
          if (single) data = data[0] ?? null;
          if (single === 'one' && !data) return resolve({ ...extra, data: null, error: { message: 'not found' } });
          resolve({ ...extra, data, error: null });
        } catch (e) {
          reject(e);
        }
      },
    };
    return api;
  }

  return {
    db,
    calls,
    from: (t) => builder(t),
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: null, error: null };
    },
    storage: {
      from: (bucket) => ({
        download: async (path) => {
          const buf = storage[`${bucket}/${path}`];
          return buf ? { data: new Blob([buf]), error: null } : { data: null, error: { message: 'missing' } };
        },
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'no' } }) },
  };
}
