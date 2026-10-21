/**
 * The admin-moderation route double (wave 5, honesty 3) — the harness
 * adminModerationRemainingSeven.test.ts builds inline, lifted so the two suites
 * of this pass share ONE statement of what it adds to schemaStrictSupabase.
 *
 * Every statement runs on schemaStrictSupabase (each column checked against the
 * live schema; 42703 otherwise), with these additions, each stated:
 *   1. `.range(lo, hi)` slices the answer (and `.limit(n)` on a read that asked
 *      for a count): `count` stays the whole match, as PostgREST's
 *      Content-Range does.
 *   2. An optional row CAP slices every list answer to its first N rows, as
 *      PostgREST's max-rows does, and nothing says it stopped.
 *   3. An insert answers the `id` its column default would give, increasing
 *      (`f0000000-…-<n>`), so a seeded id that sorts lower is older.
 *   4. A per-table OVERRIDE may replace or precede one statement's answer — after
 *      the statement was built, so its schema check has already run.
 *   5. Every statement's calls are LOGGED (`statements`), so a suite can count,
 *      for instance, how many reads of a table asked for an exact count.
 * NOT modelled (the double's own limits, stated in schemaStrictSupabase.ts):
 * `.order()` keeps only the LAST key, so a two-key order (created_at, id) sorts
 * on id alone — fixtures give ids that sort as their times do.
 */
import { makeSchemaStrictClient, type Seed, type Row, type SchemaStrictOptions } from "./schemaStrictSupabase.js";
import { liveColumns } from "./liveColumns.ts";
import { _setTestClient } from "../../lib/http.js";
import { _setTestServiceClient } from "../../lib/supabase.js";

export type Call = [string, unknown[]];
export type Answer = { data: unknown; error: unknown; count?: unknown };
/** Replace (or precede) one statement's answer. `run` executes the real statement; not calling it means it never ran. */
export type Override = (calls: Call[], run: () => Promise<Answer>) => Answer | Promise<Answer> | null | undefined;
export interface InstallOptions { overrides?: Partial<Record<string, Override>>; strict?: SchemaStrictOptions; cap?: number; tokens?: Record<string, string> }
export interface Statement { table: string; calls: Call[] }

let idSeq = 0;

export function installModerationDouble(seed: Seed, o: InstallOptions = {}) {
  const strict = makeSchemaStrictClient(seed, o.strict);
  const statements: Statement[] = [];
  const from = (table: string) => {
    const b = strict.from(table);
    const calls: Call[] = [];
    statements.push({ table, calls });
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "update", "upsert", "delete"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); return orig(...args); };
    }
    const origInsert = b.insert;
    b.insert = (rows: Row | Row[]) => {
      calls.push(["insert", [rows]]);
      const arr = (Array.isArray(rows) ? rows : [rows]).map((r) => (liveColumns(table).has("id") && r.id === undefined ? { ...r, id: `f0000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}` } : r));
      return origInsert(Array.isArray(rows) ? arr : arr[0]);
    };
    const origLimit = b.limit;
    let lim: number | null = null;
    b.limit = (n: number) => { calls.push(["limit", [n]]); if (calls.some(([m, a]) => m === "select" && (a[1] as any)?.count)) { lim = n; return b; } return origLimit(n); };
    let rng: [number, number] | null = null;
    b.range = (lo: number, hi: number) => { calls.push(["range", [lo, hi]]); rng = [lo, hi]; return b; };
    const isWrite = () => calls.some(([m]) => m === "update" || m === "insert" || m === "delete" || m === "upsert");
    const slice = (a: Answer): Answer => {
      if (!Array.isArray(a?.data) || isWrite()) return a;
      let rows = a.data as unknown[];
      if (rng) rows = rows.slice(rng[0], rng[1] + 1);
      if (lim !== null) rows = rows.slice(0, lim);
      if (o.cap !== undefined) rows = rows.slice(0, o.cap);
      return { ...a, data: rows };
    };
    const ov = o.overrides?.[table];
    const gate = (run: () => Promise<Answer>): Promise<Answer> => {
      try { const r = ov?.(calls, run); return r == null ? run() : Promise.resolve(r); } catch (e) { return Promise.reject(e); }
    };
    const origThen = b.then, origMaybe = b.maybeSingle;
    b.then = (onF: any, onR: any) => gate(() => new Promise<Answer>((res, rej) => origThen(res, rej)).then(slice)).then(onF, onR);
    b.maybeSingle = () => { calls.push(["maybeSingle", []]); return gate(() => origMaybe()); };
    return b;
  };
  const tokens = o.tokens ?? {};
  const client = {
    from,
    rpc: strict.rpc,
    auth: {
      getUser: async (token: string) => (tokens[token]
        ? { data: { user: { id: tokens[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token", status: 401 } }),
    },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { strict, seed, statements, client };
}

/** A read (no write, not head-only). */
export const isListRead = (calls: Call[]) => !calls.some(([m]) => m === "update" || m === "insert" || m === "delete" || m === "maybeSingle") && !calls.some(([m, a]) => m === "select" && (a[1] as any)?.head === true);
/** The count mode a statement's select asked for, or null. */
export const countAsked = (calls: Call[]) => (calls.find(([m]) => m === "select")?.[1]?.[1] as any)?.count ?? null;
export const selectOf = (calls: Call[]) => String(calls.find(([m]) => m === "select")?.[1]?.[0] ?? "");
