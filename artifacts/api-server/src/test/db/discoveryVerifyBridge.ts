/**
 * discoveryVerifyBridge — the REAL `@supabase/supabase-js` client, driven by an
 * injected fetch that turns each PostgREST request into ONE SQL statement run by
 * psql as service_role against the local PostgreSQL harness (LOCAL_DB_URL,
 * scripts/local-db/up.sh). Not a test file: census-discovery §59's database
 * suites (`discoveryVerify*.db.test.ts`) import it.
 *
 * It extends `trailPostgrestBridge.ts`'s translation (census §51) with what the
 * Discovery serve, outcome, attribution and admin debug paths issue: `rpc/`
 * calls typed from pg_proc, `on_conflict` upserts (ignore- and
 * merge-duplicates), `single()`'s object Accept header, HEAD + `count=exact`,
 * and PostgREST's `col->key` / `col->>key` JSON paths inside `or=(…)`.
 *
 * `feature_flags` is NEVER read from or written to the database: reads are
 * answered from an in-memory VALUES list (`flags`), and any write to it throws.
 *
 * LOUD: a request shape it does not model THROWS inside fetch — supabase-js
 * surfaces that as a resolved `{ data: null, error }` — and is recorded in
 * `unmodelled`; every statement the DATABASE refuses is recorded in `failed`
 * with its SQLSTATE, so a suite can assert that nothing on its path failed
 * silently behind a 200.
 *
 * It cannot dial Supabase: the fetch is the client's only transport and the URL
 * is the literal "http://p12-verify-bridge.invalid".
 */
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { LOCAL_DB_URL } from "./localDb.js";
import { PostgrestEmbedError, selectListWithEmbeds } from "./postgrestEmbed.js";
// ═════════════════════════════════════════════════════════════════════════════
// The bridge: real supabase-js → PostgREST-shaped fetch → one SQL statement.
// LOUD: a request shape it does not model THROWS inside fetch, which the client
// surfaces as a resolved `{ data: null, error }` and which `unmodelled` records,
// so V-tests can assert that nothing on the chain's path went unmodelled.
// ═════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;
const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  const n = name.trim();
  if (!IDENT.test(n)) throw new Error(`bridge: refusing identifier ${JSON.stringify(name)}`);
  return `"${n}"`;
}
export function lit(v: string): string { return `'${v.replace(/'/g, "''")}'`; }
function dollar(text: string): string {
  let tag = "v";
  while (text.includes(`$${tag}$`)) tag += "v";
  return `$${tag}$${text}$${tag}$`;
}
/** A column reference, with PostgREST's `col->key` / `col->>key` JSON paths. */
function colRef(spec: string, alias: string): string {
  const m = /^([a-z_][a-z0-9_]*)(->>?)([A-Za-z0-9_]+)$/.exec(spec.trim());
  if (m) return `${alias}${ident(m[1]!)}${m[2]}${lit(m[3]!)}`;
  return `${alias}${ident(spec)}`;
}
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of expr) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}
function unquote(v: string): string {
  const t = v.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, "$1") : t;
}
function condition(col: string, raw: string, alias: string): string {
  const c = colRef(col, alias);
  let s = raw, negate = false;
  if (s.startsWith("not.")) { negate = true; s = s.slice(4); }
  const dot = s.indexOf(".");
  if (dot === -1) throw new Error(`bridge: cannot parse filter ${col}=${raw}`);
  const op = s.slice(0, dot), value = s.slice(dot + 1);
  let sql: string;
  switch (op) {
    case "eq": sql = `${c} = ${lit(unquote(value))}`; break;
    case "neq": sql = `${c} <> ${lit(unquote(value))}`; break;
    case "gt": sql = `${c} > ${lit(unquote(value))}`; break;
    case "gte": sql = `${c} >= ${lit(unquote(value))}`; break;
    case "lt": sql = `${c} < ${lit(unquote(value))}`; break;
    case "lte": sql = `${c} <= ${lit(unquote(value))}`; break;
    case "like": sql = `${c}::text LIKE ${lit(unquote(value).replace(/\*/g, "%"))}`; break;
    case "ilike": sql = `${c}::text ILIKE ${lit(unquote(value).replace(/\*/g, "%"))}`; break;
    case "is": {
      const v = value.trim().toLowerCase();
      if (v !== "null" && v !== "true" && v !== "false") throw new Error(`bridge: is.${value}`);
      sql = `${c} IS ${v.toUpperCase()}`;
      break;
    }
    case "in": {
      const items = splitTopLevel(value.trim().replace(/^\(/, "").replace(/\)$/, "")).map(unquote);
      sql = items.length === 0 ? "FALSE" : `${c} IN (${items.map(lit).join(", ")})`;
      break;
    }
    default: throw new Error(`bridge: unsupported operator ${op} (${col}=${raw})`);
  }
  return negate ? `NOT (${sql})` : sql;
}
function leaf(term: string, alias: string): string {
  const m = /^([a-z_][a-z0-9_]*(?:->>?[A-Za-z0-9_]+)?)\.(.*)$/s.exec(term.trim());
  if (!m) throw new Error(`bridge: cannot parse or-term ${JSON.stringify(term)}`);
  return condition(m[1]!, m[2]!, alias);
}
function group(expr: string, joiner: "OR" | "AND", alias: string): string {
  const parts = splitTopLevel(expr).map((p) => {
    const and = /^and\(([\s\S]*)\)$/.exec(p);
    if (and) return group(and[1]!, "AND", alias);
    const or = /^or\(([\s\S]*)\)$/.exec(p);
    if (or) return group(or[1]!, "OR", alias);
    return leaf(p, alias);
  });
  if (parts.length === 0) throw new Error("bridge: empty logical group");
  return `(${parts.join(` ${joiner} `)})`;
}
const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);
function whereClause(params: URLSearchParams, alias: string): string {
  const conds: string[] = [];
  for (const [k, v] of params.entries()) {
    if (RESERVED.has(k)) continue;
    if (k === "or") { conds.push(group(v.replace(/^\(/, "").replace(/\)$/, ""), "OR", alias)); continue; }
    if (k === "and") { conds.push(group(v.replace(/^\(/, "").replace(/\)$/, ""), "AND", alias)); continue; }
    conds.push(condition(k, v, alias));
  }
  return conds.length === 0 ? "" : ` WHERE ${conds.join(" AND ")}`;
}
// `table` is passed by the GET path only (an unaliased FROM over a real table): one level of FK-hinted
// embedding, `relation!constraint(cols)`, is translated there against the REAL foreign key
// (./postgrestEmbed.ts) — the account-state gate's read of `profiles` on every authenticated request.
function selectList(select: string | null, alias = "", table: string | null = null): string {
  if (!select || select.trim() === "" || select.trim() === "*") return `${alias}*`;
  const plain = (c: string): string => {
    if (c.includes("(") || c.includes(":")) throw new Error(`bridge: embedded/aliased select ${c}`);
    return `${alias}${ident(c)}`;
  };
  if (table !== null && alias === "") {
    const withEmbeds = selectListWithEmbeds(table, select, plain, (sql) => { const e = run(sql); return e.ok ? e.stdout.split("\n").filter((l) => l.length > 0) : null; });
    if (withEmbeds !== null) return withEmbeds;
  }
  return splitTopLevel(select).map(plain).join(", ");
}
function orderClause(order: string | null): string {
  if (!order) return "";
  return ` ORDER BY ${order.split(",").map((p) => {
    const [col, ...mods] = p.split(".");
    const dir = mods.includes("desc") ? "DESC" : "ASC";
    const nulls = mods.includes("nullsfirst") ? " NULLS FIRST" : mods.includes("nullslast") ? " NULLS LAST" : "";
    return `${ident(col!)} ${dir}${nulls}`;
  }).join(", ")}`;
}
interface Ran { ok: boolean; stdout: string; code: string; message: string; details: string }
function run(sql: string): Ran {
  const r = spawnSync("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL], {
    input: `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${sql}\n`, encoding: "utf8", timeout: 60_000,
  });
  if (r.status === 0) return { ok: true, stdout: (r.stdout ?? "").trim(), code: "", message: "", details: "" };
  const stderr = r.stderr ?? "";
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
  const d = /DETAIL:\s+(.*)/.exec(stderr);
  return { ok: false, stdout: "", code: m?.[1] ?? "XX000", message: m?.[2]?.trim() ?? stderr.trim(), details: d?.[1]?.trim() ?? "" };
}
function respond(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}
let onFailure: ((line: string) => void) | null = null;
function pgFailure(e: Ran): Response {
  onFailure?.(`${e.code} ${e.message}`);
  const status = e.code === "23505" || e.code === "23503" ? 409 : 400;
  return respond({ code: e.code, message: e.message, details: e.details || null, hint: null }, status);
}

