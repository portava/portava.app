/**
 * A fake Supabase client that FAILS THE WAY POSTGRES FAILS.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every other fake client in this repo implements a filter as
 * `rows.filter(r => r[col] === val)`. It answers *"does my fixture's value
 * appear in what you passed?"* and never *"is what you passed a real label of
 * that column?"*. It is structurally incapable of returning 22P02, so a dead
 * enum literal is invisible to it — and a fixture written from a fiction PINS
 * the fiction. The 2026-09-05 audit isolated the mechanism exactly: replacing
 * BOTH literals of an `.in('status', […])` with nonsense turned a suite RED,
 * while replacing only the ALREADY-DEAD one left it GREEN 33/33.
 *
 * This double asks the second question. Every literal handed to `eq` / `neq` /
 * `in` / `not` on a column with a declared vocabulary (enum labels or a CHECK
 * set, parsed from the baseline plus every migration by
 * `scripts/lib/canonicalVocabulary.ts`) is validated. An unknown ENUM label
 * rejects the WHOLE query with a PostgREST-shaped 22P02 error — returned in
 * `{ data: null, error }`, never thrown, because that is precisely how
 * supabase-js reports it and precisely why a surrounding `try/catch` never
 * fired on any of the thirty-two production sites. An unknown CHECK value
 * matches nothing instead, silently, as Postgres does.
 *
 * It is deliberately small: enough filtering to drive a read path, no joins, no
 * writes. Use it where the question is "does this predicate name real values",
 * not "does this route work end to end".
*
 * ── CHECKED AGAINST THE REAL CLIENT ─────────────────────────────────────────
 * `src/test/supabaseContract.test.ts` runs this double and the REAL installed
 * supabase-js client through the same scenarios every CI run and fails if they
 * disagree anywhere not listed below. Do not "improve" this file by making a
 * scenario pass more loosely; change the scenario, or declare a gap here.
 *
 * MODELLED EXACTLY (measured, not assumed): thenable execution — a builder with
 * no `.then`/`await` performs NOTHING; `.single()`/`.maybeSingle()` cardinality
 * including the RESOLVED PGRST116 for more than one row; failures arriving
 * RESOLVED as `{ data: null, error }`, never thrown; `count` null unless asked.
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
 *   failure/write-error-resolves, write/read-after-write-visible,
 *   rls/denied-write-yields-42501 — this is a READ double. Every write verb
 *     THROWS: there is no RETURNING and no affected-row count here.
 *   failure/read-error-resolves, failure/read-error-under-maybeSingle,
 *   transport/aborted-request — the only error this double can raise is the
 *     22P02 it exists for. A read cannot otherwise be made to fail; use
 *     failClosedSupabase.
 *   error/unknown-column-42703 — it validates VALUES, not column names. Use
 *     schemaStrictSupabase.
 *   rls/denied-read-yields-zero-rows — one seed, no policies, no
 *     service-vs-user distinction. Use failClosedSupabase.
 *   select/count-exact — no count surface; `count` is always absent.
 *   rpc/success, rpc/error-resolves, rpc/unknown-function — no rpc surface.
 *     `.rpc()` THROWS.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalVocabulary,
  type CanonicalVocabulary,
} from "../../scripts/lib/canonicalVocabulary.js";
import { projectionKeys, projectRow } from "./selectProjection.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../../..");

let cached: CanonicalVocabulary | null = null;
export function vocabulary(): CanonicalVocabulary {
  return (cached ??= buildCanonicalVocabulary(
    resolve(API_ROOT, "baseline/20260819_baseline_structure.sql"),
    [resolve(API_ROOT, "migrations"), resolve(API_ROOT, "src/migrations")],
  ));
}

export interface PgError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

function invalidEnumInput(type: string, literal: string): PgError {
  return {
    code: "22P02",
    message: `invalid input value for enum ${type}: "${literal}"`,
    details: null,
    hint: null,
  };
}

type Row = Record<string, any>;

/** Values PostgREST would send: `("a","b")` or `(a,b)`. */
function parseInList(raw: string): string[] {
  return raw.trim().replace(/^\(/, "").replace(/\)$/, "").split(",")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .filter((s) => s.length > 0);
}

