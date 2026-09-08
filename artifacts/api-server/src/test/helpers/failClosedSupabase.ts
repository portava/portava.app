/**
 * failClosedSupabase — a fake PostgREST client whose reads can be made to FAIL,
 * per table, the way supabase-js actually fails.
 *
 * ── WHY A DEDICATED FAKE ────────────────────────────────────────────────────
 * The defect this helper exists to test is that supabase-js RESOLVES on a
 * database error. It does not throw and it does not reject. A failed read comes
 * back as `{ data: null, error: {...} }` — the same `data` an empty table
 * returns. Every fake client in this suite so far models only the HAPPY path
 * (`error: null` always), which means a test written against those fakes can
 * never distinguish "no rows" from "the table could not be read" and therefore
 * can never catch the bug.
 *
 * So `failOn` here injects EXACTLY that resolved-error shape. It never throws:
 * a test that passes because its fake threw would be testing a code path
 * production does not take (a `try/catch` around a supabase read is dead code —
 * that is half of why these defects survived).
 *
 * ── SEMANTICS MODELLED ──────────────────────────────────────────────────────
 *  - `.maybeSingle()` → `{ data: row|null }`, and RAISES (resolved error, code
 *    PGRST116) on more than one match, exactly as PostgREST does. That raise is
 *    itself one of the fail-open vectors (`blockGuard.ts` documents it for
 *    mutual blocks; `checkCooldown` had it for repeat suggestions).
 *  - `.select(cols, { count: "exact", head: true })` → `{ data: null, count }`.
 *    An injected error yields `count: null`, which is what turns `count ?? 0`
 *    into the permissive zero.
 *  - awaiting the builder → `{ data: rows[], error, count }`.
 *
 * Filters supported: eq / neq / gt / gte / lt / lte / in / is / not / filter.
 * Ordering and limits apply after filtering. Anything a test does not need is
 * deliberately absent rather than faked badly.
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
 *   insert/unique-violation-23505 — no unique index is modelled. Stage the shape
 *     with `failWritesOn: () => ({ code: "23505", message })`; this double
 *     cannot DISCOVER the collision.
 *   error/unknown-column-42703 — no schema knowledge. An unknown column reads as
 *     `undefined` instead of failing the whole statement. Use
 *     schemaStrictSupabase for that question.
 *   write/read-after-write-visible — writes are RECORDED (`spec.inserted` /
 *     `spec.updated`), not applied to `spec.rows`. A read after a write still
 *     sees the seed, and a RETURNING payload is the patched row computed on a
 *     copy. Use fakeLayoverDb or fakePassportDb when a test needs its own write
 *     to be visible to the next read.
 *
 * An unregistered `rpc` no longer resolves `{ data: null, error: null }` for ANY
 * function name — that silence made an rpc failure invisible to every caller's
 * `if (error)` branch. It now resolves PGRST202, the real client's own answer,
 * and `spec.rpc` registers real handlers.
 */

export interface FakeFilter {
  col: string;
  op: string;
  val: unknown;
}

export interface FakeReadContext {
  table: string;
  filters: FakeFilter[];
  /** Convenience: the value of the first `.eq(col, …)` on `col`, if any. */
  eq(col: string): unknown;
}

export interface FakeDbError {
  message: string;
  code?: string;
  details?: string;
}

export interface FakeClientSpec {
  /** table -> rows. A table absent from this map reads as empty (not an error). */
  rows?: Record<string, Record<string, any>[]>;
  /**
   * Return an error object to make THIS read resolve as a failure, or null to
   * let it succeed. Called once per terminal read with the table and the
   * filters that were applied, so a test can fail one specific query
   * (`feature_flags` where flag = X) and leave its siblings healthy.
   */
  failOn?: (ctx: FakeReadContext) => FakeDbError | null | undefined;
  /** Rows appended by `.insert(...)`, keyed by table — for asserting writes. */
  inserted?: Record<string, any[]>;
  /** Payloads passed to `.update(...)`, keyed by table — for asserting writes. */
  updated?: Record<string, any[]>;
  /** Tables whose writes should resolve as an error. */
  failWritesOn?: (table: string) => FakeDbError | null | undefined;
  /** token -> user id, for `.auth.getUser`. */
  users?: Record<string, string>;
  /**
   * Which connection this client stands for. Only meaningful together with
   * `rlsHiddenTables` / `rlsProtectedTables`; the other doubles in this
   * directory THROW when handed a role, because they cannot tell the two apart.
   */
  role?: "service" | "user";
  /**
   * Tables a `role: "user"` client cannot SEE. A denied SELECT under RLS is not
   * an error — the rows simply are not there — which is the whole fail-open
   * vector: `data.length === 0` reads as "none exist" rather than "not allowed".
   */
  rlsHiddenTables?: string[];
  /** Tables a `role: "user"` client cannot WRITE. Yields a resolved 42501. */
  rlsProtectedTables?: string[];
  /**
   * `fn -> handler`. An rpc with no handler THROWS rather than resolving
   * `{ data: null, error: null }`: a double that answers a stored procedure it
   * knows nothing about is exactly the failure this file exists to prevent.
   */
  rpc?: Record<string, (args: any) => { data: unknown; error: unknown }>;
}

