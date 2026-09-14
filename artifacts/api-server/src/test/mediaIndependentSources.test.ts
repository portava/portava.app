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

// ═════════════════════════════════════════════════════════════════════════════
// §18 CORROBORATION → CONTRADICTION → VISUAL CONSENSUS
// census-media MD149 / MD150 / MD151 / MD152
// ═════════════════════════════════════════════════════════════════════════════
/**
 * The three stages after Independent Sources in §18's pipeline, and the copy
 * §18 names in its own sentence:
 *
 *   MD149 Corroboration    W — "nothing corroborates one perspective against
 *                              another; a place's mosaic carries no agreement
 *                              measure."
 *   MD150 Contradiction    N — "`lib/intelConflict.ts` exists for intel claims
 *                              and is not reached from any media path."
 *   MD151 Visual Consensus N — "No consensus object exists."
 *   MD152 Mixed reports    N — "No mixed-reports copy, no uncertainty state on
 *                              `PlaceProjection` or `WorldZone`."
 *
 * WHAT IS BEING PROVED, AND WHAT IS DELIBERATELY NOT INVENTED.
 * A photograph asserts NO VALUE (the MD147 header above says so and the sync
 * detector is inert for exactly that reason), so media perspectives cannot
 * contradict each other directly — inventing a value axis for them would be
 * fabrication, which is the failure mode this whole service tree refuses.
 * Therefore:
 *
 *   • CORROBORATION is the agreement measure media CAN carry honestly: how many
 *     INDEPENDENT sources (not accounts) independently witnessed this place
 *     inside the fresh window. One account posting eight photos, or eight
 *     accounts posting one file, corroborates nothing.
 *   • CONTRADICTION is READ from the canonical `lib/intelConflict` state that
 *     already rides on every gated live-claim envelope Media ALREADY fetches
 *     (`readCurrentState` → `readLiveClaimEnvelopes`) and then drops on the
 *     floor. No second conflict engine is built. This is the media path
 *     REACHING `lib/intelConflict`, which MD150 says nothing does.
 *   • The mixed-reports copy fires ONLY on a MATERIAL conflict — the same
 *     threshold `lib/intelConflict` itself uses to suppress a Live label. A
 *     'minor' disagreement is recorded and does NOT get the banner, because
 *     intelConflict's own contract says minor means "no suppression".
 */
import {
  buildVisualConsensus,
  MIXED_REPORTS_LABEL,
  type VisualConsensus,
} from "../services/media/MediaConsensusService.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import type { ConflictState } from "../lib/intelConflict.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";

function envelope(o: { claimType?: string; conflictState: ConflictState }): LiveClaimEnvelope {
  const state = o.conflictState;
  return {
    id: `claim-${o.claimType ?? "crowd.level"}`,
    claimType: o.claimType ?? "crowd.level",
    value: "busy",
    confidence: 0.6,
    band: "likely_current",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "several",
    observedAt: new Date(NOW - 10 * 60_000).toISOString(),
    validUntil: new Date(NOW + 30 * 60_000).toISOString(),
    state: "emerging",
    conflictState: state,
    conflict: state === "none" ? null : { state, sidesCount: 2, lastUpdated: new Date(NOW - 9 * 60_000).toISOString() },
  };
}

const FRESH = new Date(NOW - 5 * 60_000).toISOString();
const STALE = new Date(NOW - 5 * 60 * 60_000).toISOString();

describe("MD151 — a Visual Consensus Projection object exists and is well-formed", () => {
  it("empty input yields the honest 'insufficient' consensus, never agreement", () => {
    const c: VisualConsensus = buildVisualConsensus([], [], NOW);
    assert.equal(c.state, "insufficient");
    assert.equal(c.corroboration.level, "none");
    assert.equal(c.corroboration.freshPerspectiveCount, 0);
    assert.equal(c.corroboration.independentSourceCount, 0);
    assert.equal(c.contradiction, null);
    assert.equal(c.uncertaintyLabel, null);
    assert.equal(c.requestAnotherObservation, false);
  });
});

