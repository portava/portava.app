/**
 * fakeCandidateDb — an in-memory PostgREST stand-in for census-discovery §85
 * (lane W10-R3): the candidate-generation, exploration, cold-start and
 * city-confidence suites.
 *
 * WHY ANOTHER FAKE. The §85 retrievals ORDER, WINDOW and PAGE their reads, and
 * a fake that ignores `order`, `gte` or `range` would pass a test of a read that
 * forgot its window. This one applies every filter it models — `eq`, `neq`,
 * `in`, `is(null)`, `not(col, 'eq' | 'is', v)`, `gt`/`gte`/`lt`/`lte`, `like`,
 * `ilike` (with `%`), the `or()` grammar of `postgrestOrFilter`, multi-key
 * `order` and `range`/`limit` — over rows the test seeded, and it THROWS on a
 * builder method it does not model rather than silently matching everything.
 *
 * Failure is seeded the way supabase-js fails: a table in `erroring` RESOLVES
 * `{ data: null, error }`; it does not reject. Every read is recorded in
 * `reads` (table plus the filters named), and every write in `writes`, never
 * applied, so a suite can assert which tables a path consulted.
 *
 * CHECKED AGAINST THE REAL CLIENT: registered in helpers/supabaseConformance.ts
 * (`candidateSubject`, census-discovery §91), so supabaseContract.test.ts
 * measures it against the real supabase-js client. Registering it changed four
 * behaviours to the real client's, rather than declaring them: a write is SENT
 * only when the builder is awaited or continued (and at most once), as the
 * real builder is lazy; `maybeSingle()` over more than one row answers
 * PGRST116; `readFailure` / `writeFailure` answer the caller's own error; and
 * `count` is present only when `select(cols, { count })` asked for it. Do not
 * loosen it to make a test pass.
 * NOT MODELLED — every entry below is a declared gap the contract enforces:
 *   refused  — single/zero-rows, single/one-row, single/many-rows (no §85
 *              path calls `.single()`); update/zero-rows-with-select,
 *              update/many-rows-with-select, delete/many-rows-with-select,
 *              insert/with-select-returns-rows, insert/with-select-single
 *              (writes are recorded, never applied, so RETURNING is refused
 *              rather than answered empty)
 *   divergent — write/read-after-write-visible (writes are recorded, never
 *              applied), insert/unique-violation-23505 (no constraints),
 *              error/unknown-column-42703 (only `missingColumns` fail),
 *              rpc/success, rpc/error-resolves, rpc/unknown-function (an rpc
 *              is recorded and resolves empty; no function is modelled, and
 *              DRS's analytics rpc must not fail the §85 suites),
 *              rls/denied-read-yields-zero-rows, rls/denied-write-yields-42501
 *              (no service-vs-user distinction)
 */
import { orPredicate } from "./postgrestOrFilter.js";

export type Row = Record<string, unknown>;

export interface FakeCandidateDbOptions {
  /** Tables whose every read resolves `{ data: null, error }`. */
  erroring?: string[];
  /** Table → columns that table lacks: a select or upsert naming one answers 42703. */
  missingColumns?: Record<string, string[]>;
  /** Table → the exact error every read of it answers (the contract's worlds); `erroring` answers a timeout. */
  readFailure?: Record<string, { code: string; message: string }>;
  /** Table → the exact error every write to it answers; a failed write is not recorded. */
  writeFailure?: Record<string, { code: string; message: string }>;
}

export interface FakeRead { table: string; ops: string[] }
export interface FakeWrite { table: string; op: string; payload: unknown; options?: unknown }

export interface FakeCandidateDb {
  from(table: string): any;
  rpc(fn: string, args: unknown): Promise<{ data: null; error: null }>;
  tables: Record<string, Row[]>;
  reads: FakeRead[];
  writes: FakeWrite[];
}

type Pred = (r: Row) => boolean;

const cmp = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;   // PostgREST default: NULLS LAST for ascending
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

function likeRx(pattern: string, flags = ""): RegExp {
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, flags);
}

