/**
 * MD385 / D-26j — a Memory item made from the caller's OWN post: migration 3999
 * executed in PGlite, and POST /api/memories/:id/items/from-post over it.
 *
 * census-media MD385 ("Memory / Postcard created"); lead ruling D-26j: "from
 * their own media only. The server checks that the person owns the source post."
 *
 * The database is real SQL (3999 applied to PGlite, every statement as
 * service_role with BYPASSRLS, as on Supabase). `memory_kernel_execute` is a
 * stub of 2711's ADD_MEDIA / REMOVE_MEDIA arms — the five columns it writes and
 * nothing else — so the kernel-on path's link-or-remove is exercised against
 * the real trigger.
 *
 * Run (from artifacts/api-server):
 *   DISCOVERY_PGLITE_MODULE=<repo>/node_modules/.pnpm/@electric-sql+pglite@0.2.17/node_modules/@electric-sql/pglite/dist/index.js \
 *   node --import tsx/esm --test src/test/memoryFromOwnMedia.pglite.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import { gateMemoryFromOwnMedia, memoryItemMediaTypeFor } from "../services/memory/memoryFromOwnMedia.js";

const modulePath = process.env.DISCOVERY_PGLITE_MODULE ?? import.meta.resolve("@electric-sql/pglite");
const migration = readFileSync(new URL("../migrations/3999_memory_items_source_post.sql", import.meta.url), "utf8");

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MY_MEMORY = "10000000-0000-4000-8000-000000000001";
const OTHER_MEMORY = "10000000-0000-4000-8000-000000000002";
const MY_POST = "20000000-0000-4000-8000-000000000001";
const OTHER_POST = "20000000-0000-4000-8000-000000000002";
const MY_DELETED_POST = "20000000-0000-4000-8000-000000000003";
const MY_VIDEO_POST = "20000000-0000-4000-8000-000000000004";
const MY_URL_0 = `https://store.example/storage/v1/object/public/post-media/${ME}/a.jpg`;
const MY_URL_1 = `https://store.example/storage/v1/object/public/post-media/${ME}/b.jpg`;
const OTHER_URL = `https://store.example/storage/v1/object/public/post-media/${OTHER}/x.jpg`;

interface Database {
  exec(sql: string): Promise<unknown>;
  query<Row = Record<string, any>>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => { assert.match(s, IDENT, s); return s; };
/** A select list; an embedded resource (`rel(cols)`) is dropped — this adapter has no joins. */
const cols = (s?: string) => (!s || s.trim() === "*" ? "*"
  : s.replace(/[a-z_]+(![a-z_]+)?\([^)]*\)/g, "").split(",").map((c) => c.trim()).filter(Boolean).map(ident).join(", "));

/** A PostgREST-shaped client over PGlite, as service_role. */
function pgClient(db: Database) {
  async function asService<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec("SET ROLE service_role");
    try { return await fn(); } finally { await db.exec("RESET ROLE"); }
  }
  const fail = (e: any) => ({ data: null, error: { message: e?.message ?? String(e), code: e?.code } });
  return {
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    from(table: string) {
      ident(table);
      const where: string[] = [];
      const values: unknown[] = [];
      let op: "select" | "insert" | "update" | "delete" = "select";
      let selectCols = "*";
      let returning = "";
      let payload: Record<string, unknown> = {};
      let single = false;
      const q: any = {
        select(c?: string) { if (op === "select") selectCols = cols(c); else returning = cols(c); return q; },
        insert(p: Record<string, unknown>) { op = "insert"; payload = p; return q; },
        update(p: Record<string, unknown>) { op = "update"; payload = p; return q; },
        delete() { op = "delete"; return q; },
        eq(c: string, v: unknown) { values.push(v); where.push(`${ident(c)}::text = $${values.length}::text`); return q; },
        neq(c: string, v: unknown) { values.push(v); where.push(`${ident(c)}::text <> $${values.length}::text`); return q; },
        in(c: string, vs: unknown[]) { values.push(vs.map(String)); where.push(`${ident(c)}::text = ANY($${values.length}::text[])`); return q; },
        is(c: string, v: unknown) { assert.equal(v, null); where.push(`${ident(c)} IS NULL`); return q; },
        order() { return q; }, limit() { return q; },
        maybeSingle() { single = true; return run(); },
        single() { single = true; return run(); },
        then(f: any, r: any) { return run().then(f, r); },
      };
      async function run(): Promise<{ data: any; error: any }> {
        try {
          return await asService(async () => {
            const w = where.length ? ` WHERE ${where.join(" AND ")}` : "";
            let r: { rows: any[] };
            if (op === "select") r = await db.query(`SELECT ${selectCols} FROM public.${table}${w}`, values);
            else if (op === "delete") r = await db.query(`DELETE FROM public.${table}${w} RETURNING ${returning || "*"}`, values);
            else if (op === "update") {
              const keys = Object.keys(payload).map(ident);
              const sets = keys.map((k, i) => `${k} = $${values.length + i + 1}`).join(", ");
              r = await db.query(`UPDATE public.${table} SET ${sets}${w} RETURNING ${returning || "*"}`, [...values, ...keys.map((k) => payload[k])]);
            } else {
              const keys = Object.keys(payload).map(ident);
              r = await db.query(`INSERT INTO public.${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${returning || "*"}`,
                keys.map((k) => payload[k]));
            }
            return { data: single ? (r.rows[0] ?? null) : r.rows, error: null };
          });
        } catch (e: any) { return fail(e); }
      }
      return q;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        return await asService(async () => {
          const r = await db.query(`SELECT public.${ident(name)}($1::jsonb) AS result`, [JSON.stringify(args.p_command)]);
          return { data: r.rows[0]?.result ?? null, error: null };
        });
      } catch (e: any) { return fail(e); }
    },
  };
}

