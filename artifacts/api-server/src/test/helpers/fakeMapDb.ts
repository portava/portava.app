/**
 * fakeMapDb — an in-memory, PostgREST-shaped Supabase client for the Map
 * producer suites (src/test/mapMeetingPointProducer.test.ts and siblings).
 *
 * Only the operators the producers and the gateway route actually issue are
 * implemented, and an unimplemented one THROWS rather than passing silently —
 * a fake that answers every call with "all rows" turns every filter test into a
 * vacuous pass. `rpc` handlers are injected per test so a suite can assert
 * WHICH arguments reached the database (the owner-only memory read must be
 * called with the viewer's own id, never a client-supplied one).
*
 * ── CHECKED AGAINST THE REAL CLIENT ─────────────────────────────────────────
 * `src/test/supabaseContract.test.ts` runs this double and the REAL installed
 * supabase-js client through the same scenarios every CI run and fails if they
 * disagree anywhere not listed below. Do not "improve" this file by making a
 * scenario pass more loosely; change the scenario, or declare a gap here.
 *
 * MODELLED EXACTLY (measured, not assumed): thenable execution — a builder with
 * no `.then`/`await` performs NOTHING, one with either performs it once;
 * `.single()`/`.maybeSingle()` cardinality including the RESOLVED PGRST116 for
 * more than one row; failures arriving RESOLVED as `{ data: null, error }`,
 * never thrown; a write with no chained `.select()` returning `data: null`, so
 * affected rows are UNKNOWABLE without one; `count` null unless requested.
 *
 * NOT MODELLED — every entry below is enforced: the contract suite fails if the
 * behaviour silently starts agreeing, and fails if a listed operation stops
 * refusing:
 *
 *   thenable/no-continuation, thenable/then-continuation, thenable/awaited,
 *   insert/no-select-returns-null, insert/with-select-returns-rows,
 *   insert/with-select-single, insert/unique-violation-23505,
 *   update/zero-rows-no-select, update/many-rows-no-select,
 *   update/zero-rows-with-select, update/many-rows-with-select,
 *   delete/many-rows-no-select, delete/many-rows-with-select,
 *   failure/write-error-resolves, rls/denied-write-yields-42501,
 *   write/read-after-write-visible — this is a
 *     READ double. Every write verb THROWS. There is no RETURNING, no
 *     affected-row count and no unique index here, so a write assertion made
 *     against it would be about this file rather than about PostgREST.
 *   rls/denied-read-yields-zero-rows — `auth.getUser` tells this fake's token
 *     from a stranger's, but `from()` has no role and no policies, so a denied
 *     read is indistinguishable from an empty one. Passing `role` THROWS.
 *   error/unknown-column-42703 — no schema knowledge. An unknown column reads as
 *     `undefined` instead of failing the whole statement. Use
 *     schemaStrictSupabase for that question.
 */
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import { projectionKeys, projectRow } from "./selectProjection.js";

export interface TableSpec {
  rows?: any[];
  /** When set, every read of this table returns this error (data null). */
  error?: { message: string };
}

export type FakeState = Record<string, TableSpec | any[]>;

export type RpcHandler = (args: Record<string, unknown>) => { data: unknown; error: unknown };

export interface FakeMapDbOptions {
  /** Bearer token the fake accepts, and the user it resolves to. */
  token: string;
  userId: string;
  rpc?: Record<string, RpcHandler>;
  /**
   * Present only so that asking for RLS is LOUD. `auth.getUser` tells the
   * fake's token from a stranger's, but `from()` has no role and no policies;
   * see NOT MODELLED above.
   */
  role?: "service" | "user";
}

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

function specOf(state: FakeState, table: string): TableSpec {
  const v = state[table];
  if (Array.isArray(v)) return { rows: v };
  return v ?? { rows: [] };
}

/** `not(col, "in", '("a","b")')` — the shape loadNearbyEvents issues. */
function parseInList(raw: unknown): string[] {
  const s = String(raw).trim().replace(/^\(/, "").replace(/\)$/, "");
  return s
    .split(",")
    .map((p) => p.trim().replace(/^"/, "").replace(/"$/, ""))
    .filter((p) => p !== "");
}

