/**
 * sqlPostgrestAdapter — the slice of supabase-js's query builder a route
 * actually calls, translated to SQL and EXECUTED by a real PostgreSQL.
 *
 * WHY. The in-memory fakes decide what a unique index, a NULL or a type does;
 * a route test over them proves the route against a model. This adapter lets
 * a db suite mount the real router and send it real HTTP while every read and
 * write lands on the real schema the migration chain built — so a 23505 is
 * Postgres's, not the fake's.
 *
 * WHAT IT IS NOT. Not PostgREST: no RLS role switch (the caller's queries run
 * as the harness's role, which is how the service client behaves), no embedded
 * relations, no `.or()` grammar. A method it does not model THROWS, so a route
 * that grows a new call fails loudly here instead of being silently answered.
 *
 * Values are inlined as SQL literals (quote-doubled), because the psql door
 * (localDb.ts) has no bind parameters. Test data only.
 */

export type SqlRunner = (sql: string) => Promise<any[]>;

/**
 * One statement as a single text value holding its rows as a JSON array — the
 * shape a runner with no row protocol (psql -At) can hand back. Timestamps and
 * json columns come out exactly as PostgREST serialises them.
 */
export function wrapForJson(sql: string): string {
  const body = sql.trim().replace(/;$/, "");
  return /^(INSERT|UPDATE|DELETE)\b/i.test(body)
    ? `WITH r AS (${body}) SELECT COALESCE(json_agg(r), '[]'::json)::text AS j FROM r`
    : `SELECT COALESCE(json_agg(t), '[]'::json)::text AS j FROM (${body}) t`;
}
export interface SqlError { code?: string; message: string }

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`sqlPostgrestAdapter: unsupported identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
};
export const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
/**
 * A select list. Plain columns, plus ONE embed shape: `child!child_<col>_fkey(a, b)`
 * — a to-many embed through a foreign key named by Postgres's default
 * convention, child.<col> referencing the parent's `id` (the account-state gate
 * reads `user_account_states` this way on every request). Anything else throws.
 */
const splitTop = (list: string) => {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
const cols = (list: string, alias = "t0") => {
  const t = list.trim();
  if (t === "*" || t === "") return "*";
  return splitTop(t).map((c) => {
    const m = /^([a-z_][a-z0-9_]*)!([a-z_][a-z0-9_]*)\(([^()]*)\)$/i.exec(c);
    if (!m) return `${alias}.${ident(c)}`;
    const [, child, fk, inner] = m as unknown as [string, string, string, string];
    const fkCol = fk.startsWith(`${child}_`) && fk.endsWith("_fkey") ? fk.slice(child.length + 1, -"_fkey".length) : null;
    if (!fkCol) throw new Error(`sqlPostgrestAdapter: unsupported embed ${c}`);
    const fields = inner.split(",").map((x) => x.trim()).filter(Boolean);
    const obj = fields.map((f) => `${lit(f)}, e.${ident(f)}`).join(", ");
    return `COALESCE((SELECT json_agg(json_build_object(${obj})) FROM public.${ident(child)} e WHERE e.${ident(fkCol)} = ${alias}."id"), '[]'::json) AS ${ident(child)}`;
  }).join(", ");
};

export function makeSqlClient(run: SqlRunner, opts: { userIdFromToken?: (t: string) => string } = {}) {
  function from(table: string) {
    const where: string[] = [];
    let order: string | null = null;
    let limit: number | null = null;
    let selectList = "*";
    let countMode: { head: boolean } | null = null;
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let returning: string | null = null;
    let single: "one" | "maybe" | null = null;

    const build = (): string => {
      const t = `public.${ident(table)} AS t0`;
      const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      if (mode === "insert") {
        const ti = `public.${ident(table)}`;
        const rows = Array.isArray(payload) ? payload : [payload];
        const keys = [...new Set(rows.flatMap((r: any) => Object.keys(r).filter((k) => r[k] !== undefined)))];
        const values = rows.map((r: any) => `(${keys.map((k) => lit(r[k])).join(", ")})`).join(", ");
        return `INSERT INTO ${ti} AS t0 (${keys.map(ident).join(", ")}) VALUES ${values} RETURNING ${returning ? cols(returning) : "*"}`;
      }
      if (mode === "update") {
        const sets = Object.keys(payload).filter((k) => payload[k] !== undefined).map((k) => `${ident(k)} = ${lit(payload[k])}`);
        return `UPDATE ${t} SET ${sets.join(", ")}${w} RETURNING ${returning ? cols(returning) : "*"}`;
      }
      if (mode === "delete") return `DELETE FROM ${t}${w} RETURNING ${returning ? cols(returning) : "*"}`;
      if (countMode) return `SELECT count(*)::int AS n FROM ${t}${w}`;
      return `SELECT ${cols(selectList)} FROM ${t}${w}${order ? ` ORDER BY ${order}` : ""}${limit !== null ? ` LIMIT ${limit}` : ""}`;
    };

    const exec = async (): Promise<{ data: any; error: SqlError | null; count?: number | null }> => {
      try {
        const rows = await run(build());
        if (countMode) return { data: countMode.head ? null : [], error: null, count: Number(rows[0]?.n ?? 0) };
        if (single === "one") {
          if (rows.length !== 1) return { data: null, error: { code: "PGRST116", message: `expected one row, got ${rows.length}` } };
          return { data: rows[0], error: null };
        }
        if (single === "maybe") {
          if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: `expected at most one row, got ${rows.length}` } };
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      } catch (e: any) {
        return { data: null, error: { code: e?.code, message: String(e?.message ?? e) } };
      }
    };

    const b: any = {
      select(list = "*", o?: { count?: string; head?: boolean }) {
        if (mode === "select") { selectList = list; if (o?.count) countMode = { head: o.head === true }; }
        else returning = list;
        return b;
      },
      insert(row: any) { mode = "insert"; payload = row; return b; },
      update(patch: any) { mode = "update"; payload = patch; return b; },
      delete() { mode = "delete"; return b; },
      eq(c: string, v: unknown) { where.push(v === null ? `${ident(c)} IS NULL` : `${ident(c)} = ${lit(v)}`); return b; },
      neq(c: string, v: unknown) { where.push(`${ident(c)} IS DISTINCT FROM ${lit(v)}`); return b; },
      gt(c: string, v: unknown) { where.push(`${ident(c)} > ${lit(v)}`); return b; },
      gte(c: string, v: unknown) { where.push(`${ident(c)} >= ${lit(v)}`); return b; },
      lt(c: string, v: unknown) { where.push(`${ident(c)} < ${lit(v)}`); return b; },
      lte(c: string, v: unknown) { where.push(`${ident(c)} <= ${lit(v)}`); return b; },
      in(c: string, vs: unknown[]) { where.push(vs.length ? `${ident(c)} IN (${vs.map(lit).join(", ")})` : "false"); return b; },
      is(c: string, v: unknown) { where.push(`${ident(c)} IS ${v === null ? "NULL" : v ? "TRUE" : "FALSE"}`); return b; },
      // PostgREST's or= grammar, the subset the server's readers use: comma-separated terms at
      // depth 0, each `and(...)` / `or(...)` or `col.op.value` with op ∈ eq|neq|gt|gte|lt|lte|is.
      or(expr: string) { where.push(`(${orSql(expr)})`); return b; },
      order(c: string, o?: { ascending?: boolean }) { order = `${ident(c)} ${o?.ascending === false ? "DESC" : "ASC"}`; return b; },
      limit(n: number) { limit = n; return b; },
      single() { single = "one"; return exec(); },
      maybeSingle() { single = "maybe"; return exec(); },
      then(resolve: (v: any) => void, reject?: (e: any) => void) { return exec().then(resolve, reject); },
    };
    return new Proxy(b, {
      get(t, p) {
        if (p in t) return t[p as string];
        if (p === "catch" || p === "finally") return undefined;
        throw new Error(`sqlPostgrestAdapter: ${table}.${String(p)}() is not modelled`);
      },
    });
  }
  return {
    from,
    rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `rpc ${fn} not modelled` } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: (opts.userIdFromToken ?? ((x) => x))(token) } }, error: null }) },
  };
}

function termSql(t: string): string {
  const g = /^(and|or)\((.*)\)$/.exec(t.trim());
  if (g) return `(${splitTop(g[2]!).map(termSql).join(g[1] === "and" ? " AND " : " OR ")})`;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|gt|gte|lt|lte|is)\.(.*)$/.exec(t.trim());
  if (!m) throw new Error(`sqlPostgrestAdapter: unsupported or() term ${t}`);
  const [, col, op, raw] = m;
  const c = `"${col}"`;
  if (op === "is") return `${c} IS ${raw === "null" ? "NULL" : raw === "true" ? "TRUE" : "FALSE"}`;
  const v = `'${raw!.replace(/'/g, "''")}'`;
  const sym = { eq: "=", neq: "IS DISTINCT FROM", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op as "eq"];
  return `${c} ${sym} ${v}`;
}
function orSql(expr: string): string { return splitTop(expr).map(termSql).join(" OR "); }
