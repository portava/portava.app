/**
 * creatorLedgerPsqlClient — a PostgREST-SHAPED client over psql, for the
 * census-discovery §52 creator-ledger database suites. Not a test file.
 *
 * WHY: CreatorAttributionService, CreatorLedgerOperations, CreatorLedgerReader,
 * CanonicalShareReader and the producer talk to a supabase-js client. There is
 * no PostgREST on the harness, so these suites run the REAL service functions
 * over this adapter, which turns each builder chain into the one SQL statement
 * PostgREST would issue, inside one transaction, as `service_role` — the role
 * the API's service client is. Every trigger, CHECK, unique index and deferred
 * constraint of 2920/2921/3385/3386/3387 therefore runs exactly as it would.
 *
 * THE FLAG IS NEVER TURNED ON IN THE DATABASE. `feature_flags` reads are
 * answered from `flags` in memory, so the harness row of
 * `creator_attribution_enabled` stays exactly as 2922 seeded it (FALSE), and a
 * suite asserts that it still is. No flag is written anywhere by this adapter.
 *
 * LOUD BY DESIGN (the discoverySearchPsqlClient precedent): it models `select`,
 * `eq`, `neq`, `in`, `lte`, `order`, `limit`, `range`, `single`, `maybeSingle`,
 * `insert … select`, `upsert(…, { onConflict, ignoreDuplicates: true })` and
 * `rpc`, and THROWS on anything else, so a new call shape cannot pass unproven.
 *
 * ERRORS ARE THE DATABASE'S: a failed statement resolves `{ data: null, error }`
 * with `code` the SQLSTATE PostgreSQL reported (VERBOSITY verbose), `message`
 * its text and `details` its DETAIL line — what PostgREST would relay.
 */
import { psql } from "./localDb.js";

export function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`psqlClient: non-finite number ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`psqlClient: refusing identifier ${JSON.stringify(s)}`);
  return s;
}

export interface PgError { code: string; message: string; details: string }

export function pgError(stderr: string): PgError {
  const m = stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
  const d = stderr.match(/DETAIL:\s+([^\n]*)/);
  return {
    code: m ? m[1]! : "",
    message: m ? m[2]!.trim() : (stderr.trim().split("\n")[0] ?? "error"),
    details: d ? d[1]!.trim() : "",
  };
}

export interface PsqlCall { table: string; sql: string }

export interface CreatorPsqlClientOptions {
  /** In-memory flag answers. The database's feature_flags rows are never touched. */
  flags?: Record<string, boolean>;
  log?: PsqlCall[];
  /**
   * Bearer token → user id, for `auth.getUser` (what `requireUser` calls). An
   * unknown token is rejected, as GoTrue would reject it.
   */
  tokens?: Record<string, string>;
}

function runJson(sql: string): { data: any; error: PgError | null } {
  const script =
    `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n` +
    `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const r = psql(script, { single: true });
  if (r.status !== 0) return { data: null, error: pgError(r.stderr) };
  return { data: JSON.parse(r.stdout.trim() || "[]"), error: null };
}

function runWrite(sql: string): { data: any; error: PgError | null } {
  const script =
    `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n` +
    `WITH w AS (${sql} RETURNING *) SELECT COALESCE(json_agg(w), '[]'::json)::text FROM w;`;
  const r = psql(script, { single: true });
  if (r.status !== 0) return { data: null, error: pgError(r.stderr) };
  return { data: JSON.parse(r.stdout.trim() || "[]"), error: null };
}

