/**
 * Shared harness for the Highlights spec tests. NOT a test file itself.
 *
 * The supabase-js stand-in below is deliberately shaped like the real client in
 * the three ways that have produced false greens on this surface before:
 *
 *   1. A failed read RESOLVES with `{ data: null, error }` — it does NOT throw.
 *      A fake that threw would exercise a `catch` that does not exist in
 *      production and every fail-closed assertion would pass for the wrong
 *      reason.
 *   2. An UPDATE with no `.select()` resolves `{ data: null, error: null }`, so
 *      a handler that treats `error === null` as "a row changed" cannot be
 *      distinguished from one that checked. `zeroRowUpdate` reproduces the
 *      RLS-filtered update: zero rows, no error.
 *   3. A MISSING TABLE is a different failure from an UNREADABLE one, and the
 *      code under test branches on exactly that. `absentTables` answers with
 *      PostgREST's real PGRST205; `failTables` answers with a plain message and
 *      no code, which is what a connection or permission failure looks like.
 *
 * The `req.log` shim is not optional. Without it every route CRASHES on
 * `req.log.error` and a 500-from-crash masquerades as a considered refusal.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";

export const VIEWER = "10000000-0000-4000-8000-000000000001";
export const OWNER = "10000000-0000-4000-8000-000000000002";
export const OTHER = "10000000-0000-4000-8000-000000000003";

export const H_PUB = "30000000-0000-4000-8000-000000000001"; // OWNER, public
export const H_MINE = "30000000-0000-4000-8000-000000000002"; // VIEWER's own
export const H_ARCH = "30000000-0000-4000-8000-000000000003"; // OWNER, archived
export const H_CIRCLE_MINE = "30000000-0000-4000-8000-000000000004"; // VIEWER's own, circle_only

export const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

export function highlight(
  id: string,
  owner_id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    owner_id,
    visibility: "public",
    media_url: "https://example.invalid/h.jpg",
    media_type: "image/jpeg",
    video_duration_seconds: null,
    caption: null,
    location_name: "The Quiet Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    expires_at: FUTURE,
    created_at: "2026-01-01T00:00:00.000Z",
    deleted_at: null,
    archived_at: null,
    ...overrides,
  };
}

export function fixtureTables(): Record<string, any[]> {
  return {
    profiles: [VIEWER, OWNER, OTHER].map((id) => ({
      id,
      handle: `h_${id.slice(-2)}`,
      name: "n",
      avatar_url: null,
      account_status: "active",
      is_private: false,
    })),
    highlights: [
      highlight(H_PUB, OWNER),
      highlight(H_MINE, VIEWER),
      highlight(H_ARCH, OWNER, { archived_at: "2026-02-01T00:00:00.000Z" }),
      highlight(H_CIRCLE_MINE, VIEWER, { visibility: "circle_only" }),
    ],
    // VIEWER follows OWNER and, deliberately, themselves — the self-follow is
    // how GET /highlights/following-feed's owner short-circuit is observable.
    user_follows: [
      { follower_id: VIEWER, following_id: OWNER },
      { follower_id: VIEWER, following_id: VIEWER },
    ],
    blocks: [],
    circle_memberships: [],
    trip_members: [],
    trips: [],
    feature_flags: [],
    highlight_views: [],
    highlight_likes: [],
    highlight_reports: [],
    highlight_replies: [],
    highlight_resurfacing_preferences: [],
    highlight_projection_policies: [],
    message_threads: [],
    message_thread_members: [],
    messages: [],
  };
}

export interface FakeOpts {
  failTables?: Set<string>;
  failWrites?: Set<string>;
  absentTables?: Set<string>;
  zeroRowUpdate?: Set<string>;
  /**
   * A specific PostgREST error object for a write, keyed by table.
   *
   * `failWrites` answers with a bare message and no `code`, which is what a
   * connection failure looks like. Handlers that branch on a SQLSTATE — a NOT
   * NULL violation (23502), a CHECK violation (23514), an unknown column
   * (PGRST204) — cannot be exercised by that, and a test that used it would be
   * asserting the fallback branch while believing it asserted the specific one.
   */
  writeError?: Record<string, any>;
}

