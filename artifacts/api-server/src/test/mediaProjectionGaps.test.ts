/**
 * mediaProjectionGaps — three §5 rows this census recorded as BUILT-AND-CORRECT
 * that were, when executed, a declared field with no producer.
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * `docs/architecture/census-media.md` §9/§10 re-read six of its own 288 C rows
 * and found four wrong, and closed with the observation that "nobody has checked
 * the other 282". §11 checked more of them. Three of the defects it found share
 * one shape — a field or an event name that is DECLARED in a type, accepted by a
 * server allow-list, and produced by nothing anywhere in the tree:
 *
 *   MD47  §7 "MediaAsset → Neighborhood".
 *         `MediaProjection.neighborhood` existed from the first commit of the
 *         World shell and was `null` on every projection ever served.
 *         `toMediaProjection` hard-codes it (correct — `posts` has no such
 *         column), and `applyLocationDisclosure` copies it off a disclosure
 *         whose input never carried one, because `disclosureForRow` passed
 *         `{ name, city, country, lat, lng }` and no neighborhood. The TIER
 *         logic was complete the whole time: `coarsenMediaLocation` discloses a
 *         neighborhood at the 'neighborhood' and 'place' tiers and withholds it
 *         at 'city' / 'country' / 'hidden'. Only the producer was missing.
 *
 *   MD227 §30 "My World filters: All · Posts · Postcards · Memories · Trips ·
 *         Tagged · Hidden Gems".
 *         Six of the seven buckets read real rows. `tagged` was the literal
 *         `{ count: 0, media: [] }` under the comment "Tagged has no backing
 *         people-tag table yet (pre-launch)". `public.tags` is created by
 *         migration 0044, is in the production baseline, and is written on the
 *         post-create path (`routes/posts.ts` → `processTagging({ sourceType:
 *         'post' })`). The bucket reported zero over a populated table — an
 *         absence asserted without opening the writer, which is the same defect
 *         class §10.1 records against itself.
 *
 *   MD386 §44 "Stamp" / MD389 §44 "Save".
 *         Both event names are in `MediaEventType` and in the
 *         `routes/mediaAnalyticsBatch` allow-list, and NOTHING emitted either.
 *         The client's only consumer of `useMediaAnalytics` is
 *         `MediaActionRail`, whose recorder fires only the eight §45 north-star
 *         names; server-side `recordMediaEvent` was called for `impression`,
 *         `qualified_view`, `completion`, `rewatch` and `share` and for nothing
 *         else. The §44 Stamp and Save funnels read zero by construction —
 *         exactly the shape §9.1 found for `hideRate` / `notInterestedCount`.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY. Each `it` fails if the producer goes
 * away again, which is the only regression that matters here: all three defects
 * were invisible precisely because a missing producer leaves every existing
 * assertion green. The neighborhood cases assert BOTH directions — the label
 * arrives at a fine tier AND is withheld at a coarse one — so a "fix" that
 * bypassed the choke point would go red too.
 *
 * MUTATIONS SEEN RED (recorded in docs/architecture/census-media.md §11):
 *   M9  drop the `neighborhood` argument from disclosureForRow's call
 *   M10 make loadPlaceNeighborhoods return an empty map
 *   M11 disclose the neighborhood at every tier (bypass the choke point)
 *   M12 restore the hard-coded `{ key: "tagged", count: 0, media: [] }`
 *   M13 let loadTaggedPostIds admit `status: 'pending'` tags
 *   M14 delete the `like` recordMediaEvent call
 *   M15 delete the `save` recordMediaEvent call
 *
 * Run: node --import tsx/esm --test src/test/mediaProjectionGaps.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import {
  resolveViewer,
  buildPlaceProjection,
  buildMyWorldProjection,
  loadPlaceNeighborhoods,
  loadTaggedPostIds,
  neighborhoodForRow,
} from "../services/media/MediaProjectionService.js";
import type { MediaCandidateRow } from "../lib/media/mediaProjection.js";

const VIEWER = "11111111-0000-4000-a000-00000000000e";
const AUTHOR = "22222222-0000-4000-a000-00000000000f";
const PLACE_1 = "aaaaaaaa-0000-4000-a000-0000000000a1";
const PLACE_2 = "aaaaaaaa-0000-4000-a000-0000000000a2";
const POST_1 = "33333333-0000-4000-a000-000000000031";
const TAGGED_POST = "44444444-0000-4000-a000-000000000041";
const GEM_ID = "55555555-0000-4000-a000-000000000051";
const TOKEN = "test-media-projection-gaps-token";

// ── A filtering fake Supabase client ─────────────────────────────────────────
//
// Modelled on src/test/mediaWorldProjection.test.ts's fake (same operators) plus
// the insert capture src/test/mediaReportIntent.test.ts uses, because the §44
// half of this suite asserts on WRITES and the §7/§30 half asserts on READS.

type Dataset = Record<string, any[]>;

function makeSc(data: Dataset) {
  const inserted: Array<{ table: string; row: any }> = [];
  const upserted: Array<{ table: string; row: any; opts?: any }> = [];

  const resolveRows = (table: string, filters: any[]): any[] => {
    let rows = (data[table] ?? []).map((r) => ({ ...r }));
    for (const f of filters) {
      if (f.op === "eq") rows = rows.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "in")
        rows = rows.filter((r) => (f.val as any[]).map(String).includes(String(r[f.col])));
      else if (f.op === "ilike") {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[f.col] ?? "").toLowerCase().includes(needle));
      } else if (f.op === "gt") rows = rows.filter((r) => r[f.col] != null && r[f.col] > f.val);
    }
    return rows;
  };

  const builder = (table: string): any => {
    const filters: any[] = [];
    const b: any = {
      select() { return b; },
      insert(row: any) { inserted.push({ table, row }); return b; },
      upsert(row: any, opts?: any) { upserted.push({ table, row, opts }); return b; },
      update() { return b; },
      delete() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      neq() { return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      gt(col: string, val: any) { filters.push({ op: "gt", col, val }); return b; },
      is() { return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() {
        const r = resolveRows(table, filters)[0];
        return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: "No rows" } });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR);
      },
    };
    return b;
  };

  return {
    from(table: string) { return builder(table); },
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    _inserted: inserted,
    _upserted: upserted,
  } as any;
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

interface PostOpts {
  id?: string;
  author_id?: string;
  placeId?: string | null;
  visibility?: string;
}

function makePost(o: PostOpts = {}): any {
  const id = o.id ?? POST_1;
  const author = o.author_id ?? AUTHOR;
  return {
    id,
    author_id: author,
    trip_id: null,
    content: "",
    visibility: o.visibility ?? "public",
    status: "active",
    post_status: "published",
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    created_at: isoAgo(10 * 60 * 1000),
    category: "nightlife",
    media_urls: [],
    location_name: "An Thuong Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    location_privacy_mode: null,
    canonical_place_id: o.placeId === undefined ? PLACE_1 : o.placeId,
    post_media: [
      {
        id: `${id}-m1`,
        media_type: "image",
        public_url: `https://cdn.example/${id}.jpg`,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: null,
      },
    ],
    profiles: {
      id: author,
      username: "maya",
      full_name: "Maya",
      name: "Maya",
      display_name: "Maya",
      avatar_url: null,
      verified: true,
      is_official: false,
      account_status: "active",
      is_private: false,
    },
  };
}

function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [],
    user_mutes: [],
    user_follows: [],
    trip_members: [],
    trips: [],
    post_hides: [],
    tags: [],
    places: [],
    feature_flags: [],
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. MD47 — §7 MediaAsset → Neighborhood
// ─────────────────────────────────────────────────────────────────────────────

describe("MD47 — the neighborhood label has a producer", () => {
  it("loadPlaceNeighborhoods reads places.neighborhood for the page's place ids", async () => {
    const sc = makeSc(baseData({
      places: [
        { id: PLACE_1, neighborhood: "An Thuong" },
        { id: PLACE_2, neighborhood: "Son Tra" },
      ],
    }));
    const map = await loadPlaceNeighborhoods(sc, [
      makePost({ id: POST_1, placeId: PLACE_1 }) as MediaCandidateRow,
    ]);
    assert.equal(map.get(PLACE_1), "An Thuong");
  });

  it("treats a blank neighborhood as absent rather than as an empty label", async () => {
    const sc = makeSc(baseData({ places: [{ id: PLACE_1, neighborhood: "   " }] }));
    const map = await loadPlaceNeighborhoods(sc, [makePost() as MediaCandidateRow]);
    assert.equal(map.get(PLACE_1), undefined);
    assert.equal(neighborhoodForRow(makePost() as MediaCandidateRow, map), null);
  });

  it("asks for nothing when no row on the page has a canonical place", async () => {
    const sc = makeSc(baseData({ places: [{ id: PLACE_1, neighborhood: "An Thuong" }] }));
    const map = await loadPlaceNeighborhoods(sc, [
      makePost({ placeId: null }) as MediaCandidateRow,
    ]);
    assert.equal(map.size, 0);
  });

  it("a served projection CARRIES the neighborhood at place tier", async () => {
    // The regression this catches: before 2026-09-13 this assertion was
    // impossible to satisfy — `neighborhood` was null on every projection the
    // World shell has ever produced.
    const sc = makeSc(baseData({
      posts: [makePost()],
      places: [{ id: PLACE_1, neighborhood: "An Thuong" }],
    }));
    const viewer = await resolveViewer(sc, VIEWER, {});
    const place = await buildPlaceProjection(sc, viewer, PLACE_1, Date.now());
    const items = place.perspectives.groups.flatMap((g) => g.media);
    assert.ok(items.length > 0, "fixture must produce at least one projected item");
    assert.equal(items[0].neighborhood, "An Thuong");
  });

  it("WITHHOLDS the neighborhood when a Hidden Gem ceiling coarsens the item to city", async () => {
    // The label goes through the choke point, not around it: a restrictive gem
    // at the same canonical place drops the tier to 'city', and
    // coarsenMediaLocation nulls the neighborhood there. A producer that wrote
    // the label straight onto the projection would leak it here.
    const sc = makeSc(baseData({
      posts: [makePost()],
      places: [{ id: PLACE_1, neighborhood: "An Thuong" }],
      hidden_gems: [
        {
          id: GEM_ID,
          canonical_place_id: PLACE_1,
          sensitivity_level: "protected",
          latitude: null,
          longitude: null,
          approx_latitude: null,
          approx_longitude: null,
          status: "active",
        },
      ],
    }));
    const viewer = await resolveViewer(sc, VIEWER, {});
    const place = await buildPlaceProjection(sc, viewer, PLACE_1, Date.now());
    const items = place.perspectives.groups.flatMap((g) => g.media);
    assert.ok(items.length > 0, "fixture must produce at least one projected item");
    assert.equal(items[0].neighborhood, null, "a gem-ceilinged item must not name its neighborhood");
    assert.equal(items[0].placeLabel, null, "…and must not name its venue either");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. MD227 — §30 the Tagged bucket
// ─────────────────────────────────────────────────────────────────────────────

describe("MD227 — My World's Tagged bucket reads public.tags", () => {
  it("loadTaggedPostIds returns the viewer's approved post tags", async () => {
    const sc = makeSc(baseData({
      tags: [
        { source_type: "post", source_id: TAGGED_POST, tagged_user_id: VIEWER, status: "approved", tagged_at: isoAgo(1000) },
      ],
    }));
    assert.deepEqual(await loadTaggedPostIds(sc, VIEWER), [TAGGED_POST]);
  });

  it("ignores a PENDING tag — a tag awaiting approval is not yet the viewer's", async () => {
    const sc = makeSc(baseData({
      tags: [
        { source_type: "post", source_id: TAGGED_POST, tagged_user_id: VIEWER, status: "pending", tagged_at: isoAgo(1000) },
      ],
    }));
    assert.deepEqual(await loadTaggedPostIds(sc, VIEWER), []);
  });

  it("ignores a tag on a COMMENT — §30's Tagged bucket is media, not mentions", async () => {
    const sc = makeSc(baseData({
      tags: [
        { source_type: "comment", source_id: TAGGED_POST, tagged_user_id: VIEWER, status: "approved", tagged_at: isoAgo(1000) },
      ],
    }));
    assert.deepEqual(await loadTaggedPostIds(sc, VIEWER), []);
  });

  it("ignores someone ELSE's tag", async () => {
    const sc = makeSc(baseData({
      tags: [
        { source_type: "post", source_id: TAGGED_POST, tagged_user_id: AUTHOR, status: "approved", tagged_at: isoAgo(1000) },
      ],
    }));
    assert.deepEqual(await loadTaggedPostIds(sc, VIEWER), []);
  });

  it("the Tagged bucket carries the tagged media, not a hard-coded zero", async () => {
    const sc = makeSc(baseData({
      posts: [makePost({ id: TAGGED_POST, author_id: AUTHOR })],
      places: [{ id: PLACE_1, neighborhood: "An Thuong" }],
      tags: [
        { source_type: "post", source_id: TAGGED_POST, tagged_user_id: VIEWER, status: "approved", tagged_at: isoAgo(1000) },
      ],
    }));
    const viewer = await resolveViewer(sc, VIEWER, {});
    const mine = await buildMyWorldProjection(sc, viewer, Date.now());
    const tagged = mine.buckets.find((b) => b.key === "tagged");
    assert.ok(tagged, "the Tagged bucket must exist");
    assert.equal(tagged!.count, 1);
    assert.equal(tagged!.media.length, 1);
    assert.equal(tagged!.media[0].id, TAGGED_POST);
  });

  it("stays empty when nothing tagged the viewer — an empty bucket is still well-formed", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ author_id: AUTHOR })] }));
    const viewer = await resolveViewer(sc, VIEWER, {});
    const mine = await buildMyWorldProjection(sc, viewer, Date.now());
    const tagged = mine.buckets.find((b) => b.key === "tagged");
    assert.ok(tagged);
    assert.equal(tagged!.count, 0);
    assert.deepEqual(tagged!.media, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. MD386 / MD389 — §44 Stamp and Save actually emit
// ─────────────────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };
    next();
  });
  app.use(mediaFeedRouter);
  return app;
}

async function callRoute(client: any, path: string, body: any): Promise<{ status: number; body: any }> {
  _setTestClient(client, true);
  const app = makeApp();
  const server = await new Promise<http.Server>((resolve) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as { port: number };
  try {
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body ?? {}),
    });
    let parsed: any = null;
    try { parsed = await resp.json(); } catch { parsed = null; }
    return { status: resp.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * `recordMediaEvent` is deliberately fire-and-forget (`void (async () => …)()`),
 * so the insert lands after the response. Drain the microtask queue rather than
 * sleeping on a wall clock: the fake client resolves synchronously, so a bounded
 * number of turns is enough and the test stays deterministic.
 */