describe("MD149 — corroboration counts INDEPENDENT sources inside the fresh window", () => {
  it("three unrelated fresh contributors corroborate the current picture", () => {
    const c = buildVisualConsensus(
      [
        proj({ id: "p1", contributorId: "A", capturedAt: FRESH }),
        proj({ id: "p2", contributorId: "B", capturedAt: FRESH }),
        proj({ id: "p3", contributorId: "C", capturedAt: FRESH }),
      ],
      [],
      NOW,
    );
    assert.equal(c.corroboration.independentSourceCount, 3);
    assert.equal(c.corroboration.level, "well_corroborated");
    assert.equal(c.state, "corroborated");
  });

  it("ONE contributor posting three perspectives corroborates NOTHING", () => {
    const c = buildVisualConsensus(
      [
        proj({ id: "p1", contributorId: "A", capturedAt: FRESH }),
        proj({ id: "p2", contributorId: "A", capturedAt: FRESH }),
        proj({ id: "p3", contributorId: "A", capturedAt: FRESH }),
      ],
      [],
      NOW,
    );
    assert.equal(c.corroboration.freshPerspectiveCount, 3, "three perspectives really are there");
    assert.equal(c.corroboration.independentSourceCount, 1);
    assert.equal(c.corroboration.level, "single_source");
    assert.equal(c.state, "insufficient", "one witness is not a consensus");
  });

  it("two accounts posting the SAME FILE are one source and do not corroborate", () => {
    const same = "https://cdn.example/one-file.jpg";
    const c = buildVisualConsensus(
      [
        proj({ id: "p1", contributorId: "A", url: same, capturedAt: FRESH }),
        proj({ id: "p2", contributorId: "B", url: same, capturedAt: FRESH }),
      ],
      [],
      NOW,
    );
    assert.equal(c.corroboration.independentSourceCount, 1);
    assert.equal(c.corroboration.level, "single_source");
  });

  it("a trip crew is one party, so a crew cannot self-corroborate", () => {
    const c = buildVisualConsensus(
      [
        proj({ id: "p1", contributorId: "A", capturedAt: FRESH }),
        proj({ id: "p2", contributorId: "B", capturedAt: FRESH }),
      ],
      [],
      NOW,
      { groupKeyById: new Map([["p1", "trip-9"], ["p2", "trip-9"]]) },
    );
    assert.equal(c.corroboration.independentSourceCount, 1);
    assert.equal(c.corroboration.level, "single_source");
  });

  it("STALE perspectives do not corroborate the CURRENT picture", () => {
    const c = buildVisualConsensus(
      [
        proj({ id: "p1", contributorId: "A", capturedAt: STALE }),
        proj({ id: "p2", contributorId: "B", capturedAt: STALE }),
        proj({ id: "p3", contributorId: "C", capturedAt: STALE }),
      ],
      [],
      NOW,
    );
    assert.equal(c.corroboration.freshPerspectiveCount, 0);
    assert.equal(c.corroboration.independentSourceCount, 0);
    assert.equal(c.corroboration.level, "none");
    assert.equal(c.state, "insufficient");
  });
});

describe("MD150 — the contradiction stage reaches lib/intelConflict from a media path", () => {
  it("a MATERIAL conflict on a gated live claim becomes a contradiction on the consensus", () => {
    const c = buildVisualConsensus(
      [proj({ id: "p1", contributorId: "A", capturedAt: FRESH }), proj({ id: "p2", contributorId: "B", capturedAt: FRESH })],
      [envelope({ conflictState: "material" })],
      NOW,
    );
    assert.ok(c.contradiction, "a materially conflicted claim must produce a contradiction block");
    assert.equal(c.contradiction!.state, "material");
    assert.deepEqual(c.contradiction!.claimTypes, ["crowd.level"]);
    assert.equal(c.contradiction!.block?.sidesCount, 2);
  });

  it("an AGREEING claim produces no contradiction at all — uncertainty is never fabricated", () => {
    const c = buildVisualConsensus(
      [proj({ id: "p1", contributorId: "A", capturedAt: FRESH }), proj({ id: "p2", contributorId: "B", capturedAt: FRESH })],
      [envelope({ conflictState: "none" })],
      NOW,
    );
    assert.equal(c.contradiction, null);
    assert.equal(c.uncertaintyLabel, null);
    assert.equal(c.state, "corroborated");
  });

  it("the WORST conflict across claim types wins, and every conflicting type is named", () => {
    const c = buildVisualConsensus(
      [proj({ id: "p1", contributorId: "A", capturedAt: FRESH })],
      [
        envelope({ claimType: "queue.band", conflictState: "minor" }),
        envelope({ claimType: "crowd.level", conflictState: "material" }),
        envelope({ claimType: "access.state", conflictState: "none" }),
      ],
      NOW,
    );
    assert.equal(c.contradiction!.state, "material");
    assert.deepEqual(
      [...c.contradiction!.claimTypes].sort(),
      ["crowd.level", "queue.band"],
      "an agreeing claim type is not listed as disagreeing",
    );
  });

  it("an UNRECOGNISED stored conflict value reads as MATERIAL — the stricter direction", () => {
    const bad = envelope({ conflictState: "none" });
    (bad as any).conflictState = "wobbly";
    const c = buildVisualConsensus([proj({ id: "p1", contributorId: "A", capturedAt: FRESH })], [bad], NOW);
    assert.equal(c.contradiction!.state, "material", "ambiguity resolves toward showing uncertainty");
  });
});