const BASE_SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE TABLE public.feature_flags (flag text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, description text);
  CREATE TABLE public.memories (id uuid PRIMARY KEY, owner_id uuid NOT NULL, state text NOT NULL DEFAULT 'published',
    visibility text NOT NULL DEFAULT 'only_me', trip_id uuid, allowed_user_ids uuid[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(), place_id text, canonical_location_id text);
  CREATE TABLE public.posts (id uuid PRIMARY KEY, author_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
    deleted_at timestamptz, media_urls text[] NOT NULL DEFAULT '{}', media_type text);
  CREATE TABLE public.memory_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE,
    media_url text NOT NULL, media_type text NOT NULL DEFAULT 'image/jpeg', caption text, position integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.media_events (id bigserial PRIMARY KEY, event_type text NOT NULL, payload jsonb, occurred_at timestamptz);
  -- No row: requireUser's account gate reads an absent profile as active.
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, account_status text);
  GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
`;

/** 2711's ADD_MEDIA and REMOVE_MEDIA arms, reduced to what they write: no source link. */
const KERNEL_STUB = `
  CREATE OR REPLACE FUNCTION public.memory_kernel_execute(p_command jsonb) RETURNS jsonb LANGUAGE plpgsql AS $k$
  DECLARE v_item public.memory_items; v_write jsonb := p_command->'payload'->'write';
  BEGIN
    IF p_command->>'type' = 'ADD_MEDIA' THEN
      INSERT INTO public.memory_items (memory_id, media_url, media_type, caption, position)
      VALUES ((p_command->>'memory_id')::uuid, v_write->>'media_url', coalesce(v_write->>'media_type', 'image/jpeg'),
              v_write->>'caption', coalesce((v_write->>'position')::integer, 0))
      RETURNING * INTO v_item;
      RETURN jsonb_build_object('ok', true, 'memory_id', p_command->>'memory_id', 'event_id', gen_random_uuid(),
        'event_type', 'memory.corrected', 'result', to_jsonb(v_item), 'contract_version', 1);
    ELSIF p_command->>'type' = 'REMOVE_MEDIA' THEN
      DELETE FROM public.memory_items WHERE id = (p_command->'payload'->>'item_id')::uuid AND memory_id = (p_command->>'memory_id')::uuid;
      RETURN jsonb_build_object('ok', true, 'memory_id', p_command->>'memory_id', 'event_id', gen_random_uuid(),
        'event_type', 'memory.corrected', 'result', jsonb_build_object('id', p_command->'payload'->>'item_id'), 'contract_version', 1);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'UNSUPPORTED');
  END $k$;
  GRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;