async function drain(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

const ANALYTICS_ON = [{ flag: "MEDIA_ANALYTICS_ENABLED", enabled: true }];

describe("MD386 / MD389 — the §44 Stamp and Save signals have a producer", () => {
  let sc: any;
  beforeEach(() => {
    sc = makeSc(baseData({
      posts: [makePost({ id: POST_1, author_id: AUTHOR })],
      hidden_gems: [],
      post_saves: [],
      media_events: [],
      feature_flags: ANALYTICS_ON,
    }));
  });

  it("POST /media/:id/like records a `like` media event", async () => {
    const res = await callRoute(sc, `/media/${POST_1}/like`, {});
    assert.equal(res.status, 200);
    await drain();
    const events = sc._inserted.filter((r: any) => r.table === "media_events");
    assert.equal(events.length, 1, "exactly one media_events row");
    assert.equal(events[0].row.event_type, "like");
  });

  it("POST /media/:id/save records a `save` media event", async () => {
    const res = await callRoute(sc, `/media/${POST_1}/save`, {});
    assert.equal(res.status, 200);
    await drain();
    const events = sc._inserted.filter((r: any) => r.table === "media_events");
    assert.equal(events.length, 1, "exactly one media_events row");
    assert.equal(events[0].row.event_type, "save");
  });

  it("emits nothing when MEDIA_ANALYTICS_ENABLED is off — the flag still binds", async () => {
    const dark = makeSc(baseData({
      posts: [makePost({ id: POST_1, author_id: AUTHOR })],
      hidden_gems: [],
      post_saves: [],
      media_events: [],
      feature_flags: [],
    }));
    const res = await callRoute(dark, `/media/${POST_1}/save`, {});
    assert.equal(res.status, 200);
    await drain();
    assert.equal(dark._inserted.filter((r: any) => r.table === "media_events").length, 0);
  });
});
