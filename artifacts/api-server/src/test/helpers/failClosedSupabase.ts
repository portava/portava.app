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

      const ctx: FakeReadContext = {
        table,
        filters,
        eq(col: string) { return filters.find((f) => f.col === col && f.op === "eq")?.val; },
      };

      function matched(): Record<string, any>[] {
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
        return { data: Array.isArray(writePayload) ? writePayload : [writePayload], error: null, count: null };
      }

      const builder: any = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
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
          if (writeKind) return Promise.resolve(settleWrite());
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
            return Promise.resolve(w.error ? w : { data: (w.data as any[])[0] ?? null, error: null });
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
    rpc(_fn: string, _args?: any) {
      return Promise.resolve({ data: null, error: null });
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
