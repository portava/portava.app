/**
 * discoverySearchPsqlClient — a PostgREST-SHAPED read adapter over psql, for
 * the census-discovery §46 database suites. Not a test file.
 *
 * WHY: lib/discoverySearchCanonical, lib/protectedZoneStore and lib/featureFlags
 * talk to a supabase-js client. There is no PostgREST on the harness, so these
 * suites run the REAL library functions over this adapter, which turns each
 * builder chain into the one SQL statement PostgREST would issue and runs it as
 * `service_role` — the role the API's service client is.
 *
 * LOUD BY DESIGN (the safetyReview.db.test.ts precedent): it models `select`,
 * `eq`, `in`, `ilike`, `limit`, `maybeSingle` and an awaited builder, and THROWS
 * on anything else, so a new call shape cannot pass unproven.
 *
 * ERRORS ARE THE DATABASE'S: a failed statement resolves `{ data: null, error }`
 * (supabase-js never throws on a query error), and `error.code` is the SQLSTATE
 * PostgreSQL itself reported — read with VERBOSITY verbose — and `message` its
 * own text. So a classifier tested through this adapter is tested against what
 * PostgreSQL 16 actually says, not against a string a test author typed.
 */
import { psql } from "./localDb.js";

function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`psqlClient: refusing identifier ${JSON.stringify(s)}`);
  return s;
}

export interface PsqlCall { table: string; sql: string }

/** Parse psql's verbose stderr into PostgREST's error shape. */
export function pgError(stderr: string): { code: string; message: string } {
  const m = stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
  return m ? { code: m[1]!, message: m[2]!.trim() } : { code: "", message: stderr.trim().split("\n")[0] ?? "error" };
}

export function psqlReadClient(log: PsqlCall[] = []): any {
  return {
    from(table: string) {
      ident(table);
      let cols = "*";
      const where: string[] = [];
      let limit: number | null = null;
      const run = async (single: boolean) => {
        const sql =
          `SELECT ${cols} FROM public.${table}` +
          (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
          (limit !== null ? ` LIMIT ${limit}` : single ? " LIMIT 2" : "");
        log.push({ table, sql });
        const script =
          `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n` +
          `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
        const r = psql(script, { single: true });
        if (r.status !== 0) return { data: null, error: pgError(r.stderr) };
        // json_agg puts a newline between elements, so the whole of stdout is the value.
        const rows = JSON.parse(r.stdout.trim() || "[]") as any[];
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      };
      const b: any = {
        select(c?: string) {
          if (c && c.trim() !== "*") cols = c.split(",").map((x) => ident(x.trim())).join(", ");
          return b;
        },
        eq(col: string, v: unknown) { where.push(`${ident(col)} = ${lit(v)}`); return b; },
        in(col: string, vals: unknown[]) {
          where.push(vals.length === 0 ? "false" : `${ident(col)} IN (${vals.map(lit).join(", ")})`);
          return b;
        },
        ilike(col: string, pat: string) { where.push(`${ident(col)} ILIKE ${lit(pat)}`); return b; },
        limit(n: number) { limit = n; return b; },
        maybeSingle() { return run(true); },
        then(onF: any, onR: any) { return run(false).then(onF, onR); },
      };
      for (const op of ["or", "not", "is", "neq", "gt", "gte", "lt", "lte", "order", "range", "single", "insert", "upsert", "update", "delete"]) {
        b[op] = () => { throw new Error(`psqlClient: '${op}' is not modelled — add it rather than assume it works`); };
      }
      return b;
    },
    rpc() { throw new Error("psqlClient: rpc is not modelled"); },
  };
}
