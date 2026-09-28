/**
 * A PostgREST-shaped in-memory fake for census-discovery §86's Trail suites
 * (discoveryTrailProductRules, discoveryTrailExploration, adminTrailsRoutes).
 *
 * Modelled on the fake in discoveryTrailRoutes.test.ts, plus what §86's code
 * calls and that fake does not model: a REAL `order(column, { ascending })`
 * (the trend-review read takes the newest row), `update().eq().eq().select()`
 * returning the matched rows (the §7 compare-and-set counts them), and `rpc`
 * through a caller-supplied table of functions. Every write is recorded.
 * A table named in `missing` answers 42P01; one in `erroring` a timeout.
 */
export type Row = Record<string, any>;

export interface FakeRulesDbOptions {
  missing?: string[];
  erroring?: string[];
  rpc?: Record<string, (args: Row, tables: Record<string, Row[]>) => { data: any; error: any }>;
}

export interface FakeRulesDb {
  from(table: string): any;
  rpc(name: string, args: Row): Promise<{ data: any; error: any }>;
  auth: { getUser(token: string): Promise<any> };
  tables: Record<string, Row[]>;
  writes: Array<{ table: string; op: "insert" | "update" | "delete" | "rpc"; rows: any }>;
  reads: string[];
}

let seq = 0;
function uuidFor(table: string, n: number): string {
  let h = 2166136261;
  for (const ch of `${table}:${n}:${seq++}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}00000000`.slice(0, 36);
}

export function makeRulesDb(seed: Record<string, Row[]>, opts: FakeRulesDbOptions = {}): FakeRulesDb {
  const tables: Record<string, Row[]> = { feature_flags: [], ...seed };
  const writes: FakeRulesDb["writes"] = [];
  const reads: string[] = [];
  const missing = new Set(opts.missing ?? []);
  const erroring = new Set(opts.erroring ?? []);
  const fail = (table: string) => (missing.has(table)
    ? { code: "42P01", message: `relation "public.${table}" does not exist` }
    : { code: "57014", message: "canceling statement due to statement timeout" });
  const broken = (table: string) => missing.has(table) || erroring.has(table);

  function from(table: string) {
    reads.push(table);
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    const store = () => (tables[table] ??= []);
    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      ilike(c: string, p: string) { const n = p.replace(/%/g, "").toLowerCase(); filters.push((r) => String(r[c] ?? "").toLowerCase().includes(n)); return b; },
      or() { return b; },
      order(col: string, o?: { ascending?: boolean }) { if (!orderBy) orderBy = { col, asc: o?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() { return Promise.resolve(broken(table) ? { data: null, error: fail(table) } : { data: rows()[0] ?? null, error: null }); },
      single() { return b.maybeSingle(); },
      insert(payload: any) {
        const list = Array.isArray(payload) ? payload : [payload];
        const settled = broken(table)
          ? { data: null, error: fail(table) }
          : (() => {
            const stored = list.map((x, i) => ({ id: uuidFor(table, store().length + i), created_at: new Date().toISOString(), ...x }));
            store().push(...stored);
            writes.push({ table, op: "insert", rows: stored });
            return { data: stored, error: null };
          })();
        const r: any = { ...settled, select: () => r, maybeSingle: () => Promise.resolve({ data: Array.isArray(settled.data) ? settled.data[0] ?? null : null, error: settled.error }) };
        r.then = (res: any, rej?: any) => Promise.resolve(settled).then(res, rej);
        return r;
      },
      update(patch: Row) {
        let representation = false;
        const u: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return u; },
          in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return u; },
          select() { representation = true; return u; },
          then(res: any, rej?: any) {
            if (broken(table)) return Promise.resolve({ data: null, error: fail(table) }).then(res, rej);
            const hit = store().filter((r) => filters.every((f) => f(r)));
            for (const r of hit) Object.assign(r, patch);
            writes.push({ table, op: "update", rows: { patch, n: hit.length } });
            return Promise.resolve({ data: representation ? hit.map((r) => ({ ...r })) : null, error: null }).then(res, rej);
          },
        };
        return u;
      },
      delete() {
        const d: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return d; },
          then(res: any, rej?: any) {
            if (broken(table)) return Promise.resolve({ data: null, error: fail(table) }).then(res, rej);
            const keep = store().filter((r) => !filters.every((f) => f(r)));
            writes.push({ table, op: "delete", rows: store().length - keep.length });
            tables[table] = keep;
            return Promise.resolve({ data: null, error: null }).then(res, rej);
          },
        };
        return d;
      },
      then(res: any, rej?: any) {
        return Promise.resolve(broken(table) ? { data: null, error: fail(table) } : { data: rows(), error: null }).then(res, rej);
      },
    };
    return b;
  }

  return {
    from,
    tables, writes, reads,
    async rpc(name: string, args: Row) {
      writes.push({ table: name, op: "rpc", rows: args });
      const fn = opts.rpc?.[name];
      if (!fn) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
      return fn(args, tables);
    },
    auth: {
      async getUser(token: string) {
        return (tables.profiles ?? []).some((p) => p.id === token)
          ? { data: { user: { id: token } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}
