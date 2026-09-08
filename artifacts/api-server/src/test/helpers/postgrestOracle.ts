/**
 * postgrestOracle — the REAL, installed `@supabase/supabase-js` client
 * (`createClient`, `@supabase/postgrest-js@2.108.2` underneath) driven by an
 * injected `fetch` that emulates a PostgREST server over an in-memory table set.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Every in-memory double in `src/test/helpers/` was written by reading the
 * production code it had to satisfy, never by reading the client. That is how
 * `src/test/rentABuddy.test.ts` came to capture inserted rows EAGERLY inside
 * `.insert()` — the fake was written AROUND the defect (`PostgrestBuilder` is a
 * thenable and never issues a request without a continuation), so twenty dead
 * writes stayed green for months. A double can only be trusted as far as
 * something has checked it against the thing it replaces.
 *
 * This module is that something. It is the ORACLE half of the conformance
 * harness in `supabaseConformance.ts`: the same scenario is run against the real
 * client here and against each fake, and the two results must agree.
 *
 * ── WHAT IS EMULATED AND WHAT IS MEASURED ───────────────────────────────────
 * The `fetch` below emulates the SERVER (PostgREST's documented wire
 * behaviour): the 406 + PGRST116 for `Accept: application/vnd.pgrst.object+json`
 * against a non-singular result, 409 + 23505 on a unique violation, 400 + 42703
 * for an unknown column, `Prefer: return=representation` vs. the bodyless 201 /
 * 204, `Prefer: count=exact` via `Content-Range`, and RLS as invisible rows.
 *
 * Everything the CONTRACT actually pins is on the CLIENT side of that wire and
 * is therefore measured, not assumed:
 *   - a builder with no continuation issues no request at all (the defect);
 *   - `.maybeSingle()` sends no object Accept header and synthesises PGRST116
 *     itself when more than one row comes back;
 *   - every failure — PostgREST error, transport abort, unparseable body —
 *     arrives RESOLVED as `{ data: null, error }`, never thrown, never rejected;
 *   - a write without a chained `.select()` yields `data: null`, so "how many
 *     rows did that UPDATE touch" is unanswerable from the response.
 * Request shapes and headers used here were read off the installed client, not
 * off documentation; `supabaseContract.test.ts` re-measures the load-bearing
 * ones every run, so a client upgrade that moves them fails loudly.
 *
 * ── NOT MODELLED ────────────────────────────────────────────────────────────
 * An affected-row COUNT on a bodyless write — `.delete({ count: "exact" })` or
 * `.update(..., { count: "exact" })` with no chained `.select()`. That answer
 * depends on whether PostgREST sends `Content-Range` on a 204, which is a fact
 * about the SERVER and cannot be read off the client. The oracle THROWS on that
 * shape rather than inventing an answer; see the comment at the write handler
 * for the eight call sites that turn on it.
 *
 * NOTHING here talks to a database. The injected `fetch` is the only transport;
 * the URL handed to `createClient` is never dialled.
 */
import { createClient } from "@supabase/supabase-js";

export type Row = Record<string, any>;

export interface OracleRpc {
  (args: Record<string, unknown>): { data: unknown; error: unknown } | { status: number; body: unknown };
}

export interface OracleWorld {
  /** table -> seed rows. Mutated in place by writes, so effects are observable. */
  tables: Record<string, Row[]>;
  /** table -> the columns that exist. A table absent here accepts any column. */
  columns?: Record<string, string[]>;
  /** table -> the columns forming a unique key. A collision yields 23505. */
  unique?: Record<string, string[]>;
  /** Tables this connection may not see. Models an RLS SELECT policy: rows vanish. */
  denyReads?: string[];
  /** Tables this connection may not write. Models an RLS WRITE policy: 42501. */
  denyWrites?: string[];
  /** table -> a resolved PostgREST error every READ of it must produce. */
  failReads?: Record<string, { code: string; message: string }>;
  /** table -> a resolved PostgREST error every WRITE to it must produce. */
  failWrites?: Record<string, { code: string; message: string }>;
  rpc?: Record<string, OracleRpc>;
  /** When "abort", the transport itself fails before any response exists. */
  transport?: "ok" | "abort" | "network";
}

