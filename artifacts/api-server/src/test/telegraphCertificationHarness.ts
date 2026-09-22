/**
 * Shared harness for the Telegraph §26/§27 certification suites.
 *
 * NOT A MOCK OF THE THING UNDER TEST. Everything these suites assert about is
 * real: the real `messagingRouter`, the real `canMessage`, the real
 * `isBlockedBetween`, the real `buildCrewCard`, the real event bus. What this
 * file replaces is PostgREST — the data source — so that a race, an unreadable
 * table or a mid-request roster change can be produced deterministically. A
 * suite that only asserted this fake's own behaviour would prove nothing, so
 * every assertion in the suites lands on an output of real code.
 *
 * The fake models the PostgREST builder surface the messaging tree actually
 * uses, including the parts that matter for authorization:
 *
 *   - supabase-js RESOLVES on a database error rather than rejecting, so an
 *     injected error returns `{ data: null, error }` exactly as the real client
 *     would. That is the single most important fidelity property here: it is
 *     the shape that turns dropped `.error` bindings into fail-open
 *     authorization, and a fake that threw instead would make those bugs
 *     untestable.
 *   - `.or()` is really parsed, including the `and(...)` groups the block guard
 *     builds, because "the filter silently stopped matching" is one of the two
 *     failure modes that resolver documents.
 *   - `.maybeSingle()` returns the first row and never raises on multiples;
 *     `.single()` behaves the same. The mutual-block case that made the real
 *     `.maybeSingle()` raise is exercised through `.limit(1)` in the guard
 *     itself, which the fake honours.
 *   - Writes mutate the same store the reads see, so an insert is observable by
 *     a later select in the same request — which is what makes the duplicate
 *     send fixture able to count rows.
 */

import express, { type Express } from "express";
import { createServer, type Server } from "node:http";

export interface InjectedError {
  message: string;
  code?: string;
  /**
   * Inject the error only from the Nth operation on that table onwards
   * (1-based, counted per table across the whole client's life).
   *
   * Needed because several handlers read one table TWICE for two different
   * decisions — the send path reads message_thread_members for the caller's own
   * membership and again for the thread roster — and failing the whole table
   * would make the first read deny, so the second guard would never be reached
   * and a suite would "prove" a refusal that came from somewhere else. Measured:
   * with a whole-table error this suite stayed green after the roster refusal
   * was deliberately deleted from routes/messaging.ts. With afterOps it goes red.
   */
  afterOps?: number;
}

export interface FakeDbOptions {
  /** table → error returned by EVERY operation on that table. */
  errors?: Record<string, InjectedError>;
  /**
   * table → column defaults applied to an inserted row that does not name them.
   *
   * PostgREST returns the row as the DATABASE stored it, defaults applied, and
   * several handlers depend on that. The message-request deduplication is the
   * clearest case: the insert never names `status`, the column defaults to
   * 'pending', and the next request short-circuits on it. A fake without
   * defaults leaves status undefined, the short-circuit never fires, and the
   * anti-flood fixture reports an unbounded flood the real database does not
   * have. Measured — that is exactly what the first run of F-01 reported.
   */
  columnDefaults?: Record<string, Record<string, unknown>>;
  /**
   * Called before each read resolves, with the table name. Lets a fixture
   * mutate the store between two reads inside one handler — the only way to
   * produce "participant removed mid-send" deterministically.
   */
  onRead?: (table: string, store: Record<string, any[]>) => void;
}

export interface Observed {
  selects: Array<{ table: string; sel: string }>;
  inserts: Array<{ table: string; rows: any[] }>;
  updates: Array<{ table: string; patch: any }>;
  upserts: Array<{ table: string; rows: any[] }>;
  deletes: Array<{ table: string }>;
  gte: Array<{ table: string; col: string; val: any }>;
}

type Predicate = (row: any) => boolean;

