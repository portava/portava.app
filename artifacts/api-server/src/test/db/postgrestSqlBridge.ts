/**
 * postgrestSqlBridge — the REAL `@supabase/supabase-js` client, driven by an
 * injected fetch that turns each PostgREST request into SQL executed by a real
 * PostgreSQL engine (PGlite or psql, see `pressedLayoverDb.ts`). Not a test
 * file: the pressed-state layover suites (`layoverPressed*.db.test.ts`) import
 * it through `pressedLayoverDb`.
 *
 * WHY ANOTHER BRIDGE. `discoveryVerifyBridge.ts` and `trailPostgrestBridge.ts`
 * translate the request shapes THEIR routes issue, over psql, and answer
 * `feature_flags` from memory. The layover routes issue more: embeds resolved
 * through foreign keys (`profiles!author_id(…)`, `layover_sessions!inner(…)`,
 * `airport_profiles(city)`), JSON-path filters (`metadata->disruption=not.is.null`),
 * `cs`, `not.in`, HEAD counts, multi-group inserts and RPCs. And the point of
 * the pressed-state suites is that FLAGS ARE REAL ROWS: a press is a migration
 * plus a flag flip, so `feature_flags` is read from and written to the database
 * like every other table.
 *
 * WHAT IT MODELS, AND HOW FAITHFULLY
 *   - ONE request = ONE transaction, run as `service_role` (BYPASSRLS) with
 *     `request.jwt.claims` = {"role":"service_role"} — what PostgREST does for the
 *     API's service key — or as `authenticated` with the user's `sub` when a
 *     suite asks for the client-side path (`asUserClient`).
 *   - A missing table answers 404 PGRST205 "Could not find the table 'public.x'
 *     in the schema cache"; a write naming an unknown column answers 400
 *     PGRST204; a missing function 404 PGRST202; an embed with no relationship
 *     400 PGRST200, with more than one 300 PGRST201 — PostgREST's own codes,
 *     because the code under test branches on them (lib/tableAbsence.ts,
 *     lib/capability/schemaCapability.ts).
 *   - Every SQLSTATE the database raises reaches the client with PostgREST's
 *     HTTP status (23505/23503 → 409, 42501 → 403, P0001/23514/22P02/… → 400)
 *     and is recorded in `failed`, so a suite can assert nothing on its path
 *     failed silently behind a 200.
 * LOUD: a request shape it does not model THROWS inside fetch (supabase-js
 * surfaces that as `{ data: null, error }`) and is recorded in `unmodelled`.
 *
 * It cannot dial anything: the fetch is the client's only transport and the URL
 * is a `.invalid` host.
 */
import { createClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

/** A database error as the engine reports it (SQLSTATE + texts). */
export interface PgFailure { code: string; message: string; detail?: string; hint?: string }

/** The engine the bridge needs: run statements as one transaction under a role; superuser query. */
export interface BridgeEngine {
  /** Run `statements` in ONE transaction as `role` with `claims`; returns the JSON text of the LAST statement's single value. Throws a PgFailure-shaped error. */
  request(statements: string[], role: "service_role" | "authenticated" | "anon", claims: Record<string, unknown>): Promise<string>;
  /** Superuser read, rows as objects (catalog lookups). */
  query(sql: string): Promise<Row[]>;
}

export interface BridgeFault {
  /** Return a response to send INSTEAD of executing the request (e.g. an unreadable flag), or null to proceed. */
  (req: { method: string; target: string; params: URLSearchParams; body: unknown }): { status: number; body: unknown } | null;
}

export interface Bridge {
  client: any;
  log: Array<{ method: string; path: string; status: number }>;
  unmodelled: string[];
  failed: string[];
  faults: BridgeFault[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function ident(name: string): string {
  const n = name.trim();
  if (!IDENT.test(n)) throw new Error(`bridge: refusing identifier ${JSON.stringify(name)}`);
  return `"${n}"`;
}
export function lit(v: string): string { return `'${v.replace(/'/g, "''")}'`; }
export function dollar(text: string): string {
  let tag = "b";
  while (text.includes(`$${tag}$`)) tag += "b";
  return `$${tag}$${text}$${tag}$`;
}
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === '"' && expr[i - 1] !== "\\") quoted = !quoted;
    if (!quoted && (ch === "(" || ch === "{" || ch === "[")) depth++;
    if (!quoted && (ch === ")" || ch === "}" || ch === "]")) depth--;
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

/** A column reference with PostgREST's JSON paths: `col`, `col->a`, `col->a->>b`. */
function colRef(spec: string, alias: string): string {
  const s = spec.trim();
  const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:->>?[A-Za-z0-9_]+)*)$/.exec(s);
  if (!m) throw new Error(`bridge: unsupported column reference ${JSON.stringify(spec)}`);
  let out = `${alias}${ident(m[1]!)}`;
  const path = m[2] ?? "";
  for (const p of path.matchAll(/(->>?)([A-Za-z0-9_]+)/g)) out += `${p[1]}${/^\d+$/.test(p[2]!) ? p[2] : lit(p[2]!)}`;
  return out;
}
/** The output key PostgREST gives a selected column: the last JSON-path segment, or the column. */
function colKey(spec: string): string {
  const parts = spec.split(/->>?/);
  return parts[parts.length - 1]!.trim();
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
    case "cs": sql = `${c} @> ${lit(value)}`; break;
    case "cd": sql = `${c} <@ ${lit(value)}`; break;
    case "ov": sql = `${c} && ${lit(value)}`; break;
    case "is": {
      const v = value.trim().toLowerCase();
      if (!["null", "true", "false", "unknown"].includes(v)) throw new Error(`bridge: is.${value}`);
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
  const m = /^([A-Za-z_][A-Za-z0-9_]*(?:->>?[A-Za-z0-9_]+)*)\.(.*)$/s.exec(term.trim());
  if (!m) throw new Error(`bridge: cannot parse or-term ${JSON.stringify(term)}`);
  return condition(m[1]!, m[2]!, alias);
}
function group(expr: string, joiner: "OR" | "AND", alias: string): string {
  const parts = splitTopLevel(expr).map((p) => {
    const and = /^(not\.)?and\(([\s\S]*)\)$/.exec(p);
    if (and) return `${and[1] ? "NOT " : ""}${group(and[2]!, "AND", alias)}`;
    const or = /^(not\.)?or\(([\s\S]*)\)$/.exec(p);
    if (or) return `${or[1] ? "NOT " : ""}${group(or[2]!, "OR", alias)}`;
    return leaf(p, alias);
  });
  if (parts.length === 0) throw new Error("bridge: empty logical group");
  return `(${parts.join(` ${joiner} `)})`;
}
const RESERVED = new Set(["select", "order", "limit", "offset", "columns", "on_conflict"]);

/** Filters for one level: top-level params, or the `<embed>.`-prefixed ones for an embed. */
function filtersFor(params: URLSearchParams, prefix: string, alias: string): string[] {
  const conds: string[] = [];
  for (const [k, v] of params.entries()) {
    let key = k;
    if (prefix) { if (!k.startsWith(prefix)) continue; key = k.slice(prefix.length); }
    if (RESERVED.has(key) || (prefix === "" && /\.(order|limit|offset)$/.test(key))) continue;
    if (!prefix && key.includes(".") && !/^(not\.)?(or|and)$/.test(key)) continue; // an embed's filter
    if (key.includes(".") && prefix) continue; // a deeper embed's filter
    const g = /^(not\.)?(or|and)$/.exec(key);
    if (g) { conds.push(`${g[1] ? "NOT " : ""}${group(v.replace(/^\(/, "").replace(/\)$/, ""), g[2] === "or" ? "OR" : "AND", alias)}`); continue; }
    conds.push(condition(key, v, alias));
  }
  return conds;
}

function orderClause(order: string | null, alias: string): string {
  if (!order) return "";
  return ` ORDER BY ${splitTopLevel(order).map((p) => {
    const parts = p.split(".");
    const mods = parts.filter((x) => ["asc", "desc", "nullsfirst", "nullslast"].includes(x));
    const col = parts.filter((x) => !mods.includes(x)).join(".");
    const dir = mods.includes("desc") ? "DESC" : "ASC";
    const nulls = mods.includes("nullsfirst") ? " NULLS FIRST" : mods.includes("nullslast") ? " NULLS LAST" : "";
    return `${colRef(col, alias)} ${dir}${nulls}`;
  }).join(", ")}`;
}

// ── the select grammar ─────────────────────────────────────────────────────────

type SelItem =
  | { kind: "star" }
  | { kind: "col"; spec: string; alias: string | null; cast: string | null }
  | { kind: "embed"; name: string; hint: string | null; inner: boolean; alias: string | null; children: SelItem[] };

function parseSelect(select: string | null): SelItem[] {
  if (!select || select.trim() === "" || select.trim() === "*") return [{ kind: "star" }];
  return splitTopLevel(select.replace(/\s+/g, " ")).map((raw) => {
    const item = raw.trim();
    if (item === "*") return { kind: "star" } as SelItem;
    const paren = item.indexOf("(");
    if (paren > 0 && item.endsWith(")")) {
      let head = item.slice(0, paren).trim();
      const inner = item.slice(paren + 1, -1);
      let alias: string | null = null;
      const colon = head.indexOf(":");
      if (colon > 0) { alias = head.slice(0, colon).trim(); head = head.slice(colon + 1).trim(); }
      const bang = head.split("!").map((s) => s.trim());
      const name = bang[0]!;
      let hint: string | null = null, isInner = false;
      for (const b of bang.slice(1)) { if (b === "inner") isInner = true; else if (b === "left") { /* default */ } else hint = b; }
      if (head.startsWith("...")) throw new Error(`bridge: spread embed ${item} is not modelled`);
      return { kind: "embed", name, hint, inner: isInner, alias, children: parseSelect(inner) } as SelItem;
    }
    let spec = item, alias: string | null = null, cast: string | null = null;
    const colon = /^([A-Za-z_][A-Za-z0-9_]*):(?!:)(.*)$/.exec(spec);
    if (colon) { alias = colon[1]!; spec = colon[2]!.trim(); }
    const castM = /^(.*)::([A-Za-z_][A-Za-z0-9_ ]*(?:\[\])?)$/.exec(spec);
    if (castM) { spec = castM[1]!.trim(); cast = castM[2]!.trim(); }
    if (/\(\)$/.test(spec)) throw new Error(`bridge: aggregate select ${item} is not modelled`);
    return { kind: "col", spec, alias, cast } as SelItem;
  });
}

// ── relationships, from the REAL catalog ───────────────────────────────────────

interface Fk { name: string; table: string; cols: string[]; refTable: string; refCols: string[] }
interface Catalog { fks: Fk[]; columns: Map<string, Set<string>>; unique: Map<string, string[][]>; relkinds: Map<string, string> }

async function loadCatalog(engine: BridgeEngine): Promise<Catalog> {
  const fkRows = await engine.query(`
    SELECT c.conname AS name, cl.relname AS "table", rf.relname AS "refTable",
           (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols,
           (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS "refCols"
      FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class rf ON rf.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_namespace rn ON rn.oid = rf.relnamespace
     WHERE c.contype = 'f' AND n.nspname = 'public' AND rn.nspname = 'public'`);
  const colRows = await engine.query(`
    SELECT c.relname AS "table", c.relkind::text AS kind, json_agg(a.attname) AS cols
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') GROUP BY c.relname, c.relkind`);
  const uqRows = await engine.query(`
    SELECT cl.relname AS "table", (SELECT json_agg(a.attname ORDER BY a.attname) FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols
      FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype IN ('p', 'u') AND n.nspname = 'public'`);
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as string[];
  const columns = new Map<string, Set<string>>();
  const relkinds = new Map<string, string>();
  for (const r of colRows) { columns.set(String(r.table), new Set(parse(r.cols))); relkinds.set(String(r.table), String(r.kind)); }
  const unique = new Map<string, string[][]>();
  for (const r of uqRows) { const t = String(r.table); unique.set(t, [...(unique.get(t) ?? []), parse(r.cols)]); }
  return {
    fks: fkRows.map((r) => ({ name: String(r.name), table: String(r.table), refTable: String(r.refTable), cols: parse(r.cols), refCols: parse(r.refCols) })),
    columns, unique, relkinds,
  };
}

export class PostgrestShapeError extends Error {
  constructor(public status: number, public body: { code: string; message: string; details: string | null; hint: string | null }) { super(body.message); }
}

interface Rel { fk: Fk; toMany: boolean; childIsFkSide: boolean }
function resolveRel(cat: Catalog, parent: string, child: string, hint: string | null): Rel {
  const cands: Rel[] = [];
  for (const fk of cat.fks) {
    if (fk.table === child && fk.refTable === parent) {
      const uniq = (cat.unique.get(child) ?? []).some((u) => u.length === fk.cols.length && [...fk.cols].sort().every((c, i) => c === u[i]));
      cands.push({ fk, toMany: !uniq, childIsFkSide: true });
    }
    if (fk.table === parent && fk.refTable === child && !(fk.table === child)) cands.push({ fk, toMany: false, childIsFkSide: false });
    if (fk.table === parent && fk.refTable === child && fk.table === child) cands.push({ fk, toMany: false, childIsFkSide: false });
  }
  const hinted = hint === null ? cands : cands.filter((c) => c.fk.name === hint || (c.fk.cols.length === 1 && c.fk.cols[0] === hint));
  if (hinted.length === 0) {
    throw new PostgrestShapeError(400, { code: "PGRST200", message: `Could not find a relationship between '${parent}' and '${child}' in the schema cache`, details: hint ? `Searched for a foreign key relationship between '${parent}' and '${child}' using the hint '${hint}' in the schema 'public', but no matches were found.` : null, hint: null });
  }
  if (hinted.length > 1) {
    throw new PostgrestShapeError(300, { code: "PGRST201", message: `Could not embed because more than one relationship was found for '${parent}' and '${child}'`, details: hinted.map((c) => c.fk.name).join(", "), hint: "Try changing the embed to one of the relationships, e.g. by using the constraint name as hint." });
  }
  return hinted[0]!;
}

let aliasSeq = 0;
/** jsonb object for one row of `alias` (a table alias) from `items`; embeds recurse. */
function objectExpr(cat: Catalog, table: string, alias: string, items: SelItem[], params: URLSearchParams, path: string): string {
  const parts: string[] = [];
  let base = "'{}'::jsonb";
  for (const it of items) {
    if (it.kind === "star") base = `to_jsonb(${alias}.*)`;
    else if (it.kind === "col") {
      checkColumn(cat, table, it.spec);
      const ref = colRef(it.spec, `${alias}.`);
      parts.push(`jsonb_build_object(${lit(it.alias ?? colKey(it.spec))}, ${it.cast ? `(${ref})::${it.cast}` : ref})`);
    } else parts.push(`jsonb_build_object(${lit(it.alias ?? it.name)}, ${embedExpr(cat, table, alias, it, params, path)})`);
  }
  return [base, ...parts].join(" || ");
}
function joinCond(rel: Rel, parentAlias: string, childAlias: string): string {
  const fk = rel.fk;
  return fk.cols.map((c, i) => rel.childIsFkSide
    ? `${childAlias}.${ident(c)} = ${parentAlias}.${ident(fk.refCols[i]!)}`
    : `${childAlias}.${ident(fk.refCols[i]!)} = ${parentAlias}.${ident(c)}`).join(" AND ");
}
function embedExpr(cat: Catalog, parent: string, parentAlias: string, it: Extract<SelItem, { kind: "embed" }>, params: URLSearchParams, path: string): string {
  if (!cat.columns.has(it.name)) throw new PostgrestShapeError(400, { code: "PGRST200", message: `Could not find a relationship between '${parent}' and '${it.name}' in the schema cache`, details: null, hint: null });
  const rel = resolveRel(cat, parent, it.name, it.hint);
  const a = `_e${++aliasSeq}`;
  const childPath = `${path}${it.alias ?? it.name}.`;
  const where = [joinCond(rel, parentAlias, a), ...filtersFor(params, childPath, `${a}.`)].join(" AND ");
  const obj = objectExpr(cat, it.name, a, it.children, params, childPath);
  if (rel.toMany) {
    const order = orderClause(params.get(`${childPath}order`), `${a}.`);
    const limit = params.get(`${childPath}limit`);
    return `COALESCE((SELECT jsonb_agg(_o) FROM (SELECT ${obj} AS _o FROM public.${ident(it.name)} ${a} WHERE ${where}${order}${limit ? ` LIMIT ${Number(limit)}` : ""}) _s), '[]'::jsonb)`;
  }
  return `(SELECT ${obj} FROM public.${ident(it.name)} ${a} WHERE ${where} LIMIT 1)`;
}
function innerConds(cat: Catalog, parent: string, parentAlias: string, items: SelItem[], params: URLSearchParams, path: string): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind !== "embed") continue;
    const childPath = `${path}${it.alias ?? it.name}.`;
    const hasFilter = [...params.keys()].some((k) => k.startsWith(childPath) && !/\.(order|limit|offset)$/.test(k));
    if (!it.inner && !hasFilter) continue;
    if (!it.inner) continue; // a filter on a non-inner embed narrows the embedded rows only (PostgREST's default)
    const rel = resolveRel(cat, parent, it.name, it.hint);
    const a = `_i${++aliasSeq}`;
    const where = [joinCond(rel, parentAlias, a), ...filtersFor(params, childPath, `${a}.`), ...innerConds(cat, it.name, a, it.children, params, childPath)].join(" AND ");
    out.push(`EXISTS (SELECT 1 FROM public.${ident(it.name)} ${a} WHERE ${where})`);
  }
  return out;
}
function checkColumn(cat: Catalog, table: string, spec: string): void {
  const col = spec.split(/->>?/)[0]!.trim();
  const cols = cat.columns.get(table);
  if (cols && !cols.has(col)) {
    const e: PgFailure = { code: "42703", message: `column ${table}.${col} does not exist` };
    throw Object.assign(new Error(e.message), e);
  }
}

