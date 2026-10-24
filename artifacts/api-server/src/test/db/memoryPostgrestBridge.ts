/**
 * memoryPostgrestBridge — a PostgREST-SHAPED client over psql, for the
 * census-highlights-memories database suites. Not a test file.
 *
 * WHY: the Memory services (memoryCorrections, memoryReaderGuard,
 * memoryDeletionLifecycle, memoryEvidenceErasure, the redrive pass and
 * MemoryDomainService's kernel dispatch) talk to a supabase-js client. There is
 * no PostgREST on the harness, so these suites run the REAL service functions
 * over this bridge, which turns each builder chain into the one statement
 * PostgREST would issue and runs it as `service_role` — the role the API's
 * service client is — on the full chain scripts/local-db/up.sh replays. Every
 * trigger, CHECK, unique index, grant and SECURITY DEFINER function of the
 * migrations therefore runs exactly as it would on a deployed database.
 *
 * FLAGS ARE NEVER WRITTEN. `feature_flags` reads are answered from `flags` in
 * memory (the creatorLedgerPsqlClient precedent), so a suite states which
 * production flag values it runs under and the harness's seeded rows are left
 * exactly as their migrations wrote them.
 *
 * LOUD BY DESIGN (the creatorLedgerPsqlClient / discoverySearchPsqlClient
 * precedent): it models plain-column `select` (with `{ count: "exact" }`),
 * `eq` `neq` `gt` `gte` `lt` `lte` `in` `is` `not(col, "is", null)`
 * `contains` `order` `limit` `range` `single` `maybeSingle`, `insert` `update`
 * `upsert` (`onConflict`, `ignoreDuplicates`) and `delete` each with an optional
 * `.select(…)` for RETURNING, and `rpc`. Anything else THROWS, so a new call
 * shape cannot pass unproven. A value is formatted for its column's REAL type
 * (read from information_schema): an array column takes an array literal, a
 * json/jsonb column takes JSON, everything else a quoted literal.
 *
 * ERRORS ARE THE DATABASE'S: a failed statement resolves `{ data: null, error }`
 * whose `code` is the SQLSTATE PostgreSQL reported (VERBOSITY verbose) — so a
 * service's absent/unreadable classifier is exercised against what PostgreSQL
 * actually says. `failOn` makes a chosen table's statements fail the way an
 * unavailable database does (code 08006), for the retry and dead-letter paths.
 */
import { psql } from "./localDb.js";
import { lit, pgError, type PgError } from "./creatorLedgerPsqlClient.js";

export interface MemoryBridgeOptions {
  /** In-memory answers for `feature_flags` reads. The table is never read or written. */
  flags?: Record<string, boolean>;
  /** Statements against these tables resolve with a connection-class error (08006) instead of running. */
  failOn?: (table: string, op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc") => boolean;
  /** Every statement issued, in order. */
  log?: string[];
}

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`memoryBridge: refusing identifier ${JSON.stringify(s)}`);
  return s;
}

const typeCache = new Map<string, Map<string, string>>();
/** column → data_type ('ARRAY', 'jsonb', 'uuid', …) for one public table, read once. */
function columnTypes(table: string): Map<string, string> {
  const hit = typeCache.get(table);
  if (hit) return hit;
  const r = psql(`SELECT column_name || '|' || data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${lit(table)};`);
  if (r.status !== 0) throw new Error(`memoryBridge: cannot read columns of ${table}: ${r.stderr}`);
  const m = new Map<string, string>();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const [c, t] = line.split("|");
    m.set(c!, t!);
  }
  typeCache.set(table, m);
  return m;
}

function arrayLiteral(values: unknown[]): string {
  const parts = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    const s = String(v);
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return lit(`{${parts.join(",")}}`);
}

/** A value formatted for `table.column`'s real type. */
function valueFor(table: string, column: string, v: unknown): string {
  if (v === undefined) return "DEFAULT";
  if (v === null) return "NULL";
  const t = columnTypes(table).get(column);
  if (t === undefined) {
    // Not a column of this table: let PostgreSQL refuse it with 42703, as PostgREST would (PGRST204).
    return lit(typeof v === "object" ? JSON.stringify(v) : v);
  }
  if (t === "ARRAY") {
    if (!Array.isArray(v)) throw new Error(`memoryBridge: ${table}.${column} is an array column and was given ${JSON.stringify(v)}`);
    return arrayLiteral(v);
  }
  if (t === "jsonb" || t === "json") return `${lit(JSON.stringify(v))}::${t}`;
  if (typeof v === "object") throw new Error(`memoryBridge: ${table}.${column} (${t}) was given an object`);
  return lit(v);
}