/** Parse one `col.op.value` term from a PostgREST `.or()` expression. */
function termPredicate(term: string): Predicate | null {
  const m = term.trim().match(/^([A-Za-z0-9_]+)\.([a-z]+)\.(.*)$/);
  if (!m) return null;
  const [, col, op, raw] = m;
  const val = raw === "null" ? null : raw;
  switch (op) {
    case "eq":
      return (r) => String(r[col]) === String(val);
    case "neq":
      return (r) => String(r[col]) !== String(val);
    case "is":
      return (r) => (val === null ? r[col] == null : r[col] === val);
    case "in": {
      // `col.in.("a","b")` — the shape lib/mediaAccess builds to ask whether a
      // message carries one of an object's URL spellings. Without this arm the
      // term parsed as null, the whole `or()` matched NOTHING, and that branch
      // was untestable through this harness: every case came back "denied",
      // which is the same answer a correct deny gives.
      const quoted = raw.match(/"((?:[^"\\]|\\.)*)"/g);
      const vals = quoted
        ? quoted.map((q) => q.slice(1, -1).replace(/\\"/g, '"'))
        : raw.replace(/^\(|\)$/g, "").split(",").map((v) => v.trim());
      return (r) => vals.includes(String(r[col]));
    }
    default:
      return null;
  }
}

/**
 * Parse a PostgREST `.or()` expression into a predicate.
 *
 * Handles the two shapes this tree builds: a flat comma-separated list of
 * terms, and a comma-separated list of `and(term,term)` groups. Anything it
 * cannot parse matches NOTHING, which is the conservative direction: an
 * unparsed block filter must not silently match every row and make a block
 * guard look like it fired when it did not.
 */
function orPredicate(expr: string): Predicate {
  const groups: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      groups.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) groups.push(cur);

  const preds: Predicate[] = [];
  for (const g of groups) {
    const trimmed = g.trim();
    const andMatch = trimmed.match(/^and\((.*)\)$/s);
    if (andMatch) {
      const inner = andMatch[1].split(",").map(termPredicate);
      if (inner.some((p) => p === null)) continue;
      const parts = inner as Predicate[];
      preds.push((r) => parts.every((p) => p(r)));
    } else {
      const p = termPredicate(trimmed);
      if (p) preds.push(p);
    }
  }
  if (preds.length === 0) return () => false;
  return (r) => preds.some((p) => p(r));
}

export interface FakeClient {
  from(table: string): any;
  rpc(name: string, args?: any): Promise<{ data: any; error: any }>;
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } } | { user: null }; error: any }> };
  _store: Record<string, any[]>;
  _observed: Observed;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  const n = idCounter.toString(16).padStart(12, "0");
  return `ffffffff-0000-4000-8000-${n}`;
}

/** Reset the synthetic id sequence so a suite's ids are stable run to run. */
export function resetFakeIds(): void {
  idCounter = 0;
}