export function makeFakeCandidateDb(tables: Record<string, Row[]>, opts: FakeCandidateDbOptions = {}): FakeCandidateDb {
  const erroring = new Set(opts.erroring ?? []);
  const db: FakeCandidateDb = {
    tables,
    reads: [],
    writes: [],
    rpc: async (fn: string, args: unknown) => { db.writes.push({ table: `rpc:${fn}`, op: "rpc", payload: args }); return { data: null, error: null }; },
    from(table: string) {
      const preds: Pred[] = [];
      const ops: string[] = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limitN: number | null = null;
      let range: [number, number] | null = null;
      let selectCols: string | null = null;
      let write: FakeWrite | null = null; let sent = false; let countRequested = false;
      const missing = new Set(opts.missingColumns?.[table] ?? []);
      const record = (op: string) => { ops.push(op); };

      const b: any = {
        select(cols?: string, o?: { count?: string }) {
          if (write) throw new Error(`fakeCandidateDb: RETURNING after ${write.op} (.select() on a write) is not modelled — writes are recorded, never applied`);
          selectCols = cols ?? "*"; countRequested = !!o?.count; record(`select(${cols ?? "*"})`); return b;
        },
        // Recorded when SENT (awaited or continued), at most once — the real builder is lazy.
        insert(p: unknown) { write = { table, op: "insert", payload: p }; return b; },
        upsert(p: unknown, o?: unknown) { write = { table, op: "upsert", payload: p, options: o }; return b; },
        update(p: unknown) { write = { table, op: "update", payload: p }; return b; },
        delete() { write = { table, op: "delete", payload: null }; return b; },
        eq(c: string, v: unknown) { record(`eq(${c})`); if (c === "flag") record(`eq(flag=${String(v)})`); preds.push((r) => r[c] === v); return b; },
        neq(c: string, v: unknown) { record(`neq(${c})`); preds.push((r) => r[c] !== v); return b; },
        in(c: string, vs: unknown[]) { record(`in(${c})`); if (c === "flag") record(`in(flag=${[...vs].map(String).sort().join("|")})`); const s = new Set(vs); preds.push((r) => s.has(r[c])); return b; },
        is(c: string, v: unknown) { record(`is(${c})`); preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
        not(c: string, op: string, v: unknown) {
          record(`not(${c},${op})`);
          if (op === "eq") preds.push((r) => r[c] != null && r[c] !== v);
          else if (op === "is") preds.push((r) => (v === null ? r[c] != null : r[c] !== v));
          else throw new Error(`fakeCandidateDb: not(${op}) is not modelled`);
          return b;
        },
        gt(c: string, v: unknown) { record(`gt(${c})`); preds.push((r) => r[c] != null && cmp(r[c], v) > 0); return b; },
        gte(c: string, v: unknown) { record(`gte(${c})`); preds.push((r) => r[c] != null && cmp(r[c], v) >= 0); return b; },
        lt(c: string, v: unknown) { record(`lt(${c})`); preds.push((r) => r[c] != null && cmp(r[c], v) < 0); return b; },
        lte(c: string, v: unknown) { record(`lte(${c})`); preds.push((r) => r[c] != null && cmp(r[c], v) <= 0); return b; },
        like(c: string, p: string) { record(`like(${c})`); const rx = likeRx(p); preds.push((r) => typeof r[c] === "string" && rx.test(r[c] as string)); return b; },
        ilike(c: string, p: string) { record(`ilike(${c})`); const rx = likeRx(p, "i"); preds.push((r) => typeof r[c] === "string" && rx.test(r[c] as string)); return b; },
        or(expr: string) { record(`or(${expr})`); preds.push(orPredicate(String(expr)) as Pred); return b; },
        order(c: string, o?: { ascending?: boolean }) { record(`order(${c},${o?.ascending === false ? "desc" : "asc"})`); orders.push({ col: c, asc: o?.ascending !== false }); return b; },
        limit(n: number) { record(`limit(${n})`); limitN = n; return b; },
        range(a: number, z: number) { record(`range(${a},${z})`); range = [a, z]; return b; },
        maybeSingle() { return settle(true); },
        single() { throw new Error("fakeCandidateDb: .single() is not modelled (no §85 path calls it); use maybeSingle()"); },
        then(onF: any, onR: any) { return settle(false).then(onF, onR); },
      };

      function missingNamed(): string | null {
        if (missing.size === 0) return null;
        const names = write
          ? Object.keys((Array.isArray(write.payload) ? write.payload[0] : write.payload) as Row ?? {})
          : String(selectCols ?? "").split(",").map((s) => s.trim());
        return names.find((n) => missing.has(n)) ?? null;
      }

      async function settle(one: boolean): Promise<{ data: any; error: any; count?: number | null }> {
        const absent = missingNamed();
        if (write) {
          if (absent) return { data: null, error: { code: "42703", message: `column "${absent}" does not exist` } };
          const wf = opts.writeFailure?.[table];
          if (wf) return { data: null, error: { ...wf } };
          if (!sent) { sent = true; db.writes.push(write); }
          return { data: null, error: null };
        }
        db.reads.push({ table, ops: [...ops] });
        if (absent) return { data: null, error: { code: "42703", message: `column ${table}.${absent} does not exist` } };
        if (erroring.has(table)) return { data: null, error: { code: "57014", message: `${table} unavailable` } };
        const rf = opts.readFailure?.[table];
        if (rf) return { data: null, error: { ...rf } };
        let out = (db.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
        if (orders.length > 0) {
          out = [...out].sort((a, z) => {
            for (const o of orders) { const d = cmp(a[o.col], z[o.col]); if (d !== 0) return o.asc ? d : -d; }
            return 0;
          });
        }
        if (range) out = out.slice(range[0], range[1] + 1);
        if (limitN !== null) out = out.slice(0, limitN);
        const data = out.map((r) => ({ ...r }));
        if (one) return data.length > 1
          ? { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }
          : { data: data[0] ?? null, error: null };
        return countRequested ? { data, error: null, count: data.length } : { data, error: null };
      }
      return b;
    },
  };
  return db;
}

/** A `feature_flags` row. */
export function flagRow(flag: string, enabled: boolean): Row {
  return { flag, enabled };
}
