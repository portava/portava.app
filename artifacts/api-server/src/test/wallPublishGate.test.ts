/**
 * Wall — delayed-publish gate (spec §23 / §37) and the Postcard discriminator
 * (§10), proven through the REAL /wall router in BOTH modes.
 *
 * POST /posts inserts a delayed-geotag post as status='active' with
 * post_status='pending_location_exit' / 'pending_delay' (and moderation can
 * park one at 'pending_safety_review'); a sweeper flips it to 'published'
 * later. Every canonical reader gates post_status='published'. The Wall's Post
 * spine and Postcard loader gated only status='active', so every follower saw
 * the post — and the author's presence at the place — while it was pending.
 *
 * Two fakes prove two layers:
 *   • honorPostStatus=true  — the fake applies `.eq("post_status", …)` the way
 *     the DB would, proving each query CARRIES the canonical predicate;
 *   • honorPostStatus=false — the fake feeds pending rows PAST the filter,
 *     proving the in-memory re-check (lib/postVisibility.isPostPublished)
 *     still refuses them, and that an ABSENT post_status reads as published,
 *     exactly as GET /posts/:id and lib/mediaEligibility treat it.
 *
 * The same fixture carries the Postcard ruling: every post has
 * add_to_passport=true (the universal default), and only the one a live
 * passport_postcards row points at is served as a `postcard`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const AUTHOR = "author-1";

const FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_input_intelligence_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_rab_integration_enabled: false,
  wall_context_threads_enabled: false,
};

const PROFILES: Record<string, any> = {
  [VIEWER]: { id: VIEWER, account_status: "active", current_city: "Da Nang", home_city: "Da Nang", interests: [] },
  [AUTHOR]: { id: AUTHOR, display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" },
};

function postRow(id: string, over: Record<string, any>) {
  return {
    id, author_id: AUTHOR, trip_id: null, content: `post ${id}`, visibility: "public", status: "active",
    published_at: "2026-09-01T10:00:00Z", canonical_place_id: null, has_video: false, media_count: 0,
    category: null, location_city: "Da Nang", location_country: "VN", like_count: 0, comment_count: 0, save_count: 0,
    // TRUE by default everywhere (schema, POST /posts, POST /postcards) — it
    // must not make any of these a Postcard.
    add_to_passport: true,
    ...over,
  };
}

// Every row is status='active' — exactly what POST /posts writes for a delayed post.
const POSTS = [
  postRow("published-1", { post_status: "published", created_at: "2026-09-01T10:00:00Z" }),
  postRow("pending-exit-1", { post_status: "pending_location_exit", created_at: "2026-09-01T09:50:00Z" }),
  postRow("pending-delay-1", { post_status: "pending_delay", created_at: "2026-09-01T09:40:00Z" }),
  postRow("review-1", { post_status: "pending_safety_review", created_at: "2026-09-01T09:30:00Z" }),
  // NO post_status key: the canonical readers treat absent as published
  // (`!post.post_status || post.post_status === "published"`).
  postRow("legacy-1", { created_at: "2026-09-01T09:20:00Z" }),
];
const PENDING_IDS = ["pending-exit-1", "pending-delay-1", "review-1"];

// Live postcard rows: one for the published post (a real Postcard) and one for
// a pending post (a Postcard that must stay hidden until it is published).
const PASSPORT_POSTCARDS = [
  { post_id: "published-1", user_id: AUTHOR, status: "active", deleted_at: null, created_at: "2026-09-01T10:00:00Z" },
  { post_id: "pending-exit-1", user_id: AUTHOR, status: "active", deleted_at: null, created_at: "2026-09-01T09:50:00Z" },
];

interface CapturedQuery {
  table: string;
  select: string;
  eqs: Record<string, any>;
  ins: Record<string, any[]>;
}

function fakeClient(opts: { honorPostStatus: boolean; captured: CapturedQuery[] }) {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    let select = "";
    const b: any = {
      select: (cols?: string) => { select = String(cols ?? ""); return b; },
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any[]) => { ins[c] = v; return b; },
      gte: () => b, lte: () => b, gt: () => b, or: () => b, order: () => b, limit: () => b, ilike: () => b,
      insert: () => Promise.resolve({ error: null }),
      upsert: () => Promise.resolve({ error: null }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      maybeSingle: () => {
        if (table === "feature_flags") return Promise.resolve({ data: { enabled: !!FLAGS[String(eqs["flag"])] }, error: null });
        if (table === "profiles") return Promise.resolve({ data: PROFILES[String(eqs["id"])] ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (onF: any, onR: any) => {
        let data: any[] = [];
        if (table === "posts") {
          opts.captured.push({ table, select, eqs: { ...eqs }, ins: { ...ins } });
          data = POSTS;
          if (ins["author_id"]) data = data.filter((p) => ins["author_id"].includes(p.author_id));
          if (ins["id"]) data = data.filter((p) => ins["id"].includes(p.id));
          // Like the DB: `.eq("post_status", v)` matches only rows whose column
          // equals v (the column is NOT NULL, so a real row always has one).
          if (opts.honorPostStatus && "post_status" in eqs) data = data.filter((p) => p.post_status === eqs["post_status"]);
        } else if (table === "passport_postcards") {
          opts.captured.push({ table, select, eqs: { ...eqs }, ins: { ...ins } });
          data = PASSPORT_POSTCARDS;
        } else if (table === "profiles") {
          if (ins["account_status"]) data = []; // media reader's suspended-creator lookup
          else data = ins["id"] ? ins["id"].map((id) => PROFILES[id]).filter(Boolean) : Object.values(PROFILES);
        } else if (table === "user_follows") {
          if (ins["follower_id"]) data = []; // second-degree seeds ⇒ nothing new
          else if (eqs["follower_id"] === VIEWER) data = [{ following_id: AUTHOR }];
        }
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

let server: http.Server;
let baseUrl = "";
function request(method: string, path: string, opts: { token?: string } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
        headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function idsOf(json: any): string[] {
  return (json.items ?? []).map((i: any) => i.canonicalObjectId);
}
function typeOf(json: any, id: string): string | undefined {
  return (json.items ?? []).find((i: any) => i.canonicalObjectId === id)?.objectType;
}

async function serve(mode: "for_you" | "following", honorPostStatus: boolean) {
  const captured: CapturedQuery[] = [];
  _clearPromotedScopeCache();
  _setTestClient(fakeClient({ honorPostStatus, captured }), true);
  const res = await request("GET", `/api/wall?mode=${mode}`, { token: TOKEN });
  assert.equal(res.status, 200);
  return { res, captured };
}

describe("Wall route — delayed-publish gate + Postcard discriminator", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  });
  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  for (const mode of ["for_you", "following"] as const) {
    it(`${mode}: the Post spine and the Postcard loader carry post_status='published' on the query (D1)`, async () => {
      const { res, captured } = await serve(mode, true);
      assert.deepEqual(idsOf(res.json), ["published-1"], "only the published post is served");

      const posts = captured.filter((q) => q.table === "posts");
      // The Post spine: a posts read that is neither the Postcard loader's
      // by-id read nor the Media v2 reader's embedded read (`post_media(`,
      // which gates post_status in memory via lib/mediaEligibility).
      const spine = posts.filter((q) => !q.ins["id"] && !q.select.includes("post_media("));
      assert.ok(spine.length >= 1, "the Post spine read posts");
      for (const q of spine) {
        assert.ok(q.select.includes("post_status"), "the spine now SELECTS post_status");
        assert.equal(q.eqs.status, "active");
        assert.equal(q.eqs.post_status, "published", "the spine query carries the canonical predicate");
      }
      const postcardPosts = posts.filter((q) => q.ins["id"]);
      assert.equal(postcardPosts.length, 1, "the Postcard loader fetched posts by the postcard rows' post_id");
      assert.equal(postcardPosts[0].eqs.status, "active");
      assert.equal(postcardPosts[0].eqs.post_status, "published", "the Postcard loader carries the canonical predicate");
      assert.deepEqual(postcardPosts[0].ins["id"].sort(), ["pending-exit-1", "published-1"]);

      const postcardRows = captured.filter((q) => q.table === "passport_postcards");
      assert.equal(postcardRows.length, 1, "the discriminator is read from passport_postcards");
      assert.equal(postcardRows[0].eqs.status, "active", "live postcard rows only");
      assert.deepEqual(postcardRows[0].ins["user_id"], [AUTHOR], "scoped to followed authors");
    });

    it(`${mode}: rows fed PAST the query filter are still refused in memory; absent post_status reads as published (D1)`, async () => {
      const { res } = await serve(mode, false);
      const ids = idsOf(res.json);
      for (const id of PENDING_IDS) assert.ok(!ids.includes(id), `${id} (status='active', pending post_status) must never be served`);
      assert.deepEqual([...ids].sort(), ["legacy-1", "published-1"], "published + legacy (absent ⇒ published) are served");
    });

    it(`${mode}: a post is a Postcard only via its live passport_postcards row — add_to_passport=true decides nothing (D2)`, async () => {
      const { res } = await serve(mode, false);
      assert.equal(typeOf(res.json, "published-1"), "postcard", "the post with a live postcard row renders as a Postcard");
      assert.notEqual(typeOf(res.json, "legacy-1"), "postcard", "add_to_passport=true without a postcard row is a plain post");
      assert.ok(!idsOf(res.json).includes("pending-exit-1"), "a Postcard whose post is pending is not served at all");
    });
  }
});