describe("MD152 — when reports disagree, the uncertainty is SURFACED", () => {
  it("a material conflict surfaces the §18 copy and flips the consensus to mixed", () => {
    const c = buildVisualConsensus(
      [proj({ id: "p1", contributorId: "A", capturedAt: FRESH }), proj({ id: "p2", contributorId: "B", capturedAt: FRESH })],
      [envelope({ conflictState: "material" })],
      NOW,
    );
    assert.equal(c.state, "mixed");
    assert.equal(c.uncertaintyLabel, MIXED_REPORTS_LABEL);
    assert.match(c.uncertaintyLabel!, /Mixed reports/);
    assert.match(c.uncertaintyLabel!, /conditions may be changing/);
    assert.equal(c.requestAnotherObservation, true, "§18 'optionally request another observation'");
  });

  it("a MINOR disagreement is recorded but does NOT get the banner", () => {
    const c = buildVisualConsensus(
      [proj({ id: "p1", contributorId: "A", capturedAt: FRESH }), proj({ id: "p2", contributorId: "B", capturedAt: FRESH })],
      [envelope({ conflictState: "minor" })],
      NOW,
    );
    assert.equal(c.contradiction!.state, "minor", "the disagreement is still visible in the block");
    assert.equal(c.uncertaintyLabel, null, "intelConflict's own contract: minor means no suppression");
    assert.notEqual(c.state, "mixed");
  });

  it("a disagreement outranks a strong corroboration — mixed is not overwritten by agreement", () => {
    const c = buildVisualConsensus(
      [
        proj({ id: "p1", contributorId: "A", capturedAt: FRESH }),
        proj({ id: "p2", contributorId: "B", capturedAt: FRESH }),
        proj({ id: "p3", contributorId: "C", capturedAt: FRESH }),
        proj({ id: "p4", contributorId: "D", capturedAt: FRESH }),
      ],
      [envelope({ conflictState: "material" })],
      NOW,
    );
    assert.equal(c.corroboration.level, "well_corroborated");
    assert.equal(c.state, "mixed", "four agreeing photographs do not settle a disputed live claim");
  });
});

describe("MD151/MD152 — the consensus object is SERVED on the place projection", () => {
  it("GET /media/places/:id carries a well-formed consensus block", async () => {
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
    assert.ok((p as any).consensus, "PlaceProjection must carry the §18 consensus object");
    assert.equal((p as any).consensus.corroboration.independentSourceCount, 2);
    assert.equal((p as any).consensus.state, "corroborated");
    assert.equal((p as any).consensus.uncertaintyLabel, null, "no live claim ⇒ no fabricated uncertainty");
  });

  it("a MATERIALLY CONFLICTED promoted live claim reaches the served projection as mixed reports", async () => {
    _clearPromotedScopeCache();
    const sc = makeSc(
      base({
        posts: [postRow("p1", "aaaa", null, "https://cdn.example/1.jpg")],
        feature_flags: [
          { flag: "intel_live_label_crowd", enabled: true },
          { flag: "intel_claim_projection_crowd", enabled: true },
          { flag: "intel_capture_quick_signal", enabled: true },
          { flag: "intel_limited_live", enabled: true },
          { flag: "disable_intel_live_labels", enabled: false },
        ],
        intel_live_promoted_scopes: [
          { scope_key: `${PLACE}|crowd.level`, expires_at: null, withdrawn_at: null },
        ],
        intel_state_snapshots: [
          {
            id: "snap-1",
            subject_id: PLACE,
            zone_id: PLACE,
            claim_type: "crowd.level",
            value: "busy",
            confidence: 0.8,
            source_count: 6,
            observed_at: new Date(NOW - 10 * 60_000).toISOString(),
            expires_at: new Date(NOW + 30 * 60_000).toISOString(),
            privacy_eligible: true,
            conflict_state: "material",
            source_class: "community",
            computed_at: new Date(NOW - 9 * 60_000).toISOString(),
          },
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE, NOW);
    _clearPromotedScopeCache();
    assert.equal(p.currentState.claims.length, 1, "the fixture must actually serve a live claim");
    assert.equal((p as any).consensus.state, "mixed");
    assert.equal((p as any).consensus.uncertaintyLabel, MIXED_REPORTS_LABEL);
  });
});
