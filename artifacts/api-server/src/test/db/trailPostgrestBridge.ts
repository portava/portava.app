/**
 * trailPostgrestBridge — the REAL `@supabase/supabase-js` client, driven by an
 * injected `fetch` that turns each PostgREST request into ONE SQL statement run
 * by `psql` against the local PostgreSQL harness (scripts/local-db/up.sh).
 *
 * WHY: the Trails suites in `src/test/*Trail*` run TrailService and the routes
 * against in-memory fakes. A fake enforces only what its author remembered, so
 * a CHECK, a trigger, a UNIQUE index, a timestamp comparison or a `db/` id that
 * no fixture ever carried is invisible to it. This bridge lets the SAME service
 * and route code run against migration 2910's real tables, triggers and
 * constraints with controlled rows — the client renders every builder call into
 * a PostgREST URL exactly as it does in production, and the database answers.
 *
 * WHAT IS TRANSLATED (the subset `services/trails/TrailService.ts`,
 * `lib/blocks.ts` and `lib/discoveryLocalMomentum.ts` issue, nothing more):
 *   GET     select=<plain columns>, filters eq/neq/gt/gte/lt/lte/is/in/like/ilike
 *           (and `not.` of each), `or=(...)` with `and(...)` groups, order,
 *           limit, offset.
 *   POST    object or array body → INSERT … RETURNING, with the `columns`
 *           parameter postgrest-js sends for arrays.
 *   PATCH   UPDATE … FROM json_populate_record … WHERE <filters>.
 *   DELETE  DELETE … WHERE <filters>.
 *   /auth/v1/user  → the bearer token is a user id; it resolves iff a
 *           `public.profiles` row carries it (the fakes' convention, kept).
 * Anything else THROWS inside `fetch`, which the client surfaces as a resolved
 * `{ data: null, error }` — loud, never an invented answer.
 *
 * Every statement runs as `service_role` (BYPASSRLS, as the API's service
 * client does) inside its own transaction, with `VERBOSITY verbose` so the
 * SQLSTATE comes back and is handed to the client as PostgREST would: 23505 and
 * 23503 as 409, everything else as 400.
 *
 * `failTables` makes a named table's statements fail with a chosen error — the
 * one thing a real database cannot be asked to do on cue.
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { LOCAL_DB_URL } from "./localDb.js";

type Row = Record<string, unknown>;

export interface BridgeOptions {
  /** table → the error every statement against it answers with. */
  failTables?: Record<string, { code: string; message: string }>;
}

export interface BridgeHandle {
  client: any;
  /** Every request the client issued: method + decoded URL path/query. */
  log: Array<{ method: string; path: string; sql: string }>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  const n = name.trim();
  if (!IDENT.test(n)) throw new Error(`trailPostgrestBridge: refusing identifier ${JSON.stringify(name)}`);
  return `"${n}"`;
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function dollar(text: string): string {
  let tag = "b";
  while (text.includes(`$${tag}$`)) tag += "b";
  return `$${tag}$${text}$${tag}$`;
}

/** Split on commas that are not inside parentheses or double quotes. */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
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
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, "$1");
  return t;
}

/** `op.value` (optionally `not.op.value`) on one column → a SQL predicate. */
function condition(col: string, raw: string, alias: string): string {
  const c = `${alias}${ident(col)}`;
  let s = raw;
  let negate = false;
  if (s.startsWith("not.")) { negate = true; s = s.slice(4); }
  const dot = s.indexOf(".");
  if (dot === -1) throw new Error(`trailPostgrestBridge: cannot parse filter ${col}=${raw}`);
  const op = s.slice(0, dot);
  const value = s.slice(dot + 1);
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
      if (v !== "null" && v !== "true" && v !== "false") throw new Error(`trailPostgrestBridge: is.${value}`);
      sql = `${c} IS ${v.toUpperCase()}`;
      break;
    }
    case "in": {
      const inner = value.trim().replace(/^\(/, "").replace(/\)$/, "");
      const items = splitTopLevel(inner).map(unquote);
      sql = items.length === 0 ? "FALSE" : `${c} IN (${items.map(lit).join(", ")})`;
      break;
    }
    default:
      throw new Error(`trailPostgrestBridge: unsupported operator ${op} (${col}=${raw})`);
  }
  return negate ? `NOT (${sql})` : sql;
}