export interface BridgeOpts { flags: Record<string, { enabled: boolean; metadata?: Record<string, unknown> }>; tokens: Record<string, string> }
export interface Bridge { client: any; log: Array<{ method: string; path: string }>; unmodelled: string[]; failed: string[] }

export function bridge(opts: BridgeOpts): Bridge {
  const log: Bridge["log"] = [];
  const unmodelled: string[] = [];
  /** Statements the DATABASE refused, with SQLSTATE — the evidence a case asserts on. */
  const failed: string[] = [];
  const flagsCte = (): string => {
    const entries = Object.entries(opts.flags);
    const values = entries.length === 0
      ? "SELECT NULL::text AS flag, NULL::boolean AS enabled, NULL::jsonb AS metadata WHERE false"
      : `SELECT * FROM (VALUES ${entries.map(([f, v]) => `(${lit(f)}, ${v.enabled}, ${dollar(JSON.stringify(v.metadata ?? {}))}::jsonb)`).join(", ")}) v(flag, enabled, metadata)`;
    return `WITH feature_flags AS (${values}) `;
  };

  const fetchImpl = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    onFailure = (line) => failed.push(`${String(init?.method ?? "GET").toUpperCase()} ${url.pathname} :: ${line}`);
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers ?? input?.headers;
    if (h && typeof h.forEach === "function") h.forEach((v: string, k: string) => (headers[k.toLowerCase()] = v));
    else for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
    const body: string | null = typeof init?.body === "string" ? init.body : null;
    log.push({ method, path: `${url.pathname}${url.search}` });
    try {
      if (url.pathname === "/auth/v1/user") {
        const token = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
        const id = opts.tokens[token];
        if (!id) return respond({ code: 401, msg: "invalid JWT" }, 401);
        return respond({ id, aud: "authenticated", role: "authenticated", email: `${id}@local.test` }, 200);
      }
      if (!url.pathname.startsWith("/rest/v1/")) throw new Error(`unhandled path ${url.pathname}`);
      const target = url.pathname.slice("/rest/v1/".length);
      const params = url.searchParams;
      const prefer = headers["prefer"] ?? "";
      const accept = headers["accept"] ?? "";
      const single = accept.includes("application/vnd.pgrst.object+json");

      if (target.startsWith("rpc/")) {
        const fn = target.slice(4);
        ident(fn);
        const sig = run(`SELECT pg_get_function_identity_arguments(p.oid) || '|' || p.proretset || '|' || format_type(p.prorettype, NULL) FROM pg_proc p WHERE p.proname = ${lit(fn)} AND p.pronamespace = 'public'::regnamespace;`);
        if (!sig.ok || sig.stdout === "") return respond({ code: "PGRST202", message: `Could not find the function public.${fn}`, details: null, hint: null }, 404);
        if (sig.stdout.split("\n").length > 1) throw new Error(`rpc ${fn} is overloaded`);
        const [argList, retset, rettype] = sig.stdout.split("|");
        const args = (body ? JSON.parse(body) : {}) as Row;
        const j = `${dollar(JSON.stringify(args))}::jsonb`;
        const named = (argList ?? "").split(",").map((a) => a.trim()).filter(Boolean).map((a) => {
          const [name, ...type] = a.split(/\s+/);
          const t = type.join(" ");
          if (!(name! in args)) return null;
          const v = t === "jsonb" ? `(${j}->${lit(name!)})` : t === "json" ? `(${j}->${lit(name!)})::json`
            : t.endsWith("[]") ? `ARRAY(SELECT jsonb_array_elements_text(${j}->${lit(name!)}))::${t}`
            : `(${j}->>${lit(name!)})::${t}`;
          return `${ident(name!)} => ${v}`;
        }).filter(Boolean).join(", ");
        const sql = retset === "t"
          ? `SELECT COALESCE(json_agg(_r), '[]'::json)::text FROM public.${ident(fn)}(${named}) _r;`
          : rettype === "void" ? `SELECT public.${ident(fn)}(${named}); SELECT 'null';`
          : `SELECT COALESCE(to_json(public.${ident(fn)}(${named})), 'null'::json)::text;`;
        const e = run(sql);
        if (!e.ok) return pgFailure(e);
        const out = e.stdout.split("\n").pop() ?? "null";
        return respond(JSON.parse(out), 200);
      }

      const isFlags = target === "feature_flags";
      if (isFlags && method !== "GET" && method !== "HEAD") throw new Error("a write to feature_flags — this suite never writes a flag");
      const t = isFlags ? "feature_flags" : `public.${ident(target)}`;
      const select = params.get("select");
      if (method === "GET" || method === "HEAD") {
        const limit = params.get("limit"), offset = params.get("offset");
        let columns: string;
        try {
          columns = selectList(select, "", isFlags ? null : target);
        } catch (err) {
          // An embed PostgREST would refuse (no such relationship): its answer, 400 + PGRST200.
          if (!(err instanceof PostgrestEmbedError)) throw err;
          failed.push(`${method} ${url.pathname} :: ${err.body.code} ${err.body.message}`);
          return respond(err.body, 400);
        }
        const inner = `SELECT ${columns} FROM ${t}${whereClause(params, "")}${orderClause(params.get("order"))}`
          + `${limit !== null ? ` LIMIT ${Number(limit)}` : ""}${offset !== null ? ` OFFSET ${Number(offset)}` : ""}`;
        const sql = `${isFlags ? flagsCte() : ""}SELECT COALESCE(json_agg(_q), '[]'::json)::text FROM (${inner}) _q;`;
        const e = run(sql);
        if (!e.ok) return pgFailure(e);
        const data = JSON.parse(e.stdout || "[]") as Row[];
        const extra: Record<string, string> = /count=exact/.test(prefer) ? { "content-range": `0-${Math.max(0, data.length - 1)}/${data.length}` } : {};
        if (method === "HEAD") return new Response(null, { status: 200, headers: extra });
        if (single) {
          if (data.length !== 1) return respond({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${data.length} rows`, hint: null }, 406);
          return respond(data[0], 200, extra);
        }
        return respond(data, 200, extra);
      }

      const representation = prefer.includes("return=representation");
      const returning = representation ? ` RETURNING ${selectList(select)}` : "";
      const wrap = (inner: string) => representation ? `WITH _w AS (${inner}) SELECT COALESCE(json_agg(_w), '[]'::json)::text FROM _w;` : `${inner};`;
      let sql: string;
      if (method === "POST") {
        const parsed = body ? JSON.parse(body) : null;
        const rowsIn: Row[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        const colsParam = params.get("columns");
        const cols = colsParam ? colsParam.split(",").map((c) => c.replace(/"/g, "").trim()).filter(Boolean) : [...new Set(rowsIn.flatMap((r) => Object.keys(r)))];
        const colList = cols.map(ident).join(", ");
        let conflict = "";
        const onConflict = params.get("on_conflict");
        if (prefer.includes("resolution=ignore-duplicates")) {
          conflict = onConflict ? ` ON CONFLICT (${onConflict.split(",").map(ident).join(", ")}) DO NOTHING` : " ON CONFLICT DO NOTHING";
        } else if (prefer.includes("resolution=merge-duplicates")) {
          if (!onConflict) throw new Error(`merge-duplicates on ${target} without on_conflict is not modelled`);
          const keys = new Set(onConflict.split(",").map((c) => c.trim()));
          const set = cols.filter((c) => !keys.has(c)).map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ");
          conflict = ` ON CONFLICT (${[...keys].map(ident).join(", ")}) ${set ? `DO UPDATE SET ${set}` : "DO NOTHING"}`;
        }
        sql = wrap(`INSERT INTO ${t} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${t}, ${dollar(JSON.stringify(rowsIn))}::json)${conflict}${returning}`);
      } else if (method === "PATCH") {
        const patch = (body ? JSON.parse(body) : {}) as Row;
        const set = Object.keys(patch).map((c) => `${ident(c)} = _r.${ident(c)}`).join(", ");
        sql = wrap(`UPDATE ${t} AS _t SET ${set} FROM json_populate_record(NULL::${t}, ${dollar(JSON.stringify(patch))}::json) AS _r${whereClause(params, "_t.")}${representation ? ` RETURNING ${selectList(select, "_t.")}` : ""}`);
      } else if (method === "DELETE") {
        sql = wrap(`DELETE FROM ${t} AS _t${whereClause(params, "_t.")}${representation ? ` RETURNING ${selectList(select, "_t.")}` : ""}`);
      } else {
        throw new Error(`unhandled method ${method}`);
      }
      const e = run(sql);
      if (!e.ok) return pgFailure(e);
      if (!representation) return respond(null, method === "POST" ? 201 : 204);
      const data = JSON.parse(e.stdout || "[]") as Row[];
      if (single) {
        if (data.length !== 1) return respond({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${data.length} rows`, hint: null }, 406);
        return respond(data[0], method === "POST" ? 201 : 200);
      }
      return respond(data, method === "POST" ? 201 : 200);
    } catch (err) {
      unmodelled.push(`${method} ${url.pathname}${url.search} :: ${(err as Error).message}`);
      throw err;
    }
  };

  const client = createClient("http://p12-verify-bridge.invalid", "p12-verify-service-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl as any },
  });
  return { client, log, unmodelled, failed };
}
