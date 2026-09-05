/**
 * A fake Supabase client that FAILS THE WAY POSTGREST FAILS ON A WRONG COLUMN.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `helpers/enumAwareSupabase` closed the sibling gap: a fake that could not
 * return 22P02, so a dead enum LITERAL was invisible. This one closes the other
 * half of the same class — a dead column NAME.
 *
 * Every ordinary fake in this repo implements `.select("a, b, c")` by ignoring
 * the string entirely and handing back whole fixture rows, and implements a
 * write by storing the payload object as-is. So it answers *"is my fixture
 * shaped the way the code expects?"* and never *"is every column the code named
 * a column that exists?"*. It is structurally incapable of returning PGRST100
 * or PGRST204, which is exactly why eleven dead references — two of them inside
 * media AUTHORIZATION, where a close-friends story denied its own close
 * friends — survived every suite that covered those files.
 *
 * Worse, a fixture written from the fiction PINS it: `posts` fixtures in this
 * repo carry `view_count`, a column `posts` has never had, so the ranking read
 * that named it looked fine in tests while returning nothing in production.
 *
 * WHAT IT DOES
 * ------------
 * The column model is the canonical schema — `baseline/20260819_baseline_
 * structure.sql` plus every migration (scripts/lib/canonicalSchema.ts), the same
 * source `check:schema-references` judges against, and deliberately NOT
 * `src/lib/database.types.ts`, which over-reports.
 *
 *   - `.select("a, b")` naming a column the table does not declare fails the
 *     WHOLE read: `{ data: null, error: PGRST100 }`. Returned, never thrown —
 *     that is how supabase-js reports it, and why a surrounding `try/catch`
 *     never fired on any of the eleven sites.
 *   - `.insert(row)` / `.upsert(row)` / `.update(row)` naming an undeclared
 *     column is rejected with PGRST204 — *even when the value is null*, which is
 *     what made a stray `updated_at` enough to lose an abuse cooldown entirely.
 *   - A table the canonical model could not confidently build is NEVER judged,
 *     matching the check's over-permissive posture. A false failure here would
 *     block unrelated work.
 *
 * It is deliberately small: enough filtering to drive a read path, no joins.
 * Use it where the question is "does this query name real columns", not "does
 * this route work end to end".
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalSchema,
  isModelled,
  type CanonicalSchema,
} from "../../scripts/lib/canonicalSchema.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../../..");

let cached: CanonicalSchema | null = null;
export function schema(): CanonicalSchema {
  return (cached ??= buildCanonicalSchema(
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

function undefinedSelectColumn(table: string, column: string): PgError {
  return {
    code: "PGRST100",
    message: `column ${table}.${column} does not exist`,
    details: null,
    hint: null,
  };
}

function undefinedWriteColumn(table: string, column: string): PgError {
  return {
    code: "PGRST204",
    message: `Could not find the '${column}' column of '${table}' in the schema cache`,
    details: null,
    hint: null,
  };
}

type Row = Record<string, any>;

/**
 * Split a PostgREST select list into bare column names.
 *
 * Embedded resources (`stamp_definitions(name)`) and `*` are NOT judged: the
 * first names another table, the second names nothing. Aliases (`a:b`) resolve
 * to the underlying column `b`.
 */
export function selectedColumns(select: string): string[] {
  if (select.includes("(")) return []; // embedded resource — decline to judge
  return select
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*")
    .map((s) => (s.includes(":") ? s.slice(s.indexOf(":") + 1).trim() : s))
    .filter((s) => /^[A-Za-z0-9_]+$/.test(s));
}

export interface ColumnAwareOptions {
  /** Rows recorded per table by insert/upsert/update, for write assertions. */
  writes?: Record<string, Row[]>;
}

export function makeColumnAwareClient(
  data: Record<string, Row[]>,
  opts: ColumnAwareOptions = {},
): any {
  const model = schema();
  const writes = opts.writes ?? {};

  const builder = (table: string): any => {
    const backing: Row[] = (data[table] ??= []);
    let rows: Row[] = backing.slice();
    let error: PgError | null = null;
    /** Pending UPDATE payload, applied to the matched rows when the statement resolves. */
    let patch: Row | null = null;
    const judged = isModelled(model, table);
    const declared = judged ? model.columns.get(table)! : null;

    /** Reject the whole statement on the first column the table cannot have. */
    const guard = (cols: string[], mk: (t: string, c: string) => PgError): void => {
      if (error || !declared) return;
      for (const c of cols) {
        if (!declared.has(c)) {
          error = mk(table, c);
          rows = [];
          patch = null;
          return;
        }
      }
    };

    /**
     * Resolve the statement. An UPDATE applies to the rows its filters matched —
     * so `.update(…).eq(…).select(…)` behaves like UPDATE … RETURNING, which the
     * place-collections worker's atomic claim depends on.
     */
    const finish = (): { data: Row[] | null; error: PgError | null } => {
      if (error) return { data: null, error };
      if (patch) {
        (writes[table] ??= []).push({ ...patch });
        for (const r of rows) Object.assign(r, patch);
        patch = null;
      }
      return { data: rows.map((r) => ({ ...r })), error: null };
    };

    const b: any = {
      select: (sel?: string) => {
        if (typeof sel === "string") guard(selectedColumns(sel), undefinedSelectColumn);
        return b;
      },
      insert: (payload: Row | Row[]) => {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const p of list) guard(Object.keys(p), undefinedWriteColumn);
        if (!error) {
          const copies = list.map((p) => ({ ...p }));
          (writes[table] ??= []).push(...copies);
          backing.push(...copies);
          rows = copies;
        }
        return b;
      },
      upsert: (payload: Row | Row[]) => b.insert(payload),
      update: (payload: Row) => {
        guard(Object.keys(payload), undefinedWriteColumn);
        if (!error) patch = { ...payload };
        return b;
      },
      order: () => b,
      range: () => b,
      or: () => b,
      not: () => b,
      neq: (col: string, val: any) => { rows = rows.filter((r) => r[col] !== val); return b; },
      gte: (col: string, val: any) => { rows = rows.filter((r) => String(r[col] ?? "") >= String(val)); return b; },
      gt:  (col: string, val: any) => { rows = rows.filter((r) => String(r[col] ?? "") >  String(val)); return b; },
      lte: () => b,
      lt:  () => b,
      is:  (col: string, val: any) => {
        if (val === null) rows = rows.filter((r) => r[col] == null);
        return b;
      },
      ilike: (col: string, pat: string) => {
        const needle = String(pat).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[col] ?? "").toLowerCase().includes(needle));
        return b;
      },
      limit: (n: number) => { rows = rows.slice(0, n); return b; },
      eq: (col: string, val: any) => { rows = rows.filter((r) => r[col] === val); return b; },
      in: (col: string, vals: any[]) => { rows = rows.filter((r) => vals.includes(r[col])); return b; },
      maybeSingle: () => {
        const r = finish();
        return Promise.resolve(r.error ? { data: null, error: r.error } : { data: r.data![0] ?? null, error: null });
      },
      single: () => {
        const r = finish();
        return Promise.resolve(r.error ? { data: null, error: r.error } : { data: r.data![0] ?? null, error: null });
      },
      then: (onF: any, onR: any) => Promise.resolve(finish()).then(onF, onR),
    };
    return b;
  };

  return { from: (t: string) => builder(t) };
}
