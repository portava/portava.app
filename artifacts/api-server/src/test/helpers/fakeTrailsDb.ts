/**
 * A PostgREST-shaped in-memory fake for the Trails service, with the two
 * `rank_events` reads of `trailTrending` separately breakable.
 *
 * census-discovery §75 (lane P33, DC-17). Modelled on the fake in
 * `discoveryTrailProvenance.test.ts` (it pages with `.range()`, so a momentum
 * reading asserted over it is a reading the kernel really took), plus what
 * §75's hunks need and that fake does not model:
 *
 *   - `failRankEvents: "discovery"` fails ONLY the per-item read (the one that
 *     filters `surface = 'discovery'`); `"all_surfaces"` fails ONLY the Trail
 *     read (the one with no surface filter). H-P21-5 turns on exactly that split.
 *   - `missingColumns` makes an INSERT or a SELECT that names one of these
 *     columns answer 42703, as a database without the migration would, so a
 *     column-absent latch can be driven both ways.
 *   - every insert is RECORDED (`inserts`), so a test can read what a
 *     fire-and-forget writer actually sent.
 *
 * Anything it does not model throws rather than matching everything.
 *
 * CHECKED AGAINST THE REAL CLIENT: registered in helpers/supabaseConformance.ts
 * (`trailsSubject`), so supabaseContract.test.ts measures it against the real
 * supabase-js client. Do not loosen it to make a test pass.
 * NOT MODELLED — every entry below is a declared gap the contract enforces:
 *   refused  — single/zero-rows, single/one-row, single/many-rows,
 *              update/zero-rows-no-select, update/many-rows-no-select,
 *              update/zero-rows-with-select, update/many-rows-with-select,
 *              delete/many-rows-no-select, delete/many-rows-with-select,
 *              insert/with-select-single, rpc/success, rpc/error-resolves,
 *              rpc/unknown-function (TrailService never calls these verbs)
 *   divergent — insert/unique-violation-23505 (no unique constraints),
 *              error/unknown-column-42703 (only `missingColumns` fail),
 *              select/count-exact (no count surface),
 *              rls/denied-read-yields-zero-rows, rls/denied-write-yields-42501
 *              (no service-vs-user distinction)
 */
import { orPredicate } from "./postgrestOrFilter.js";

export type Row = Record<string, unknown>;

export interface FakeTrailsDbOptions {
  /** Tables whose every read fails with a statement timeout (an unknown answer). */
  erroring?: string[];
  /** Which `rank_events` read fails: the per-item (discovery-surface) read or the all-surfaces Trail read. */
  failRankEvents?: "discovery" | "all_surfaces";
  /** Columns this database does not have: a write or select naming one answers 42703. */
  missingColumns?: string[];
  /** Tables whose INSERT answers this error (counted in `insertAttempts`), e.g. 42P01 or a timeout. */
  insertFailure?: Record<string, { code: string; message: string }>;
  /** Tables whose every read answers this exact error (the contract's worlds); `erroring` answers a timeout. */
  readFailure?: Record<string, { code: string; message: string }>;
}

type Settled = { data: Row[] | Row | null; error: { code: string; message: string } | null };

/** The PostgREST builder surface TrailService calls, and nothing else. */
export interface FakeBuilder extends PromiseLike<Settled> {
  select(cols?: string): FakeBuilder;
  eq(c: string, v: unknown): FakeBuilder;
  neq(c: string, v: unknown): FakeBuilder;
  in(c: string, v: unknown[]): FakeBuilder;
  is(c: string, v: unknown): FakeBuilder;
  gt(c: string, v: unknown): FakeBuilder;
  gte(c: string, v: unknown): FakeBuilder;
  or(expr: string): FakeBuilder;
  order(): FakeBuilder;
  limit(n: number): FakeBuilder;
  range(a: number, z: number): FakeBuilder;
  maybeSingle(): Promise<Settled>;
  insert(payload: Row): PromiseLike<Settled> & { select(): unknown; maybeSingle(): Promise<Settled> };
}

export interface FakeTrailsDb {
  from(table: string): FakeBuilder;
  rpc(): never;
  tables: Record<string, Row[]>;
  inserts: Array<{ table: string; payload: Row }>;
  /** Every INSERT attempted, per table — including the ones that failed. */
  insertAttempts: Record<string, number>;
}

