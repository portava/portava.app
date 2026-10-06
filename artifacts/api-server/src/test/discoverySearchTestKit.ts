/**
 * discoverySearchTestKit — ONE PostgREST-shaped fake and ONE express harness for
 * the census-discovery §46 suites (discoverySearch*.test.ts). Not a test file:
 * it declares no test and is imported by the suites that do.
 *
 * WHY A KIT RATHER THAN A FOURTH COPY. The route suites that already exist each
 * carry a private fake, and they disagree about what an unmodelled operator
 * does (some return the builder, some return nothing). This one is LOUD: an
 * operator it does not model throws, so a future query shape cannot slip past a
 * negative test by being silently ignored. It models exactly what
 * routes/discoverySearch.ts, lib/blocks, lib/publicIdentity, the Passport list
 * projection, lib/featureFlags, lib/protectedZoneStore, lib/canonicalLocations,
 * lib/discoverySearchCanonical and lib/discoveryServeLog issue.
 *
 * FAILURE SHAPES ARE MODELLED ON WHAT POSTGREST SENDS, not invented:
 *   • a table error resolves `{ data: null, error }` (supabase-js never throws);
 *   • a column that does not exist resolves 42703 with PostgreSQL's own
 *     wording — the local-harness suite captures the real message and pins the
 *     classifier against it;
 *   • `throwTables` makes the builder REJECT, which is the other shape a read
 *     can fail in (a network reset), and which every reader must also survive.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

export const VIEWER = "aa000000-0000-4000-a000-000000000001";
export const VIEWER_TOKEN = "tok-viewer";

export interface KitError { code?: string; message: string }

export interface KitState {
  /** Rows per table. Mutated in place by a test to model a change between requests. */
  rows: Record<string, any[]>;
  /** Tables whose every read resolves with this error. */
  errorTables: Record<string, KitError>;
  /** `table.column` pairs: any read that names the column resolves 42703. */
  missingColumns: Set<string>;
  /** Tables whose reads REJECT (throw) instead of resolving. */
  throwTables: Set<string>;
  /** feature_flags: true / false / "error" (unreadable). Absent key ⇒ no row. */
  flags: Record<string, boolean | "error">;
  /**
   * A NARROW failure: fail one query shape and not another on the same table
   * (e.g. the owner-status read on `profiles` but not the caller's own ban
   * check). Called at resolution with the columns the query named.
   */
  errorOn?: (q: { table: string; named: ReadonlySet<string>; terminal: "then" | "maybeSingle" }) => KitError | null;
}

export interface KitCalls {
  /** Every `from(table)` in order. */
  tables: string[];
  /** Every `.or(expr)` string, with its table. */
  ors: Array<{ table: string; expr: string }>;
  /** Every `.ilike(col, pat)` with its table. */
  ilikes: Array<{ table: string; col: string; pat: string }>;
  /** Every insert / upsert payload. */
  writes: Array<{ table: string; op: "insert" | "upsert" | "update" | "delete"; rows: any[] }>;
  /** Every column list a read asked for (`*` when none was named). */
  selects: Array<{ table: string; cols: string }>;
}

export function emptyState(over: Partial<KitState> = {}): KitState {
  return {
    rows: {},
    errorTables: {},
    missingColumns: new Set(),
    throwTables: new Set(),
    flags: {},
    ...over,
  };
}