`;

async function newDb(withMigration: boolean): Promise<Database> {
  const runtime = await import(modulePath.startsWith("file:") ? modulePath : pathToFileURL(modulePath).href);
  const db = new runtime.PGlite() as Database;
  await db.exec(BASE_SCHEMA);
  if (withMigration) await db.exec(migration);
  await db.exec(KERNEL_STUB);
  return db;
}

describe("MD385 — migration 3999 in PGlite, and POST /memories/:id/items/from-post over it", { concurrency: 1 }, () => {
  let db: Database;
  let base = "";
  let server: http.Server;
  const rows = async (text: string, p: unknown[] = []) => (await db.query<any>(text, p)).rows;
  const asService = async (text: string, p: unknown[] = []) => {
    await db.exec("SET ROLE service_role");
    try { return (await db.query<any>(text, p)).rows; } finally { await db.exec("RESET ROLE"); }
  };
  const setFlag = (flag: string, on: boolean) =>
    db.query("INSERT INTO public.feature_flags (flag, enabled) VALUES ($1, $2) ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled", [flag, on]);

  async function post(path: string, actor: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + "/api" + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  before(async () => {
    db = await newDb(true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
    app.use("/api", memoriesRouter);
    await new Promise<void>((resolve, reject) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; server.unref(); resolve(); });
      server.on("error", reject);
    });
  });

  beforeEach(async () => {
    _setTestClient(pgClient(db) as any, true);
    await db.exec(`TRUNCATE public.memory_items, public.media_events; DELETE FROM public.posts; DELETE FROM public.memories;
      UPDATE public.feature_flags SET enabled = false;`);
    await setFlag("memory_from_own_media_enabled", true);
    await setFlag("MEDIA_ANALYTICS_ENABLED", true);
    await db.query(`INSERT INTO public.memories (id, owner_id) VALUES ($1, $2), ($3, $4)`, [MY_MEMORY, ME, OTHER_MEMORY, OTHER]);
    await db.query(`INSERT INTO public.posts (id, author_id, status, deleted_at, media_urls, media_type) VALUES
      ($1, $2, 'active', NULL, ARRAY[$3, $4], 'image'),
      ($5, $6, 'active', NULL, ARRAY[$7], 'image'),
      ($8, $2, 'deleted', now(), ARRAY[$3], 'image'),
      ($9, $2, 'active', NULL, ARRAY['https://store.example/v.mp4'], 'video')`,
      [MY_POST, ME, MY_URL_0, MY_URL_1, OTHER_POST, OTHER, OTHER_URL, MY_DELETED_POST, MY_VIDEO_POST]);
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await db?.close();
  });

  // ── The SQL contract ───────────────────────────────────────────────────────

  it("3999 seeds its flag FALSE, re-runs cleanly, and gives no client role anything", async () => {
    const other = await newDb(false);
    try {
      await other.exec(migration);
      await other.exec(migration);
      const flags = (await other.query<any>("SELECT flag, enabled FROM public.feature_flags")).rows;
      assert.deepEqual(flags, [{ flag: "memory_from_own_media_enabled", enabled: false }]);
      const p = (await other.query<any>(`SELECT
        has_function_privilege('authenticated', 'public.memory_items_source_post_guard()', 'EXECUTE') AS a,
        has_function_privilege('anon', 'public.memory_items_source_post_guard()', 'EXECUTE') AS b`)).rows[0];
      assert.deepEqual(p, { a: false, b: false });
    } finally { await other.close(); }
  });

  it("the database accepts a link only to the Memory owner's own live post, and only that post's media", async () => {
    await asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, MY_URL_0, MY_POST]);
    const refused = [
      [MY_MEMORY, OTHER_URL, OTHER_POST, "someone else's post"],
      [OTHER_MEMORY, MY_URL_0, MY_POST, "my post into someone else's Memory"],
      [MY_MEMORY, MY_URL_0, MY_DELETED_POST, "a deleted post"],
      [MY_MEMORY, OTHER_URL, MY_POST, "a URL the post does not carry"],
    ];
    for (const [memory, url, postId, why] of refused) {
      await assert.rejects(asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [memory, url, postId]),
        /D-26j/, why);
    }
    const [item] = await rows(`SELECT id FROM public.memory_items WHERE source_post_id = $1`, [MY_POST]);
    await assert.rejects(asService(`UPDATE public.memory_items SET source_post_id = $1 WHERE id = $2`, [OTHER_POST, item.id]), /D-26j/,
      "re-pointing a link at someone else's post");
    await assert.rejects(asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, MY_URL_0, MY_POST]),
      (e: any) => e?.code === "23505", "one copy of one post photo per Memory");
    // An item added by URL, with no link, is untouched by the guard.
    await asService(`INSERT INTO public.memory_items (memory_id, media_url) VALUES ($1, $2)`, [OTHER_MEMORY, OTHER_URL]);
  });

  it("erasing the source post row erases the copies made from it", async () => {
    await asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, MY_URL_0, MY_POST]);
    await asService(`INSERT INTO public.memory_items (memory_id, media_url) VALUES ($1, $2)`, [MY_MEMORY, MY_URL_1]);
    await db.query(`DELETE FROM public.posts WHERE id = $1`, [MY_POST]);
    assert.deepEqual((await rows(`SELECT media_url, source_post_id FROM public.memory_items`)), [{ media_url: MY_URL_1, source_post_id: null }]);
  });

  // ── The route ──────────────────────────────────────────────────────────────

  it("flag off: feature_disabled, and nothing is read or written", async () => {
    await setFlag("memory_from_own_media_enabled", false);
    const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal((await rows("SELECT count(*)::int AS n FROM public.memory_items"))[0].n, 0);
  });

  it("my own post: the item is written WITH its source link, the post's own URL, and the §44 signal", async () => {
    const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST, mediaIndex: 1, caption: "rooftop" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.item.mediaUrl, MY_URL_1);
    assert.equal(r.body.item.sourcePostId, MY_POST);
    const stored = await rows(`SELECT memory_id, media_url, media_type, caption, source_post_id FROM public.memory_items`);
    assert.deepEqual(stored, [{ memory_id: MY_MEMORY, media_url: MY_URL_1, media_type: "image/jpeg", caption: "rooftop", source_post_id: MY_POST }]);
    await new Promise((res) => setTimeout(res, 50));
    const events = await rows(`SELECT event_type, payload FROM public.media_events`);
    assert.deepEqual(events.map((e) => [e.event_type, e.payload.media_id, e.payload.post_id, e.payload.viewer_id, "memory_id" in e.payload]),
      [["memory_create", MY_POST, MY_POST, ME, false]]);
  });

  it("someone else's post is refused, as not_found, and nothing is written or signalled", async () => {
    const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: OTHER_POST });
    assert.equal(r.status, 404);
    assert.equal((await rows("SELECT count(*)::int AS n FROM public.memory_items"))[0].n, 0);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal((await rows("SELECT count(*)::int AS n FROM public.media_events"))[0].n, 0);
  });

  it("a deleted post of mine, a missing post, an index past the media, and someone else's Memory are each refused", async () => {
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_DELETED_POST })).status, 404);
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: "20000000-0000-4000-8000-0000000000ff" })).status, 404);
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST, mediaIndex: 2 })).status, 400);
    assert.equal((await post(`/memories/${OTHER_MEMORY}/items/from-post`, ME, { postId: MY_POST })).status, 403);
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST, mediaUrl: OTHER_URL })).status, 400,
      "a client-supplied URL is not accepted at all");
    assert.equal((await rows("SELECT count(*)::int AS n FROM public.memory_items"))[0].n, 0);
  });

  it("a video post becomes a video item; the same photo twice is a conflict", async () => {
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_VIDEO_POST })).status, 201);
    assert.equal(memoryItemMediaTypeFor("video"), "video/mp4");
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST })).status, 201);
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST })).status, 409);
    assert.deepEqual((await rows(`SELECT media_type FROM public.memory_items ORDER BY media_type`)).map((r) => r.media_type), ["image/jpeg", "video/mp4"]);
  });

  it("kernel on: the kernel's item is linked after it is written", async () => {
    await setFlag("memory_kernel_enabled", true);
    const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST }, { "Idempotency-Key": "k-1" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await rows(`SELECT source_post_id FROM public.memory_items`), [{ source_post_id: MY_POST }]);
  });

  it("kernel on, and the link cannot be written: the item is removed and the request refused", async () => {
    await setFlag("memory_kernel_enabled", true);
    // The post's media changes between the route's read and the link write: the
    // trigger refuses the link, so the route must not leave an unlinked copy.
    await db.exec(`CREATE OR REPLACE FUNCTION public.zz_race() RETURNS trigger LANGUAGE plpgsql AS $r$
      BEGIN UPDATE public.posts SET media_urls = '{}' WHERE id = NEW.source_post_id; RETURN NEW; END $r$;
      CREATE TRIGGER aa_zz_race BEFORE UPDATE OF source_post_id ON public.memory_items FOR EACH ROW EXECUTE FUNCTION public.zz_race();`);
    try {
      const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST }, { "Idempotency-Key": "k-2" });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal((await rows("SELECT count(*)::int AS n FROM public.memory_items"))[0].n, 0, "no unlinked copy is left");
    } finally {
      await db.exec(`DROP TRIGGER aa_zz_race ON public.memory_items; DROP FUNCTION public.zz_race();`);
    }
  });

  it("flag ON over a database without 3999: refused before anything is read, never an unlinked write", async () => {
    const bare = await newDb(false);
    try {
      await bare.query(`INSERT INTO public.feature_flags (flag, enabled) VALUES ('memory_from_own_media_enabled', true)`);
      await bare.query(`INSERT INTO public.memories (id, owner_id) VALUES ($1, $2)`, [MY_MEMORY, ME]);
      await bare.query(`INSERT INTO public.posts (id, author_id, media_urls, media_type) VALUES ($1, $2, ARRAY[$3], 'image')`, [MY_POST, ME, MY_URL_0]);
      const gate = await gateMemoryFromOwnMedia(pgClient(bare) as any);
      assert.equal(gate.ok, false);
      assert.equal((gate as any).reason, "storage_absent");
      _setTestClient(pgClient(bare) as any, true);
      const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MY_POST });
      assert.equal(r.status, 503);
      assert.equal((await bare.query<any>("SELECT count(*)::int AS n FROM public.memory_items")).rows[0].n, 0);
    } finally { await bare.close(); }
  });
});