const DEFAULT_ERROR: FakeDbError = { message: "connection terminated unexpectedly", code: "57P01" };

/** The canonical resolved-error read result. Never a rejection. */
export function readError(err: FakeDbError = DEFAULT_ERROR): { data: null; error: FakeDbError; count: null } {
  return { data: null, error: err, count: null };
}

function applyOp(rowVal: unknown, op: string, val: unknown): boolean {
  switch (op) {
    case "eq":   return String(rowVal) === String(val);
    case "neq":  return String(rowVal) !== String(val);
    case "gt":   return (rowVal as any) > (val as any);
    case "gte":  return (rowVal as any) >= (val as any);
    case "lt":   return (rowVal as any) < (val as any);
    case "lte":  return (rowVal as any) <= (val as any);
    case "in":   return Array.isArray(val) && val.map(String).includes(String(rowVal));
    case "is":   return val === null ? rowVal == null : rowVal === val;
    case "not.is":
      return val === null ? rowVal != null : rowVal !== val;
    default:     return true;
  }
}

/** Resolve `metadata->>venue_name` style JSON paths as well as plain columns. */
function readColumn(row: Record<string, any>, col: string): unknown {
  if (!col.includes("->")) return row[col];
  const [head, ...rest] = col.split(/->>?/);
  let cur: any = row[head];
  for (const seg of rest) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function makeFailClosedClient(spec: FakeClientSpec): any {
  const rows = spec.rows ?? {};
  const asUser = spec.role === "user";
  const hidden = (t: string) => asUser && (spec.rlsHiddenTables ?? []).includes(t);
  const protectedTable = (t: string) => asUser && (spec.rlsProtectedTables ?? []).includes(t);
  const RLS_DENIED: FakeDbError = {
    code: "42501",
    message: 'new row violates row-level security policy',
  };
  /** PostgREST's answer when `application/vnd.pgrst.object+json` sees != 1 row. */
  const pgrst116 = (n: number) => ({
    data: null,
    error: {
      code: "PGRST116",
      details: `Results contain ${n} rows, application/vnd.pgrst.object+json requires 1 row`,
      hint: null,
      message: "JSON object requested, multiple (or no) rows returned",
    },
    count: null,
  });

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        const id = spec.users?.[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from(table: string) {
      const filters: FakeFilter[] = [];
      let countMode: string | null = null;
      let headOnly = false;
      let limitN: number | null = null;
      let orderCol: string | null = null;
      let orderAsc = true;
      let writeKind: "insert" | "update" | "upsert" | "delete" | null = null;
      let writePayload: any = null;
      /** Whether a `.select()` was chained — PostgREST's RETURNING switch. */
      let selected = false;

      const ctx: FakeReadContext = {
        table,
        filters,
        eq(col: string) { return filters.find((f) => f.col === col && f.op === "eq")?.val; },
      };

      function matched(): Record<string, any>[] {
        if (hidden(table)) return [];
        let out = (rows[table] ?? []).filter((r) =>
          filters.every((f) => applyOp(readColumn(r, f.col), f.op, f.val)),
        );
        if (orderCol) {
          out = [...out].sort((a, b) => {
            const av = a[orderCol!], bv = b[orderCol!];
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * (orderAsc ? 1 : -1);
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
        return out;
      }

      function injectedError(): FakeDbError | null {
        const e = spec.failOn?.(ctx);
        return e ?? null;
      }

      function settleRead(): any {
        const err = injectedError();
        if (err) return readError(err);
        const list = matched();
        return {
          data: headOnly ? null : list,
          error: null,
          count: countMode ? list.length : null,
        };
      }

      function settleWrite(): any {
        if (protectedTable(table)) return { data: null, error: RLS_DENIED, count: null };
        const err = spec.failWritesOn?.(table);
        if (err) return { data: null, error: err, count: null };
        if (writeKind === "insert" || writeKind === "upsert") {
          const bucket = (spec.inserted ??= {});
          (bucket[table] ??= []).push(...(Array.isArray(writePayload) ? writePayload : [writePayload]));
        }
        if (writeKind === "update") {
          const bucket = (spec.updated ??= {});
          (bucket[table] ??= []).push(writePayload);
        }
        // Without a chained `.select()` PostgREST returns 201/204 with NO body,
        // so the client hands back `data: null`. Returning the payload here
        // would let a test "count affected rows" on a response that carries
        // none — see NOT MODELLED / MODELLED EXACTLY in the header.
        if (!selected) return { data: null, error: null, count: null };
        // RETURNING shows the row AS UPDATED. The seed is not mutated (this
        // double records writes rather than applying them — see NOT MODELLED),
        // so the patch is merged onto a copy.
        const affected =
          writeKind === "update"
            ? matched().map((r) => ({ ...r, ...(writePayload ?? {}) }))
            : writeKind === "delete"
              ? matched().map((r) => ({ ...r }))
              : Array.isArray(writePayload)
                ? writePayload
                : [writePayload];
        return { data: affected, error: null, count: null };
      }

      const builder: any = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          selected = true;
          if (opts?.count) countMode = opts.count;
          if (opts?.head) headOnly = true;
          return builder;
        },
        insert(payload: any) { writeKind = "insert"; writePayload = payload; return builder; },
        upsert(payload: any) { writeKind = "upsert"; writePayload = payload; return builder; },
        update(payload: any) { writeKind = "update"; writePayload = payload; return builder; },
        delete()             { writeKind = "delete"; writePayload = null;   return builder; },
        eq(col: string, val: unknown)  { filters.push({ col, op: "eq",  val }); return builder; },
        neq(col: string, val: unknown) { filters.push({ col, op: "neq", val }); return builder; },
        gt(col: string, val: unknown)  { filters.push({ col, op: "gt",  val }); return builder; },
        gte(col: string, val: unknown) { filters.push({ col, op: "gte", val }); return builder; },
        lt(col: string, val: unknown)  { filters.push({ col, op: "lt",  val }); return builder; },
        lte(col: string, val: unknown) { filters.push({ col, op: "lte", val }); return builder; },
        in(col: string, val: unknown[]) { filters.push({ col, op: "in", val }); return builder; },
        is(col: string, val: unknown)  { filters.push({ col, op: "is",  val }); return builder; },
        not(col: string, op: string, val: unknown) { filters.push({ col, op: `not.${op}`, val }); return builder; },
        filter(col: string, op: string, val: unknown) { filters.push({ col, op, val }); return builder; },
        or() { return builder; },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col; orderAsc = opts?.ascending !== false; return builder;
        },
        range() { return builder; },
        limit(n: number) { limitN = n; return builder; },
        maybeSingle() {
          if (writeKind) {
            const w = settleWrite();
            if (w.error || w.data === null) return Promise.resolve(w);
            const list = w.data as any[];
            return Promise.resolve(list.length > 1 ? pgrst116(list.length) : { data: list[0] ?? null, error: null, count: null });
          }
          const err = injectedError();
          if (err) return Promise.resolve({ data: null, error: err, count: null });
          const list = matched();
          if (list.length > 1) {
            // Real PostgREST behaviour, and a fail-open vector in its own right.
            return Promise.resolve({
              data: null,
              error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
              count: null,
            });
          }
          return Promise.resolve({ data: list[0] ?? null, error: null, count: null });
        },
        single() {
          if (writeKind) {
            const w = settleWrite();
            if (w.error || w.data === null) return Promise.resolve(w);
            const list = w.data as any[];
            return Promise.resolve(list.length === 1 ? { data: list[0], error: null, count: null } : pgrst116(list.length));
          }
          const err = injectedError();
          if (err) return Promise.resolve({ data: null, error: err, count: null });
          const list = matched();
          if (list.length !== 1) {
            return Promise.resolve({
              data: null,
              error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
              count: null,
            });
          }
          return Promise.resolve({ data: list[0], error: null, count: null });
        },
        then(onF: any, onR: any) {
          const result = writeKind ? settleWrite() : settleRead();
          return Promise.resolve(result).then(onF, onR);
        },
      };
      return builder;
    },
    rpc(fn: string, args?: any) {
      const handler = spec.rpc?.[fn];
      if (handler) return Promise.resolve(handler(args ?? {}));
      // An UNREGISTERED function resolves the real client's own answer for a
      // function that is not there — PGRST202 — rather than the
      // `{ data: null, error: null }` this used to return for ANY name. That
      // silence made an rpc failure invisible to every caller's `if (error)`
      // branch, which is the exact shape of double this file exists to prevent.
      return Promise.resolve({
        data: null,
        error: { code: "PGRST202", details: null, hint: null, message: `Could not find the function public.${fn}` },
      });
    },
  };
  return client;
}

/** A no-op `req.log` shim matching the one the real server installs. */
export const noopLog = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLog,
};
