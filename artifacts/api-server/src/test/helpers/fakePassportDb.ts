/**
 * fakePassportDb — a small in-memory supabase-js query surface for the passport
 * projection service tests. Supports the read operations those services use:
 *   .from(t).select(cols,{count}).eq/.neq/.in/.is/.gt/.lt/.gte/.lte/.or/.not
 *           .order/.limit/.maybeSingle/.single  and thenable list resolution.
 *
 * `.or()` is intentionally a no-op (it does not narrow) — tests stage only the
 * rows relevant to the case, so the coarse matching is sufficient and matches
 * the pattern used by the existing trust tests. Unknown tables resolve empty.
 */

import { projectionKeys, projectRow } from "./selectProjection.js";

type Row = Record<string, any>;

export function makePassportDb(tables: Record<string, Row[]>) {
  function from(table: string) {
    const store: Row[] = tables[table] ?? [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let pendingDelete = false;
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

    const builder: any = {
      select(_fields?: string, _opts?: any) { projection = projectionKeys(_fields); return builder; },
      insert(row: Row) { pendingInsert = { id: `fake-${Math.random().toString(16).slice(2)}`, ...row }; store.push(pendingInsert); return builder; },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      upsert(row: Row) { pendingInsert = row; return builder; },
      delete() { pendingDelete = true; return builder; },
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
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolveSingle(); },
      single() { return resolveSingle(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function matched(): Row[] {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function resolveSingle() {
      if (pendingInsert || pendingUpdate) {
        if (pendingUpdate) { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return { data: projectOne(rows[0] ?? null), error: null }; }
        return { data: projectOne(pendingInsert), error: null };
      }
      if (pendingDelete) { const rows = matched(); rows.forEach((r) => store.splice(store.indexOf(r), 1)); return { data: projectOne(rows[0] ?? null), error: null }; }
      const rows = matched();
      return { data: projectOne(rows[0] ?? null), error: null };
    }
    async function resolveList() {
      // `count` is a row count and is unaffected by projection, so it is taken
      // from the matched rows before they are narrowed.
      if (pendingUpdate) { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return { data: project(rows), error: null, count: rows.length }; }
      if (pendingDelete) { const rows = matched(); rows.forEach((r) => store.splice(store.indexOf(r), 1)); return { data: project(rows), error: null, count: rows.length }; }
      const rows = matched();
      return { data: project(rows), error: null, count: rows.length };
    }
    return builder;
  }

  const client: any = {
    from,
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
  return client;
}
