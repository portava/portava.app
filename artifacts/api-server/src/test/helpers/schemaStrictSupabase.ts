/**
 * A fake Supabase client that CAN see a dead column.
 *
 * WHY THIS EXISTS
 * ===============
 * Every hand-rolled fake in this repo answers the question "is my fixture's
 * value in your list?". None of them answers "is your column a real column?".
 * That asymmetry is what let five separate reads in the Memory/Compass lane
 * select a column the database does not have — `rent_buddy_bookings.date_from`,
 * `shared_moments.visibility`, `feature_flags.numeric_value`,
 * `compass_visibility_cooldowns.updated_at` — while their tests stayed green
 * for months. The fixtures had been written to match the code, so the tests
 * proved the code matched the fixture and proved nothing about production,
 * where PostgREST rejects the unknown name with 42703 and fails the WHOLE
 * statement.
 *
 * This client reproduces that behaviour: any column named in a `.select()`
 * list, a filter, or a write body that is not in the LIVE schema snapshot
 * makes the statement resolve `{ data: null, error: { code: "42703" } }` —
 * resolve, not throw, exactly as supabase-js does, so a caller that
 * destructures `{ data }` and ignores `error` degrades the same way it does in
 * production.
 *
 * Truth comes from `src/test/generated/liveColumns.json` (information_schema
 * of the live database), NEVER from `src/lib/database.types.ts`, which is
 * generated from the same code it would be used to check.
 *
 * Deliberately small: select / eq / in / gt / gte / lt / lte / not / order /
 * limit / maybeSingle / single / insert / upsert / update / delete, and
 * `await`ing the builder. It is a schema conscience for a query, not a
 * Postgres.
 */
import { liveColumns } from "./liveColumns.ts";

export type Row = Record<string, unknown>;
export type Seed = Record<string, Row[]>;

export interface SchemaStrictOptions {
  /**
   * Tables the schema check should skip (e.g. a table created by an
   * out-of-band migration that the snapshot predates). Use sparingly and say
   * why at the call site — every entry is a hole in the check.
   */
  unchecked?: string[];
  /** Force an error from a specific table's write, to exercise failure paths. */
  writeError?: { table: string; error: { code?: string; message?: string } };
}

export interface SchemaStrictClient {
  from: (table: string) => any;
  /** Every write body the client accepted, in order. */
  writes: Array<{ table: string; op: "insert" | "upsert" | "update"; rows: Row[] }>;
  /** Every 42703 the client raised: the proof a dead column was named. */
  deadColumnErrors: Array<{ table: string; column: string; where: string }>;
}

const PG_UNDEFINED_COLUMN = "42703";

/** Split a PostgREST select list into bare column names. */
export function selectedColumns(select: string): string[] {
  if (!select || select.trim() === "*") return [];
  return select
    .split(",")
    .map((part) => part.trim())
    // drop embedded resources — `stamp_definitions(name)` names a relation,
    // not a column of this table, and its inner names belong to that relation.
    .filter((part) => part.length > 0 && !part.includes("("))
    // `alias:column` — the real column is on the right of the colon.
    .map((part) => (part.includes(":") ? part.slice(part.indexOf(":") + 1) : part))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "*");
}