export function makeFakeTrailsDb(seed: Record<string, Row[]>, opts: FakeTrailsDbOptions = {}): FakeTrailsDb {
  const tables: Record<string, Row[]> = {
    trails: [], content_trails: [], trail_follows: [],
    trail_reports: [], trail_health_snapshots: [], rank_events: [],
    ...seed,
  };
  const broken = new Set(opts.erroring ?? []);
  const missing = new Set(opts.missingColumns ?? []);
  const inserts: Array<{ table: string; payload: Row }> = [];
  const insertAttempts: Record<string, number> = {};
  const timeout = (): Settled => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  const noColumn = (table: string, col: string): Settled => ({
    data: null, error: { code: "42703", message: `column ${table}.${col} does not exist` },
  });

  function from(table: string): FakeBuilder {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    let surfaceFilter: string | null = null;
    let selected: string[] = [];
    const store = () => (tables[table] ??= []);
    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out.map((r) => ({ ...r }));
    };
    const fault = (): Settled | null => {
      const failed = opts.readFailure?.[table];
      if (failed) return { data: null, error: failed };
      if (broken.has(table)) return timeout();
      const absent = selected.find((c) => missing.has(c));
      if (absent) return noColumn(table, absent);
      if (table === "rank_events" && opts.failRankEvents === "discovery" && surfaceFilter === "discovery") return timeout();
      if (table === "rank_events" && opts.failRankEvents === "all_surfaces" && surfaceFilter === null) return timeout();
      return null;
    };
    const run = (): Settled => fault() ?? { data: rows(), error: null };

    const b: FakeBuilder = {
      select(cols?: string) {
        selected = typeof cols === "string" ? cols.split(",").map((c) => c.trim()).filter(Boolean) : [];
        return b;
      },
      eq(c: string, v: unknown) { if (c === "surface") surfaceFilter = String(v); filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: unknown[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: unknown) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      or(expr: string) { filters.push(orPredicate(expr)); return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() {
        const f = fault();
        if (f) return Promise.resolve(f);
        const found = rows();
        // PostgREST refuses more than one row here (PGRST116), as the real client reports.
        if (found.length > 1) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } });
        return Promise.resolve({ data: found[0] ?? null, error: null });
      },
      insert(payload: Row) {
        // Lazy, like supabase-js: nothing is sent until the builder is continued
        // (.then / await / .maybeSingle()), and it is sent at most once.
        let sent: Settled | null = null;
        const exec = (): Settled => {
          if (sent) return sent;
          const cols = Object.keys(payload ?? {});
          const absent = cols.find((c) => missing.has(c));
          insertAttempts[table] = (insertAttempts[table] ?? 0) + 1;
          const forced = opts.insertFailure?.[table];
          sent = forced ? { data: null, error: forced } : broken.has(table) ? timeout() : absent ? noColumn(table, absent) : { data: null, error: null };
          if (!sent.error) { inserts.push({ table, payload }); store().push({ ...payload }); }
          return sent;
        };
        const withRows = (): Settled => { const r = exec(); return r.error ? r : { data: [{ ...payload }], error: null }; };
        type Then = Promise<Settled>["then"];
        const selected = {
          then: ((...a: Parameters<Then>) => Promise.resolve(withRows()).then(...a)) as Then,
          maybeSingle: (): Promise<Settled> =>
            Promise.resolve(withRows()).then((r): Settled => (r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null })),
          single: (): never => { throw new Error("fakeTrailsDb does not model insert().select().single()"); },
        };
        return {
          select: () => selected,
          maybeSingle: (): Promise<Settled> => Promise.resolve(exec()),
          then: ((...a: Parameters<Then>) => Promise.resolve(exec()).then(...a)) as Then,
        };
      },
      then(res, rej) {
        return Promise.resolve(run()).then(res, rej);
      },
    };
    // Verbs TrailService never calls: refused honestly, never matched loosely.
    const refuse = (what: string) => (): never => { throw new Error(`fakeTrailsDb does not model ${what}`); };
    Object.assign(b, { single: refuse(".single()"), update: refuse(".update()"), delete: refuse(".delete()"), upsert: refuse(".upsert()") });
    return b;
  }
  const rpc = (): never => { throw new Error("fakeTrailsDb does not model .rpc()"); };
  return { from, rpc, tables, inserts, insertAttempts };
}
