/**
 * census-media §36 (MD262) — spec §34 "Show neighborhood only", and the owner's
 * location choice honoured on every Media read.
 *
 * WHAT IS PROVED HERE, AND THE LINE EACH CASE TURNS RED ON
 * ---------------------------------------------------------
 *   A. The policy. `neighborhood_only` caps a non-owner at §33 'neighborhood':
 *      no venue name, no canonical place id, the neighbourhood and city kept.
 *      (locationPrivacyModeToCeiling's `case "neighborhood_only"`.)
 *   B. mapPublicPost fails CLOSED on a mode it does not know, withholds the venue
 *      for neighborhood_only, and never serves the venue as the public label.
 *      (mapPublicPost's two-delayed-modes-only release; its rebuilt label.)
 *   C. "A non-owner sees no more than before" — exhaustively, over every mode,
 *      every post_status the create route writes, and every gem state: the new
 *      Watch-feed resolver discloses a SUBSET of what the old one did, and the
 *      new mapPublicPost a subset of the old one's. The old functions are
 *      restated below verbatim from e9e0b0404 as the reference.
 *   D. The Watch feed routes (GET /media/:id, GET /media/feed?mode=grid, and the
 *      Watch mode) now SELECT and honour location_privacy_mode. The fake client
 *      here serves only the columns a query names, so dropping the column from
 *      FEED_POST_COLUMNS / GRID_POST_COLUMNS turns these red, not just dropping
 *      the resolver call.
 *   E. A place page never lists a post whose place the choke point withheld;
 *      the owner still sees their own there. (keepDisclosedAtPlace.)
 *   F. The writes: POST /posts and PATCH /posts/:id/location-privacy REFUSE
 *      `neighborhood_only` and write nothing while the flag is off, and accept
 *      it when it is on. Every other mode is unaffected by the flag.
 *   G. Migration 3350 seeds the flag FALSE and adds only the label and the row.
 *
 * Run: node --import tsx/esm --test src/test/mediaNeighborhoodOnlyMode.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  POST_LOCATION_PRIVACY_MODES,
  locationPrivacyModeToCeiling,
  resolveMediaLocationWithGemProtection,
  resolveMediaPlaceDisclosure,
  type MediaLocationDisclosure,
} from "../lib/mediaLocationVisibility.js";
import { mapPublicPost, safeLocationLabel, locationPrivacyMode } from "../lib/postSchemas.js";
import {
  NEIGHBORHOOD_ONLY_MODE,
  NEIGHBORHOOD_ONLY_MODE_FLAG,
  neighborhoodOnlyModePermitted,
} from "../lib/media/neighborhoodOnlyMode.js";
import {
  resolveViewer,
  buildPlaceProjection,
  buildTimelineProjection,
  keepDisclosedAtPlace,
} from "../services/media/MediaProjectionService.js";
import type { MediaProjection } from "../lib/media/mediaProjection.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import postsRouter from "../routes/posts.js";
import { makeFakeClient, BEARER, type FakeState } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const VENUE = "An Thuong Bar";
const HOOD = "An Thuong";
const CITY = "Da Nang";
const COUNTRY = "Vietnam";
const INPUT = { name: VENUE, neighborhood: HOOD, city: CITY, country: COUNTRY, lat: 16.0544, lng: 108.2497 };

/** The post_status the create route writes for each mode (routes/posts.ts). */
function createdStatus(mode: string | null): string {
  if (mode === "delayed_until_exit") return "pending_location_exit";
  if (mode === "delayed_until_time") return "pending_delay";
  return "published";
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The policy
// ─────────────────────────────────────────────────────────────────────────────

describe("A. neighborhood_only caps a non-owner at §33 neighborhood", () => {
  it("is a mode the post write can parse, and one the tier table knows", () => {
    assert.ok(locationPrivacyMode.options.includes(NEIGHBORHOOD_ONLY_MODE));
    assert.ok((POST_LOCATION_PRIVACY_MODES as readonly string[]).includes(NEIGHBORHOOD_ONLY_MODE));
  });

  it("the ceiling is 'neighborhood' from creation — it is not a delayed mode", () => {
    for (const status of ["published", "pending_location_exit", null]) {
      assert.equal(locationPrivacyModeToCeiling("neighborhood_only", status), "neighborhood", String(status));
    }
  });

  it("a non-owner gets the neighbourhood and the city — never the venue, never the place id", () => {
    const d = resolveMediaPlaceDisclosure(INPUT, {
      locationVisibility: "place",
      locationPrivacyMode: "neighborhood_only",
      postStatus: "published",
      isOwner: false,
      gem: { ceiling: null, determined: true },
    });
    assert.equal(d.visibility, "neighborhood");
    assert.equal(d.name, null, "no venue");
    assert.equal(d.neighborhood, HOOD);
    assert.equal(d.city, CITY);
    assert.equal(d.country, COUNTRY);
    assert.equal(d.lat, null);
    assert.equal(d.mayDisclosePlaceId, false, "a canonical place id is place-level");
  });

  it("the stricter constraint still wins: a protected gem pulls it to city", () => {
    const d = resolveMediaPlaceDisclosure(INPUT, {
      locationVisibility: "place",
      locationPrivacyMode: "neighborhood_only",
      postStatus: "published",
      isOwner: false,
      gem: { ceiling: "city", determined: true },
    });
    assert.equal(d.visibility, "city");
    assert.equal(d.neighborhood, null);
  });

  it("the author still sees their own venue", () => {
    const d = resolveMediaPlaceDisclosure(INPUT, { locationPrivacyMode: "neighborhood_only", isOwner: true });
    assert.equal(d.name, VENUE);
    assert.equal(d.mayDisclosePlaceId, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. mapPublicPost / safeLocationLabel
// ─────────────────────────────────────────────────────────────────────────────

function postRow(mode: string | null, over: Record<string, any> = {}) {
  return {
    id: "p1",
    location_privacy_mode: mode,
    post_status: createdStatus(mode),
    location_name: VENUE,
    location_city: CITY,
    location_country: COUNTRY,
    public_location_label: VENUE,
    ...over,
  };
}

describe("B. mapPublicPost withholds the venue for neighborhood_only and for any mode it does not know", () => {
  it("neighborhood_only: no venue name, and the public label is the city — not the venue", () => {
    const out = mapPublicPost(postRow("neighborhood_only"));
    assert.equal(out.location_name, null);
    assert.equal(out.public_location_label, `${CITY}, ${COUNTRY}`);
    assert.equal(out.location_city, CITY);
  });

  it("an UNKNOWN mode on a published row withholds the venue (it used to serve it)", () => {
    const out = mapPublicPost(postRow("some_future_mode", { post_status: "published" }));
    assert.equal(out.location_name, null);
    assert.notEqual(out.public_location_label, VENUE);
  });

  it("trusted_circle_only: the stored label WAS the venue; it is no longer served as one", () => {
    // safeLocationLabel wrote the venue as the label of every trusted_circle_only
    // post, and mapPublicPost passed the label through untouched.
    const out = mapPublicPost(postRow("trusted_circle_only"));
    assert.equal(out.location_name, null);
    assert.equal(out.public_location_label, `${CITY}, ${COUNTRY}`);
  });

  it("hidden keeps no label; a released delayed post and 'none' are unchanged", () => {
    assert.equal(mapPublicPost(postRow("hidden", { public_location_label: null })).public_location_label, null);
    // census-media MD79 (lead ruling D-26f): a released "Publish after I leave" post is unchanged for the
    // 24 h after its release, and only then (the ended case is tested in mediaLocationDisclosureLifetime.test.ts).
    const releasedAt = Date.parse("2026-10-07T10:00:00Z");
    const released = postRow("delayed_until_exit", { post_status: "published", published_at: new Date(releasedAt).toISOString() });
    assert.deepEqual(mapPublicPost(released, releasedAt + 60_000), released);
    const open = postRow("none");
    assert.deepEqual(mapPublicPost(open), open);
  });

  it("does not ADD a public_location_label key to a row that had none", () => {
    const { public_location_label: _drop, ...noLabel } = postRow("city_only");
    assert.equal("public_location_label" in mapPublicPost(noLabel), false);
  });

  it("safeLocationLabel stores city/country for neighborhood_only and trusted_circle_only", () => {
    assert.equal(safeLocationLabel(VENUE, CITY, COUNTRY, "neighborhood_only" as any, "low"), `${CITY}, ${COUNTRY}`);
    assert.equal(safeLocationLabel(VENUE, CITY, COUNTRY, "trusted_circle_only", "low"), `${CITY}, ${COUNTRY}`);
    assert.equal(safeLocationLabel(VENUE, CITY, COUNTRY, "none", "low"), VENUE, "an open post still carries its venue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. A non-owner sees no more than before — exhaustive
// ─────────────────────────────────────────────────────────────────────────────

/** routes/mediaFeed.ts protectedMediaLocation as it stood at e9e0b0404: no owner mode. */
function watchBefore(mode: string | null, status: string | null, gem: { ceiling: any; determined: boolean }) {
  void mode; void status;
  return resolveMediaLocationWithGemProtection(INPUT, {
    locationVisibility: "place", isOwner: false, coarsenSeed: "p1", emitCoarseCoords: false, gem,
  });
}
/** The same function now. */
function watchAfter(mode: string | null, status: string | null, gem: { ceiling: any; determined: boolean }) {
  return resolveMediaPlaceDisclosure(INPUT, {
    locationVisibility: "place", locationPrivacyMode: mode, postStatus: status,
    isOwner: false, coarsenSeed: "p1", emitCoarseCoords: false, gem,
  });
}
/** lib/postSchemas.mapPublicPost as it stood at e9e0b0404, verbatim. */
function mapPublicPostBefore(row: any): any {
  const mode = row.location_privacy_mode as string | null | undefined;
  if (!mode || mode === "none") return row;
  if (mode === "city_only" || mode === "hidden" || mode === "trusted_circle_only") {
    return { ...row, location_name: null };
  }
  if (row.post_status === "published") return row;
  return { ...row, location_name: null };
}

const LOCATION_FIELDS: (keyof MediaLocationDisclosure)[] = ["name", "neighborhood", "city", "country", "lat", "lng"];
const MODES: (string | null)[] = [...POST_LOCATION_PRIVACY_MODES, null, "some_future_mode"];
const STATUSES = ["published", "pending_location_exit", "pending_delay", null];
const GEMS = [
  { ceiling: null, determined: true },
  { ceiling: "neighborhood", determined: true },
  { ceiling: "city", determined: true },
  { ceiling: null, determined: false },
];

describe("C. a non-owner sees no more than before — every mode × status × gem state", () => {
  it("the Watch-feed resolver: every field is what it was, or withheld", () => {
    let narrowed = 0;
    for (const mode of MODES) for (const status of STATUSES) for (const gem of GEMS) {
      const before = watchBefore(mode, status, gem);
      const after = watchAfter(mode, status, gem);
      for (const f of LOCATION_FIELDS) {
        const ok = after[f] === null || after[f] === before[f];
        assert.ok(ok, `mode=${mode} status=${status} gem=${JSON.stringify(gem)}: ${String(f)} widened (${before[f]} → ${after[f]})`);
      }
      if (before.name !== null && after.name === null) narrowed++;
    }
    assert.ok(narrowed > 0, "the change must actually narrow something — or it changed nothing at all");
  });

  it("…and it narrows exactly the modes that withhold the venue, where no gem already did", () => {
    const open = { ceiling: null, determined: true };
    for (const mode of ["city_only", "hidden", "trusted_circle_only", "neighborhood_only", "some_future_mode"]) {
      assert.equal(watchBefore(mode, "published", open).name, VENUE, `${mode}: the Watch feed used to serve the venue`);
      assert.equal(watchAfter(mode, "published", open).name, null, `${mode}: it no longer does`);
    }
    for (const mode of ["none", null]) {
      assert.equal(watchAfter(mode, "published", open).name, VENUE, `${String(mode)}: an open post keeps its venue`);
    }
    assert.equal(watchAfter("delayed_until_exit", "published", open).name, VENUE, "a released delayed post keeps its venue");
  });

  it("mapPublicPost: location_name and public_location_label are what they were, or withheld/coarser", () => {
    for (const mode of MODES) for (const status of STATUSES) {
      const row = postRow(mode, { post_status: status });
      const before = mapPublicPostBefore({ ...row });
      const after = mapPublicPost({ ...row });
      assert.ok(after.location_name === null || after.location_name === before.location_name, `${mode}/${status}: name`);
      assert.ok(
        after.public_location_label === before.public_location_label ||
          after.public_location_label === null ||
          after.public_location_label === `${CITY}, ${COUNTRY}`,
        `${mode}/${status}: label may only stay, vanish, or fall to the city`,
      );
      if (after.location_name === null) {
        assert.notEqual(after.public_location_label, VENUE, `${mode}/${status}: a withheld venue must not ride the label`);
      }
      assert.equal(after.location_city, before.location_city);
      assert.equal(after.location_country, before.location_country);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The Watch feed routes select and honour the mode
// ─────────────────────────────────────────────────────────────────────────────

/** Split a PostgREST select list on top-level commas. */
function topLevel(select: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Serve ONLY the columns the select names — the property that makes D prove the SELECT. */
function projectColumns(row: any, select: string | null): any {
  if (!select || select.trim() === "*") return row;
  const out: any = {};
  for (const tok of topLevel(select)) {
    const key = /^([A-Za-z_][\w]*)/.exec(tok)?.[1];
    if (key && key in row) out[key] = row[key];
  }
  return out;
}

const VIEWER = "aaaaaaaa-0000-4000-a000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-a000-000000000002";
const POST_ID = "11111111-0000-4000-a000-000000000001";
const PLACE = "cccccccc-0000-4000-a000-000000000003";
const TOKEN = "nbhd-token";

function feedPost(mode: string | null, over: Record<string, any> = {}) {
  return {
    id: POST_ID, author_id: AUTHOR, trip_id: null, content: "", visibility: "public",
    status: "active", post_status: createdStatus(mode), moderation_status: "approved",
    created_at: new Date(Date.now() - 60_000).toISOString(), category: "nightlife",
    location_name: VENUE, location_city: CITY, location_country: COUNTRY,
    location_source: "gps", location_verified: true, location_privacy_mode: mode,
    location_lat: 16.0544, location_lng: 108.2497, canonical_place_id: PLACE, post_buckets: [],
    save_count: 0, like_count: 0, comment_count: 0, tags: [], publish_at: null,
    has_video: false, primary_media_type: "image", media_urls: [],
    post_media: [{
      id: "m1", media_type: "image", public_url: "https://example.com/a.jpg", thumbnail_url: null,
      thumbnail_storage_path: null, duration_seconds: null, width: 800, height: 600, sort_order: 0,
      processing_status: "ready", moderation_status: "approved", storage_path: null, storage_bucket: null,
    }],
    profiles: { id: AUTHOR, username: "maya", full_name: "Maya", avatar_url: null, show_profile_picture_publicly: true, is_private: false, verified: false, bio: null, account_status: "active", is_official: false },
    ...over,
  };
}

function feedClient(posts: any[], flags: string[]) {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let select: string | null = null;
    let limitVal = 1000;
    const source = () =>
      table === "posts" ? posts
        : table === "feature_flags" ? flags.map((flag) => ({ flag, enabled: true }))
        : [];
    const rows = () =>
      source()
        .filter((r: any) => filters.every((f) => f(r)))
        .slice(0, limitVal)
        .map((r: any) => (table === "posts" ? projectColumns(r, select) : r));
    const b: any = {
      select(s?: string) { select = s ?? null; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      not() { return b; }, is() { return b; }, or() { return b; }, filter() { return b; },
      gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
      contains() { return b; }, overlaps() { return b; }, match() { return b; },
      order() { return b; }, range() { return b; },
      limit(n: number) { limitVal = n; return b; },
      insert() { return Promise.resolve({ data: null, error: null }); },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      update() { return b; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
    };
    return b;
  }
  return {
    from: builder,
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: async (t: string) =>
        t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } },
    },
  } as any;
}

async function serve(router: any): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function getJson(base: string, path: string) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, connection: "close" } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

afterEach(() => { _clearTestClient(); });

describe("D. the Watch feed routes read the owner's mode and honour it", () => {
  const WITHHOLDING = ["city_only", "hidden", "trusted_circle_only", "neighborhood_only"];

  it("GET /media/:id — a withholding mode serves the city, never the venue", async () => {
    const s = await serve(mediaFeedRouter);
    try {
      for (const mode of WITHHOLDING) {
        _setTestClient(feedClient([feedPost(mode)], []), true);
        const { status, body } = await getJson(s.base, `/media/${POST_ID}`);
        assert.equal(status, 200, mode);
        assert.equal(body.item.location?.name ?? null, null, `${mode}: venue withheld`);
        assert.equal(body.item.location?.city, CITY, `${mode}: city kept`);
        assert.equal(JSON.stringify(body).includes(VENUE), false, `${mode}: the venue appears nowhere`);
      }
      _setTestClient(feedClient([feedPost("none")], []), true);
      const open = await getJson(s.base, `/media/${POST_ID}`);
      assert.equal(open.body.item.location?.name, VENUE, "an open post keeps its venue");
    } finally { s.close(); }
  });

  it("GET /media/:id — the author still sees their own venue", async () => {
    const s = await serve(mediaFeedRouter);
    try {
      _setTestClient(feedClient([feedPost("neighborhood_only", { author_id: VIEWER, profiles: { ...feedPost(null).profiles, id: VIEWER } })], []), true);
      const { body } = await getJson(s.base, `/media/${POST_ID}`);
      assert.equal(body.item.location?.name, VENUE);
    } finally { s.close(); }
  });

  it("GET /media/feed?mode=grid — the grid label is the city for a withholding mode", async () => {
    const s = await serve(mediaFeedRouter);
    try {
      for (const mode of WITHHOLDING) {
        _setTestClient(feedClient([feedPost(mode)], ["MEDIA_VIEW_MODE_GRID_ENABLED"]), true);
        const { status, body } = await getJson(s.base, `/media/feed?mode=grid`);
        assert.equal(status, 200, mode);
        assert.equal(body.items.length, 1, `${mode}: the item is still served`);
        assert.equal(JSON.stringify(body).includes(VENUE), false, `${mode}: no venue in the grid`);
      }
    } finally { s.close(); }
  });

  it("GET /media/feed?mode=fullscreen (Watch) — the venue is withheld for a withholding mode", async () => {
    const s = await serve(mediaFeedRouter);
    try {
      for (const mode of WITHHOLDING) {
        // The Watch feed is video-only (`.eq("has_video", true)`).
        const still = feedPost(mode).post_media[0]!;
        const video = feedPost(mode, {
          has_video: true, primary_media_type: "video",
          post_media: [{ ...still, media_type: "video", public_url: "https://example.com/a.mp4", duration_seconds: 8 }],
        });
        _setTestClient(feedClient([video], ["MEDIA_FOR_YOU_ENABLED"]), true);
        const { status, body } = await getJson(s.base, `/media/feed?mode=fullscreen`);
        assert.equal(status, 200, mode);
        assert.ok(body.items.length >= 1, `${mode}: the item is still served`);
        assert.equal(JSON.stringify(body).includes(VENUE), false, `${mode}: no venue in the Watch feed`);
      }
    } finally { s.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Place-scoped reads
// ─────────────────────────────────────────────────────────────────────────────

type Dataset = Record<string, any[]>;
function projectionClient(data: Dataset) {
  const builder = (table: string): any => {
    const filters: any[] = [];
    const rows = () => {
      let r = (data[table] ?? []).map((x) => ({ ...x }));
      for (const f of filters) {
        if (f.op === "eq") r = r.filter((x) => String(x[f.col]) === String(f.val));
        else if (f.op === "in") r = r.filter((x) => (f.val as any[]).map(String).includes(String(x[f.col])));
      }
      return r;
    };
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      neq() { return b; }, ilike() { return b; }, gt() { return b; }, gte() { return b; }, lt() { return b; },
      not() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; }, range() { return b; },
      is() { return b; },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      insert() { return Promise.resolve({ data: null, error: null }); },
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
    };
    return b;
  };
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

function projectionData(posts: any[]): Dataset {
  return {
    posts,
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    places: [{ id: PLACE, name: VENUE, city: CITY, country_code: "VN", neighborhood: HOOD }],
    blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], hidden_gems: [],
    feature_flags: [], intel_state_snapshots: [], intel_live_promoted_scopes: [], post_hides: [],
  };
}

function placePost(id: string, mode: string, author = AUTHOR) {
  return {
    ...feedPost(mode, { id, author_id: author }),
    profiles: { id: author, username: "u", full_name: "U", name: "U", display_name: "U", avatar_url: null, verified: false, is_official: false, account_status: "active", is_private: false },
  };
}

describe("E. a place page lists only what may be SAID to be at that place", () => {
  it("keepDisclosedAtPlace narrows to items carrying this place id, and is a no-op off a place", () => {
    const at = { id: "a", placeId: PLACE } as MediaProjection;
    const withheld = { id: "b", placeId: null } as MediaProjection;
    assert.deepEqual(keepDisclosedAtPlace([at, withheld], PLACE).map((m) => m.id), ["a"]);
    assert.deepEqual(keepDisclosedAtPlace([at, withheld], null).map((m) => m.id), ["a", "b"]);
  });

  it("GET /media/places/:placeId — an open post is listed; a neighborhood_only or city_only one is not", async () => {
    const posts = [
      placePost("10000000-0000-4000-a000-000000000001", "none"),
      placePost("10000000-0000-4000-a000-000000000002", "neighborhood_only"),
      placePost("10000000-0000-4000-a000-000000000003", "city_only"),
    ];
    const sc = projectionClient(projectionData(posts));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, Date.now());
    const ids = p.perspectives.groups.flatMap((g) => g.media).map((m) => m.id).sort();
    assert.deepEqual(ids, ["10000000-0000-4000-a000-000000000001"]);
    assert.equal(p.perspectives.totalPerspectives, 1, "the count is taken from what is listed");
  });

  it("GET /media/timeline?placeId — the same rule", async () => {
    const posts = [
      placePost("10000000-0000-4000-a000-000000000001", "none"),
      placePost("10000000-0000-4000-a000-000000000002", "neighborhood_only"),
    ];
    const sc = projectionClient(projectionData(posts));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const t = await buildTimelineProjection(sc, viewer, { placeId: PLACE, nowMs: Date.now() });
    assert.equal(t.totalPerspectives, 1);
  });

  it("the AUTHOR's own neighborhood_only post is still on the place page for them", async () => {
    const posts = [placePost("10000000-0000-4000-a000-000000000002", "neighborhood_only", VIEWER)];
    const sc = projectionClient(projectionData(posts));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, Date.now());
    assert.equal(p.perspectives.totalPerspectives, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. The writes are gated
// ─────────────────────────────────────────────────────────────────────────────

function writeState(): FakeState {
  return {
    users: { "author-tok": { id: "author-1" } },
    trips: new Set(),
    members: [],
    posts: [{
      id: "20000000-0000-4000-a000-000000000001", author_id: "author-1", status: "active",
      post_status: "pending_location_exit", location_privacy_mode: "delayed_until_exit",
    }],
  };
}

/** helpers.makeFakeClient, plus a feature_flags table (it has none). */
function writeClient(state: FakeState, flagOn: boolean) {
  const base = makeFakeClient(state);
  const from = base.from;
  base.from = (table: string) => {
    if (table !== "feature_flags") return from(table);
    const rows = flagOn ? [{ flag: NEIGHBORHOOD_ONLY_MODE_FLAG, enabled: true }] : [];
    const filters: Array<(r: any) => boolean> = [];
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      maybeSingle() { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(onF, onR); },
    };
    return b;
  };
  return base;
}

async function servePosts(client: any) {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { error() {}, info() {}, warn() {} }; next(); });
  app.use("/api", postsRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function send(base: string, method: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: BEARER("author-tok"), connection: "close" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const CREATE = {
  content: "sunset", visibility: "public", locationName: VENUE, locationCity: CITY, locationCountry: COUNTRY,
  locationLat: 16.0544, locationLng: 108.2497, locationSource: "manual",
};

describe("F. choosing neighborhood_only is gated by media_neighborhood_only_mode_enabled", () => {
  it("the gate answers true for every other mode without reading a flag", async () => {
    let reads = 0;
    const sc = { from() { reads++; throw new Error("must not read"); } };
    for (const m of ["none", "hidden", "city_only", "delayed_until_exit", "delayed_until_time", "trusted_circle_only", undefined, null]) {
      assert.equal(await neighborhoodOnlyModePermitted(sc, m), true, String(m));
    }
    assert.equal(reads, 0);
    assert.equal(await neighborhoodOnlyModePermitted(null, NEIGHBORHOOD_ONLY_MODE), false, "no client ⇒ refused");
    assert.equal(await neighborhoodOnlyModePermitted(sc, NEIGHBORHOOD_ONLY_MODE), false, "a throwing flag read ⇒ refused");
  });

  it("POST /posts — flag OFF: refused (feature_disabled) and NOTHING is inserted", async () => {
    const client = writeClient(writeState(), false);
    const s = await servePosts(client);
    try {
      const r = await send(s.base, "POST", "/api/posts", { ...CREATE, locationPrivacyMode: "neighborhood_only" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(client.__inserted.filter((i: any) => i.table === "posts").length, 0);
    } finally { s.close(); }
  });

  it("POST /posts — flag OFF: every other mode is written exactly as before", async () => {
    const client = writeClient(writeState(), false);
    const s = await servePosts(client);
    try {
      const r = await send(s.base, "POST", "/api/posts", { ...CREATE, locationPrivacyMode: "city_only" });
      assert.equal(r.status, 201);
      const row = client.__inserted.find((i: any) => i.table === "posts").row;
      assert.equal(row.location_privacy_mode, "city_only");
    } finally { s.close(); }
  });

  it("POST /posts — flag ON: written as neighborhood_only, published now, with a city label", async () => {
    const client = writeClient(writeState(), true);
    const s = await servePosts(client);
    try {
      const r = await send(s.base, "POST", "/api/posts", { ...CREATE, locationPrivacyMode: "neighborhood_only" });
      assert.equal(r.status, 201);
      const row = client.__inserted.find((i: any) => i.table === "posts").row;
      assert.equal(row.location_privacy_mode, "neighborhood_only");
      assert.equal(row.post_status, "published", "not a delayed mode");
      assert.equal(row.public_location_label, `${CITY}, ${COUNTRY}`, "the stored public label is never the venue");
    } finally { s.close(); }
  });

  it("PATCH /posts/:id/location-privacy — refused while OFF, applied (and published) while ON", async () => {
    const off = writeClient(writeState(), false);
    let s = await servePosts(off);
    try {
      const r = await send(s.base, "PATCH", "/api/posts/20000000-0000-4000-a000-000000000001/location-privacy", { locationPrivacyMode: "neighborhood_only" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
    } finally { s.close(); }
    const on = writeClient(writeState(), true);
    s = await servePosts(on);
    try {
      const r = await send(s.base, "PATCH", "/api/posts/20000000-0000-4000-a000-000000000001/location-privacy", { locationPrivacyMode: "neighborhood_only" });
      assert.equal(r.status, 200);
      assert.equal(r.body.post?.location_privacy_mode ?? r.body.location_privacy_mode, "neighborhood_only");
      assert.equal(r.body.post?.post_status ?? r.body.post_status, "published");
    } finally { s.close(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Migration 3350
// ─────────────────────────────────────────────────────────────────────────────

describe("G. migration 3350 and its rollback", () => {
  const sql = readFileSync(join(HERE, "..", "migrations", "3350_media_neighborhood_only_location_mode.sql"), "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("seeds the flag FALSE and refuses a seed that finds it ON", () => {
    assert.match(code, /'media_neighborhood_only_mode_enabled',\s*false,/);
    assert.match(code, /enabled = TRUE;\s*IF on_count <> 0 THEN\s*RAISE EXCEPTION/);
  });

  it("adds exactly one enum label and touches no other object — no UPDATE of posts", () => {
    assert.match(code, /ALTER TYPE public\.post_location_privacy_mode ADD VALUE IF NOT EXISTS 'neighborhood_only';/);
    assert.equal((code.match(/ALTER\s+TYPE/gi) ?? []).length, 1);
    assert.ok(!/\b(CREATE|DROP)\s+(TABLE|TYPE|INDEX|POLICY|FUNCTION)\b/i.test(code));
    assert.ok(!/UPDATE\s+public\.posts/i.test(code), "3350 must not rewrite anyone's choice");
  });

  it("the rollback refuses while the flag is on or any post carries the value", () => {
    const rb = readFileSync(
      join(HERE, "..", "..", "..", "..", "db", "rollback", "2026-09-27-3350-media-neighborhood-only-location-mode-rollback.sql"),
      "utf8",
    );
    const rbCode = rb.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.match(rbCode, /ROLLBACK REFUSED: media_neighborhood_only_mode_enabled is TRUE/);
    assert.match(rbCode, /location_privacy_mode = 'neighborhood_only';\s*IF using_value <> 0 THEN\s*RAISE EXCEPTION/);
    assert.ok(!/UPDATE\s+public\.posts/i.test(rbCode), "the rollback does not rewrite users' choices itself");
  });
});