// ── the bridge ─────────────────────────────────────────────────────────────────

export function makeBridge(engine: BridgeEngine, opts: {
  url: string;
  tokens: () => Record<string, string>;
  role?: "service_role" | "authenticated" | "anon";
  sub?: string | null;
}): Bridge {
  const log: Bridge["log"] = [];
  const unmodelled: string[] = [];
  const failed: string[] = [];
  const faults: BridgeFault[] = [];
  let catalog: Catalog | null = null;
  const cat = async () => (catalog ??= await loadCatalog(engine));
  const role = opts.role ?? "service_role";
  const claims = role === "service_role" ? { role: "service_role" } : { role, sub: opts.sub ?? undefined };

  const respond = (body: unknown, status: number, extra: Record<string, string> = {}) =>
    new Response(body === null || body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
  const pgStatus = (code: string) =>
    code === "23505" || code === "23503" ? 409 : code === "42501" ? 403 : code === "PGRST205" || code === "PGRST202" ? 404 : code.startsWith("08") || code === "57014" ? 503 : 400;

  async function run(method: string, path: string, statements: string[]): Promise<{ ok: true; json: any } | { ok: false; res: Response }> {
    try {
      const text = await engine.request(statements, role, claims as Record<string, unknown>);
      return { ok: true, json: JSON.parse(text || "null") };
    } catch (err: any) {
      let code = String(err?.code ?? "XX000");
      let message = String(err?.message ?? err);
      let details: string | null = err?.detail ?? null;
      const rel = /relation "(?:public\.)?([A-Za-z0-9_]+)" does not exist/.exec(message);
      if (code === "42P01" && rel) { code = "PGRST205"; message = `Could not find the table 'public.${rel[1]}' in the schema cache`; details = null; }
      failed.push(`${method} ${path} :: ${code} ${message}`);
      return { ok: false, res: respond({ code, message, details, hint: err?.hint ?? null }, pgStatus(code)) };
    }
  }

  const fetchImpl = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers ?? input?.headers;
    if (h && typeof h.forEach === "function") h.forEach((v: string, k: string) => (headers[k.toLowerCase()] = v));
    else for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
    const bodyText: string | null = typeof init?.body === "string" ? init.body : null;
    const path = `${url.pathname}${url.search}`;
    const done = (r: Response) => { log.push({ method, path, status: r.status }); return r; };
    try {
      if (url.pathname === "/auth/v1/user") {
        const token = (headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
        const id = opts.tokens()[token];
        if (!id) return done(respond({ code: 401, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature" }, 401));
        return done(respond({ id, aud: "authenticated", role: "authenticated", email: `${id}@pressed.test`, app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }, 200));
      }
      if (!url.pathname.startsWith("/rest/v1/")) throw new Error(`unhandled path ${url.pathname}`);
      const target = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
      const params = url.searchParams;
      const prefer = headers["prefer"] ?? "";
      const single = (headers["accept"] ?? "").includes("application/vnd.pgrst.object+json");
      const parsedBody = bodyText ? JSON.parse(bodyText) : null;
      for (const f of faults) { const r = f({ method, target, params, body: parsedBody }); if (r) { failed.push(`${method} ${path} :: FAULT ${r.status}`); return done(respond(r.body, r.status)); } }
      const c = await cat();
      const shape = (rows: any[], status: number, extra: Record<string, string> = {}) => {
        if (single) {
          if (rows.length !== 1) return respond({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null }, 406);
          return respond(rows[0], status, extra);
        }
        return respond(rows, status, extra);
      };

      if (target.startsWith("rpc/")) {
        const fn = target.slice(4);
        ident(fn);
        const args = (method === "GET" ? Object.fromEntries(params.entries()) : (parsedBody ?? {})) as Row;
        const sigs = await engine.query(`SELECT p.oid::text AS oid, COALESCE(p.proargnames, '{}'::text[]) AS names, p.pronargs AS nargs, p.pronargdefaults AS ndef, p.proretset AS retset, format_type(p.prorettype, NULL) AS rettype, t.typtype::text AS typtype,
                (SELECT json_agg(format_type(x, NULL) ORDER BY o) FROM unnest(p.proargtypes) WITH ORDINALITY u(x, o)) AS types
           FROM pg_proc p JOIN pg_type t ON t.oid = p.prorettype WHERE p.proname = ${lit(fn)} AND p.pronamespace = 'public'::regnamespace`);
        const keys = Object.keys(args);
        const fit = sigs.filter((s) => {
          const names = (typeof s.names === "string" ? String(s.names).replace(/^\{|\}$/g, "").split(",").filter(Boolean) : (s.names as string[])).slice(0, Number(s.nargs));
          const required = names.slice(0, Number(s.nargs) - Number(s.ndef));
          return keys.every((k) => names.includes(k)) && required.every((r) => keys.includes(r));
        });
        if (fit.length === 0) return done(respond({ code: "PGRST202", message: `Could not find the function public.${fn}(${keys.join(", ")}) in the schema cache`, details: null, hint: null }, 404));
        if (fit.length > 1) throw new Error(`rpc ${fn} is ambiguous over ${fit.length} overloads`);
        const s = fit[0]!;
        const names = (typeof s.names === "string" ? String(s.names).replace(/^\{|\}$/g, "").split(",").filter(Boolean) : (s.names as string[]));
        const types = (typeof s.types === "string" ? JSON.parse(String(s.types)) : (s.types ?? [])) as string[];
        const j = `${dollar(JSON.stringify(args))}::jsonb`;
        const named = keys.map((k) => {
          const t = types[names.indexOf(k)]!;
          const v = t === "jsonb" ? `(${j}->${lit(k)})` : t === "json" ? `(${j}->${lit(k)})::json`
            : t.endsWith("[]") ? `(CASE WHEN jsonb_typeof(${j}->${lit(k)}) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${j}->${lit(k)}))::${t} END)`
            : `(${j}->>${lit(k)})::${t}`;
          return `${ident(k)} => ${v}`;
        }).join(", ");
        const call = `public.${ident(fn)}(${named})`;
        const composite = s.typtype === "c" || s.rettype === "record";
        const sql = s.retset
          ? (composite ? `SELECT COALESCE(json_agg(_r), '[]'::json)::text FROM ${call} _r` : `SELECT COALESCE(json_agg(_r.v), '[]'::json)::text FROM ${call} AS _r(v)`)
          : s.rettype === "void" ? `SELECT 'null'::text FROM (SELECT ${call}) _v`
          : composite ? `SELECT COALESCE((SELECT to_json(_r) FROM ${call} _r WHERE _r IS NOT NULL LIMIT 1), 'null'::json)::text`
          : `SELECT COALESCE(to_json(${call}), 'null'::json)::text`;
        const r = await run(method, path, [sql]);
        if (!r.ok) return done(r.res);
        return done(single && Array.isArray(r.json) ? shape(r.json, 200) : respond(r.json, 200));
      }

      ident(target);
      if (!c.columns.has(target)) {
        failed.push(`${method} ${path} :: PGRST205`);
        return done(respond({ code: "PGRST205", message: `Could not find the table 'public.${target}' in the schema cache`, details: null, hint: null }, 404));
      }
      const items = parseSelect(params.get("select"));
      const T = `public.${ident(target)}`;
      const rowObj = (alias: string) => objectExpr(c, target, alias, items, params, "");
      const where = (alias: string) => {
        const conds = [...filtersFor(params, "", `${alias}.`), ...innerConds(c, target, alias, items, params, "")];
        return conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
      };
      const counting = /count=(exact|planned|estimated)/.test(prefer);

      if (method === "GET" || method === "HEAD") {
        const limit = params.get("limit"), offset = params.get("offset");
        const inner = `SELECT ${rowObj("_t0")} AS _o FROM ${T} _t0${where("_t0")}${orderClause(params.get("order"), "_t0.")}`
          + `${limit !== null ? ` LIMIT ${Number(limit)}` : ""}${offset !== null ? ` OFFSET ${Number(offset)}` : ""}`;
        const stmts = [`SELECT COALESCE(json_agg(_q._o), '[]'::json)::text FROM (${inner}) _q`];
        if (counting) stmts[0] = `SELECT json_build_object('rows', (${stmts[0]})::json, 'total', (SELECT count(*) FROM ${T} _t0${where("_t0")}))::text`;
        const r = await run(method, path, stmts);
        if (!r.ok) return done(r.res);
        const rows = (counting ? r.json.rows : r.json) as any[];
        const extra: Record<string, string> = {};
        if (counting) {
          const total = Number(r.json.total);
          const from = Number(offset ?? 0);
          extra["content-range"] = rows.length === 0 ? `*/${total}` : `${from}-${from + rows.length - 1}/${total}`;
        }
        if (method === "HEAD") return done(new Response(null, { status: 200, headers: extra }));
        return done(shape(rows, 200, extra));
      }

      const representation = prefer.includes("return=representation");
      const returning = (cte: string) => `SELECT COALESCE(json_agg(${objectExpr(c, target, "_w", items, params, "")}), '[]'::json)::text FROM ${cte} _w`;
      const cols = c.columns.get(target)!;
      const unknown = (keys: string[]) => keys.find((k) => !cols.has(k));
      let stmts: string[];
      if (method === "POST") {
        const rowsIn: Row[] = Array.isArray(parsedBody) ? parsedBody : parsedBody ? [parsedBody] : [];
        const colsParam = params.get("columns");
        const declared = colsParam ? colsParam.split(",").map((x) => x.replace(/"/g, "").trim()).filter(Boolean) : null;
        const missingDefault = prefer.includes("missing=default");
        const groups = new Map<string, Row[]>();
        for (const r of rowsIn) {
          const keys = declared ? (missingDefault ? declared.filter((k) => k in r) : declared) : Object.keys(r);
          const g = JSON.stringify([...keys].sort());
          groups.set(g, [...(groups.get(g) ?? []), r]);
        }
        const bad = unknown([...groups.keys()].flatMap((g) => JSON.parse(g) as string[]));
        if (bad) {
          failed.push(`${method} ${path} :: PGRST204 ${bad}`);
          return done(respond({ code: "PGRST204", message: `Could not find the '${bad}' column of '${target}' in the schema cache`, details: null, hint: null }, 400));
        }
        const onConflict = params.get("on_conflict");
        const parts: string[] = [];
        let i = 0;
        for (const [g, rows] of groups) {
          const keys = JSON.parse(g) as string[];
          let conflict = "";
          if (prefer.includes("resolution=ignore-duplicates")) {
            conflict = onConflict ? ` ON CONFLICT (${onConflict.split(",").map(ident).join(", ")}) DO NOTHING` : " ON CONFLICT DO NOTHING";
          } else if (prefer.includes("resolution=merge-duplicates")) {
            const pk = onConflict ? onConflict.split(",").map((x) => x.trim()) : (c.unique.get(target) ?? [])[0];
            if (!pk) throw new Error(`merge-duplicates on ${target} without on_conflict or a key`);
            const set = keys.filter((k) => !pk.includes(k)).map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(", ");
            conflict = ` ON CONFLICT (${pk.map(ident).join(", ")}) ${set ? `DO UPDATE SET ${set}` : "DO NOTHING"}`;
          }
          const colList = keys.map(ident).join(", ");
          const src = keys.length
            ? `SELECT ${colList} FROM json_populate_recordset(NULL::${T}, ${dollar(JSON.stringify(rows))}::json)`
            : `SELECT FROM generate_series(1, ${rows.length})`;
          const ins = keys.length ? `INSERT INTO ${T} (${colList}) ${src}${conflict} RETURNING *` : `INSERT INTO ${T} DEFAULT VALUES RETURNING *`;
          parts.push(`_g${i++} AS (${ins})`);
        }
        if (parts.length === 0) return done(respond(representation ? [] : null, 201));
        const all = [...Array(i).keys()].map((n) => `SELECT * FROM _g${n}`).join(" UNION ALL ");
        stmts = [`WITH ${parts.join(", ")}, _all AS (${all}) ${representation ? returning("_all") : "SELECT 'null'::text"}`];
      } else if (method === "PATCH") {
        const patch = (parsedBody ?? {}) as Row;
        const bad = unknown(Object.keys(patch));
        if (bad) {
          failed.push(`${method} ${path} :: PGRST204 ${bad}`);
          return done(respond({ code: "PGRST204", message: `Could not find the '${bad}' column of '${target}' in the schema cache`, details: null, hint: null }, 400));
        }
        const set = Object.keys(patch).map((k) => `${ident(k)} = _r.${ident(k)}`).join(", ");
        stmts = [`WITH _u AS (UPDATE ${T} AS _t0 SET ${set} FROM json_populate_record(NULL::${T}, ${dollar(JSON.stringify(patch))}::json) AS _r${where("_t0")} RETURNING _t0.*) ${representation || counting ? returning("_u") : "SELECT 'null'::text"}`];
      } else if (method === "DELETE") {
        stmts = [`WITH _d AS (DELETE FROM ${T} AS _t0${where("_t0")} RETURNING _t0.*) ${representation || counting ? returning("_d") : "SELECT 'null'::text"}`];
      } else {
        throw new Error(`unhandled method ${method}`);
      }
      const r = await run(method, path, stmts);
      if (!r.ok) return done(r.res);
      const okStatus = method === "POST" ? 201 : representation ? 200 : 204;
      const extra: Record<string, string> = counting && Array.isArray(r.json) ? { "content-range": `*/${r.json.length}` } : {};
      if (!representation) return done(new Response(null, { status: okStatus, headers: extra }));
      return done(shape(r.json as any[], okStatus, extra));
    } catch (err) {
      if (err instanceof PostgrestShapeError) { failed.push(`${method} ${path} :: ${err.body.code} ${err.body.message}`); return done(respond(err.body, err.status)); }
      if ((err as any)?.code === "42703") { failed.push(`${method} ${path} :: 42703 ${(err as Error).message}`); return done(respond({ code: "42703", message: (err as Error).message, details: null, hint: null }, 400)); }
      unmodelled.push(`${method} ${path} :: ${(err as Error).message}`);
      throw err;
    }
  };

  const client = createClient(opts.url, "pressed-layover-service-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl as any },
  });
  return { client, log, unmodelled, failed, faults };
}
