/**
 * Pulse feed — featuredByPortava field shaping
 *
 * Confirms that:
 *   1. A post whose id appears in portava_featured (status='live') gets
 *      featuredByPortava set to the feature category in the /api/pulse response.
 *   2. A post that is NOT in portava_featured gets featuredByPortava = null.
 *
 * Run:
 *   node --import tsx/esm --test src/test/pulseFeaturedField.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";

const USER_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const POST_FEAT = "post-featured-000-0000-0000-00000000001";
const POST_PLAIN = "post-plain-0000-0000-0000-00000000001";
// Minimal JWT-like token — pulse route verifies via the fake client's auth
const TOKEN = "test-token-pulse-featured";

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makePulseClient(featuredPostIds: string[]) {
  const featuredSet = new Set(featuredPostIds);

  // Builder that accumulates filter state and resolves on .then() / awaited
  function makeBuilder(table: string, rows: any[]): any {
    let filtered = rows;
    const b: any = {
      select: () => b,
      eq: (_col: string, _val: any) => b,
      neq: () => b,
      not: () => b,
      in: (_col: string, vals: any[]) => {
        if (table === "portava_featured") {
          filtered = filtered.filter((r) => vals.includes(r.post_id));
        }
        return b;
      },
      gte: () => b,
      lt:  () => b,
      lte: () => b,
      order: () => b,
      limit: () => b,
      ilike: () => b,
      is: () => b,
      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single:       async () => ({ data: filtered[0] ?? null, error: null }),
      then: (onF: (v: any) => any) =>
        Promise.resolve({ data: filtered, error: null }).then(onF),
    };
    return b;
  }

  // Rows returned by the main posts query
  const postRows = [
    {
      id: POST_FEAT, author_id: USER_ID, content: "Featured post", trip_id: null,
      media_urls: [], visibility: "public", created_at: new Date().toISOString(),
      status: "active", location_name: null, location_city: "Tokyo",
      location_country: "JP", location_source: "manual",
      post_media: [], pulse_geo_tags: null,
      profiles: { id: USER_ID, username: "tester", full_name: "Tester", avatar_url: null, verified: false, is_official: false },
      tags: [], category: null, like_count: 0,
    },
    {
      id: POST_PLAIN, author_id: USER_ID, content: "Plain post", trip_id: null,
      media_urls: [], visibility: "public", created_at: new Date().toISOString(),
      status: "active", location_name: null, location_city: "Berlin",
      location_country: "DE", location_source: "manual",
      post_media: [], pulse_geo_tags: null,
      profiles: { id: USER_ID, username: "tester", full_name: "Tester", avatar_url: null, verified: false, is_official: false },
      tags: [], category: null, like_count: 0,
    },
  ];

  return {
    auth: {
      getUser: async (token: string) => {
        if (token !== TOKEN) return { data: { user: null }, error: { message: "bad token" } };
        return { data: { user: { id: USER_ID } }, error: null };
      },
    },
    from(table: string) {
      if (table === "posts")            return makeBuilder("posts", postRows);
      if (table === "portava_featured") {
        const featuredRows = featuredSet.size > 0
          ? [{ post_id: POST_FEAT, category: "best_hidden_gem", status: "live", featured_at: new Date().toISOString() }].filter(
              (r) => featuredSet.has(r.post_id),
            )
          : [];
        return makeBuilder("portava_featured", featuredRows);
      }
      // All other tables: return empty results
      return makeBuilder(table, []);
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function withPulseServer(
  featuredPostIds: string[],
  fn: (port: number) => Promise<void>,
): Promise<void> {
  _setTestClient(makePulseClient(featuredPostIds), true);

  // Dynamic import so the test client is in place before the module resolves
  const { default: pulseRouter } = await import("../routes/pulse.js");

  const app = express();
  app.use(express.json());
  // Shim req.log — Pino is not wired in test servers
  app.use((req: any, _res: any, next: any) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", pulseRouter);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function pulseGet(port: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1", port,
      path: "/api/pulse",
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || "{}") });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: {} });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Pulse feed — featuredByPortava field shaping", () => {
  it("featured post carries featuredByPortava = category string", async () => {
    await withPulseServer([POST_FEAT], async (port) => {
      const { status, body } = await pulseGet(port);
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
      const posts: any[] = body.posts ?? [];
      const featured = posts.find((p: any) => p.id === POST_FEAT);
      assert.ok(featured, `Featured post ${POST_FEAT} must appear in response`);
      assert.equal(
        featured.featuredByPortava, "best_hidden_gem",
        `featuredByPortava must equal 'best_hidden_gem', got: ${featured.featuredByPortava}`,
      );
    });
  });

  it("non-featured post has featuredByPortava = null", async () => {
    await withPulseServer([POST_FEAT], async (port) => {
      const { body } = await pulseGet(port);
      const posts: any[] = body.posts ?? [];
      const plain = posts.find((p: any) => p.id === POST_PLAIN);
      assert.ok(plain, `Plain post ${POST_PLAIN} must appear in response`);
      assert.equal(
        plain.featuredByPortava, null,
        `Non-featured post must have featuredByPortava=null, got: ${plain.featuredByPortava}`,
      );
    });
  });
});