function run(sql: string, log: string[]): { data: any[] | null; error: (PgError & { hint: string | null }) | null } {
  log.push(sql);
  const script = `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${sql}`;
  const r = psql(script, { single: true });
  if (r.status !== 0) return { data: null, error: { ...pgError(r.stderr), hint: null } };
  return { data: JSON.parse(r.stdout.trim() || "[]"), error: null };
}

const unavailable = () => ({ code: "08006", message: "connection failure (injected by memoryBridge.failOn)", details: "", hint: null });

export function memoryBridge(opts: MemoryBridgeOptions = {}): any {
  const flags = opts.flags ?? {};
  const log = opts.log ?? [];
  const failOn = opts.failOn ?? (() => false);
  return {
    from(table: string) {
      ident(table);
      let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
      let cols = "*";
      let returning: string | null = null;
      let countExact = false;
      const where: string[] = [];
      const order: string[] = [];
      let limit: number | null = null;
      let offset: number | null = null;
      let single: "none" | "single" | "maybe" = "none";
      let rows: Record<string, unknown>[] = [];
      let onConflict: string | null = null;
      let ignoreDuplicates = false;

      const listOf = (c: string): string => c.split(",").map((x) => ident(x.trim())).join(", ");
      const filters = () => (where.length ? ` WHERE ${where.join(" AND ")}` : "");

      const exec = async () => {
        if (table === "feature_flags" && op === "select") {
          const f = where.map((w) => /^flag = '(.*)'$/.exec(w)?.[1]).find(Boolean);
          const data = f && flags[f] === true ? { enabled: true } : f && f in flags ? { enabled: false } : null;
          if (single === "none") return { data: data ? [data] : [], error: null };
          return { data, error: null };
        }
        if (table === "feature_flags") throw new Error("memoryBridge: refusing a write to feature_flags");
        if (failOn(table, op)) return { data: null, error: unavailable(), count: null };
        let sql: string;
        if (op === "select") {
          sql = `SELECT COALESCE(json_agg(t.*), '[]'::json)::text FROM (SELECT ${cols} FROM public.${table}${filters()}` +
            (order.length ? ` ORDER BY ${order.join(", ")}` : "") +
            (limit !== null ? ` LIMIT ${limit}` : "") + (offset !== null ? ` OFFSET ${offset}` : "") + `) t;`;
        } else {
          let body: string;
          if (op === "delete") {
            if (!where.length) throw new Error("memoryBridge: a delete needs filters");
            body = `DELETE FROM public.${table}${filters()}`;
          } else if (op === "update") {
            const payload = rows[0]!;
            const sets = Object.entries(payload).filter(([, v]) => v !== undefined).map(([c, v]) => `${ident(c)} = ${valueFor(table, c, v)}`);
            if (!where.length || !sets.length) throw new Error("memoryBridge: an update needs filters and assignments");
            body = `UPDATE public.${table} SET ${sets.join(", ")}${filters()}`;
          } else {
            const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].map(ident);
            const values = rows.map((r) => `(${keys.map((k) => (k in r ? valueFor(table, k, r[k]) : "DEFAULT")).join(", ")})`).join(", ");
            body = `INSERT INTO public.${table} (${keys.join(", ")}) VALUES ${values}`;
            if (op === "upsert") {
              const target = (onConflict ?? "").split(",").map((c) => ident(c.trim()));
              if (!target.length || !target[0]) throw new Error("memoryBridge: an upsert needs onConflict");
              const rest = keys.filter((k) => !target.includes(k));
              body += ignoreDuplicates || rest.length === 0
                ? ` ON CONFLICT (${target.join(", ")}) DO NOTHING`
                : ` ON CONFLICT (${target.join(", ")}) DO UPDATE SET ${rest.map((k) => `${k} = EXCLUDED.${k}`).join(", ")}`;
            }
          }
          sql = `WITH w AS (${body} RETURNING ${returning ?? "*"}) SELECT COALESCE(json_agg(w.*), '[]'::json)::text FROM w;`;
        }
        const r = run(sql, log);
        if (r.error) return { data: null, error: r.error, count: null };
        let count: number | null = null;
        if (countExact) {
          const c = run(`SELECT json_build_array(count(*))::text FROM public.${table}${filters()};`, log);
          if (c.error) return { data: null, error: c.error, count: null };
          count = Number((c.data as number[])[0]);
        }
        const out = op !== "select" && returning === null ? null : r.data!;
        if (single === "single") {
          if (!out || out.length !== 1) return { data: null, error: { code: "PGRST116", message: `JSON object requested, multiple (or no) rows returned (${out?.length ?? 0})`, details: "", hint: null }, count };
          return { data: out[0], error: null, count };
        }
        if (single === "maybe") {
          if (out && out.length > 1) return { data: null, error: { code: "PGRST116", message: `JSON object requested, multiple rows returned (${out.length})`, details: "", hint: null }, count };
          return { data: out?.[0] ?? null, error: null, count };
        }
        return { data: out, error: null, count };
      };

      const b: any = {
        select(c?: string, o?: { count?: string; head?: boolean }) {
          if (o?.head) throw new Error("memoryBridge: head selects are not modelled");
          const list = !c || c.trim() === "*" ? "*" : listOf(c);
          if (op === "select") { cols = list; countExact = o?.count === "exact"; } else returning = list;
          return b;
        },
        eq(c: string, v: unknown) {
          if (v === null || v === undefined) throw new Error(`memoryBridge: eq(${c}, null) is not modelled — use is()`);
          where.push(`${ident(c)} = ${lit(v)}`); return b;
        },
        neq(c: string, v: unknown) { where.push(`${ident(c)} <> ${lit(v)}`); return b; },
        gt(c: string, v: unknown) { where.push(`${ident(c)} > ${lit(v)}`); return b; },
        gte(c: string, v: unknown) { where.push(`${ident(c)} >= ${lit(v)}`); return b; },
        lt(c: string, v: unknown) { where.push(`${ident(c)} < ${lit(v)}`); return b; },
        lte(c: string, v: unknown) { where.push(`${ident(c)} <= ${lit(v)}`); return b; },
        in(c: string, vs: readonly unknown[]) {
          where.push(vs.length === 0 ? "false" : `${ident(c)} IN (${vs.map(lit).join(", ")})`); return b;
        },
        is(c: string, v: unknown) {
          if (v === null) where.push(`${ident(c)} IS NULL`);
          else if (v === true || v === false) where.push(`${ident(c)} IS ${v ? "TRUE" : "FALSE"}`);
          else throw new Error(`memoryBridge: is(${c}, ${JSON.stringify(v)}) is not modelled`);
          return b;
        },
        not(c: string, operator: string, v: unknown) {
          if (operator === "is" && v === null) { where.push(`${ident(c)} IS NOT NULL`); return b; }
          throw new Error(`memoryBridge: not(${c}, ${operator}, …) is not modelled`);
        },
        contains(c: string, vs: unknown) {
          if (!Array.isArray(vs)) throw new Error("memoryBridge: contains() takes an array");
          where.push(`${ident(c)}::text[] @> ${arrayLiteral(vs)}::text[]`); return b;
        },
        order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
          order.push(`${ident(c)} ${o.ascending === false ? "DESC" : "ASC"}${o.nullsFirst === undefined ? "" : o.nullsFirst ? " NULLS FIRST" : " NULLS LAST"}`);
          return b;
        },
        limit(n: number) { limit = n; return b; },
        range(lo: number, hi: number) { offset = lo; limit = hi - lo + 1; return b; },
        single() { single = "single"; return exec(); },
        maybeSingle() { single = "maybe"; return exec(); },
        insert(p: any) { op = "insert"; rows = Array.isArray(p) ? p : [p]; return b; },
        update(p: Record<string, unknown>) { op = "update"; rows = [p]; return b; },
        upsert(p: any, o: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
          op = "upsert"; rows = Array.isArray(p) ? p : [p]; onConflict = o.onConflict ?? null; ignoreDuplicates = o.ignoreDuplicates === true; return b;
        },
        delete() { op = "delete"; return b; },
        then(onF: any, onR: any) { return exec().then(onF, onR); },
      };
      for (const unmodelled of ["or", "ilike", "like", "match", "filter", "textSearch", "overlaps", "csv", "abortSignal"]) {
        b[unmodelled] = () => { throw new Error(`memoryBridge: '${unmodelled}' is not modelled — add it rather than assume it works`); };
      }
      return b;
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      ident(fn);
      if (failOn(fn, "rpc")) return { data: null, error: unavailable() };
      const named = Object.entries(args).map(([k, v]) => {
        const value = v === null || v === undefined ? "NULL"
          : typeof v === "object" ? `${lit(JSON.stringify(v))}::jsonb`
          : lit(v);
        return `${ident(k)} => ${value}`;
      }).join(", ");
      const r = run(`SELECT json_build_array(public.${fn}(${named}))::text;`, log);
      if (r.error) return { data: null, error: r.error };
      return { data: (r.data as unknown[])[0] ?? null, error: null };
    },
  };
}
