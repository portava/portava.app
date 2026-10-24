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
  CREATE TABLE public.media_events (id bigserial PRIMARY KEY, event_type text NOT NULL, payload jsonb, occurred_at timestamptz); ${postMediaTable()}
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

// ── Re-parenting: 3676's SPLIT_MEMORY / MERGE_MEMORY over 3999's guard ────────
//
// 3676 moves an item between two Memories of ONE owner by an UPDATE of memory_id
// alone (its owner check refuses any other Memory before the first write). The
// link was checked when it was made, so a re-parent re-checks ownership only: a
// source post soft-deleted or held since never blocks a split or merge of the
// owner's own Memory, and a move into anyone else's Memory is still refused.

const graphKernel = readFileSync(new URL("../migrations/3676_memory_graph_kernel.sql", import.meta.url), "utf8");
const MY_SECOND_MEMORY = "10000000-0000-4000-8000-000000000003";
const MY_HELD_POST = "20000000-0000-4000-8000-000000000005";

/** What 3676 reads and writes beyond BASE_SCHEMA: 2710's kernel tables, 3674's
 *  redirects and source_mode, the tags/likes/saves a merge folds, the relation a
 *  split records, and the FALSE flag 3676's postcondition reads. */
const GRAPH_SCHEMA = `
  ALTER TABLE public.memories ADD COLUMN hidden_user_ids uuid[] NOT NULL DEFAULT '{}', ADD COLUMN title text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN source_mode text NOT NULL DEFAULT 'USER_CREATED';
  CREATE TABLE public.memory_domain_events (event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id uuid NOT NULL REFERENCES public.memories(id) ON DELETE CASCADE, sequence bigint NOT NULL, type text NOT NULL,
    actor_user_id uuid, causation_id uuid, correlation_id uuid, payload_json jsonb NOT NULL DEFAULT '{}',
    schema_version integer NOT NULL DEFAULT 1, occurred_at timestamptz NOT NULL, UNIQUE (memory_id, sequence));
  CREATE TABLE public.memory_event_outbox (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id uuid NOT NULL REFERENCES public.memory_domain_events(event_id) ON DELETE CASCADE, memory_id uuid NOT NULL, type text NOT NULL);
  CREATE TABLE public.memory_command_receipts (actor_user_id uuid NOT NULL, idempotency_key text NOT NULL, command_id uuid NOT NULL,
    command_type text NOT NULL, memory_id uuid, event_id uuid NOT NULL, event_type text NOT NULL, result_json jsonb NOT NULL,
    PRIMARY KEY (actor_user_id, idempotency_key));
  CREATE TABLE public.memory_command_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, command_id uuid NOT NULL,
    command_type text NOT NULL, memory_id uuid, actor_user_id uuid NOT NULL, idempotency_key text NOT NULL, outcome text NOT NULL,
    reason text, event_id uuid);
  CREATE TABLE public.memory_id_redirects (old_memory_id uuid PRIMARY KEY, new_memory_id uuid NOT NULL, owner_id uuid NOT NULL,
    reason text NOT NULL, command_id uuid);
  CREATE TABLE public.memory_tags (memory_id uuid NOT NULL, tagged_user_id uuid NOT NULL, status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (memory_id, tagged_user_id));
  CREATE TABLE public.memory_likes (memory_id uuid NOT NULL, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (memory_id, user_id));
  CREATE TABLE public.memory_saves (memory_id uuid NOT NULL, user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (memory_id, user_id));
  CREATE TABLE public.memory_relations (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id uuid NOT NULL,
    source_type text NOT NULL, source_id uuid NOT NULL, target_type text NOT NULL, target_id text NOT NULL, relation_type text NOT NULL,
    confidence numeric(4,3), source_mode text, detector_version text, reason_code text);
  INSERT INTO public.feature_flags (flag, enabled) VALUES ('memory_merge_split_enabled', false);
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
`;

