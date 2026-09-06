/**
 * GET /api/pulse — an impression is the SERVED PAGE, not the candidate pool.
 *
 * THE DEFECT THIS IS WRITTEN AGAINST
 * ==================================
 * routes/pulse.ts ranked posts + events + plans + buddies together and then
 * called
 *
 *     void logImpression(ranked, user.id, "pulse", sessionId);
 *
 * immediately after rankCandidates() — on the whole CANDIDATE POOL, ~60 rows,
 * and before the DiscoveryRankingService re-order, before the creator-frequency
 * caps, and before the intent-mode overlays. The response then serves ONLY the
 * posts: `rankedCandidates` is stripped from the body ("perf-trim … internal
 * ranking state only"), so every event, plan and buddy candidate produced a
 * rank_events impression row for an item the viewer never saw.
 *
 * Those rows are the exposure DENOMINATOR: lib/rankLog.ts increments
 * content_distribution_stats.eligible_impressions once per distinct item whose
 * impression row landed. The denominator therefore ran roughly an order of
 * magnitude high, and every rate normalised by it — the underexposure
 * classification included — was wrong in the same direction.
 *
 * WHAT IS PINNED HERE
 * ===================
 *   A. The number of impression rows equals the number of SERVED posts, and the
 *      item_ids are exactly the served post ids in served order.
 *   B. The exposure denominator (increment_distribution_stats calls) equals the
 *      served page size, not the candidate count.
 *   C. Non-post candidates that were ranked but stripped from the response get
 *      NO impression row.
 *   D. selectServedImpressions itself: served order, de-duplication, and
 *      ids that were never ranked.
 *
 * Runtime: node:test + node:assert/strict. Fake Supabase client via
 * _setTestClient (which also installs it as the service client, so
 * lib/rankLog.ts writes land in the same fake).
 *
 * Run: node --import tsx/esm --test src/test/pulseServedImpressions.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { selectServedImpressions } from "../lib/rankLog.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const CITY     = "Manila";
const NOW      = new Date().toISOString();
const SOON     = new Date(Date.now() + 60 * 60 * 1_000).toISOString();

const INCREMENT_RPC = "increment_distribution_stats";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function postRow(n: number): Record<string, any> {
  const id = `${n.toString(16).padStart(8, "0")}-0000-0000-0000-000000000001`;
  return {
    id,
    author_id:        BOB_ID,
    content:          `post ${n}`,
    created_at:       NOW,
    visibility:       "public",
    status:           "active",
    post_status:      "published",
    location_city:    CITY,
    location_country: "Philippines",
    location_name:    null,
    location_source:  null,
    media_urls:       [],
    trip_id:          null,
    canonical_place_id: null,
    pulse_geo_tags:   null,
    post_media:       [],
    profiles:         { id: BOB_ID, username: "bob", full_name: "Bob", avatar_url: null },
  };
}

function eventRow(n: number): Record<string, any> {
  return {
    id:            `e0000000-0000-0000-0000-00000000000${n}`,
    host_id:       BOB_ID,
    title:         `event ${n}`,
    category:      "food",
    starts_at:     SOON,
    city:          CITY,
    max_attendees: null,
    going_count:   0,
    tags:          [],
    state:         "open",
    visibility:    "public",
  };
}

function buddyRow(n: number): Record<string, any> {
  return {
    id:                    `rb000000-0000-0000-0000-00000000000${n}`,
    user_id:               `bb000000-0000-0000-0000-00000000000${n}`,
    city:                  CITY,
    trust_score_override:  null,
    admin_status:          "active",
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Inserted { table: string; rows: any[] }
interface RpcCall  { name: string; params: Record<string, any> }

function makeClient(state: { posts: any[]; events: any[]; buddies: any[] }) {
  const inserts:  Inserted[] = [];
  const rpcCalls: RpcCall[]  = [];

  const db: Record<string, any[]> = {
    posts:                    state.posts,
    events:                   state.events,
    rent_buddy_profiles:      state.buddies,
    trips:                    [],
    trip_members:             [],
    profiles:                 [{ id: ALICE_ID, account_status: "active" }],
    blocks:                   [],
    follows:                  [],
    feature_flags:            [{ flag: "COMPASS_ENABLED", enabled: true }],
    compass_profiles:         [{
      user_id: ALICE_ID, current_city: CITY, persona_type: "explorer",
      travel_intensity: "moderate", active_trip_id: null, vibe_tags: [],
    }],
    compass_user_preferences: [],
    hashtag_usage:            [],
    hashtags:                 [],
    tags:                     [],
    user_location_state:      [{ user_id: ALICE_ID, city: CITY, country: "Philippines" }],
    trust_profiles:           [],
    user_preference_profiles: [],
    user_location_preferences: [],
    safe_return_sessions:     [],
    rent_buddy_bookings:      [],
    user_mutes:               [],
    discovery_places:         [],
    rank_events:              [],
    content_distribution_stats: [],
  };

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: (_c?: string) => builder(table, rows),
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      not: (col: string, op: string, val: any) => {
        if (op === "in" && Array.isArray(val)) filtered = filtered.filter((r) => !val.includes(r[col]));
        return b;
      },
      ilike: (col: string, pattern: string) => {
        const rx = new RegExp("^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
        filtered = filtered.filter((r) => typeof r[col] === "string" && rx.test(r[col]));
        return b;
      },
      like: (_c: string, _p: string) => b,
      lt: () => b, lte: () => b, gt: () => b, gte: () => b,
      contains: () => b, overlaps: () => b, or: () => b, order: () => b,
      limit: () => b, range: () => b,
      is: (col: string, val: any) => {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (res: any, rej?: any) =>
        Promise.resolve({ data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }

  const client: any = {
    auth: {
      getUser: (token?: string) =>
        token === "alice-token"
          ? Promise.resolve({ data: { user: { id: ALICE_ID } }, error: null })
          : Promise.resolve({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => {
      const b = builder(table, db[table] ?? []);
      b.insert = (data: any) => {
        const rows = Array.isArray(data) ? data : [data];
        inserts.push({ table, rows });
        for (const r of rows) (db[table] ??= []).push({ ...r });
        return Promise.resolve({ data: null, error: null });
      };
      b.update = (patch: any) => ({
        eq: (col: string, val: any) => {
          db[table] = (db[table] ?? []).map((r) => (r[col] === val ? { ...r, ...patch } : r));
          return Promise.resolve({ data: null, error: null });
        },
      });
      return b;
    },
    rpc: (name: string, params?: Record<string, any>) => {
      rpcCalls.push({ name, params: params ?? {} });
      return Promise.resolve({ data: null, error: null });
    },
  };

  return {
    client,
    /** Only genuine impression rows — analytics rows carry outcome='analytics'. */
    impressions: () => (db.rank_events ?? []).filter((r: any) => r.outcome === "impression"),
    incrementCalls: () => rpcCalls.filter((c) => c.name === INCREMENT_RPC),
  };
}

