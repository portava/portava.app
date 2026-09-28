/**
 * A PostgREST-shaped in-memory fake for census-discovery §86's Trail suites
 * (discoveryTrailProductRules, discoveryTrailExploration, adminTrailsRoutes).
 *
 * Modelled on the fake in discoveryTrailRoutes.test.ts, plus what §86's code
 * calls and that fake does not model: a REAL `order(column, { ascending })`
 * (the trend-review read takes the newest row), `update().eq().eq().select()`
 * returning the matched rows (the §7 compare-and-set counts them), and `rpc`
 * through a caller-supplied table of functions. Every write is recorded.
 * A table named in `missing` answers 42P01; one in `erroring` a timeout;
 * `readFailure` / `writeFailure` answer the exact error given (the contract's
 * worlds).
 *
 * Like the real client, a builder does NOTHING until it is awaited or given a
 * `.then`: an insert that is never continued writes nothing, and one that is
 * continued writes exactly once. An INSERT or DELETE without `.select()`
 * resolves `data: null`. `maybeSingle` over more than one row resolves
 * PGRST116. Anything it does not model throws, saying so, rather than
 * answering.
 *
 * CHECKED AGAINST THE REAL CLIENT: registered in helpers/supabaseConformance.ts
 * (`trailRulesSubject`), so supabaseContract.test.ts measures it against the
 * real supabase-js client. Do not loosen it to make a test pass.
 * NOT MODELLED — every entry below is a declared gap the contract enforces:
 *   refused   — single/zero-rows, single/one-row, single/many-rows,
 *               insert/with-select-single (the §86 code never calls these)
 *   divergent — insert/unique-violation-23505 (no unique constraints are
 *               modelled; a duplicate insert appends),
 *               error/unknown-column-42703 (no schema; an unknown column reads
 *               as undefined),
 *               rls/denied-read-yields-zero-rows, rls/denied-write-yields-42501
 *               (no service-vs-user distinction: one seed, no policies)
 */
export type Row = Record<string, any>;

type PgError = { code: string; message: string };

export interface FakeRulesDbOptions {
  missing?: string[];
  erroring?: string[];
  /** Tables whose every read answers exactly this error. */
  readFailure?: Record<string, PgError>;
  /** Tables whose every write (insert, update, delete) answers exactly this error and stores nothing. */
  writeFailure?: Record<string, PgError>;
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

const refuse = (what: string) => () => { throw new Error(`fakeTrailRulesDb does not model ${what}`); };
/** Builder verbs the §86 code never calls: each refuses rather than matching everything. */
const UNMODELLED_VERBS = ["not", "lt", "lte", "like", "contains", "containedBy", "overlaps", "textSearch", "match", "filter", "upsert", "csv", "returns", "abortSignal", "single"] as const;

let seq = 0;
function uuidFor(table: string, n: number): string {
  let h = 2166136261;
  for (const ch of `${table}:${n}:${seq++}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}00000000`.slice(0, 36);
}

/** A thenable that runs `exec` at most once, and only when continued — as supabase-js does. */
function lazy<T>(exec: () => T, extra: Record<string, unknown> = {}): any {
  let settled: { v: T } | null = null;
  const once = () => (settled ??= { v: exec() }).v;
  return { ...extra, then(res: any, rej?: any) { return Promise.resolve().then(once).then(res, rej); } };
}

export function makeRulesDb(seed: Record<string, Row[]>, opts: FakeRulesDbOptions = {}): FakeRulesDb {
  const tables: Record<string, Row[]> = { feature_flags: [], ...seed };
  const writes: FakeRulesDb["writes"] = [];
  const reads: string[] = [];
  const missing = new Set(opts.missing ?? []);
  const erroring = new Set(opts.erroring ?? []);
  const readError = (table: string): PgError | null =>
    opts.readFailure?.[table] ?? (missing.has(table) ? { code: "42P01", message: `relation "public.${table}" does not exist` }
      : erroring.has(table) ? { code: "57014", message: "canceling statement due to statement timeout" } : null);
  const writeError = (table: string): PgError | null => opts.writeFailure?.[table] ?? readError(table);

  function from(table: string) {
    reads.push(table);
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    let wantCount = false;
    const store = () => (tables[table] ??= []);
    const matched = () => store().filter((r) => filters.every((f) => f(r)));
    const rows = () => {
      let out = matched();
      if (orderBy) {
        const { col, asc } = orderBy;
        out = [...out].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : String(a[col] ?? "") > String(b[col] ?? "") ? 1 : 0) * (asc ? 1 : -1));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out;
    };
    const b: any = {
      select(_cols?: string, o?: { count?: string }) { if (o?.count) wantCount = true; return b; },
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
      maybeSingle() {
        return lazy(() => {
          const e = readError(table);
          if (e) return { data: null, error: e };
          const r = rows();
          if (r.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
          return { data: r[0] ?? null, error: null };
        });
      },
      insert(payload: any) {
        const list = Array.isArray(payload) ? payload : [payload];
        let done: { data: any; error: any } | null = null;
        const exec = (returning: boolean) => {
          if (done) return done;
          const e = writeError(table);
          if (e) return (done = { data: null, error: e });
          const stored = list.map((x, i) => ({ id: uuidFor(table, store().length + i), created_at: new Date().toISOString(), ...x }));
          store().push(...stored);
          writes.push({ table, op: "insert", rows: stored });
          return (done = { data: returning ? stored.map((r) => ({ ...r })) : null, error: null });
        };
        return lazy(() => exec(false), {
          select: () => lazy(() => exec(true), { single: refuse("insert().select().single()"), maybeSingle: refuse("insert().select().maybeSingle()") }),
          maybeSingle: refuse("insert().maybeSingle()"),
          single: refuse("insert().single()"),
        });
      },
      update(patch: Row) {
        let representation = false;
        const u: any = lazy(() => {
          const e = writeError(table);
          if (e) return { data: null, error: e };
          const hit = matched();
          for (const r of hit) Object.assign(r, patch);
          writes.push({ table, op: "update", rows: { patch, n: hit.length } });
          return { data: representation ? hit.map((r) => ({ ...r })) : null, error: null };
        });
        u.eq = (c: string, v: any) => { filters.push((r) => r[c] === v); return u; };
        u.in = (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return u; };
        u.select = () => { representation = true; return u; };
        return u;
      },
      delete() {
        let representation = false;
        const d: any = lazy(() => {
          const e = writeError(table);
          if (e) return { data: null, error: e };
          const gone = matched();
          tables[table] = store().filter((r) => !filters.every((f) => f(r)));
          writes.push({ table, op: "delete", rows: gone.length });
          return { data: representation ? gone.map((r) => ({ ...r })) : null, error: null };
        });
        d.eq = (c: string, v: any) => { filters.push((r) => r[c] === v); return d; };
        d.select = () => { representation = true; return d; };
        return d;
      },
      then(res: any, rej?: any) {
        const e = readError(table);
        const r = e ? { data: null, error: e } : { data: rows(), error: null, ...(wantCount ? { count: matched().length } : {}) };
        return Promise.resolve(r).then(res, rej);
      },
    };
    for (const verb of UNMODELLED_VERBS) b[verb] = refuse(`.${verb}()`);
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