export interface OracleHandle {
  client: any;
  /** Round trips the real client actually made. 0 proves a builder never ran. */
  requests(): number;
  /** Rows added to `table` since the world was built. */
  writes(table: string): number;
  rows(table: string): Row[];
  /** Every request the client issued, for shape assertions. */
  log: Array<{ method: string; url: string; accept: string | null; prefer: string | null; body: string | null }>;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

const PGRST116 = (detail: string) => ({
  code: "PGRST116",
  details: detail,
  hint: null,
  message: "JSON object requested, multiple (or no) rows returned",
});

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Split a PostgREST select list at top level; embedded resources are ignored. */
function selectColumns(select: string | null): string[] | null {
  if (!select || select.trim() === "" || select.trim() === "*") return null;
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out
    .map((p) => p.trim())
    .filter((p) => p !== "" && !p.includes("("))
    .map((p) => (p.includes(":") ? p.slice(p.indexOf(":") + 1) : p))
    .map((p) => p.trim())
    .filter((p) => p !== "*");
}

function project(row: Row, cols: string[] | null): Row {
  if (!cols) return { ...row };
  const out: Row = {};
  for (const c of cols) out[c] = row[c];
  return out;
}

/** `id=eq.1`, `id=in.(1,2)`, `d=is.null`, `e=not.is.null`. */
function predicate(raw: string): (v: unknown) => boolean {
  let s = raw;
  let negate = false;
  if (s.startsWith("not.")) { negate = true; s = s.slice(4); }
  const dot = s.indexOf(".");
  const op = dot === -1 ? "eq" : s.slice(0, dot);
  const rest = dot === -1 ? "" : s.slice(dot + 1);
  const lit = (t: string): unknown => {
    if (t === "null") return null;
    if (t === "true") return true;
    if (t === "false") return false;
    const n = Number(t);
    return t !== "" && Number.isFinite(n) ? n : t.replace(/^"(.*)"$/, "$1");
  };
  const base = (v: unknown): boolean => {
    switch (op) {
      case "eq": return String(v) === String(lit(rest));
      case "neq": return String(v) !== String(lit(rest));
      case "gt": return (v as any) > (lit(rest) as any);
      case "gte": return (v as any) >= (lit(rest) as any);
      case "lt": return (v as any) < (lit(rest) as any);
      case "lte": return (v as any) <= (lit(rest) as any);
      case "is": return lit(rest) === null ? v == null : v === lit(rest);
      case "in": {
        const items = rest.replace(/^\(/, "").replace(/\)$/, "").split(",").map((t) => String(lit(t.trim())));
        return items.includes(String(v));
      }
      default: throw new Error(`postgrestOracle: unsupported filter operator "${op}" (${raw})`);
    }
  };
  return (v) => (negate ? !base(v) : base(v));
}

export function makeOracle(world: OracleWorld): OracleHandle {
  const tables = world.tables;
  const seedSizes: Record<string, number> = {};
  for (const [t, rs] of Object.entries(tables)) seedSizes[t] = rs.length;

  let requests = 0;
  const log: OracleHandle["log"] = [];

  const columnsOf = (t: string) => world.columns?.[t] ?? null;

  function unknownColumn(table: string, named: string[]): string | null {
    const known = columnsOf(table);
    if (!known) return null;
    for (const c of named) {
      const bare = c.split("->")[0].trim();
      if (bare !== "" && bare !== "*" && !known.includes(bare)) return bare;
    }
    return null;
  }

  const fetchImpl = async (input: any, init: any = {}): Promise<Response> => {
    requests += 1;
    const url: string = typeof input === "string" ? input : input.url;
    const method: string = (init?.method ?? input?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers ?? input?.headers;
    if (h && typeof h.forEach === "function") h.forEach((v: string, k: string) => (headers[k.toLowerCase()] = v));
    else for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
    const bodyText: string | null = typeof init?.body === "string" ? init.body : null;
    const accept = headers["accept"] ?? null;
    const prefer = headers["prefer"] ?? null;
    log.push({ method, url, accept, prefer, body: bodyText });

    if (world.transport === "abort") {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    if (world.transport === "network") throw new TypeError("fetch failed");

    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest\/v1\//, "");
    const wantObject = (accept ?? "").includes("application/vnd.pgrst.object+json");
    const representation = (prefer ?? "").includes("return=representation");
    const merge = (prefer ?? "").includes("resolution=merge-duplicates");
    const wantCount = /count=(exact|planned|estimated)/.exec(prefer ?? "")?.[1] ?? null;

    // ── rpc ──────────────────────────────────────────────────────────────────
    if (path.startsWith("rpc/")) {
      const fn = path.slice(4);
      const handler = world.rpc?.[fn];
      if (!handler) {
        return json({ code: "PGRST202", details: null, hint: null, message: `Could not find the function public.${fn}` }, 404);
      }
      const out: any = handler(bodyText ? JSON.parse(bodyText) : {});
      if (out && typeof out === "object" && "status" in out) return json((out as any).body, (out as any).status);
      if (out?.error) return json(out.error, 400);
      return json(out?.data ?? null, 200);
    }

    const table = path;
    const store = (tables[table] ??= []);
    const select = u.searchParams.get("select");
    const cols = selectColumns(select);

    // Filters, in the order PostgREST would apply them.
    const preds: Array<{ col: string; test: (v: unknown) => boolean }> = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (RESERVED.has(k)) continue;
      if (k === "or") throw new Error("postgrestOracle: or() is out of contract scope; no scenario issues it");
      preds.push({ col: k, test: predicate(v) });
    }

    const parsedBody: unknown = bodyText ? JSON.parse(bodyText) : null;
    const bodyRows: Row[] = parsedBody === null ? [] : Array.isArray(parsedBody) ? parsedBody : [parsedBody as Row];

    // ── unknown column (42703) — PostgREST rejects the WHOLE statement ───────
    const named = [
      ...(cols ?? []),
      ...preds.map((p) => p.col),
      ...bodyRows.flatMap((r) => Object.keys(r)),
      ...(u.searchParams.get("order") ?? "").split(",").map((s) => s.split(".")[0]).filter(Boolean),
    ];
    const dead = unknownColumn(table, named);
    if (dead) {
      return json({ code: "42703", details: null, hint: null, message: `column ${table}.${dead} does not exist` }, 400);
    }

    const readFailure = world.failReads?.[table];
    if (readFailure && (method === "GET" || method === "HEAD")) {
      return json({ ...readFailure, details: null, hint: null }, 400);
    }
    const writeFailure = world.failWrites?.[table];
    if (writeFailure && method !== "GET" && method !== "HEAD") {
      return json({ ...writeFailure, details: null, hint: null }, 400);
    }

    const denied = (world.denyReads ?? []).includes(table);
    const writeDenied = (world.denyWrites ?? []).includes(table);

    const matches = () => (denied ? [] : store.filter((r) => preds.every((p) => p.test(r[p.col]))));

    const respondRows = (rows: Row[], okStatus: number): Response => {
      const shaped = rows.map((r) => project(r, cols));
      if (wantObject) {
        if (shaped.length !== 1) {
          return json(PGRST116(`Results contain ${shaped.length} rows, application/vnd.pgrst.object+json requires 1 row`), 406);
        }
        return json(shaped[0], okStatus);
      }
      const extra: Record<string, string> = wantCount
        ? { "content-range": `0-${Math.max(shaped.length - 1, 0)}/${rows.length}` }
        : {};
      return json(shaped, okStatus, extra);
    };

    if (method === "GET" || method === "HEAD") {
      let rows = matches();
      const order = u.searchParams.get("order");
      if (order) {
        const [col, ...mods] = order.split(".");
        const asc = !mods.includes("desc");
        rows = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
      }
      const total = rows.length;
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const limit = u.searchParams.get("limit");
      if (limit !== null) rows = rows.slice(offset, offset + Number(limit));
      else if (offset) rows = rows.slice(offset);
      if (method === "HEAD") {
        const headExtra: Record<string, string> = wantCount ? { "content-range": `*/${total}` } : {};
        return json(null, 200, headExtra);
      }
      if (wantObject) {
        if (rows.length !== 1) {
          return json(PGRST116(`Results contain ${rows.length} rows, application/vnd.pgrst.object+json requires 1 row`), 406);
        }
        return json(project(rows[0], cols), 200);
      }
      const extra: Record<string, string> = wantCount
        ? { "content-range": `${offset}-${Math.max(offset + rows.length - 1, 0)}/${total}` }
        : {};
      return json(rows.map((r) => project(r, cols)), 200, extra);
    }

    if (writeDenied) {
      return json(
        { code: "42501", details: null, hint: null, message: `new row violates row-level security policy for table "${table}"` },
        403,
      );
    }

    if (method === "POST") {
      const key = world.unique?.[table];
      const written: Row[] = [];
      for (const r of bodyRows) {
        const clash = key ? store.find((s) => key.every((k) => s[k] === r[k])) : undefined;
        if (clash && !merge) {
          return json(
            {
              code: "23505",
              details: `Key (${key!.join(", ")})=(${key!.map((k) => r[k]).join(", ")}) already exists.`,
              hint: null,
              message: `duplicate key value violates unique constraint "${table}_${key!.join("_")}_key"`,
            },
            409,
          );
        }
        if (clash && merge) { Object.assign(clash, r); written.push(clash); }
        else { const row = { ...r }; store.push(row); written.push(row); }
      }
      if (!representation) return json(null, 201);
      return respondRows(written, 201);
    }

    // ── NOT MODELLED: an affected-row COUNT on a bodyless write. ────────────
    //
    // The client half is settled and readable: postgrest-js takes `count` from
    // the response's `content-range` header whenever the request carried
    // `Prefer: count=exact` (index.mjs:400-402). The SERVER half is not. Whether
    // PostgREST emits `Content-Range` on a 204 with no representation is a fact
    // about PostgREST, and no amount of reading the installed client can
    // establish it — which is exactly the kind of thing this oracle was built to
    // stop being assumed.
    //
    // It matters. Eight call sites in this repo branch on `if (!count)` after a
    // `.delete({ count: "exact" })` with no chained `.select()`
    // (routes/emergencyContacts.ts, services/location/LocationSafetyService.ts,
    // compass/CompassGraphEngine.ts, lib/weatherCacheCleanup.ts,
    // lib/suggestionSeenCleanup.ts, lib/dailyBriefCleanup.ts,
    // lib/discoveryCacheCleanup.ts, lib/rankingFatigueSweeper.ts). If the header
    // does come back, they work; if it does not, every one of them treats a
    // successful delete as "nothing matched". Three tests were written against
    // this oracle's guess, passed for a reason unrelated to what they claimed,
    // and were deleted once that was noticed.
    //
    // So the oracle REFUSES rather than guesses. A refusal is a question a
    // reader can answer with one measurement against a live PostgREST; a guess
    // is a green that means nothing.
    //
    // HOW THE REFUSAL SURFACES, stated exactly: this throw happens inside the
    // injected `fetch`, and the real client treats a transport that throws as a
    // RESOLVED failure — so the caller gets `{ data: null, error: <this text> }`
    // rather than a rejection. That is faithful (it is what the client does with
    // any transport error) and it is loud enough: `error` is non-null and its
    // message names the open question. It is NOT a rejection, so a test that
    // asserts only `count === null` would still pass — assert on `error`.
    const wantsCount = (prefer ?? "").includes("count=");
    if (!representation && wantsCount && (method === "PATCH" || method === "DELETE")) {
      throw new Error(
        `postgrestOracle does not model an affected-row count on a bodyless ${method}. ` +
          "postgrest-js reads `count` from the response's content-range header, and whether PostgREST " +
          "sends that header on a 204 with no `return=representation` has NOT been measured against a " +
          "real server — so any answer here would be this fake's opinion, and eight call sites in this " +
          "repo branch on it. Chain `.select()` (then the count is not in question), or measure the real " +
          "server and teach this oracle what it does.",
      );
    }

    if (method === "PATCH") {
      const hit = matches();
      const patch = bodyRows[0] ?? {};
      for (const r of hit) Object.assign(r, patch);
      if (!representation) return json(null, 204);
      return respondRows(hit, 200);
    }

    if (method === "DELETE") {
      const hit = matches();
      for (const r of hit) store.splice(store.indexOf(r), 1);
      if (!representation) return json(null, 204);
      return respondRows(hit, 200);
    }

    throw new Error(`postgrestOracle: unhandled method ${method}`);
  };

  const client = createClient("http://oracle.invalid", "oracle-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl as any },
  });

  return {
    client,
    requests: () => requests,
    writes: (table: string) => (tables[table]?.length ?? 0) - (seedSizes[table] ?? 0),
    rows: (table: string) => tables[table] ?? [],
    log,
  };
}
