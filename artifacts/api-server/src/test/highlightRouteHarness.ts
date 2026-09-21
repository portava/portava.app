/**
 * The table-backed fake supabase client the Highlights ROUTE tests drive
 * `routes/highlights.ts` over. Extracted from verifyFlowHighlightControls.test.ts
 * so that a second route-level suite (highlightPublicProjectionEnforcement)
 * can use the same fake rather than a divergent copy.
 *
 * Written here rather than reused from `telegraphCertificationHarness.ts`
 * because of ONE clause this surface depends on and that harness does not
 * model: `.or("expires_at.is.null,expires_at.gt.<iso>")`, the §5 lifetime
 * filter every Highlight read applies. The shared harness parses `eq`/`neq`/`is`
 * terms only and matches NOTHING for an expression it cannot read — the
 * conservative direction for a block filter, and the wrong one here, because it
 * would empty the feed and make every suppression case pass vacuously.
 * Measured: with that harness the positive control returned zero Highlights.
 */
export interface FakeClient {
  from(table: string): any;
  rpc(name: string, args?: any): Promise<{ data: any; error: any }>;
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } }; error: any }> };
  _store: Record<string, any[]>;
}

/** One `col.op.value` term of a PostgREST `.or()` expression. */
function orTerm(term: string): ((r: any) => boolean) | null {
  const m = term.trim().match(/^([A-Za-z0-9_]+)\.([a-z]+)\.(.*)$/);
  if (!m) return null;
  const [, col, op, raw] = m;
  const val = raw === "null" ? null : raw;
  switch (op) {
    case "eq": return (r) => String(r?.[col]) === String(val);
    case "neq": return (r) => String(r?.[col]) !== String(val);
    case "is": return (r) => (val === null ? r?.[col] == null : r?.[col] === val);
    case "gt": return (r) => r?.[col] != null && Date.parse(r[col]) > Date.parse(String(val));
    case "gte": return (r) => r?.[col] != null && Date.parse(r[col]) >= Date.parse(String(val));
    case "lt": return (r) => r?.[col] != null && Date.parse(r[col]) < Date.parse(String(val));
    default: return null;
  }
}

function orPredicate(expr: string): (r: any) => boolean {
  const preds = expr.split(",").map(orTerm).filter(Boolean) as Array<(r: any) => boolean>;
  // An expression none of whose terms parsed matches nothing — a filter that
  // silently matched everything would make a gate look like it fired.
  if (preds.length === 0) return () => false;
  return (r) => preds.some((p) => p(r));
}

export function makeClient(
  seedTables: Record<string, any[]>,
  opts: { errors?: Record<string, { message: string; code?: string }> } = {},
): FakeClient {
  const store: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seedTables)) store[k] = v.map((r) => ({ ...r }));
  let gen = 0;

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let pendingRows: any[] = [];
    let pendingPatch: any = null;
    let onConflict: string[] | null = null;
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;

    const rows = () => {
      let out = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (_order) {
        const { col, asc } = _order;
        out = [...out].sort((a, b) => {
          const x = Date.parse(a?.[col]) || 0;
          const y = Date.parse(b?.[col]) || 0;
          return asc ? x - y : y - x;
        });
      }
      return _limit !== null ? out.slice(0, _limit) : out;
    };

    const applyWrite = (): any[] => {
      store[table] = store[table] ?? [];
      if (mode === "insert" || mode === "upsert") {
        const written: any[] = [];
        for (const r of pendingRows) {
          const row = { id: r.id ?? `gen-${table}-${gen++}`, ...r };
          if (mode === "upsert") {
            const keys = onConflict ?? ["id"];
            const idx = store[table].findIndex((e) => keys.every((k) => e[k] === row[k]));
            if (idx >= 0) {
              store[table][idx] = { ...store[table][idx], ...row, id: store[table][idx].id };
              written.push(store[table][idx]);
              continue;
            }
          }
          store[table].push(row);
          written.push(row);
        }
        return written;
      }
      if (mode === "update") {
        const target = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
        for (const r of target) Object.assign(r, pendingPatch);
        return target;
      }
      const doomed = (store[table] ?? []).filter((r) => preds.every((p) => p(r)));
      store[table] = (store[table] ?? []).filter((r) => !doomed.includes(r));
      return doomed;
    };

    const settle = () => {
      const e = opts.errors?.[table];
      if (e) return { data: null, error: e, count: null };
      if (mode === "select") {
        const out = rows();
        return { data: out, error: null, count: out.length };
      }
      const written = applyWrite();
      return { data: written, error: null, count: written.length };
    };

    const target: any = {
      select() { return proxy; },
      insert(r: any) { mode = "insert"; pendingRows = Array.isArray(r) ? r : [r]; return proxy; },
      upsert(r: any, o?: { onConflict?: string }) {
        mode = "upsert";
        pendingRows = Array.isArray(r) ? r : [r];
        onConflict = o?.onConflict ? o.onConflict.split(",").map((s) => s.trim()) : null;
        return proxy;
      },
      update(p: any) { mode = "update"; pendingPatch = p; return proxy; },
      delete() { mode = "delete"; return proxy; },
      eq(col: string, v: any) { preds.push((r) => String(r?.[col]) === String(v)); return proxy; },
      neq(col: string, v: any) { preds.push((r) => String(r?.[col]) !== String(v)); return proxy; },
      in(col: string, vs: any[]) {
        const set = (vs ?? []).map(String);
        preds.push((r) => set.includes(String(r?.[col])));
        return proxy;
      },
      is(col: string, v: any) { preds.push((r) => (v === null ? r?.[col] == null : r?.[col] === v)); return proxy; },
      not(col: string, op: string, v: any) {
        if (op === "is") preds.push((r) => (v === null ? r?.[col] != null : r?.[col] !== v));
        return proxy;
      },
      or(expr: string) { preds.push(orPredicate(expr)); return proxy; },
      ilike(col: string, pattern: string) {
        const needle = String(pattern).replace(/%/g, "").toLowerCase();
        preds.push((r) => typeof r?.[col] === "string" && r[col].toLowerCase().includes(needle));
        return proxy;
      },
      gt(col: string, v: any) { preds.push((r) => Date.parse(r?.[col]) > Date.parse(v)); return proxy; },
      gte(col: string, v: any) { preds.push((r) => Date.parse(r?.[col]) >= Date.parse(v)); return proxy; },
      lt(col: string, v: any) { preds.push((r) => Date.parse(r?.[col]) < Date.parse(v)); return proxy; },
      lte(col: string, v: any) { preds.push((r) => Date.parse(r?.[col]) <= Date.parse(v)); return proxy; },
      order(col: string, o?: any) { _order = { col, asc: o?.ascending !== false }; return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : (Array.isArray(s.data) ? s.data[0] ?? null : s.data), error: s.error });
      },
      single() {
        const s = settle();
        return Promise.resolve({ data: s.error ? null : (Array.isArray(s.data) ? s.data[0] ?? null : s.data), error: s.error });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
    };
    // Any builder method not modelled keeps the chain alive rather than
    // throwing: a TypeError inside a handler becomes a 500 and would read as
    // "the gate refused", the one wrong conclusion a suite about refusals must
    // not be able to draw.
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    _store: store,
  };
}