export function makeFakeClient(tables: Record<string, any[]>, opts: FakeOpts = {}) {
  const failTables = opts.failTables ?? new Set<string>();
  const failWrites = opts.failWrites ?? new Set<string>();
  const absentTables = opts.absentTables ?? new Set<string>();
  const zeroRowUpdate = opts.zeroRowUpdate ?? new Set<string>();
  const writeError = opts.writeError ?? {};

  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    // ORDER, LIMIT AND RANGE ARE HONOURED (census H100, lane R wave 2). They
    // were no-ops, so every list came back in fixture order and unbounded: a
    // route that asked Postgres for `created_at DESC` and a route that asked
    // for nothing looked the same, and a page cut by `.limit()` could not be
    // told from the whole table. A test of "what does page one hold" was then
    // a test of the fixture's array order. Postgres's defaults are kept:
    // ascending unless told otherwise, NULLS LAST ascending and NULLS FIRST
    // descending unless `nullsFirst` says otherwise; a sort is stable.
    const orders: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let limitN: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let single = false,
      head = false,
      isWrite = false,
      isUpdate = false,
      selectedAfterWrite = false;
    let patch: any = null;
    const obj: any = {
      select(_c?: string, o?: any) {
        if (o?.head) head = true;
        if (isWrite) selectedAfterWrite = true;
        return obj;
      },
      insert(d: any) { isWrite = true; obj.__insert = d; return obj; },
      update(d: any) { isWrite = true; isUpdate = true; patch = d; return obj; },
      upsert(d: any, o?: any) { isWrite = true; obj.__upsert = d; obj.__upsertOpts = o ?? null; return obj; },
      delete() { isWrite = true; obj.__delete = true; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      not(c: string, op: string, v: any) {
        if (op === "is" && v === null) filters.push((r) => r[c] != null);
        return obj;
      },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      ilike() { return obj; },
      /**
       * PostgREST's `or=(a,b)` — parsed, not ignored.
       *
       * The Highlight feeds have asked for "not expired OR permanent" since
       * migration 2975 made `expires_at` nullable, and a no-op `or()` would
       * make this harness serve EXPIRED Highlights on every feed while every
       * assertion still passed. That is the shape of fake that produces a false
       * green: the filter under test simply would not run.
       *
       * Only the operators this surface uses are implemented — `is.null`,
       * `gt`, `lt`, `eq` — and anything else throws rather than silently
       * matching everything.
       */
      or(expr: string) {
        // Top-level commas only: `and(a,b)` is ONE clause (census H100's
        // following-feed cursor sends `and(pinned_at.eq.P,created_at.gt.C)`).
        const splitTop = (x: string): string[] => {
          const out: string[] = [];
          let depth = 0;
          let cur = "";
          for (const ch of x) {
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
            cur += ch;
          }
          if (cur) out.push(cur);
          return out.map((c) => c.trim()).filter(Boolean);
        };
        type FakeRow = Record<string, unknown>;
        // A number column compares as a number, everything else as text — the
        // same coercion `r[col] > raw` gave when this was untyped.
        const gt = (v: unknown, raw: string) => (typeof v === "number" ? v > Number(raw) : String(v) > raw);
        const lt = (v: unknown, raw: string) => (typeof v === "number" ? v < Number(raw) : String(v) < raw);
        const atom = (clause: string): ((r: FakeRow) => boolean) => {
          if (clause.startsWith("and(") && clause.endsWith(")")) {
            const inner = splitTop(clause.slice(4, -1)).map(atom);
            return (r) => inner.every((p) => p(r));
          }
          const [col = "", op, ...rest] = clause.split(".");
          const raw = rest.join(".");
          switch (op) {
            case "is": return (r) => (raw === "null" ? r[col] == null : r[col] === raw);
            case "gt": return (r) => r[col] != null && gt(r[col], raw);
            case "lt": return (r) => r[col] != null && lt(r[col], raw);
            case "eq": return (r) => String(r[col]) === raw;
            default:
              throw new Error(`highlightsSpecHarness: or() does not implement operator ${JSON.stringify(op)} in ${JSON.stringify(clause)}`);
          }
        };
        const preds = splitTop(String(expr)).map(atom);
        filters.push((r) => preds.some((p) => p(r)));
        return obj;
      },
      filter() { return obj; },
      order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string }) {
        // An embedded resource's order sorts the embedded rows, not this table's.
        if (o?.foreignTable || o?.referencedTable) return obj;
        const asc = o?.ascending !== false;
        orders.push({ col: c, asc, nullsFirst: o?.nullsFirst ?? !asc });
        return obj;
      },
      limit(n: number, o?: { foreignTable?: string; referencedTable?: string }) {
        if (!(o?.foreignTable || o?.referencedTable)) limitN = n;
        return obj;
      },
      range(from: number, to: number) { rangeFrom = from; rangeTo = to; return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<{ data: any; error: any; count: number | null }> {
      if (absentTables.has(table)) {
        // PostgREST's real answer for a table that is not in the schema cache.
        return {
          data: null,
          error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` },
          count: null,
        };
      }
      if (isWrite && writeError[table]) return { data: null, error: writeError[table], count: null };
      if (isWrite && failWrites.has(table)) return { data: null, error: { message: `${table} write failed` }, count: null };
      if (failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (obj.__insert || obj.__upsert) {
        const raw = obj.__insert ?? obj.__upsert;
        const rows = (Array.isArray(raw) ? raw : [raw]).map((r: any) => ({
          ...r,
          // A GENERATED ID IS A UUID, because every `id` this harness stands in
          // for is `UUID PRIMARY KEY DEFAULT gen_random_uuid()`. The previous
          // shape was `new-<random hex>`, which is not a UUID — so a handler
          // that takes the id the insert returned and passes it to anything
          // validating a UUID (services/highlights/highlightSources.ts does)
          // failed HERE and only here, for a reason production cannot produce.
          // A fake that invents a key shape the database cannot is the kind
          // that makes a real handler look broken, or a broken one look fine.
          id: r.id ?? randomUUID(),
        }));
        // UPSERT MEANS UPSERT. The previous shape appended unconditionally, so
        // an idempotent write — setting the same §11 control twice — produced
        // two rows here and one row in Postgres, and any test asserting
        // idempotency would have been asserting a fiction. `onConflict` names
        // the unique index, so conflict resolution is done on exactly the
        // columns the database would use.
        const conflict = obj.__upsert
          ? String(obj.__upsertOpts?.onConflict ?? "id").split(",").map((c: string) => c.trim()).filter(Boolean)
          : [];
        for (const r of rows) {
          const existing = conflict.length
            ? (tables[table] ??= []).find((e: any) => conflict.every((c: string) => e[c] === r[c]))
            : undefined;
          if (existing) {
            // Keep the stored id and created_at: an upsert updates a row, it
            // does not replace its identity.
            const { id: _newId, ...rest } = r;
            Object.assign(existing, rest);
          } else {
            (tables[table] ??= []).push(r);
          }
        }
        const stored = conflict.length
          ? rows.map((r: any) => (tables[table] ?? []).find((e: any) => conflict.every((c: string) => e[c] === r[c])) ?? r)
          : rows;
        return { data: single ? stored[0] : stored, error: null, count: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (obj.__delete) {
        const ids = new Set(rows);
        tables[table] = (tables[table] ?? []).filter((r) => !ids.has(r));
        // A DELETE that asked for its rows back GETS them, exactly as
        // supabase-js does, and one that did not still resolves `{ data: null,
        // error: null }`. The distinction is the same one `zeroRowUpdate`
        // exists for: without it a handler that checks "did this remove
        // anything" cannot be told apart from one that assumed it did.
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: rows, error: null, count: null };
      }
      if (isUpdate) {
        if (zeroRowUpdate.has(table)) rows = [];
        for (const r of rows) Object.assign(r, patch);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: rows, error: null, count: null };
      }
      const total = rows.length;
      if (orders.length > 0) {
        rows = rows
          .map((r, i) => ({ r, i }))
          .sort((a, b) => {
            for (const { col, asc, nullsFirst } of orders) {
              const x = a.r[col] ?? null;
              const y = b.r[col] ?? null;
              if (x === null && y === null) continue;
              if (x === null) return nullsFirst ? -1 : 1;
              if (y === null) return nullsFirst ? 1 : -1;
              if (x < y) return asc ? -1 : 1;
              if (x > y) return asc ? 1 : -1;
            }
            return a.i - b.i;
          })
          .map(({ r }) => r);
      }
      if (rangeFrom !== null && rangeTo !== null) rows = rows.slice(rangeFrom, rangeTo + 1);
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      // `count` is the whole match, as PostgREST's `count=exact` is — not the page.
      return { data: rows, error: null, count: head ? total : null };
    }
    return obj;
  }

  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

export interface App {
  baseUrl: string;
  close: () => Promise<void>;
  errors: Array<{ obj: any; msg: string }>;
  tables: Record<string, any[]>;
}

export async function startApp(
  opts: FakeOpts & { tables?: Record<string, any[]> } = {},
): Promise<App> {
  // The schema-availability memo is keyed by client OBJECT, and every call here
  // builds a new one — but reset anyway so a leaked reference from a previous
  // test can never hand this one a stale "ready".
  resetHighlightSchemaMemo();
  const tables = opts.tables ?? fixtureTables();
  _setTestClient(makeFakeClient(tables, opts) as any, true);
  const errors: Array<{ obj: any; msg: string }> = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = {
      error: (obj: any, msg: string) => errors.push({ obj, msg }),
      info: () => {},
      warn: () => {},
    };
    n();
  });
  app.use("/api", highlightsRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        errors,
        tables,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
    srv.on("error", reject);
  });
}

export async function call(app: App, method: string, path: string, viewer: string, body?: unknown) {
  const res = await fetch(app.baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${viewer}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** Every highlight id in a following-feed response. */
export const feedIds = (body: any) =>
  new Set(((body?.users ?? []) as any[]).flatMap((u) => (u.highlights ?? []).map((h: any) => h.id as string)));

/** Every highlight id in an /highlights/active or profile response. */
export const listIds = (body: any) =>
  new Set(((body?.highlights ?? []) as any[]).map((h: any) => h.id as string));