export function makeFakeClient(
  seed: Record<string, any[]>,
  opts: FakeDbOptions = {},
): FakeClient {
  const store: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(seed)) store[k] = v.map((r) => ({ ...r }));

  const observed: Observed = {
    selects: [],
    inserts: [],
    updates: [],
    upserts: [],
    deletes: [],
    gte: [],
  };

  const opCounts: Record<string, number> = {};

  function injected(table: string): InjectedError | null {
    const e = opts.errors?.[table];
    if (!e) return null;
    if (e.afterOps === undefined) return e;
    return (opCounts[table] ?? 0) >= e.afterOps ? e : null;
  }

  function from(table: string): any {
    const filters: Predicate[] = [];
    let _limit: number | null = null;
    let _order: { col: string; asc: boolean } | null = null;
    let _head = false;
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let pendingRows: any[] = [];
    let pendingPatch: any = null;

    const rows = (): any[] => {
      opts.onRead?.(table, store);
      let out = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
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

    /** Apply the pending write and return the affected rows. */
    const applyWrite = (): any[] => {
      store[table] = store[table] ?? [];
      if (mode === "insert" || mode === "upsert") {
        const written: any[] = [];
        const defaults = opts.columnDefaults?.[table] ?? {};
        for (const r of pendingRows) {
          const row = { id: r.id ?? nextId(), ...defaults, ...r };
          if (mode === "upsert") {
            const idx = store[table].findIndex(
              (e) =>
                (e.thread_id !== undefined && e.thread_id === row.thread_id && e.user_id === row.user_id) ||
                (row.id !== undefined && e.id === row.id),
            );
            if (idx >= 0) {
              store[table][idx] = { ...store[table][idx], ...row };
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
        const target = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
        for (const r of target) Object.assign(r, pendingPatch);
        return target;
      }
      // delete
      const doomed = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      store[table] = (store[table] ?? []).filter((r) => !doomed.includes(r));
      return doomed;
    };

    const settle = (): { data: any; error: any; count: number | null } => {
      const err = injected(table);
      opCounts[table] = (opCounts[table] ?? 0) + 1;
      if (err) return { data: null, error: err, count: null };
      if (mode === "select") {
        const out = rows();
        return { data: _head ? null : out, error: null, count: out.length };
      }
      const written = applyWrite();
      return { data: written, error: null, count: written.length };
    };

    const target: any = {
      select(sel?: string, o?: any) {
        if (mode === "select") observed.selects.push({ table, sel: sel ?? "" });
        if (o?.head) _head = true;
        return proxy;
      },
      insert(r: any) {
        mode = "insert";
        pendingRows = Array.isArray(r) ? r : [r];
        observed.inserts.push({ table, rows: pendingRows });
        return proxy;
      },
      upsert(r: any) {
        mode = "upsert";
        pendingRows = Array.isArray(r) ? r : [r];
        observed.upserts.push({ table, rows: pendingRows });
        return proxy;
      },
      update(patch: any) {
        mode = "update";
        pendingPatch = patch;
        observed.updates.push({ table, patch });
        return proxy;
      },
      delete() {
        mode = "delete";
        observed.deletes.push({ table });
        return proxy;
      },
      eq(col: string, val: any) { filters.push((r) => String(r?.[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { filters.push((r) => String(r?.[col]) !== String(val)); return proxy; },
      in(col: string, vals: any[]) {
        const set = (vals ?? []).map(String);
        filters.push((r) => set.includes(String(r?.[col])));
        return proxy;
      },
      is(col: string, val: any) {
        filters.push((r) => (val === null ? r?.[col] == null : r?.[col] === val));
        return proxy;
      },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => (val === null ? r?.[col] != null : r?.[col] !== val));
        return proxy;
      },
      or(expr: string) { filters.push(orPredicate(expr)); return proxy; },
      lt(col: string, val: any) { filters.push((r) => Date.parse(r?.[col]) < Date.parse(val)); return proxy; },
      lte(col: string, val: any) { filters.push((r) => Date.parse(r?.[col]) <= Date.parse(val)); return proxy; },
      gt(col: string, val: any) { filters.push((r) => Date.parse(r?.[col]) > Date.parse(val)); return proxy; },
      gte(col: string, val: any) {
        observed.gte.push({ table, col, val });
        filters.push((r) => Date.parse(r?.[col]) >= Date.parse(val));
        return proxy;
      },
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

    // Any builder method this fake does not model keeps the chain alive rather
    // than throwing. A TypeError inside a route would be reported as a 500 and
    // read as "the guard refused", which is the one wrong conclusion a suite
    // about refusals must not be able to draw.
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
    rpc: async () => ({ data: null, error: { message: "rpc not modelled by the certification harness" } }),
    auth: {
      // The bearer token IS the user id, so one app serves every caller.
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: token } }, error: null }
          : { data: { user: null }, error: { message: "no token" } },
    },
    _store: store,
    _observed: observed,
  } as FakeClient;
}

// ── HTTP harness ──────────────────────────────────────────────────────────────

export interface RouterHarness {
  base: string;
  server: Server;
  close(): Promise<void>;
}

export async function startRouter(router: express.Router): Promise<RouterHarness> {
  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${addr.port}/api`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface HttpResult {
  status: number;
  body: any;
}

export async function call(
  base: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  asUser: string,
  body?: any,
): Promise<HttpResult> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${asUser}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}