function likeToRegExp(pat: string): RegExp {
  // PostgREST's `ilike`: % = any run, _ = one char, backslash escapes either.
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]!;
    if (ch === "\\" && i + 1 < pat.length) { re += pat[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (ch === "%") { re += ".*"; continue; }
    if (ch === "_") { re += "."; continue; }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

function parseInList(val: string): string[] {
  return String(val).replace(/^\(|\)$/g, "").split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
}

const UNMODELLED = ["csv", "geojson", "explain", "rollback", "returns", "abortSignal", "textSearch", "match", "filter", "contains", "containedBy", "overlaps"];

/** Build the fake. `state` is read at CALL time, so a test may mutate it between requests. */
export function makeKitClient(state: KitState, calls: KitCalls) {
  function builder(table: string) {
    calls.tables.push(table);
    const filters: Array<(r: any) => boolean> = [];
    const named = new Set<string>();
    let rangeFrom = 0;
    let rangeTo = Infinity;
    let limitN = Infinity;
    let mode: "select" | "write" = "select";
    let selectCols: string[] | null = null;
    // PostgREST reverse to-many embeds through a named FK, `rel!rel_col_fkey(a, b)` (the auth
    // gate's user_account_states read, lib/accountStateGate.ts): `rel` rows whose `col` is this row's id.
    let embeds: Array<{ rel: string; col: string; cols: string[] }> = [];

    const failure = (terminal: "then" | "maybeSingle"): { data: null; error: KitError } | null => {
      if (state.errorTables[table]) return { data: null, error: state.errorTables[table]! };
      const narrow = mode === "select" ? state.errorOn?.({ table, named, terminal }) ?? null : null;
      if (narrow) return { data: null, error: narrow };
      for (const col of named) {
        if (state.missingColumns.has(`${table}.${col}`)) {
          return { data: null, error: { code: "42703", message: `column ${table}.${col} does not exist` } };
        }
      }
      return null;
    };
    const rowsNow = () => (state.rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const project = (rs: any[]) =>
      selectCols === null ? rs : rs.map((r) => ({
        ...Object.fromEntries(selectCols!.filter((c) => c in r).map((c) => [c, r[c]])),
        ...Object.fromEntries(embeds.map((e) => [e.rel, (state.rows[e.rel] ?? []).filter((x) => x[e.col] === r.id)
          .map((x) => Object.fromEntries(e.cols.map((c) => [c, x[c] ?? null])))])),
      }));

    const b: any = {
      select(cols?: string) {
        if (mode === "write") return b; // RETURNING after a write
        calls.selects.push({ table, cols: typeof cols === "string" ? cols : "*" });
        if (typeof cols === "string" && cols.trim() !== "*") {
          const items: string[] = [];
          let depth = 0, cur = "";
          for (const ch of cols) {
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            if (ch === "," && depth === 0) { items.push(cur.trim()); cur = ""; continue; }
            cur += ch;
          }
          items.push(cur.trim());
          embeds = items.flatMap((it) => {
            const m = /^([a-z_]+)!([a-z_]+)\((.*)\)$/.exec(it);
            if (!m || !m[2]!.startsWith(`${m[1]}_`) || !m[2]!.endsWith("_fkey")) return [];
            return [{ rel: m[1]!, col: m[2]!.slice(m[1]!.length + 1, -"_fkey".length), cols: m[3]!.split(",").map((c) => c.trim()).filter(Boolean) }];
          });
          selectCols = items.filter((c) => c && !c.includes("("));
          for (const c of selectCols) named.add(c);
        }
        return b;
      },
      eq(col: string, v: any) { named.add(col); filters.push((r) => r[col] === v); return b; },
      neq(col: string, v: any) { named.add(col); filters.push((r) => r[col] !== v); return b; },
      gt(col: string, v: any) { named.add(col); filters.push((r) => r[col] != null && r[col] > v); return b; },
      gte(col: string, v: any) { named.add(col); filters.push((r) => r[col] != null && r[col] >= v); return b; },
      lt(col: string, v: any) { named.add(col); filters.push((r) => r[col] != null && r[col] < v); return b; },
      lte(col: string, v: any) { named.add(col); filters.push((r) => r[col] != null && r[col] <= v); return b; },
      in(col: string, vals: any[]) { named.add(col); const s = new Set(vals); filters.push((r) => s.has(r[col])); return b; },
      is(col: string, v: any) { named.add(col); filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return b; },
      not(col: string, op: string, v: any) {
        named.add(col);
        if (op === "is") { filters.push((r) => (v === null ? r[col] != null : r[col] !== v)); return b; }
        if (op === "in") { const s = new Set(parseInList(v)); filters.push((r) => !s.has(String(r[col] ?? ""))); return b; }
        if (op === "eq") { filters.push((r) => r[col] !== v); return b; }
        throw new Error(`kit: unmodelled .not(${col}, "${op}")`);
      },
      ilike(col: string, pat: string) {
        named.add(col);
        calls.ilikes.push({ table, col, pat });
        const re = likeToRegExp(pat);
        filters.push((r) => r[col] != null && re.test(String(r[col])));
        return b;
      },
      or(expr: string) {
        calls.ors.push({ table, expr });
        const parts = expr.split(",").map((p) => {
          const m = p.trim().match(/^([\w]+)\.(ilike|eq)\.(.*)$/);
          if (!m) throw new Error(`kit: unmodelled .or() clause "${p}"`);
          named.add(m[1]!);
          return { col: m[1]!, op: m[2]!, val: m[3]! };
        });
        filters.push((r) => parts.some(({ col, op, val }) =>
          op === "eq" ? String(r[col] ?? "") === val : r[col] != null && likeToRegExp(val).test(String(r[col]))));
        return b;
      },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      range(from: number, to: number) { rangeFrom = from; rangeTo = to; return b; },
      insert(rows: any) { mode = "write"; calls.writes.push({ table, op: "insert", rows: Array.isArray(rows) ? rows : [rows] }); return b; },
      upsert(rows: any) { mode = "write"; calls.writes.push({ table, op: "upsert", rows: Array.isArray(rows) ? rows : [rows] }); return b; },
      update(patch: any) { mode = "write"; calls.writes.push({ table, op: "update", rows: [patch] }); return b; },
      delete() { mode = "write"; calls.writes.push({ table, op: "delete", rows: [] }); return b; },
      async maybeSingle() {
        if (state.throwTables.has(table)) throw new Error(`kit: ${table} read rejected`);
        const f = failure("maybeSingle");
        if (f) return f;
        if (mode === "write") return { data: null, error: null };
        const rs = project(rowsNow());
        return { data: rs[0] ?? null, error: null };
      },
      async single() {
        const r = await b.maybeSingle();
        if (r.error) return r;
        return r.data === null ? { data: null, error: { code: "PGRST116", message: "no rows" } } : r;
      },
      then(onF: any, onR: any) {
        const settle = async () => {
          if (state.throwTables.has(table)) throw new Error(`kit: ${table} read rejected`);
          const f = failure("then");
          if (f) return f;
          if (mode === "write") return { data: null, error: null };
          const end = rangeTo < Infinity ? rangeTo + 1 : limitN < Infinity ? rangeFrom + limitN : undefined;
          return { data: project(rowsNow().slice(rangeFrom, end)), error: null };
        };
        return settle().then(onF, onR);
      },
    };
    for (const op of UNMODELLED) b[op] = () => { throw new Error(`kit: '${op}' is not modelled — model it rather than assume it works`); };
    return b;
  }

  function flagBuilder() {
    calls.tables.push("feature_flags");
    let flag: string | null = null;
    const b: any = {
      select() { return b; },
      eq(col: string, v: any) { if (col === "flag") flag = v; return b; },
      in() { return b; },
      async maybeSingle() {
        const v = flag === null ? undefined : state.flags[flag];
        if (v === "error") return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        if (v === undefined) return { data: null, error: null };
        return { data: { enabled: v, metadata: null }, error: null };
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: Object.entries(state.flags).filter(([, v]) => v !== "error").map(([f, v]) => ({ flag: f, enabled: v })), error: null }).then(onF, onR);
      },
    };
    return b;
  }

  return {
    auth: {
      getUser: async (tok: string) =>
        tok === VIEWER_TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => (table === "feature_flags" ? flagBuilder() : builder(table)),
    rpc: async () => ({ data: null, error: null }),
  };
}

export function emptyCalls(): KitCalls {
  return { tables: [], ors: [], ilikes: [], writes: [], selects: [] };
}

/** An express app mounting `router` at /api, listening on an ephemeral port. */
export async function startKitServer(router: any): Promise<{ base: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", router);
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}/api`, server };
}

/** Install a fresh fake for the next request(s). Returns the state and calls so a test can mutate / inspect. */
export function installKit(over: Partial<KitState> = {}): { state: KitState; calls: KitCalls } {
  const state = emptyState(over);
  const calls = emptyCalls();
  _resetRateLimit();
  _setTestClient(makeKitClient(state, calls) as any, true);
  return { state, calls };
}

export async function kitGet(base: string, path: string, token: string | null = VIEWER_TOKEN): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

/** A served list without its per-exposure `recommendationId` (DV-40 mints one per request). */
export function sansExposure<T extends Record<string, any>>(rows: T[] | undefined | null): Array<Omit<T, "recommendationId">> {
  return (rows ?? []).map(({ recommendationId: _rid, ...rest }) => rest);
}

/** Let the fire-and-forget serve log settle after a response. */
export async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
