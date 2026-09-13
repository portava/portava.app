/**
 * mediaIndependentSources — census-media MD147 (§18 "Independent Sources stage").
 *
 * The row read **W** on: *"The count is displayed nowhere and computed nowhere
 * in the media path: `MediaPerspectiveService` counts `contributorCount`, which
 * is distinct contributors, not independent sources. The independence machinery
 * exists (`lib/intelIndependence.ts` …) but nothing in Media calls it."*
 *
 * Both halves were true. `PerspectiveSummary.independentSourceCount` existed and
 * its whole implementation was `independentSourceCount: contributors.size` —
 * the same number under a second name, so three accounts posting ONE photo read
 * as three independent sources, which is the exact consensus inflation §11
 * anti-manipulation exists to refuse.
 *
 * WHICH DETECTORS MEDIA CAN FEED, and why the other is not "unbuilt".
 * `clusterByIndependence` merges on three signals. Media carries two of them and
 * the third does not exist for a photograph:
 *
 *   1. SHARED EVIDENCE MEDIA — fed. The served media URL IS the asset key: two
 *      posts resolving to one stored file are one source. (census-media §11.6
 *      asserted Media has "no asset hash"; the URL is the key the module's own
 *      contract names, and this file executes that.)
 *   2. ACTOR RELATIONSHIP — fed, through a SIDE CHANNEL. `posts.trip_id` is the
 *      party token. It is handed to the summary as an id→key map and is NEVER
 *      written onto `MediaProjection`, because the projection is a privacy
 *      whitelist and trip membership is not on it.
 *   3. COMMON SOURCE — INAPPLICABLE, not missing. No media perspective is ever
 *      produced by an official feed or partner API; there is no such reference
 *      anywhere on a post.
 *
 * And the SYNC detector is deliberately made inert rather than mapped badly: a
 * perspective asserts no VALUE, so two strangers photographing the same bar
 * thirty seconds apart are two witnesses, not coordination. The `valueKey` is
 * the perspective's own id, which cannot collide — asserted below, because a
 * wrong mapping here would silently destroy honest corroboration.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaIndependentSources.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPerspectiveSummary } from "../services/media/MediaPerspectiveService.js";
import type { MediaProjection } from "../lib/media/mediaProjection.js";
import { resolveViewer, buildPlaceProjection } from "../services/media/MediaProjectionService.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");

function proj(o: {
  id: string;
  contributorId: string | null;
  url?: string;
  capturedAt?: string;
  category?: string;
}): MediaProjection {
  return {
    id: o.id,
    mediaType: "image",
    url: o.url ?? `https://cdn.example/${o.id}.jpg`,
    thumbnailUrl: null,
    width: 1080,
    height: 1080,
    durationSeconds: null,
    capturedAt: o.capturedAt ?? new Date(NOW - 5 * 60_000).toISOString(),
    placeId: "place-1",
    placeLabel: "An Thuong Bar",
    neighborhood: null,
    city: "Da Nang",
    country: "Vietnam",
    category: o.category ?? "nightlife",
    freshness: "fresh",
    contributor: o.contributorId
      ? {
          id: o.contributorId,
          username: "u",
          displayName: "U",
          avatarUrl: null,
          verified: false,
          isOfficial: false,
        }
      : null,
  } as MediaProjection;
}

describe("MD147 — independent sources are CLUSTERED, not counted as contributors", () => {
  it("two unrelated contributors with distinct media are two independent sources", () => {
    const s = buildPerspectiveSummary([proj({ id: "p1", contributorId: "A" }), proj({ id: "p2", contributorId: "B" })], NOW);
    assert.equal(s.contributorCount, 2);
    assert.equal(s.independentSourceCount, 2);
  });

  it("TWO contributors posting the SAME file are ONE independent source", () => {
    const same = "https://cdn.example/one-and-the-same.jpg";
    const s = buildPerspectiveSummary(
      [proj({ id: "p1", contributorId: "A", url: same }), proj({ id: "p2", contributorId: "B", url: same })],
      NOW,
    );
    assert.equal(s.contributorCount, 2, "they really are two accounts");
    assert.equal(
      s.independentSourceCount,
      1,
      "one photograph is one source however many accounts post it",
    );
  });

  it("THREE copies of one file collapse to one source — the AT-04 shape", () => {
    const same = "https://cdn.example/brigade.jpg";
    const s = buildPerspectiveSummary(
      [
        proj({ id: "p1", contributorId: "A", url: same }),
        proj({ id: "p2", contributorId: "B", url: same }),
        proj({ id: "p3", contributorId: "C", url: same }),
      ],
      NOW,
    );
    assert.equal(s.contributorCount, 3);
    assert.equal(s.independentSourceCount, 1);
  });

  it("two contributors on the SAME TRIP are one independent source", () => {
    const s = buildPerspectiveSummary(
      [proj({ id: "p1", contributorId: "A" }), proj({ id: "p2", contributorId: "B" })],
      NOW,
      { groupKeyById: new Map([["p1", "trip-9"], ["p2", "trip-9"]]) },
    );
    assert.equal(s.contributorCount, 2);
    assert.equal(s.independentSourceCount, 1, "a party that travelled together is one party");
  });

  it("two contributors on DIFFERENT trips stay two independent sources", () => {
    const s = buildPerspectiveSummary(
      [proj({ id: "p1", contributorId: "A" }), proj({ id: "p2", contributorId: "B" })],
      NOW,
      { groupKeyById: new Map([["p1", "trip-9"], ["p2", "trip-10"]]) },
    );
    assert.equal(s.independentSourceCount, 2);
  });

  it("the SYNC detector is inert: two strangers shooting the same place seconds apart are TWO witnesses", () => {
    const t0 = new Date(NOW - 60_000).toISOString();
    const t1 = new Date(NOW - 59_000).toISOString(); // 1 second later, well inside SYNC_WINDOW_SECONDS
    const s = buildPerspectiveSummary(
      [
        proj({ id: "p1", contributorId: "A", capturedAt: t0 }),
        proj({ id: "p2", contributorId: "B", capturedAt: t1 }),
      ],
      NOW,
    );
    assert.equal(
      s.independentSourceCount,
      2,
      "a photograph asserts no value, so simultaneity is not coordination",
    );
  });

  it("one contributor with many perspectives is one source, not many", () => {
    const s = buildPerspectiveSummary(
      [
        proj({ id: "p1", contributorId: "A" }),
        proj({ id: "p2", contributorId: "A" }),
        proj({ id: "p3", contributorId: "A" }),
      ],
      NOW,
    );
    assert.equal(s.totalPerspectives, 3);
    assert.equal(s.contributorCount, 1);
    assert.equal(s.independentSourceCount, 1);
  });

  it("independentSourceCount NEVER exceeds contributorCount, on every case above", () => {
    const cases: MediaProjection[][] = [
      [],
      [proj({ id: "a", contributorId: "A" })],
      [proj({ id: "a", contributorId: "A" }), proj({ id: "b", contributorId: "B" })],
      [proj({ id: "a", contributorId: "A", url: "u" }), proj({ id: "b", contributorId: "B", url: "u" })],
      [proj({ id: "a", contributorId: null }), proj({ id: "b", contributorId: "B" })],
    ];
    for (const c of cases) {
      const s = buildPerspectiveSummary(c, NOW);
      assert.ok(
        s.independentSourceCount <= s.contributorCount,
        `merging may only REDUCE: got ${s.independentSourceCount} > ${s.contributorCount}`,
      );
    }
  });

  it("an anonymous perspective contributes no source at all", () => {
    const s = buildPerspectiveSummary([proj({ id: "p1", contributorId: null })], NOW);
    assert.equal(s.totalPerspectives, 1);
    assert.equal(s.contributorCount, 0);
    assert.equal(s.independentSourceCount, 0);
  });

  it("empty input stays a well-formed empty summary", () => {
    const s = buildPerspectiveSummary([], NOW);
    assert.equal(s.totalPerspectives, 0);
    assert.equal(s.independentSourceCount, 0);
  });
});

// ── The place projection actually supplies the trip side channel ─────────────

type Dataset = Record<string, any[]>;

function makeSc(data: Dataset) {
  const resolveRows = (table: string, filters: any[]): any[] => {
    let rows = (data[table] ?? []).map((r) => ({ ...r }));
    for (const f of filters) {
      if (f.op === "eq") rows = rows.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "in")
        rows = rows.filter((r) => (f.val as any[]).map(String).includes(String(r[f.col])));
      else if (f.op === "ilike") {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[f.col] ?? "").toLowerCase().includes(needle));
      }
    }
    return rows;
  };
  const builder = (table: string): any => {
    const filters: any[] = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      gt() { return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR);
      },
    };
    return b;
  };
  return { from(table: string) { return builder(table); } } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const PLACE = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function postRow(id: string, author: string, tripId: string | null, url: string): any {
  return {
    id,
    author_id: author,
    trip_id: tripId,
    content: "",
    visibility: "public",
    status: "active",
    post_status: "published",
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    created_at: new Date(NOW - 5 * 60_000).toISOString(),
    category: "nightlife",
    media_urls: [],
    has_video: false,
    location_name: "An Thuong Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: PLACE,
    post_media: [
      {
        id: `${id}-m1`,
        media_type: "image",
        public_url: url,
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
      username: `u-${author}`,
      full_name: "P",
      name: "P",
      display_name: "P",
      avatar_url: null,
      verified: false,
      is_official: false,
      account_status: "active",
      is_private: false,
    },
  };
}

function base(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [], user_mutes: [], post_hides: [], user_follows: [],
    trip_members: [], trips: [], places: [], feature_flags: [],
    ...extra,
  };
}

describe("MD147 — GET /media/places/:id carries a real independent-source count", () => {
  it("two authors of one trip, two distinct photos → 2 contributors, 1 independent source", async () => {
    const sc = makeSc(
      base({
        posts: [
          postRow("p1", "aaaa", "trip-9", "https://cdn.example/1.jpg"),
          postRow("p2", "bbbb", "trip-9", "https://cdn.example/2.jpg"),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, NOW);
    assert.equal(p.perspectives.contributorCount, 2);
    assert.equal(
      p.perspectives.independentSourceCount,
      1,
      "the trip_id side channel must reach the summary from the candidate rows",
    );
  });

  it("two authors, no trip, distinct photos → 2 and 2", async () => {
    const sc = makeSc(
      base({
        posts: [
          postRow("p1", "aaaa", null, "https://cdn.example/1.jpg"),
          postRow("p2", "bbbb", null, "https://cdn.example/2.jpg"),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, NOW);
    assert.equal(p.perspectives.contributorCount, 2);
    assert.equal(p.perspectives.independentSourceCount, 2);
  });

  it("two authors posting the SAME file → 2 contributors, 1 independent source", async () => {
    const same = "https://cdn.example/same.jpg";
    const sc = makeSc(
      base({ posts: [postRow("p1", "aaaa", null, same), postRow("p2", "bbbb", null, same)] }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, NOW);
    assert.equal(p.perspectives.contributorCount, 2);
    assert.equal(p.perspectives.independentSourceCount, 1);
  });

  it("the trip id never leaves the server on the projection", async () => {
    const sc = makeSc(
      base({ posts: [postRow("p1", "aaaa", "trip-secret", "https://cdn.example/1.jpg")] }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, NOW);
    assert.equal(
      JSON.stringify(p).includes("trip-secret"),
      false,
      "the party token is an INPUT to clustering, never an output",
    );
  });
});
