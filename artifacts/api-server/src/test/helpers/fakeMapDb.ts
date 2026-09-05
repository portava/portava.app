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

function buildQuery(spec: TableSpec) {
  let rows = [...(spec.rows ?? [])];
  const err = spec.error ?? null;
  // `null` = do not project (the historical behaviour: the whole seeded row).
  // Narrowing happens on the way OUT only — the real database filters and sorts
  // on the full row and projects last, and filtering on an unselected column is
  // legal PostgREST. See selectProjection.ts.
  let projection: Array<[string, string]> | null = null;
  const narrow = (rs: any[]) => (projection ? rs.map((r) => projectRow(r, projection!)) : rs);
  const narrowOne = (r: any) => (r && projection ? projectRow(r, projection) : r);
  const result = () => (err ? { data: null, error: err } : { data: narrow(rows), error: null });

  const q: any = {
    select(fields?: string) { projection = projectionKeys(fields); return q; },
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
      // "col.eq.val,col2.eq.val2" and "and(a.eq.x,b.eq.y),and(...)" — the two
      // shapes the readers under test issue.
      const groups = String(expr).match(/and\([^)]*\)|[^,]+/g) ?? [];
      const conds = groups.map((g) => {
        const inner = g.startsWith("and(") ? g.slice(4, -1) : g;
        const parts = inner.split(",").map((p) => p.trim().match(/^([\w.]+)\.(\w+)\.(.*)$/)).filter(Boolean) as RegExpMatchArray[];
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
      return Promise.resolve(err ? { data: null, error: err } : { data: narrowOne(rows[0] ?? null), error: null });
    },
    single() {
      return Promise.resolve(err ? { data: null, error: err } : { data: narrowOne(rows[0] ?? null), error: null });
    },
    then(resolve: (v: any) => void, reject?: (e: any) => void) {
      return Promise.resolve(result()).then(resolve, reject);
    },
  };
  return q;
}

export function makeFakeMapDb(state: FakeState, opts: FakeMapDbOptions) {
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
      const out = h ? h(args) : { data: null, error: { message: `fakeMapDb: no rpc handler for ${fn}` } };
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