/** One `col.op.value` leaf inside an or()/and() group. */
function leaf(term: string, alias: string): string {
  const m = /^([A-Za-z0-9_]+)\.(.*)$/s.exec(term.trim());
  if (!m) throw new Error(`trailPostgrestBridge: cannot parse or-term ${JSON.stringify(term)}`);
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
  if (parts.length === 0) throw new Error("trailPostgrestBridge: empty logical group");
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

function selectList(select: string | null, alias = ""): string {
  if (!select || select.trim() === "" || select.trim() === "*") return `${alias}*`;
  return select.split(",").map((c) => c.trim()).filter(Boolean).map((c) => {
    if (c.includes("(") || c.includes(":")) throw new Error(`trailPostgrestBridge: embedded/aliased select ${c}`);
    return `${alias}${ident(c)}`;
  }).join(", ");
}

function orderClause(order: string | null): string {
  if (!order) return "";
  const parts = order.split(",").map((p) => {
    const [col, ...mods] = p.split(".");
    const dir = mods.includes("desc") ? "DESC" : "ASC";
    const nulls = mods.includes("nullsfirst") ? " NULLS FIRST" : mods.includes("nullslast") ? " NULLS LAST" : "";
    return `${ident(col!)} ${dir}${nulls}`;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}

interface Exec { ok: boolean; stdout: string; code: string; message: string; details: string }

function run(sql: string): Exec {
  const script = `\\set VERBOSITY verbose\nSET LOCAL ROLE service_role;\n${sql}\n`;
  const r = spawnSync("psql", ["-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-At", LOCAL_DB_URL], {
    input: script, encoding: "utf8", timeout: 60_000,
  });
  if (r.status === 0) return { ok: true, stdout: (r.stdout ?? "").trim(), code: "", message: "", details: "" };
  const stderr = r.stderr ?? "";
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
  const d = /DETAIL:\s+(.*)/.exec(stderr);
  return { ok: false, stdout: "", code: m?.[1] ?? "XX000", message: m?.[2]?.trim() ?? stderr.trim(), details: d?.[1]?.trim() ?? "" };
}

function json(body: unknown, status: number): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function pgError(e: Exec): Response {
  const status = e.code === "23505" || e.code === "23503" ? 409 : 400;
  return json({ code: e.code, message: e.message, details: e.details || null, hint: null }, status);
}

export function makeTrailBridge(opts: BridgeOptions = {}): BridgeHandle {
  const log: BridgeHandle["log"] = [];

  const fetchImpl = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers ?? input?.headers;
    if (h && typeof h.forEach === "function") h.forEach((v: string, k: string) => (headers[k.toLowerCase()] = v));
    else for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
    const body: string | null = typeof init?.body === "string" ? init.body : null;

    // ── GoTrue: the bearer token IS the user id, admitted iff a profile exists.
    if (url.pathname === "/auth/v1/user") {
      const token = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ code: 401, msg: "invalid JWT" }, 401);
      const e = run(`SELECT count(*) FROM public.profiles WHERE id = ${lit(token)};`);
      if (!e.ok || e.stdout !== "1") return json({ code: 401, msg: "invalid JWT" }, 401);
      return json({ id: token, aud: "authenticated", role: "authenticated", email: `${token}@local.test` }, 200);
    }

    if (!url.pathname.startsWith("/rest/v1/")) throw new Error(`trailPostgrestBridge: unhandled path ${url.pathname}`);
    const table = url.pathname.slice("/rest/v1/".length);
    if (table.startsWith("rpc/")) throw new Error(`trailPostgrestBridge: rpc is out of scope (${table})`);
    const t = `public.${ident(table)}`;
    const params = url.searchParams;
    const prefer = headers["prefer"] ?? "";
    const representation = prefer.includes("return=representation");
    const select = params.get("select");

    const failure = opts.failTables?.[table];
    if (failure) {
      log.push({ method, path: `${url.pathname}${url.search}`, sql: "(failTables)" });
      return json({ ...failure, details: null, hint: null }, 400);
    }

    let sql: string;
    if (method === "GET" || method === "HEAD") {
      const limit = params.get("limit");
      const offset = params.get("offset");
      sql = `SELECT COALESCE(json_agg(_q), '[]'::json)::text FROM (SELECT ${selectList(select)} FROM ${t}`
        + `${whereClause(params, "")}${orderClause(params.get("order"))}`
        + `${limit !== null ? ` LIMIT ${Number(limit)}` : ""}${offset !== null ? ` OFFSET ${Number(offset)}` : ""}) _q;`;
      log.push({ method, path: `${url.pathname}${url.search}`, sql });
      const e = run(sql);
      if (!e.ok) return pgError(e);
      return json(JSON.parse(e.stdout || "[]"), 200);
    }

    const returning = representation ? ` RETURNING ${selectList(select)}` : "";
    const wrap = (inner: string) => representation
      ? `WITH _w AS (${inner}) SELECT COALESCE(json_agg(_w), '[]'::json)::text FROM _w;`
      : `${inner};`;

    if (method === "POST") {
      const parsed = body ? JSON.parse(body) : null;
      const rows: Row[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      const colsParam = params.get("columns");
      const cols = colsParam
        ? colsParam.split(",").map((c) => c.replace(/"/g, "").trim()).filter(Boolean)
        : [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const colList = cols.map(ident).join(", ");
      const inner = `INSERT INTO ${t} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${t}, ${dollar(JSON.stringify(rows))}::json)${returning}`;
      sql = wrap(inner);
    } else if (method === "PATCH") {
      const patch = (body ? JSON.parse(body) : {}) as Row;
      const cols = Object.keys(patch);
      const set = cols.map((c) => `${ident(c)} = _r.${ident(c)}`).join(", ");
      const inner = `UPDATE ${t} AS _t SET ${set} FROM json_populate_record(NULL::${t}, ${dollar(JSON.stringify(patch))}::json) AS _r`
        + `${whereClause(params, "_t.")}${representation ? ` RETURNING ${selectList(select, "_t.")}` : ""}`;
      sql = wrap(inner);
    } else if (method === "DELETE") {
      const inner = `DELETE FROM ${t} AS _t${whereClause(params, "_t.")}${representation ? ` RETURNING ${selectList(select, "_t.")}` : ""}`;
      sql = wrap(inner);
    } else {
      throw new Error(`trailPostgrestBridge: unhandled method ${method}`);
    }

    log.push({ method, path: `${url.pathname}${url.search}`, sql });
    const e = run(sql);
    if (!e.ok) return pgError(e);
    if (!representation) return json(null, method === "POST" ? 201 : 204);
    return json(JSON.parse(e.stdout || "[]"), method === "POST" ? 201 : 200);
  };

  const client = createClient("http://trail-bridge.invalid", "bridge-service-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl as any },
  });
  return { client, log };
}