describe("3999's guard under re-parenting, and 3676's real split / merge applied after it", { concurrency: 1 }, () => {
  let db: Database;
  const rows = async (text: string, p: unknown[] = []) => (await db.query<any>(text, p)).rows;
  const asService = async (text: string, p: unknown[] = []) => {
    await db.exec("SET ROLE service_role");
    try { return (await db.query<any>(text, p)).rows; } finally { await db.exec("RESET ROLE"); }
  };
  const link = async (memory: string, url: string, postId: string, position = 0) =>
    (await asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id, position) VALUES ($1, $2, $3, $4) RETURNING id`,
      [memory, url, postId, position]))[0].id as string;
  const softDelete = (postId: string) => db.query(`UPDATE public.posts SET status = 'deleted', deleted_at = now() WHERE id = $1`, [postId]);
  const item = async (id: string) => (await rows(`SELECT memory_id, media_url, source_post_id FROM public.memory_items WHERE id = $1`, [id]))[0];
  const graph = (type: string, actor: string, memoryId: string, payload: Record<string, unknown>) =>
    asService(`SELECT public.memory_graph_kernel_execute($1::jsonb) AS r`, [JSON.stringify({
      type, actor_user_id: actor, memory_id: memoryId, payload, command_id: crypto.randomUUID(),
      correlation_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() })]).then((r) => r[0].r);

  before(async () => {
    db = await newDb(true);
    await db.exec(GRAPH_SCHEMA);
    await db.exec(graphKernel);
  });

  beforeEach(async () => {
    await db.exec(`TRUNCATE public.memory_items, public.memory_domain_events, public.memory_event_outbox, public.memory_command_receipts,
      public.memory_command_audit, public.memory_id_redirects, public.memory_relations CASCADE;
      DELETE FROM public.posts; DELETE FROM public.memories;`);
    await db.query(`INSERT INTO public.memories (id, owner_id) VALUES ($1, $2), ($3, $2), ($4, $5)`,
      [MY_MEMORY, ME, MY_SECOND_MEMORY, OTHER_MEMORY, OTHER]);
    await db.query(`INSERT INTO public.posts (id, author_id, status, deleted_at, media_urls, media_type) VALUES
      ($1, $2, 'active', NULL, ARRAY[$3, $4], 'image'),
      ($5, $6, 'active', NULL, ARRAY[$7], 'image'),
      ($8, $2, 'deleted', now(), ARRAY[$3], 'image'),
      ($9, $2, 'hidden', NULL, ARRAY[$3], 'image')`,
      [MY_POST, ME, MY_URL_0, MY_URL_1, OTHER_POST, OTHER, OTHER_URL, MY_DELETED_POST, MY_HELD_POST]);
  });

  after(async () => { await db?.close(); });

  it("re-parenting between two of the owner's Memories re-checks ownership only: a source since soft-deleted, held or edited does not block it", async () => {
    const id = await link(MY_MEMORY, MY_URL_0, MY_POST);
    await softDelete(MY_POST);
    await asService(`UPDATE public.memory_items SET memory_id = $1 WHERE id = $2`, [MY_SECOND_MEMORY, id]);
    assert.deepEqual(await item(id), { memory_id: MY_SECOND_MEMORY, media_url: MY_URL_0, source_post_id: MY_POST });
    await db.query(`UPDATE public.posts SET status = 'hidden', deleted_at = NULL WHERE id = $1`, [MY_POST]);
    await asService(`UPDATE public.memory_items SET memory_id = $1 WHERE id = $2`, [MY_MEMORY, id]);
    await db.query(`UPDATE public.posts SET status = 'active', media_urls = '{}' WHERE id = $1`, [MY_POST]);
    await asService(`UPDATE public.memory_items SET memory_id = $1, position = 7 WHERE id = $2`, [MY_SECOND_MEMORY, id]);
    assert.deepEqual(await item(id), { memory_id: MY_SECOND_MEMORY, media_url: MY_URL_0, source_post_id: MY_POST });
  });

  it("re-parenting into another owner's Memory is still refused, whether the source post is live or not", async () => {
    const id = await link(MY_MEMORY, MY_URL_0, MY_POST);
    await assert.rejects(asService(`UPDATE public.memory_items SET memory_id = $1 WHERE id = $2`, [OTHER_MEMORY, id]),
      (e: any) => e?.code === "23514" && /D-26j/.test(e.message), "live source");
    await softDelete(MY_POST);
    await assert.rejects(asService(`UPDATE public.memory_items SET memory_id = $1 WHERE id = $2`, [OTHER_MEMORY, id]),
      (e: any) => e?.code === "23514" && /D-26j/.test(e.message), "soft-deleted source");
    assert.deepEqual(await item(id), { memory_id: MY_MEMORY, media_url: MY_URL_0, source_post_id: MY_POST });
  });

  it("a new or re-pointed link still needs the owner's own live post and its own media, even when memory_id moves with it", async () => {
    for (const [postId, url, why] of [[MY_DELETED_POST, MY_URL_0, "a soft-deleted post"], [MY_HELD_POST, MY_URL_0, "a held post"],
      [OTHER_POST, OTHER_URL, "someone else's post"]]) {
      await assert.rejects(link(MY_MEMORY, url, postId), /D-26j/, `insert linking ${why}`);
    }
    const id = await link(MY_MEMORY, MY_URL_0, MY_POST);
    const refused: Array<[string, unknown[], string]> = [
      [`source_post_id = $1`, [MY_DELETED_POST], "re-pointing at a soft-deleted post"],
      [`source_post_id = $1`, [MY_HELD_POST], "re-pointing at a held post"],
      [`source_post_id = $1, memory_id = $2`, [MY_DELETED_POST, MY_SECOND_MEMORY], "re-pointing and re-parenting at once"],
      [`media_url = $1`, [OTHER_URL], "a URL the post does not carry"],
    ];
    for (const [set, values, why] of refused) {
      await assert.rejects(asService(`UPDATE public.memory_items SET ${set} WHERE id = $${values.length + 1}`, [...values, id]), /D-26j/, why);
    }
    await softDelete(MY_POST);
    await assert.rejects(asService(`UPDATE public.memory_items SET media_url = $1, memory_id = $2 WHERE id = $3`, [MY_URL_1, MY_SECOND_MEMORY, id]),
      /D-26j/, "a re-parent that also changes the media is a new copy: the source must be live");
    assert.deepEqual(await item(id), { memory_id: MY_MEMORY, media_url: MY_URL_0, source_post_id: MY_POST });
    await db.query(`UPDATE public.posts SET status = 'active', deleted_at = NULL WHERE id = $1`, [MY_POST]);
    await asService(`UPDATE public.memory_items SET source_post_id = $1, memory_id = $2 WHERE id = $3`, [MY_POST, MY_SECOND_MEMORY, id]);
    assert.equal((await item(id)).memory_id, MY_SECOND_MEMORY, "both columns at once, to a live own post: accepted");
  });

  it("an item with no source link is not the guard's business: it moves without a check", async () => {
    const [{ id }] = await asService(`INSERT INTO public.memory_items (memory_id, media_url) VALUES ($1, $2) RETURNING id`, [MY_MEMORY, OTHER_URL]);
    await asService(`UPDATE public.memory_items SET memory_id = $1 WHERE id = $2`, [OTHER_MEMORY, id]);
    assert.equal((await item(id)).memory_id, OTHER_MEMORY);
  });

  it("3676 SPLIT_MEMORY moves a linked item whose source post was soft-deleted to the owner's new Memory", async () => {
    const linked = await link(MY_MEMORY, MY_URL_0, MY_POST);
    await asService(`INSERT INTO public.memory_items (memory_id, media_url, position) VALUES ($1, $2, 1)`, [MY_MEMORY, MY_URL_1]);
    await softDelete(MY_POST);
    const r = await graph("SPLIT_MEMORY", ME, MY_MEMORY, { item_ids: [linked] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const newId = r.result.new_memory_id;
    assert.deepEqual(await item(linked), { memory_id: newId, media_url: MY_URL_0, source_post_id: MY_POST });
    assert.deepEqual(await rows(`SELECT owner_id FROM public.memories WHERE id = $1`, [newId]), [{ owner_id: ME }]);
  });

  it("3676 MERGE_MEMORY absorbs a Memory holding a linked item whose source post is held", async () => {
    const linked = await link(MY_SECOND_MEMORY, MY_URL_1, MY_POST);
    await asService(`INSERT INTO public.memory_items (memory_id, media_url) VALUES ($1, $2)`, [MY_MEMORY, MY_URL_0]);
    await db.query(`UPDATE public.posts SET status = 'hidden' WHERE id = $1`, [MY_POST]);
    const r = await graph("MERGE_MEMORY", ME, MY_MEMORY, { absorbed_memory_ids: [MY_SECOND_MEMORY] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.moved.items, 1);
    assert.deepEqual(await item(linked), { memory_id: MY_MEMORY, media_url: MY_URL_1, source_post_id: MY_POST });
  });

  it("3676 never re-parents across owners: another owner's Memory is refused before any item moves", async () => {
    const mine = await link(MY_MEMORY, MY_URL_0, MY_POST);
    const theirs = await link(OTHER_MEMORY, OTHER_URL, OTHER_POST);
    const merge = await graph("MERGE_MEMORY", ME, MY_MEMORY, { absorbed_memory_ids: [OTHER_MEMORY] });
    assert.deepEqual([merge.ok, merge.reason], [false, "MEMORY_AUTH_NOT_OWNER"]);
    const split = await graph("SPLIT_MEMORY", OTHER, MY_MEMORY, { item_ids: [mine] });
    assert.deepEqual([split.ok, split.reason], [false, "MEMORY_AUTH_NOT_OWNER"]);
    assert.equal((await item(mine)).memory_id, MY_MEMORY);
    assert.equal((await item(theirs)).memory_id, OTHER_MEMORY);
  });
});

// ── 2026-10-24, video on every surface: "Save to a Memory" from an UPLOAD post (post_media only) — 3928 ─────────────
// 2083 / 3924 / #795 keep uploads in post_media; 3999's guard and the reader knew only posts.media_urls, so an upload
// post's own photo or video was refused (`no_such_media` in the route, D-26j in the database).
//   PM1  an upload post (media_urls empty, one ready row): the route writes the item, named by the row, typed by its MIME
//   PM2  rows first in sort_order, then the EXTERNAL media_urls entries; a storage key left in media_urls is not offered
//        twice; a row with no public_url is named `<storage_bucket>/<storage_path>`, which the guard accepts too
//   PM3  a rejected, flagged or still-processing row is never offered (route) and never accepted (database)
//   PM4  the database widens ONLY to the post's own row: another post's row, another user's post, a non-owner's Memory refused
//   PM5  without 3928 (3999 alone) the database refuses the row the reader now offers — 3928 is required, not decorative
//   PM6  3928 re-runs cleanly, refuses to overwrite a guard body that is neither 3999's nor its own, and its rollback
//        restores 3999's body byte for byte (and the refusal with it)
//   PM7  an unreadable post_media read refuses 503 — never read as "no rows", never a write
const migration3928 = readFileSync(new URL("../migrations/3928_memory_items_source_post_guard_post_media.sql", import.meta.url), "utf8");
const rollback3928 = readFileSync(new URL("../../../../db/rollback/2026-10-24-3928-memory-items-source-post-guard-post-media-rollback.sql", import.meta.url), "utf8");

describe("3928 — Save to a Memory from an upload post (post_media), reader and guard", { concurrency: 1 }, () => {
  let db: Database;
  let base = "";
  let server: http.Server;
  let failPostMedia = false;
  const UPLOAD_POST = "20000000-0000-4000-8000-0000000000a1";
  const MIXED_POST = "20000000-0000-4000-8000-0000000000a2";
  const OTHER_UPLOAD = "20000000-0000-4000-8000-0000000000a3";
  const MOV = `post-media/${ME}/1792727980484.mov`;
  const JPG = `post-media/${ME}/1792727980485.jpg`;
  const EXTERNAL = "https://images.example.org/view.jpg";
  const rows = async (text: string, p: unknown[] = []) => (await db.query<any>(text, p)).rows;
  const asService = async (text: string, p: unknown[] = []) => {
    await db.exec("SET ROLE service_role");
    try { return (await db.query<any>(text, p)).rows; } finally { await db.exec("RESET ROLE"); }
  };
  const setFlag = (flag: string, on: boolean) =>
    db.query("INSERT INTO public.feature_flags (flag, enabled) VALUES ($1, $2) ON CONFLICT (flag) DO UPDATE SET enabled = EXCLUDED.enabled", [flag, on]);
  async function post(path: string, actor: string, body: unknown) {
    const res = await fetch(base + "/api" + path, {
      method: "POST", headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" }, body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }
  const guardSrc = async (d: Database) => (await d.query<any>("SELECT prosrc FROM pg_proc WHERE oid = 'public.memory_items_source_post_guard()'::regprocedure")).rows[0].prosrc as string;

  before(async () => {
    db = await newDb(true);
    await db.exec(migration3928);
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
    failPostMedia = false;
    const real = pgClient(db);
    _setTestClient({ ...real, from: (t: string) => (failPostMedia && t === "post_media"
      ? { select: () => ({ eq: async () => ({ data: null, error: { message: "permission denied for table post_media" } }) }) }
      : real.from(t)) } as any, true);
    await db.exec(`TRUNCATE public.memory_items, public.media_events; DELETE FROM public.post_media; DELETE FROM public.posts; DELETE FROM public.memories;
      UPDATE public.feature_flags SET enabled = false;`);
    await setFlag("memory_from_own_media_enabled", true);
    await db.query(`INSERT INTO public.memories (id, owner_id) VALUES ($1, $2), ($3, $4)`, [MY_MEMORY, ME, OTHER_MEMORY, OTHER]);
    await db.query(`INSERT INTO public.posts (id, author_id, media_urls, media_type) VALUES
      ($1, $2, '{}', 'video/quicktime'), ($3, $2, ARRAY[$5, $6], 'image/jpeg'), ($4, $7, '{}', 'video/quicktime')`,
      [UPLOAD_POST, ME, MIXED_POST, OTHER_UPLOAD, EXTERNAL, JPG, OTHER]);
    await db.query(`INSERT INTO public.post_media (post_id, user_id, media_type, storage_path, public_url, mime_type, processing_status, moderation_status, sort_order) VALUES
      ($1, $2, 'video', $3, $4, 'video/quicktime', 'ready', 'pending', 0),
      ($5, $2, 'image', $6, $7, 'image/jpeg', 'ready', 'approved', 1),
      ($5, $2, 'image', $8, $9, 'image/jpeg', 'ready', 'rejected', 0),
      ($5, $2, 'image', $10, $11, 'image/jpeg', 'ready', 'flagged', 2),
      ($5, $2, 'video', $12, $13, 'video/mp4', 'pending', 'pending', 3),
      ($14, $15, 'video', $16, $17, 'video/quicktime', 'ready', 'pending', 0)`,
      [UPLOAD_POST, ME, MOV.slice("post-media/".length), MOV,
       MIXED_POST, JPG.slice("post-media/".length), JPG, `${ME}/rejected.jpg`, `post-media/${ME}/rejected.jpg`,
       `${ME}/flagged.jpg`, `post-media/${ME}/flagged.jpg`, `${ME}/processing.mp4`, `post-media/${ME}/processing.mp4`,
       OTHER_UPLOAD, OTHER, `${OTHER}/theirs.mov`, `post-media/${OTHER}/theirs.mov`]);
  });

  after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await db?.close();
  });

  it("PM1 an upload post: the item is written from its post_media row, linked, typed by the row's MIME", async () => {
    const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: UPLOAD_POST });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await rows(`SELECT media_url, media_type, source_post_id FROM public.memory_items`),
      [{ media_url: MOV, media_type: "video/quicktime", source_post_id: UPLOAD_POST }]);
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: UPLOAD_POST, mediaIndex: 1 })).status, 400, "one row, one item");
  });

  it("PM2 rows first in sort_order, then the external media_urls entries; the storage key in media_urls is not offered twice", async () => {
    // media_urls is [EXTERNAL, JPG] (the upload's key left behind). A second visible row, sort_order 0, is inserted
    // LAST, so only a sort puts it first. The list is [first.jpg, the JPG row, EXTERNAL].
    const FIRST = `post-media/${ME}/first.jpg`;
    await db.query(`INSERT INTO public.post_media (post_id, user_id, media_type, storage_path, public_url, mime_type, processing_status, moderation_status, sort_order)
      VALUES ($1, $2, 'image', $3, '', 'image/jpeg', 'ready', 'approved', 0)`, [MIXED_POST, ME, `${ME}/first.jpg`]);
    const expected = [FIRST, JPG, EXTERNAL];
    for (let i = 0; i < expected.length; i++) {
      const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MIXED_POST, mediaIndex: i });
      assert.equal(r.status, 201, `index ${i}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.item.mediaUrl, expected[i], `index ${i}`);
    }
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: MIXED_POST, mediaIndex: 3 })).status, 400, "the JPG key in media_urls is not a fourth item");
  });

  it("PM3 a rejected, flagged or still-processing row is never offered, and the database refuses each", async () => {
    for (const bad of ["rejected.jpg", "flagged.jpg", "processing.mp4"]) {
      await assert.rejects(asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, `post-media/${ME}/${bad}`, MIXED_POST]), /D-26j/, bad);
    }
    assert.equal((await rows("SELECT count(*)::int AS n FROM public.memory_items"))[0].n, 0);
  });

  it("PM4 the guard widens only to the post's OWN row: another post's row, another user's post, another owner's Memory are refused", async () => {
    await asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, MOV, UPLOAD_POST]);
    await asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, `post-media/${ME}/1792727980485.jpg`, MIXED_POST]);
    const refused: Array<[string, string, string, string]> = [
      [MY_MEMORY, JPG, UPLOAD_POST, "my other post's row, linked to this post"],
      [MY_MEMORY, `post-media/${OTHER}/theirs.mov`, OTHER_UPLOAD, "someone else's upload post"],
      [MY_MEMORY, `post-media/${OTHER}/theirs.mov`, UPLOAD_POST, "someone else's row through my post"],
      [OTHER_MEMORY, MOV, UPLOAD_POST, "my upload into someone else's Memory"],
    ];
    for (const [memory, url, postId, why] of refused) {
      await assert.rejects(asService(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [memory, url, postId]), /D-26j/, why);
    }
    assert.equal((await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: OTHER_UPLOAD })).status, 404);
  });

  it("PM5 3999 alone refuses the post_media row the reader now offers: 3928 is required", async () => {
    const only3999 = await newDb(true);
    try {
      await only3999.query(`INSERT INTO public.memories (id, owner_id) VALUES ($1, $2)`, [MY_MEMORY, ME]);
      await only3999.query(`INSERT INTO public.posts (id, author_id, media_urls) VALUES ($1, $2, '{}')`, [UPLOAD_POST, ME]);
      await only3999.query(`INSERT INTO public.post_media (post_id, user_id, media_type, storage_path, public_url, mime_type, processing_status) VALUES ($1, $2, 'video', $3, $4, 'video/quicktime', 'ready')`,
        [UPLOAD_POST, ME, MOV.slice("post-media/".length), MOV]);
      await only3999.exec("SET ROLE service_role");
      await assert.rejects(only3999.query(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, MOV, UPLOAD_POST]), /D-26j/);
      await only3999.exec("RESET ROLE");
      await only3999.exec(migration3928);
      await only3999.exec("SET ROLE service_role");
      await only3999.query(`INSERT INTO public.memory_items (memory_id, media_url, source_post_id) VALUES ($1, $2, $3)`, [MY_MEMORY, MOV, UPLOAD_POST]);
      await only3999.exec("RESET ROLE");
    } finally { await only3999.close(); }
  });

  it("PM6 3928 re-runs, refuses a foreign guard body, and its rollback restores 3999's body exactly", async () => {
    const d = await newDb(true);
    try {
      const body3999 = await guardSrc(d);
      await d.exec(migration3928);
      await d.exec(migration3928);
      assert.notEqual(await guardSrc(d), body3999);
      await d.exec(rollback3928);
      assert.equal(await guardSrc(d), body3999, "the rollback restores 3999's body byte for byte");
      const p = (await d.query<any>(`SELECT has_function_privilege('authenticated', 'public.memory_items_source_post_guard()', 'EXECUTE') AS a,
        has_function_privilege('anon', 'public.memory_items_source_post_guard()', 'EXECUTE') AS b`)).rows[0];
      assert.deepEqual(p, { a: false, b: false });
      await d.exec(`CREATE OR REPLACE FUNCTION public.memory_items_source_post_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
        SET search_path = pg_catalog, public AS $f$ BEGIN RETURN NEW; END $f$;`);
      await assert.rejects(d.exec(migration3928), /PRECONDITION FAILED \(3928\)/);
    } finally { await d.close(); }
  });

  it("PM7 an unreadable post_media read refuses 503 and writes nothing", async () => {
    failPostMedia = true;
    const r = await post(`/memories/${MY_MEMORY}/items/from-post`, ME, { postId: UPLOAD_POST });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal((await rows("SELECT count(*)::int AS n FROM public.memory_items"))[0].n, 0);
  });
});

/** 0103's post_media, the columns the from-post reader and 3928's guard read (added 2026-10-24: the reader now reads it). A hoisted function at the tail, so no cited line above moves. */
function postMediaTable(): string {
  return `CREATE TABLE public.post_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    user_id uuid NOT NULL, media_type text NOT NULL CHECK (media_type IN ('image', 'video')), storage_bucket text NOT NULL DEFAULT 'post-media',
    storage_path text NOT NULL DEFAULT '', public_url text NOT NULL DEFAULT '', mime_type text NOT NULL,
    processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'ready', 'failed')),
    moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'approved', 'flagged', 'rejected')),
    sort_order integer NOT NULL DEFAULT 0);`;
}