export function creatorPsqlClient(opts: CreatorPsqlClientOptions = {}): any {
  const flags = opts.flags ?? {};
  const log = opts.log ?? [];
  const tokens = opts.tokens ?? {};
  return {
    auth: {
      async getUser(token: string) {
        const id = tokens[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from(table: string) {
      ident(table);
      let cols = "*";
      const where: string[] = [];
      const order: string[] = [];
      let limit: number | null = null;
      let offset: number | null = null;
      let single: "none" | "single" | "maybe" = "none";
      let write: null | { kind: "insert" | "upsert"; rows: any[]; onConflict?: string; ignore?: boolean; many: boolean } = null;

      const buildSelect = () =>
        `SELECT ${cols} FROM public.${table}` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        (order.length ? ` ORDER BY ${order.join(", ")}` : "") +
        (limit !== null ? ` LIMIT ${limit}` : "") +
        (offset !== null ? ` OFFSET ${offset}` : "");

      const run = async () => {
        if (table === "feature_flags" && !write) {
          const f = where.map((w) => /^flag = '(.*)'$/.exec(w)?.[1]).find(Boolean);
          const on = f ? flags[f] === true : false;
          const data = on ? { enabled: true } : null;
          return { data: single === "none" ? (data ? [data] : []) : data, error: null };
        }
        let result: { data: any; error: PgError | null };
        if (write) {
          const keys = [...new Set(write.rows.flatMap((r) => Object.keys(r)))].map(ident);
          const values = write.rows
            .map((r) => `(${keys.map((k) => (k in r ? lit(r[k]) : "DEFAULT")).join(", ")})`)
            .join(", ");
          let sql = `INSERT INTO public.${table} (${keys.join(", ")}) VALUES ${values}`;
          if (write.kind === "upsert") {
            if (!write.ignore) throw new Error("psqlClient: only upsert(…, { ignoreDuplicates: true }) is modelled");
            sql += ` ON CONFLICT (${(write.onConflict ?? "").split(",").map((c) => ident(c.trim())).join(", ")}) DO NOTHING`;
          }
          log.push({ table, sql });
          result = runWrite(sql);
        } else {
          const sql = buildSelect();
          log.push({ table, sql });
          result = runJson(sql);
        }
        if (result.error) return { data: null, error: result.error };
        const rows = result.data as any[];
        if (single === "single") {
          if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${rows.length}`, details: "" } };
          return { data: rows[0], error: null };
        }
        if (single === "maybe") {
          if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: `expected at most 1 row, got ${rows.length}`, details: "" } };
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      };

      const b: any = {
        select(c?: string) {
          if (c && c.trim() !== "*") cols = c.split(",").map((x) => ident(x.trim())).join(", ");
          return b;
        },
        eq(col: string, v: unknown) { where.push(`${ident(col)} = ${lit(v)}`); return b; },
        neq(col: string, v: unknown) { where.push(`${ident(col)} <> ${lit(v)}`); return b; },
        lte(col: string, v: unknown) { where.push(`${ident(col)} <= ${lit(v)}`); return b; },
        in(col: string, vals: unknown[]) {
          where.push(vals.length === 0 ? "false" : `${ident(col)} IN (${vals.map(lit).join(", ")})`);
          return b;
        },
        order(col: string, o: { ascending?: boolean } = {}) {
          order.push(`${ident(col)} ${o.ascending === false ? "DESC" : "ASC"}`);
          return b;
        },
        limit(n: number) { limit = n; return b; },
        range(lo: number, hi: number) { offset = lo; limit = hi - lo + 1; return run(); },
        single() { single = "single"; return run(); },
        maybeSingle() { single = "maybe"; return run(); },
        insert(p: any) { write = { kind: "insert", rows: Array.isArray(p) ? p : [p], many: Array.isArray(p) }; return b; },
        upsert(p: any, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
          write = { kind: "upsert", rows: Array.isArray(p) ? p : [p], onConflict: o.onConflict, ignore: o.ignoreDuplicates, many: Array.isArray(p) };
          return b;
        },
        then(onF: any, onR: any) { return run().then(onF, onR); },
      };
      for (const op of ["or", "not", "is", "gt", "gte", "lt", "ilike", "update", "delete"]) {
        b[op] = () => { throw new Error(`psqlClient: '${op}' is not modelled — add it rather than assume it works`); };
      }
      return b;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      ident(fn);
      const named = Object.entries(args ?? {})
        .map(([k, v]) => `${ident(k)} => ${lit(v)}::jsonb`)
        .join(", ");
      const sql = `SELECT public.${fn}(${named}) AS r`;
      log.push({ table: `rpc:${fn}`, sql });
      const r = runJson(sql);
      if (r.error) return { data: null, error: r.error };
      return { data: (r.data as any[])[0]?.r ?? null, error: null };
    },
  };
}