export function makeEnumAwareClient(data: Record<string, Row[]>): any {
  const vocab = vocabulary();

  const builder = (table: string): any => {
    let rows: Row[] = (data[table] ?? []).map((r) => ({ ...r }));
    let error: PgError | null = null;
    // `null` = do not project (the historical behaviour: the whole seeded row).
    // Narrowing happens on the way OUT only — the real database filters on the
    // full row, and filtering on an unselected column is legal PostgREST.
    // See selectProjection.ts.
    let projection: Array<[string, string]> | null = null;
    const narrow = (rs: Row[]): Row[] => (projection ? rs.map((r) => projectRow(r, projection!) as Row) : rs);
    const narrowOne = (r: Row | null): Row | null => (r && projection ? (projectRow(r, projection) as Row) : r);

    /**
     * Validate one literal against the column's declared vocabulary.
     * Returns true when the predicate may still be applied.
     */
    const check = (col: string, literal: unknown): boolean => {
      if (error) return false;
      if (typeof literal !== "string") return true;
      const key = `${table}.${col}`;
      const allowed = vocab.values.get(key);
      if (!allowed) return true; // unmodelled column — no opinion
      if (allowed.has(literal)) return true;
      const origin = vocab.origin.get(key) ?? "";
      if (origin.startsWith("enum ")) {
        // Postgres rejects the CAST. The whole request dies.
        error = invalidEnumInput(origin.slice(5), literal);
        rows = [];
        return false;
      }
      // CHECK-constrained text: legal SQL, matches nothing. Quietly.
      return true;
    };

    const refuse = (what: string, why: string) => () => {
      throw new Error(`enumAwareSupabase does not model ${what}: ${why}`);
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
    });

    const b: any = {
      select: (fields?: string) => { projection = projectionKeys(fields); return b; },
      insert: refuse("writes (.insert)", "it is a READ double for predicate vocabulary; use fakeLayoverDb or failClosedSupabase"),
      upsert: refuse("writes (.upsert)", "it is a READ double for predicate vocabulary; use fakeLayoverDb or failClosedSupabase"),
      update: refuse("writes (.update)", "it is a READ double for predicate vocabulary; use fakeLayoverDb or failClosedSupabase"),
      delete: refuse("writes (.delete)", "it is a READ double for predicate vocabulary; use fakeLayoverDb or failClosedSupabase"),
      order: () => b,
      range: () => b,
      gte: () => b,
      lte: () => b,
      gt: () => b,
      lt: () => b,
      is: () => b,
      or: () => b,
      ilike: (col: string, pat: string) => {
        const needle = String(pat).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
        return b;
      },
      limit: (n: number) => { rows = rows.slice(0, n); return b; },
      eq: (col: string, val: any) => {
        if (check(col, val)) rows = rows.filter((r) => r[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        if (check(col, val)) rows = rows.filter((r) => r[col] !== val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        let ok = true;
        for (const v of vals) if (!check(col, v)) ok = false;
        if (ok) rows = rows.filter((r) => vals.includes(r[col]));
        return b;
      },
      not: (col: string, op: string, val: any) => {
        const o = String(op).toLowerCase();
        if (o === "in") {
          const list = parseInList(String(val));
          let ok = true;
          for (const v of list) if (!check(col, v)) ok = false;
          if (ok) rows = rows.filter((r) => !list.includes(String(r[col])));
        } else if (o === "eq") {
          if (check(col, val)) rows = rows.filter((r) => r[col] !== val);
        } else if (o === "neq") {
          if (check(col, val)) rows = rows.filter((r) => r[col] === val);
        } else if (o === "is") {
          rows = rows.filter((r) => (val === null ? r[col] != null : true));
        }
        return b;
      },
      maybeSingle: () => {
        if (error) return Promise.resolve({ data: null, error });
        if (rows.length > 1) return Promise.resolve(pgrst116(rows.length));
        return Promise.resolve({ data: narrowOne(rows[0] ?? null), error: null });
      },
      single: () => {
        if (error) return Promise.resolve({ data: null, error });
        if (rows.length !== 1) return Promise.resolve(pgrst116(rows.length));
        return Promise.resolve({ data: narrowOne(rows[0]), error: null });
      },
      then: (onF: any, onR: any) =>
        Promise.resolve(error ? { data: null, error } : { data: narrow(rows), error: null }).then(onF, onR),
    };
    return b;
  };

  return {
    from: (table: string) => builder(table),
    rpc(fn: string) {
      throw new Error(
        `enumAwareSupabase does not model rpc (called "${fn}"): its subject is predicate vocabulary, ` +
          "not stored procedures. Use failClosedSupabase or fakeMapDb, which take explicit handlers.",
      );
    },
  };
}