export function makeSchemaStrictClient(
  seed: Seed = {},
  opts: SchemaStrictOptions = {},
): SchemaStrictClient {
  const unchecked = new Set(opts.unchecked ?? []);
  const writes: SchemaStrictClient["writes"] = [];
  const deadColumnErrors: SchemaStrictClient["deadColumnErrors"] = [];

  function checkColumns(table: string, columns: string[], where: string): boolean {
    if (unchecked.has(table)) return true;
    const live = liveColumns(table); // throws loudly if the table itself is unknown
    let ok = true;
    for (const col of columns) {
      if (!live.has(col)) {
        deadColumnErrors.push({ table, column: col, where });
        ok = false;
      }
    }
    return ok;
  }

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let dead: { column: string; where: string } | null = null;
    let limit: number | null = null;
    let orderKey: { key: string; asc: boolean } | null = null;
    let written: Row[] | null = null;
    let op: "insert" | "upsert" | "update" | null = null;

    function fail(column: string, where: string) {
      if (!dead) dead = { column, where };
    }

    function note(columns: string[], where: string) {
      const before = deadColumnErrors.length;
      checkColumns(table, columns, where);
      for (let i = before; i < deadColumnErrors.length; i++) {
        fail(deadColumnErrors[i].column, where);
      }
    }

    function settle() {
      if (dead) {
        return {
          data: null,
          error: {
            code: PG_UNDEFINED_COLUMN,
            message: `column ${table}.${dead.column} does not exist`,
            details: dead.where,
          },
          count: null,
        };
      }
      if (written) {
        if (opts.writeError && opts.writeError.table === table) {
          return { data: null, error: opts.writeError.error, count: null };
        }
        writes.push({ table, op: op ?? "insert", rows: written });
        const store = (seed[table] ??= []);
        if (op !== "update") store.push(...written);
        return { data: written, error: null, count: written.length };
      }
      let out = (seed[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderKey) {
        const { key, asc } = orderKey;
        out = [...out].sort((a, b) => {
          const av = String(a[key] ?? ""), bv = String(b[key] ?? "");
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null, count: out.length };
    }

    const b: any = {
      select: (cols?: string) => { if (cols) note(selectedColumns(cols), `select("${cols}")`); return b; },
      eq: (col: string, val: unknown) => {
        note([col], `eq("${col}")`);
        filters.push((r) => r[col] === val); return b;
      },
      neq: (col: string, val: unknown) => {
        note([col], `neq("${col}")`);
        filters.push((r) => r[col] !== val); return b;
      },
      in: (col: string, vals: unknown[]) => {
        note([col], `in("${col}")`);
        filters.push((r) => vals.includes(r[col] as never)); return b;
      },
      gt:  (col: string, v: any) => { note([col], `gt("${col}")`);  filters.push((r) => String(r[col]) >  String(v)); return b; },
      gte: (col: string, v: any) => { note([col], `gte("${col}")`); filters.push((r) => String(r[col]) >= String(v)); return b; },
      lt:  (col: string, v: any) => { note([col], `lt("${col}")`);  filters.push((r) => String(r[col]) <  String(v)); return b; },
      lte: (col: string, v: any) => { note([col], `lte("${col}")`); filters.push((r) => String(r[col]) <= String(v)); return b; },
      is:  (col: string, v: any) => {
        note([col], `is("${col}")`);
        filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return b;
      },
      not: (col: string, _opName: string, v: any) => {
        note([col], `not("${col}")`);
        filters.push((r) => (v === null ? r[col] != null : r[col] !== v)); return b;
      },
      like:  (col: string) => { note([col], `like("${col}")`);  return b; },
      ilike: (col: string) => { note([col], `ilike("${col}")`); return b; },
      order: (col: string, o?: { ascending?: boolean }) => {
        note([col], `order("${col}")`);
        orderKey = { key: col, asc: o?.ascending !== false }; return b;
      },
      limit: (n: number) => { limit = n; return b; },
      insert: (rows: Row | Row[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) note(Object.keys(r), "insert body");
        written = arr; op = "insert"; return b;
      },
      upsert: (rows: Row | Row[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const r of arr) note(Object.keys(r), "upsert body");
        written = arr; op = "upsert"; return b;
      },
      update: (row: Row) => { note(Object.keys(row), "update body"); written = [row]; op = "update"; return b; },
      delete: () => { written = []; op = "update"; return b; },
      maybeSingle: async () => {
        const r = settle();
        if (r.error) return { data: null, error: r.error };
        const rows = (r.data as Row[] | null) ?? [];
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const r = settle();
        if (r.error) return { data: null, error: r.error };
        const rows = (r.data as Row[] | null) ?? [];
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "no/multiple rows" } };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try { return Promise.resolve(settle()).then(resolve, reject); }
        catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e); }
      },
    };
    return b;
  }

  return { from, writes, deadColumnErrors };
}