// ── Server harness ────────────────────────────────────────────────────────────

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      res({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => srv.close(() => r(undefined))),
      });
    });
  });
}

/**
 * The impression write is fire-and-forget AFTER res.json, so the response can
 * arrive before the rows do. Poll rather than guess a sleep length.
 */
async function waitForImpressions(f: ReturnType<typeof makeClient>, atLeast: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (f.impressions().length >= atLeast) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("GET /api/pulse — impressions describe the served page", () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = express();
    app.use(express.json());
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));
  });

  after(async () => { await close(); _setTestClient(null as any, false); });

  it("A/B/C. logs one impression per SERVED post — not one per ranked candidate", async () => {
    const posts   = [postRow(1), postRow(2), postRow(3)];
    const events  = [eventRow(1), eventRow(2)];
    const buddies = [buddyRow(1), buddyRow(2), buddyRow(3)];
    const f = makeClient({ posts, events, buddies });
    _setTestClient(f.client, true);

    const r = await fetch(`${url}/api/pulse`, { headers: { Authorization: "Bearer alice-token" } });
    assert.equal(r.status, 200);
    const body = (await r.json()) as any;

    const servedIds: string[] = (body.posts as any[]).map((p: any) => p.id as string);
    assert.equal(servedIds.length, 3, "precondition: three posts are served");

    // The candidate pool is strictly larger than the served page: 3 posts + 2
    // events + 3 buddies = 8 candidates were ranked, 3 posts were served. That
    // gap is the defect; without it the assertion below proves nothing.
    const candidateCount = posts.length + events.length + buddies.length;
    assert.ok(candidateCount > servedIds.length,
      "precondition: the ranked pool must be larger than the served page");

    await waitForImpressions(f, servedIds.length);
    const rows = f.impressions();

    assert.equal(
      rows.length, servedIds.length,
      `one impression per SERVED item — got ${rows.length} for a ${servedIds.length}-item ` +
      `page out of ${candidateCount} ranked candidates`,
    );
    assert.deepEqual(
      rows.map((x: any) => x.item_id), servedIds,
      "the impression rows are the served posts, in served order",
    );
    assert.deepEqual(
      rows.map((x: any) => x.position), servedIds.map((_, i) => i),
      "position is the index in the SERVED list",
    );

    // C. Nothing the response stripped may claim an impression.
    const strippedIds = new Set<string>([
      ...events.map((e) => e.id as string),
      ...buddies.map((b) => b.user_id as string),
    ]);
    for (const row of rows) {
      assert.ok(
        !strippedIds.has(row.item_id as string),
        `${row.item_id} was ranked but never served — it must not have an impression row`,
      );
    }

    // B. The exposure denominator follows the impression rows exactly.
    const increments = f.incrementCalls();
    assert.equal(
      increments.length, servedIds.length,
      "eligible_impressions must be incremented once per SERVED item, not once per candidate",
    );
    assert.deepEqual(
      increments.map((c) => c.params.p_item_id).sort(),
      [...servedIds].sort(),
      "…and for exactly the served items",
    );
  });
});

// ── D. The selector itself ────────────────────────────────────────────────────

describe("selectServedImpressions", () => {
  const scored = (id: string) => ({
    candidate: { id, kind: "post" as const },
    score: 1,
    features: { distance: 0.5 },
  }) as any;

  it("D1. returns the served ids in SERVED order, not ranked order", () => {
    const pool = [scored("a"), scored("b"), scored("c"), scored("d")];
    const out = selectServedImpressions(pool, ["c", "a"]);
    assert.deepEqual(out.map((s) => (s.candidate as any).id), ["c", "a"]);
  });

  it("D2. drops candidates that were ranked but not served", () => {
    const pool = [scored("a"), scored("b"), scored("c")];
    assert.equal(selectServedImpressions(pool, ["b"]).length, 1);
    assert.equal(selectServedImpressions(pool, []).length, 0);
  });

  it("D3. ignores served ids that were never ranked, and blank ids", () => {
    const pool = [scored("a")];
    const out = selectServedImpressions(pool, ["a", "never-ranked", ""]);
    assert.deepEqual(out.map((s) => (s.candidate as any).id), ["a"]);
  });

  it("D4. emits at most one row per item — a duplicate served id is one impression", () => {
    const pool = [scored("a"), scored("b")];
    const out = selectServedImpressions(pool, ["a", "a", "b"]);
    assert.deepEqual(out.map((s) => (s.candidate as any).id), ["a", "b"]);
  });
});
