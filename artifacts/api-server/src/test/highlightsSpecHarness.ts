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
}

export function makeFakeClient(tables: Record<string, any[]>, opts: FakeOpts = {}) {
  const failTables = opts.failTables ?? new Set<string>();
  const failWrites = opts.failWrites ?? new Set<string>();
  const absentTables = opts.absentTables ?? new Set<string>();
  const zeroRowUpdate = opts.zeroRowUpdate ?? new Set<string>();

  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
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
      upsert(d: any) { isWrite = true; obj.__upsert = d; return obj; },
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
      ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
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
      if (isWrite && failWrites.has(table)) return { data: null, error: { message: `${table} write failed` }, count: null };
      if (failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (obj.__insert || obj.__upsert) {
        const raw = obj.__insert ?? obj.__upsert;
        const rows = (Array.isArray(raw) ? raw : [raw]).map((r: any) => ({
          ...r,
          id: r.id ?? `new-${Math.random().toString(16).slice(2)}`,
        }));
        for (const r of rows) (tables[table] ??= []).push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (obj.__delete) {
        const ids = new Set(rows);
        tables[table] = (tables[table] ?? []).filter((r) => !ids.has(r));
        return { data: null, error: null, count: null };
      }
      if (isUpdate) {
        if (zeroRowUpdate.has(table)) rows = [];
        for (const r of rows) Object.assign(r, patch);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: rows, error: null, count: null };
      }
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      return { data: rows, error: null, count: head ? rows.length : null };
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
