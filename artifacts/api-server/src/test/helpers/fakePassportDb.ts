/**
 * fakePassportDb — a small in-memory supabase-js query surface for the passport
 * projection service tests. Supports the read operations those services use:
 *   .from(t).select(cols,{count}).eq/.neq/.in/.is/.gt/.lt/.gte/.lte/.or/.not
 *           .order/.limit/.maybeSingle/.single  and thenable list resolution.
 *
 * `.or()` is intentionally a no-op (it does not narrow) — tests stage only the
 * rows relevant to the case, so the coarse matching is sufficient and matches
 * the pattern used by the existing trust tests. Unknown tables resolve empty.
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
 *   insert/unique-violation-23505 — no unique index. A duplicate insert appends
 *     a second row instead of resolving 23505. Stage it with
 *     `failWrites["<table>"] = { code: "23505", message }`; this double cannot
 *     DISCOVER the collision.
 *   error/unknown-column-42703 — no schema knowledge. An unknown column reads as
 *     `undefined` instead of failing the whole statement. Use
 *     schemaStrictSupabase for that question.
 *   rls/denied-read-yields-zero-rows, rls/denied-write-yields-42501 — one table
 *     set, no service-vs-user distinction. Passing `role` THROWS rather than
 *     answering. Use failClosedSupabase for a role-sensitive read.
 *   rpc/success, rpc/error-resolves, rpc/unknown-function — no rpc surface.
 *     `.rpc()` THROWS.
 *
 * ── THE EAGER-INSERT DEFECT, ONCE PRESENT HERE ──────────────────────────────
 * `insert()` used to `store.push(...)` on the spot. That is the exact shape that
 * let twenty `void …insert(…)` sites in production stay green for months: the
 * double recorded a row that the real client never sent, because
 * PostgrestBuilder only calls `_fetch` from `then()`. The push now happens in
 * the resolver, and `thenable/no-continuation` in the contract suite fails if it
 * ever moves back.
 */

import { projectionKeys, projectRow } from "./selectProjection.js";

type Row = Record<string, any>;

export interface FakePassportDbOptions {
  /** table -> a resolved PostgREST error every READ of that table must produce. */
  failReads?: Record<string, { code?: string; message: string }>;
  /** table -> a resolved PostgREST error every WRITE to that table must produce. */
  failWrites?: Record<string, { code?: string; message: string }>;
  /**
   * Present only so that asking for RLS is LOUD. This double has one table set
   * and no policies; see NOT MODELLED above.
   */
  role?: "service" | "user";
}

export function makePassportDb(tables: Record<string, Row[]>, opts: FakePassportDbOptions = {}) {
  if (opts.role !== undefined) {
    throw new Error(
      "fakePassportDb does not model RLS: there is one table set and no service-vs-user distinction. " +
        "Use failClosedSupabase (role/rlsHiddenTables) for a role-sensitive read.",
    );
  }
  const failReads = opts.failReads ?? {};
  const failWrites = opts.failWrites ?? {};

  function from(table: string) {
    const store: Row[] = tables[table] ?? [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let pendingWrite: "insert" | "upsert" | "update" | "delete" | null = null;
    // `null` = do not project (the historical behaviour: the whole seeded row).
    // See selectProjection.ts for why an unparseable select falls back to that.
    let projection: Array<[string, string]> | null = null;

    /** Narrow on the way OUT only — the real database filters on the full row. */
    function project<T extends Row>(rows: T[]): Row[] {
      return projection ? rows.map((r) => projectRow(r, projection!)) : rows;
    }
    function projectOne(row: Row | null): Row | null {
      return row && projection ? projectRow(row, projection) : row;
    }

    let selected = false;
    let countMode: string | null = null;
    let headOnly = false;

    const builder: any = {
      select(_fields?: string, _opts?: any) {
        selected = true;
        projection = projectionKeys(_fields);
        if (_opts?.count) countMode = String(_opts.count);
        if (_opts?.head) headOnly = true;
        return builder;
      },
      // NOT eager. `store.push` happens in the resolver, which runs only from
      // `.then()`/`.single()`/`.maybeSingle()` — see THE EAGER-INSERT DEFECT
      // in this file's header.
      insert(row: Row) { pendingWrite = "insert"; pendingInsert = { id: `fake-${Math.random().toString(16).slice(2)}`, ...row }; return builder; },
      update(patch: Row) { pendingWrite = "update"; pendingUpdate = patch; return builder; },
      upsert(row: Row) { pendingWrite = "upsert"; pendingInsert = row; return builder; },
      delete() { pendingWrite = "delete"; return builder; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => Array.isArray(vals) && vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return builder; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return builder; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return builder; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return builder; },
      or() { return builder; },
      not(col: string, _op: string, val: any) { filters.push((r) => (val === null ? r[col] != null : r[col] !== val)); return builder; },
      order() { return builder; },
      range() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolveSingle(false); },
      single() { return resolveSingle(true); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function matched(): Row[] {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

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
        count: null,
      };
    }

    function injectedRead() {
      const e = failReads[table];
      return e ? { data: null, error: e.code ? { code: e.code, message: e.message } : { message: e.message }, count: null } : null;
    }
    function injectedWrite() {
      const e = failWrites[table];
      return e ? { data: null, error: e.code ? { code: e.code, message: e.message } : { message: e.message }, count: null } : null;
    }

    /** Apply the staged write and return the rows it affected. */
    function applyWrite(): Row[] {
      if (pendingWrite === "insert" || pendingWrite === "upsert") { store.push(pendingInsert as Row); return [pendingInsert as Row]; }
      if (pendingWrite === "update") { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return rows; }
      const rows = matched(); rows.forEach((r) => store.splice(store.indexOf(r), 1)); return rows;
    }

    async function resolveSingle(strict: boolean) {
      if (pendingWrite) {
        const err = injectedWrite();
        if (err) return err;
        const rows = applyWrite();
        // Without a chained `.select()` PostgREST returns no body at all; the
        // object Accept header then has nothing to be singular about.
        if (!selected) return { data: null, error: null, count: null };
        if (rows.length !== 1) return pgrst116(rows.length);
        return { data: projectOne(rows[0]), error: null, count: null };
      }
      const err = injectedRead();
      if (err) return err;
      const rows = matched();
      if (rows.length > 1 || (strict && rows.length !== 1)) return pgrst116(rows.length);
      return { data: projectOne(rows[0] ?? null), error: null, count: null };
    }

    async function resolveList() {
      if (pendingWrite) {
        const err = injectedWrite();
        if (err) return err;
        const rows = applyWrite();
        if (!selected) return { data: null, error: null, count: null };
        return { data: project(rows), error: null, count: null };
      }
      const err = injectedRead();
      if (err) return err;
      const rows = matched();
      // `count` is a row count and is unaffected by projection, so it is taken
      // from the matched rows before they are narrowed — and it is null unless
      // the caller asked for it, as PostgREST's Content-Range is.
      return { data: headOnly ? null : project(rows), error: null, count: countMode ? rows.length : null };
    }
    return builder;
  }

  const client: any = {
    from,
    rpc(fn: string) {
      throw new Error(
        `fakePassportDb does not model rpc (called "${fn}"). A double that answers every rpc with a plausible ` +
          "shape is exactly what hid the dead writes; use fakeMapDb or failClosedSupabase, which take explicit handlers.",
      );
    },
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
  return client;
}