/**
 * Split at commas OUTSIDE parentheses. `and(a,b)` and `id.in.(u1,u2)` are each
 * one token; a bare `a.eq.x,b.eq.y` splits in two.
 */
function splitOutsideParens(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { if (cur.trim() !== "") out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** PostgREST's answer when `application/vnd.pgrst.object+json` sees != 1 row. */
function pgrst116(n: number) {
  return {
    data: null,
    error: {
      code: "PGRST116",
      details: `Results contain ${n} rows, application/vnd.pgrst.object+json requires 1 row`,
      hint: null,
      message: "JSON object requested, multiple (or no) rows returned",
    },
  };
}

function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  // `null` = do not project (the historical behaviour: the whole seeded row).
  // Narrowing happens on the way OUT only — the real database filters and sorts
  // on the full row and projects last, and filtering on an unselected column is
  // legal PostgREST. See selectProjection.ts.
  let projection: Array<[string, string]> | null = null;
  let countMode: string | null = null;
  let headOnly = false;
  const narrow = (rs: any[]) => (projection ? rs.map((r) => projectRow(r, projection!)) : rs);
  const narrowOne = (r: any) => (r && projection ? projectRow(r, projection) : r);
  // `count` mirrors PostgREST's Content-Range: null unless the caller asked.
  const result = () =>
    err ? { data: null, error: err, count: null } : { data: headOnly ? null : narrow(rows), error: null, count: countMode ? rows.length : null };

  const refuseWrite = (verb: string) => () => {
    throw new Error(
      `fakeMapDb does not model writes (called .${verb}()). It is a READ double for the Map producers: ` +
        "there is no RETURNING, no affected-row count and no unique index here, so a write assertion made " +
        "against it would be about this file rather than about PostgREST. Use failClosedSupabase or fakeLayoverDb.",
    );
  };

  const q: any = {
    select(fields?: string, o?: { count?: string; head?: boolean }) {
      projection = projectionKeys(fields);
      if (o?.count) countMode = String(o.count);
      if (o?.head) headOnly = true;
      return q;
    },
    insert: refuseWrite("insert"),
    upsert: refuseWrite("upsert"),
    update: refuseWrite("update"),
    delete: refuseWrite("delete"),
    order() { return q; },
    range() { return q; },
    limit(n: number) { rows = rows.slice(0, n); return q; },
    eq(col: string, val: any) { rows = rows.filter((r) => r[col] === val); return q; },
    neq(col: string, val: any) { rows = rows.filter((r) => r[col] !== val); return q; },
    in(col: string, vals: any[]) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
    gt(col: string, val: any) { rows = rows.filter((r) => r[col] > val); return q; },
    gte(col: string, val: any) { rows = rows.filter((r) => r[col] >= val); return q; },
    lt(col: string, val: any) { rows = rows.filter((r) => r[col] < val); return q; },
    lte(col: string, val: any) { rows = rows.filter((r) => r[col] <= val); return q; },
    is(col: string, val: any) {
      rows = rows.filter((r) => (val === null ? r[col] == null : r[col] === val));
      return q;
    },
    not(col: string, op: string, val: any) {
      if (op === "is" && val === null) { rows = rows.filter((r) => r[col] != null); return q; }
      if (op === "in") { const list = parseInList(val); rows = rows.filter((r) => !list.includes(r[col])); return q; }
      throw new Error(`fakeMapDb: unsupported not(${col}, ${op})`);
    },
    /** jsonb containment: every key of `obj` present and equal on the row's column. */
    contains(col: string, obj: Record<string, unknown>) {
      rows = rows.filter((r) => {
        const v = r[col];
        if (!v || typeof v !== "object") return false;
        return Object.entries(obj).every(([k, want]) => (v as any)[k] === want);
      });
      return q;
    },
    or(expr: string) {
      // "col.eq.val,col2.eq.val2", "and(a.eq.x,b.eq.y),and(...)" and
      // "col.in.(a,b),col2.in.(c)" — the shapes the readers under test issue.
      //
      // Splitting is TOP-LEVEL ONLY. An in-list's own commas sit inside
      // parentheses, and a naive `split(",")` turned `id.in.(u1,u2)` into
      // `id.in.(u1` plus an unparseable `u2)`, so every id after the first
      // silently matched nothing — a fake answering a multi-id filter with
      // fewer rows than the database would, which is exactly the vacuous pass
      // this helper exists to prevent.
      const groups = splitOutsideParens(String(expr));
      const conds = groups.map((g) => {
        const inner = g.startsWith("and(") ? g.slice(4, -1) : g;
        const parts = splitOutsideParens(inner)
          .map((p) => p.trim().match(/^([\w.]+)\.(\w+)\.(.*)$/))
          .filter(Boolean) as RegExpMatchArray[];
        const all = g.startsWith("and(");
        return (r: any) => {
          const hits = parts.map((m) => {
            const [, col, op, val] = m;
            if (op === "eq") return String(r[col]) === val;
            if (op === "in") return parseInList(val).includes(String(r[col]));
            throw new Error(`fakeMapDb: unsupported or() operator ${op}`);
          });
          return all ? hits.every(Boolean) : hits.some(Boolean);
        };
      });
      rows = rows.filter((r) => conds.some((c) => c(r)));
      return q;
    },
    maybeSingle() {
      if (err) return Promise.resolve({ data: null, error: err });
      if (rows.length > 1) return Promise.resolve(pgrst116(rows.length));
      return Promise.resolve({ data: narrowOne(rows[0] ?? null), error: null });
    },
    single() {
      if (err) return Promise.resolve({ data: null, error: err });
      if (rows.length !== 1) return Promise.resolve(pgrst116(rows.length));
      return Promise.resolve({ data: narrowOne(rows[0]), error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

export function makeFakeMapDb(state: FakeState, opts: FakeMapDbOptions) {
  if (opts.role !== undefined) {
    throw new Error(
      "fakeMapDb does not model RLS: `from()` has one table set and no policies, so a denied read is " +
        "indistinguishable from an empty one here. Use failClosedSupabase (role/rlsHiddenTables).",
    );
  }
  const rpcCalls: RpcCall[] = [];
  const client: any = {
    auth: {
      getUser: async (token: string) =>
        token === opts.token
          ? { data: { user: { id: opts.userId } }, error: null }
          : { data: { user: null }, error: { message: "Unauthorized" } },
    },
    from: (table: string) => buildQuery(specOf(state, table)),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const h = opts.rpc?.[fn];
      const out = h
        ? h(args)
        : {
            data: null,
            error: { code: "PGRST202", details: null, hint: null, message: `Could not find the function public.${fn}` },
          };
      return Promise.resolve(out);
    },
    __rpcCalls: rpcCalls,
  };
  return client;
}

export interface ProjectionApp {
  baseUrl: string;
  client: any;
  close: () => Promise<void>;
  /** GET /api/map/projection with the fake's bearer token. */
  projection: (query: string) => Promise<{ status: number; body: any }>;
}

/**
 * Mount a router (the gateway, normally) over the fake and start it on a
 * loopback port. Host-less `listen(0)` binds `[::]` and a foreign IPv4
 * listener can steal the request, so the bind is explicit.
 */
export async function startRouterApp(
  router: express.Router,
  state: FakeState,
  opts: FakeMapDbOptions,
): Promise<ProjectionApp> {
  const client = makeFakeMapDb(state, opts);
  _setTestClient(client, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", router);

  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        client,
        close: () =>
          new Promise<void>((res, rej) => {
            srv.closeAllConnections();
            srv.close((e) => (e ? rej(e) : res()));
          }),
        projection: async (query: string) => {
          const r = await fetch(`${baseUrl}/api/map/projection?${query}`, {
            headers: { Authorization: `Bearer ${opts.token}` },
          });
          return { status: r.status, body: await r.json() };
        },
      });
    });
    srv.on("error", reject);
  });
}
