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
 */
import { orPredicate } from "./postgrestOrFilter.js";

export type Row = Record<string, unknown>;

export interface FakeCandidateDbOptions {
  /** Tables whose every read resolves `{ data: null, error }`. */
  erroring?: string[];
  /** Table → columns that table lacks: a select or upsert naming one answers 42703. */
  missingColumns?: Record<string, string[]>;
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
      let write: FakeWrite | null = null;
      const missing = new Set(opts.missingColumns?.[table] ?? []);
      const record = (op: string) => { ops.push(op); };

      const b: any = {
        select(cols?: string) { selectCols = cols ?? "*"; record(`select(${cols ?? "*"})`); return b; },
        insert(p: unknown) { write = { table, op: "insert", payload: p }; db.writes.push(write); return b; },
        upsert(p: unknown, o?: unknown) { write = { table, op: "upsert", payload: p, options: o }; db.writes.push(write); return b; },
        update(p: unknown) { write = { table, op: "update", payload: p }; db.writes.push(write); return b; },
        delete() { write = { table, op: "delete", payload: null }; db.writes.push(write); return b; },
        eq(c: string, v: unknown) { record(`eq(${c})`); preds.push((r) => r[c] === v); return b; },
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
        single() { return settle(true); },
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
          return { data: null, error: null };
        }
        db.reads.push({ table, ops: [...ops] });
        if (absent) return { data: null, error: { code: "42703", message: `column ${table}.${absent} does not exist` } };
        if (erroring.has(table)) return { data: null, error: { code: "57014", message: `${table} unavailable` } };
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
        if (one) return { data: data[0] ?? null, error: null };
        return { data, error: null, count: data.length };
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
