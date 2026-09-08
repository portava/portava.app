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
 *   failure/read-error-resolves, failure/read-error-under-maybeSingle,
 *   transport/aborted-request — only a WRITE error can be injected
 *     (`opts.writeError`). A READ here cannot be made to fail, so this double
 *     cannot answer "does the caller fail closed when the table is unreadable".
 *     Use failClosedSupabase for that.
 *   insert/unique-violation-23505 — no unique index. A duplicate insert appends
 *     a second row; stage the shape with `opts.writeError` instead.
 *   rls/denied-read-yields-zero-rows, rls/denied-write-yields-42501 — one seed,
 *     no policies, no service-vs-user distinction. Use failClosedSupabase
 *     (`role` + `rlsHiddenTables`/`rlsProtectedTables`).
 *   rpc/success, rpc/error-resolves, rpc/unknown-function — no rpc surface.
 *     `.rpc()` THROWS rather than answering a stored procedure it knows nothing
 *     about.
 */
import { liveColumns } from "./liveColumns.ts";
import { projectionKeys, projectRow } from "./selectProjection.js";

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
  /**
   * Column sets that STAND IN for the live snapshot, table by table.
   *
   * This exists for ONE caller: `src/test/supabaseContract.test.ts`, which has
   * to run this double over synthetic tables that do not exist in the live
   * database in order to compare it against the real client. Handing a
   * production suite a schema of its own invention would destroy the only thing
   * this file is for, so it is refused unless the conformance harness sets
   * SUPABASE_CONFORMANCE=1.
   */
  syntheticColumns?: Record<string, string[]>;
}

export interface SchemaStrictClient {
  from: (table: string) => any;
  /** Always throws: this double has no stored procedures. */
  rpc?: (fn: string, args?: unknown) => never;
  /** Every write body the client accepted, in order. */
  writes: Array<{ table: string; op: "insert" | "upsert" | "update"; rows: Row[] }>;
  /** Every 42703 the client raised: the proof a dead column was named. */
  deadColumnErrors: Array<{ table: string; column: string; where: string }>;
}

const PG_UNDEFINED_COLUMN = "42703";

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
  const synthetic = opts.syntheticColumns;
  if (synthetic && process.env.SUPABASE_CONFORMANCE !== "1") {
    throw new Error(
      "makeSchemaStrictClient: `syntheticColumns` replaces the LIVE schema snapshot, which is the only " +
        "thing this double is for. It is available exclusively to the conformance harness " +
        "(src/test/supabaseContract.test.ts, SUPABASE_CONFORMANCE=1). Seed real tables instead.",
    );
  }
  const writes: SchemaStrictClient["writes"] = [];
  const deadColumnErrors: SchemaStrictClient["deadColumnErrors"] = [];

  function checkColumns(table: string, columns: string[], where: string): boolean {
    if (unchecked.has(table)) return true;
    // `liveColumns` throws loudly if the table itself is unknown.
    const live = synthetic?.[table] ? new Set(synthetic[table]) : liveColumns(table);
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
    let selected = false;
    let deleting = false;
    let countMode: string | null = null;
    // `null` = do not project (the historical behaviour). See selectProjection.ts.
    let projection: Array<[string, string]> | null = null;
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
      if (written || deleting) {
        if (opts.writeError && opts.writeError.table === table) {
          return { data: null, error: opts.writeError.error, count: null };
        }
        const store = (seed[table] ??= []);
        let affected: Row[];
        if (deleting) {
          affected = store.filter((r) => filters.every((f) => f(r)));
          for (const r of affected) store.splice(store.indexOf(r), 1);
        } else if (op === "update") {
          affected = store.filter((r) => filters.every((f) => f(r)));
          for (const r of affected) Object.assign(r, written![0] ?? {});
          writes.push({ table, op, rows: written! });
        } else {
          affected = written!;
          writes.push({ table, op: op ?? "insert", rows: written! });
          store.push(...written!);
        }
        // No chained `.select()` means PostgREST sent 201/204 with no body.
        if (!selected) return { data: null, error: null, count: null };
        return { data: projection ? affected.map((r) => projectRow(r, projection!) as Row) : affected, error: null, count: null };
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
      // `count` mirrors PostgREST's Content-Range: null unless the caller asked.
      return { data: projection ? out.map((r) => projectRow(r, projection!) as Row) : out, error: null, count: countMode ? out.length : null };
    }

    const b: any = {
      select: (cols?: string, o?: { count?: string; head?: boolean }) => {
        selected = true;
        if (o?.count) countMode = String(o.count);
        if (cols) note(selectedColumns(cols), `select("${cols}")`);
        // Adopt the SHARED projector (#436) rather than growing a second copy of
        // the rule — this double validated the select list but still returned the
        // whole seeded row, so a read of a column the caller never selected was
        // undefined in production and green here.
        projection = projectionKeys(cols);
        return b;
      },
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
      delete: () => { deleting = true; return b; },
      maybeSingle: async () => {
        const r = settle();
        if (r.error) return { data: null, error: r.error };
        if (r.data === null) return { data: null, error: null };
        const rows = r.data as Row[];
        return rows.length > 1 ? pgrst116(rows.length) : { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const r = settle();
        if (r.error) return { data: null, error: r.error };
        if (r.data === null) return { data: null, error: null };
        const rows = r.data as Row[];
        return rows.length === 1 ? { data: rows[0], error: null } : pgrst116(rows.length);
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try { return Promise.resolve(settle()).then(resolve, reject); }
        catch (e) { return reject ? Promise.resolve(reject(e)) : Promise.reject(e); }
      },
    };
    return b;
  }

  const rpc = (fn: string) => {
    throw new Error(
      `makeSchemaStrictClient does not model rpc (called "${fn}"): its subject is column names in the live ` +
        "schema, not stored procedures. Use failClosedSupabase or fakeMapDb, which take explicit handlers.",
    );
  };

  return { from, writes, deadColumnErrors, rpc } as SchemaStrictClient & { rpc: (fn: string) => never };
}
