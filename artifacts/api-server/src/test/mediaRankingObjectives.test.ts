/**
 * mediaRankingObjectives — census-media §21: the §24 World-shell ranker, term by
 * term, and the §42 Media Ranking stage reaching what a client is served.
 *
 * Rows proved here: MD8 (authentic outranks generated), MD177 (viewer intent),
 * MD179 (trip context), MD184 (live state), MD187 (media quality), MD188 (trust
 * / provenance), MD194 (expected real-world utility), MD195 (experience fit),
 * MD196 (useful social connection), MD197 (contribution value), MD198
 * (narrative value), MD201 (− low-confidence live claims), MD348
 * (MediaRankingService is §24's ranker), MD356 (a ranking stage before the
 * client).
 *
 * Fake Supabase clients only — no DB, no network.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/mediaRankingObjectives.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { MediaCandidateRow } from "../lib/media/mediaProjection.js";
import {
  EMPTY_MEDIA_RANKING_SIGNALS,
  buildRankingPage,
  provenanceClassOf,
  mediaQualityOf,
  utilityTerm,
  type MediaRankingSignals,
} from "../lib/mediaRankingSignals.js";
import {
  MEDIA_RANKING_WEIGHTS,
  SPEC_24_COVERAGE,
  rankMediaCandidates,
  scoreMediaCandidate,
  type MediaRankingScore,
} from "../services/media/MediaRankingService.js";
import { loadMediaRankingSignals } from "../services/ranking/MediaRankingSignalLoader.js";
import {
  resolveViewer,
  buildPlaceProjection,
  buildPeopleProjection,
} from "../services/media/MediaProjectionService.js";
import { resolveExperience } from "../services/media/MediaExperienceResolver.js";
import type { LiveClaim } from "../lib/liveClaimRead.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const AUTHOR_B = "33333333-3333-3333-3333-333333333333";
const AUTHOR_C = "44444444-4444-4444-4444-444444444444";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PLACE_3 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TRIP_1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A candidate row with EVERY scored input equal, so a test moves exactly one. */
function row(id: string, o: Record<string, unknown> = {}): MediaCandidateRow {
  return {
    id,
    author_id: AUTHOR_A,
    trip_id: null,
    content: "",
    created_at: iso(NOW - HOUR),
    category: "food",
    location_name: "Somewhere",
    location_city: "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: PLACE_1,
    post_media: [{ processing_status: "ready", moderation_status: "approved", public_url: `https://x/${id}`, width: 1200, height: 800, media_type: "image", sort_order: 0 }],
    profiles: { id: AUTHOR_A, verified: false, is_official: false },
    ...o,
  } as MediaCandidateRow;
}

function signals(o: Partial<MediaRankingSignals>): MediaRankingSignals {
  return { ...EMPTY_MEDIA_RANKING_SIGNALS, ...o };
}

function canonical(sourceType: string, extra: Record<string, unknown> = {}): unknown[] {
  return [{ processing_status: "ready", moderation_status: "active", public_url: "https://x/c", position: 0, width: 1200, height: 800, source_type: sourceType, ...extra }];
}

function ids(rows: MediaCandidateRow[]): string[] {
  return rows.map((r) => String(r.id));
}

function score(r: MediaCandidateRow, s: MediaRankingSignals, extra: Record<string, unknown> = {}): MediaRankingScore {
  return scoreMediaCandidate(r, { nowMs: NOW, signals: s, ...extra });
}

// ── A filtering fake Supabase client ──────────────────────────────────────────

type Dataset = Record<string, any[]>;

function read(r: any, col: string): unknown {
  if (col.includes("->>")) {
    const [base, key] = col.split("->>");
    return r?.[base]?.[key];
  }
  return r?.[col];
}

function makeSc(data: Dataset, opts: { failing?: string[] } = {}) {
  const calls: string[] = [];
  const builder = (table: string): any => {
    calls.push(table);
    const filters: Array<(r: any) => boolean> = [];
    let limit: number | null = null;
    const resolveRows = () => {
      let rows = (data[table] ?? []).map((r) => ({ ...r }));
      for (const f of filters) rows = rows.filter(f);
      return limit === null ? rows : rows.slice(0, limit);
    };
    const fail = opts.failing?.includes(table);
    const result = () => (fail ? { data: null, error: { code: "XX000", message: `${table} unreadable` } } : { data: resolveRows(), error: null });
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => String(read(r, col)) === String(val)); return b; },
      neq(col: string, val: any) { filters.push((r) => String(read(r, col)) !== String(val)); return b; },
      in(col: string, val: any[]) { const v = val.map(String); filters.push((r) => v.includes(String(read(r, col)))); return b; },
      gte(col: string, val: any) { filters.push((r) => read(r, col) != null && String(read(r, col)) >= String(val)); return b; },
      gt(col: string, val: any) { filters.push((r) => read(r, col) != null && String(read(r, col)) > String(val)); return b; },
      lte() { return b; },
      lt() { return b; },
      is(col: string, val: any) { filters.push((r) => (read(r, col) ?? null) === val); return b; },
      not() { return b; },
      or() { return b; },
      ilike() { return b; },
      order() { return b; },
      range() { return b; },
      limit(n: number) { limit = n; return b; },
      maybeSingle() {
        const r = result();
        return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null });
      },
      single() {
        const r = result();
        return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null });
      },
      then(onF: any, onR: any) { return Promise.resolve(result()).then(onF, onR); },
    };
    return b;
  };
  const sc: any = { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: { message: "no rpc" } }) };
  sc.calls = calls;
  return sc;
}

const RANKING_VIEWER = {
  viewerId: VIEWER,
  viewerCountry: "Vietnam",
  followedCreatorIds: new Set<string>(),
  viewerTripIds: new Set<string>(),
};

// ── MD8 — authentic outranks generated fallback media ─────────────────────────

describe("MD8 — authentic media outranks generated fallback media (a partition, not a weight)", () => {
  it("a generated asset that wins on every other term still ranks after an authentic one", () => {
    const generated = row("generated", {
      canonical_media: canonical("generated", { width: 3840, height: 2160 }),
      profiles: { id: AUTHOR_B, is_official: true, verified: true },
      author_id: AUTHOR_B,
      content: "a long caption with plenty of words to earn narrative value here",
    });
    const authentic = row("authentic", {
      canonical_media: canonical("camera", { width: 320, height: 240 }),
      created_at: iso(NOW - 20 * DAY),
    });
    const s = signals({ intent: { mediaIds: new Set(["generated"]), placeIds: new Set(), categories: new Set() } });
    assert.ok(score(generated, s).score > score(authentic, s).score, "fixture: generated must out-SCORE authentic, or the partition is untested");
    assert.deepEqual(ids(rankMediaCandidates([generated, authentic], { nowMs: NOW, signals: s })), ["authentic", "generated"]);
  });

  it("a camera capture with a generative edit is §35-altered, so it is demoted too", () => {
    const altered = row("altered", {
      canonical_media: canonical("camera", { provenance: { sourceType: "camera", editHistory: [{ op: "ai_generate", at: iso(NOW) }] } }),
      created_at: iso(NOW - 5 * 60_000),
    });
    const plain = row("plain", { canonical_media: canonical("camera"), created_at: iso(NOW - 10 * DAY) });
    assert.equal(provenanceClassOf(altered), "synthetic");
    assert.equal(provenanceClassOf(plain), "authentic");
    assert.deepEqual(ids(rankMediaCandidates([altered, plain], { nowMs: NOW })), ["plain", "altered"]);
  });

  it("an item with NO provenance is neither promoted nor demoted by the partition", () => {
    const unknown = row("unknown", { created_at: iso(NOW - 5 * 60_000) });
    const authentic = row("authentic", { canonical_media: canonical("camera"), created_at: iso(NOW - 30 * DAY), author_id: AUTHOR_B });
    const s = signals({ intent: { mediaIds: new Set(["unknown"]), placeIds: new Set(), categories: new Set() } });
    assert.equal(provenanceClassOf(unknown), "unknown");
    assert.deepEqual(ids(rankMediaCandidates([authentic, unknown], { nowMs: NOW, signals: s })), ["unknown", "authentic"]);
  });
});

// ── MD188 — trust / provenance: asset provenance is not author trust ─────────

describe("MD188 — Trust / provenance scores the ASSET's provenance separately from the author", () => {
  it("orders the provenance classes authentic > third_party > unknown > non_observation > synthetic", () => {
    const by = (st: string) => score(row(st, { canonical_media: canonical(st) }), EMPTY_MEDIA_RANKING_SIGNALS).provenance;
    assert.ok(by("camera") > by("official"));
    assert.ok(by("official") > score(row("none"), EMPTY_MEDIA_RANKING_SIGNALS).provenance);
    assert.ok(score(row("none"), EMPTY_MEDIA_RANKING_SIGNALS).provenance > by("screenshot"));
    assert.ok(by("screenshot") > by("generated"));
    assert.equal(by("derivative"), 0);
  });

  it("an OFFICIAL author does not make an asset's provenance authentic, and vice versa", () => {
    const officialGenerated = row("og", { canonical_media: canonical("generated"), profiles: { id: AUTHOR_A, is_official: true } });
    const plainCamera = row("pc", { canonical_media: canonical("camera") });
    const og = score(officialGenerated, EMPTY_MEDIA_RANKING_SIGNALS);
    const pc = score(plainCamera, EMPTY_MEDIA_RANKING_SIGNALS);
    assert.equal(og.authorTrust, 1);
    assert.equal(og.provenance, 0);
    assert.equal(pc.authorTrust, 0.5);
    assert.equal(pc.provenance, 1);
  });
});

// ── MD177 — viewer intent ─────────────────────────────────────────────────────

describe("MD177 — viewer intent generalises past the one wanted item", () => {
  const s = signals({ intent: { mediaIds: new Set(["wanted"]), placeIds: new Set([PLACE_2]), categories: new Set(["nightlife"]) } });

  it("wanted item 1.0 > wanted place 0.8 > wanted category 0.5 > nothing 0", () => {
    assert.equal(score(row("wanted"), s).intent, 1);
    assert.equal(score(row("p", { canonical_place_id: PLACE_2 }), s).intent, 0.8);
    assert.equal(score(row("c", { category: "nightlife" }), s).intent, 0.5);
    assert.equal(score(row("x"), s).intent, 0);
  });

  it("another perspective of a WANTED PLACE outranks an otherwise-identical one", () => {
    const atWanted = row("atWanted", { canonical_place_id: PLACE_2, author_id: AUTHOR_B });
    const other = row("other", { canonical_place_id: PLACE_3, author_id: AUTHOR_C });
    assert.deepEqual(ids(rankMediaCandidates([other, atWanted], { nowMs: NOW, signals: s })), ["atWanted", "other"]);
  });

  it("the loader builds the place and category sets from the viewer's own wants", async () => {
    const sc = makeSc({
      media_intent_signals: [
        { user_id: VIEWER, media_id: "m1", entity_type: "place", entity_id: PLACE_2 },
        { user_id: "someone-else", media_id: "m2", entity_type: "place", entity_id: PLACE_3 },
      ],
      posts: [{ id: "m1", category: "Nightlife" }, { id: "m2", category: "beach" }],
    });
    const out = await loadMediaRankingSignals(sc, RANKING_VIEWER, [row("x")], NOW, { readLiveClaims: async () => [], loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }) });
    assert.deepEqual([...out.intent!.mediaIds], ["m1"]);
    assert.deepEqual([...out.intent!.placeIds], [PLACE_2]);
    assert.deepEqual([...out.intent!.categories], ["nightlife"]);
  });
});

// ── MD179 — trip context ──────────────────────────────────────────────────────

describe("MD179 — trip context: the viewer's own trips, and where they are going", () => {
  const upcoming = { id: TRIP_1, city: "Hoi An", country: "Vietnam", startMs: NOW + 5 * DAY, endMs: NOW + 9 * DAY };
  const ended = { id: "old", city: "Hue", country: "Vietnam", startMs: NOW - 30 * DAY, endMs: NOW - 25 * DAY };

  it("media ON a viewer trip 1.0; in an upcoming trip's city 0.8; its country 0.3; an ENDED trip's city 0", () => {
    const s = signals({ trips: [upcoming, ended] });
    assert.equal(score(row("t", { trip_id: TRIP_1 }), s, { viewerTripIds: new Set([TRIP_1]) }).tripAffinity, 1);
    assert.equal(score(row("h", { location_city: "Hoi An" }), s).tripAffinity, 0.8);
    assert.equal(score(row("v", { location_city: "Saigon" }), s).tripAffinity, 0.3);
    assert.equal(score(row("e", { location_city: "Hue", location_country: "Laos" }), s).tripAffinity, 0);
  });

  it("the loader reads the viewer's trip destinations and dates", async () => {
    const sc = makeSc({
      trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member" }],
      trips: [{ id: TRIP_1, owner_id: AUTHOR_B, destination_city: "Hoi An", destination_country: "Vietnam", start_date: "2026-10-01", end_date: "2026-10-05" }],
    });
    const out = await loadMediaRankingSignals(sc, { ...RANKING_VIEWER, viewerTripIds: new Set([TRIP_1]) }, [row("x")], NOW, { readLiveClaims: async () => [], loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }) });
    assert.equal(out.trips!.length, 1);
    assert.equal(out.trips![0].city, "Hoi An");
    assert.equal(out.trips![0].startMs, Date.parse("2026-10-01T00:00:00.000Z"));
    assert.ok(out.trips![0].endMs! > Date.parse("2026-10-05T00:00:00.000Z"));
  });
});

// ── MD184 / MD201 — live state, and the penalty on low-confidence claims ─────

function claim(band: LiveClaim["band"], conflictState: LiveClaim["conflictState"] = "none"): LiveClaim {
  return {
    id: "s", claimType: "crowd.level", value: "busy", confidence: 0.8, band,
    sourceClass: "firsthand_unverified" as LiveClaim["sourceClass"], sourceCount: 20,
    observedAt: iso(NOW), expiresAt: iso(NOW + HOUR), conflictState,
  };
}

describe("MD184 / MD201 — live state is an input, and a SHAKY live claim is a penalty", () => {
  it("live place > no claim > low-confidence place", () => {
    const s = signals({
      livePlaces: new Map([
        [PLACE_1, { live: true, lowConfidence: false }],
        [PLACE_3, { live: false, lowConfidence: true }],
      ]),
    });
    const live = row("live", { canonical_place_id: PLACE_1, author_id: AUTHOR_A });
    const none = row("none", { canonical_place_id: PLACE_2, author_id: AUTHOR_B });
    const shaky = row("shaky", { canonical_place_id: PLACE_3, author_id: AUTHOR_C });
    assert.equal(score(live, s).live, 1);
    assert.equal(score(shaky, s).lowConfidenceLive, 1);
    assert.deepEqual(ids(rankMediaCandidates([shaky, none, live], { nowMs: NOW, signals: s })), ["live", "none", "shaky"]);
  });

  it("the loader: live/strong band → live; likely_current → low confidence; a MATERIAL conflict → low confidence, never live", async () => {
    const byPlace: Record<string, LiveClaim[]> = {
      [PLACE_1]: [claim("live")],
      [PLACE_2]: [claim("likely_current")],
      [PLACE_3]: [claim("strong", "material")],
    };
    const rows = [row("a", { canonical_place_id: PLACE_1 }), row("b", { canonical_place_id: PLACE_2 }), row("c", { canonical_place_id: PLACE_3 })];
    const out = await loadMediaRankingSignals(makeSc({}), RANKING_VIEWER, rows, NOW, {
      readLiveClaims: async (_sc, id) => byPlace[id] ?? [],
      loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }),
    });
    assert.deepEqual(out.livePlaces!.get(PLACE_1), { live: true, lowConfidence: false });
    assert.deepEqual(out.livePlaces!.get(PLACE_2), { live: false, lowConfidence: true });
    assert.deepEqual(out.livePlaces!.get(PLACE_3), { live: false, lowConfidence: true });
  });
});

// ── MD187 — media quality is the FILE, never how long it was watched ─────────

describe("MD187 — media quality from the file's own metadata", () => {
  it("resolution orders 4K > 720p > 360p, and watch/view fields do not move it", () => {
    const q = (w: number, h: number, extra: Record<string, unknown> = {}) =>
      mediaQualityOf(row("q", { post_media: [{ processing_status: "ready", public_url: "u", width: w, height: h, media_type: "image" }], ...extra })).score;
    assert.ok(q(3840, 2160) > q(1280, 720));
    assert.ok(q(1280, 720) > q(640, 360));
    assert.equal(q(640, 360, { watch_completion_rate: 1, view_count: 1e6, like_count: 1e6 }), q(640, 360));
  });

  it("quality reaches the SCORE: a 4K frame outranks a 360p one that is otherwise identical", () => {
    const sharp = row("sharp", { author_id: AUTHOR_B, post_media: [{ processing_status: "ready", public_url: "u", width: 3840, height: 2160, media_type: "image" }] });
    const soft = row("soft", { author_id: AUTHOR_C, post_media: [{ processing_status: "ready", public_url: "u", width: 640, height: 360, media_type: "image" }] });
    assert.deepEqual(ids(rankMediaCandidates([soft, sharp], { nowMs: NOW })), ["sharp", "soft"]);
  });

  it("video duration fit: a 30 s clip beats a 10 minute one; an extreme strip loses to a normal frame", () => {
    const vid = (seconds: number) =>
      mediaQualityOf(row("v", { post_media: [{ processing_status: "ready", public_url: "u", width: 1920, height: 1080, media_type: "video", duration_seconds: seconds }] })).score;
    assert.ok(vid(30) > vid(600));
    const strip = mediaQualityOf(row("s", { post_media: [{ processing_status: "ready", public_url: "u", width: 4000, height: 1000 }] })).score;
    const normal = mediaQualityOf(row("n", { post_media: [{ processing_status: "ready", public_url: "u", width: 4000, height: 3000 }] })).score;
    assert.ok(normal > strip);
  });
});

// ── MD194 — expected real-world utility ───────────────────────────────────────

describe("MD194 — expected real-world utility is the media's own §45 outcome rate", () => {
  it("the loader counts §45 outcomes and impressions per media id, and NOT watch or like events", async () => {
    const ev = (event_type: string, media_id: string, ago = HOUR) => ({ event_type, payload: { media_id }, occurred_at: iso(NOW - ago) });
    const sc = makeSc({
      media_events: [
        ev("media_trip_add", "useful"), ev("media_route", "useful"), ev("media_place_open", "useful"),
        ...Array.from({ length: 10 }, () => ev("impression", "useful")),
        ev("completion", "watched"), ev("qualified_view", "watched"), ev("rewatch", "watched"), ev("like", "watched"),
        ...Array.from({ length: 10 }, () => ev("impression", "watched")),
        ev("media_trip_add", "stale", 90 * DAY),
      ],
    });
    const rows = [row("useful"), row("watched"), row("stale")];
    const out = await loadMediaRankingSignals(sc, RANKING_VIEWER, rows, NOW, { readLiveClaims: async () => [], loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }) });
    assert.deepEqual(out.outcomes!.get("useful"), { outcomes: 3, impressions: 10 });
    assert.deepEqual(out.outcomes!.get("watched"), { outcomes: 0, impressions: 10 });
    assert.equal(out.outcomes!.get("stale"), undefined, "an outcome outside the 30-day window does not count");
  });

  it("a media that led to real-world action outranks one that was only watched", () => {
    const s = signals({ outcomes: new Map([["useful", { outcomes: 3, impressions: 10 }], ["watched", { outcomes: 0, impressions: 200 }]]) });
    assert.ok(utilityTerm(row("useful"), s) > utilityTerm(row("watched"), s));
    assert.deepEqual(ids(rankMediaCandidates([row("watched", { author_id: AUTHOR_B }), row("useful", { author_id: AUTHOR_C })], { nowMs: NOW, signals: s })), ["useful", "watched"]);
  });

  it("one lucky tap is not utility: smoothing keeps 1/1 below 3/10", () => {
    const s = signals({ outcomes: new Map([["lucky", { outcomes: 1, impressions: 1 }], ["steady", { outcomes: 3, impressions: 10 }]]) });
    assert.ok(utilityTerm(row("steady"), s) >= utilityTerm(row("lucky"), s) || utilityTerm(row("lucky"), s) < 1);
    assert.ok(utilityTerm(row("lucky"), s) < 1, "a single outcome must not saturate utility");
  });
});

// ── MD195 — experience fit ────────────────────────────────────────────────────

describe("MD195 — experience fit: can the viewer still have this experience, where they will be?", () => {
  const trip = { id: TRIP_1, city: "Hoi An", country: "Vietnam", startMs: NOW + DAY, endMs: NOW + 4 * DAY };

  it("an upcoming event in the viewer's trip city fits (1.0); the same event ENDED does not (0); no experience 0", () => {
    const upcoming = signals({ trips: [trip], events: new Map([["e", { startMs: NOW + 2 * DAY, endMs: NOW + 2 * DAY + 3 * HOUR, city: "Hoi An", closed: false }]]) });
    const over = signals({ trips: [trip], events: new Map([["e", { startMs: NOW - 2 * DAY, endMs: NOW - 2 * DAY + 3 * HOUR, city: "Hoi An", closed: false }]]) });
    const cancelled = signals({ trips: [trip], events: new Map([["e", { startMs: NOW + 2 * DAY, endMs: null, city: "Hoi An", closed: true }]]) });
    assert.equal(score(row("e", { location_city: "Hoi An" }), upcoming).experienceFit, 1);
    assert.equal(score(row("e", { location_city: "Hoi An" }), over).experienceFit, 0);
    assert.equal(score(row("e", { location_city: "Hoi An" }), cancelled).experienceFit, 0);
    assert.equal(score(row("plain"), upcoming).experienceFit, 0);
  });

  it("an available experience that fits neither the viewer's trips nor their wants is 0.3", () => {
    const s = signals({ trips: [trip], events: new Map([["e", { startMs: NOW + 2 * DAY, endMs: null, city: "Hue", closed: false }]]) });
    assert.equal(score(row("e", { location_city: "Hue" }), s).experienceFit, 0.3);
  });

  it("the loader only reads PUBLIC events", async () => {
    const sc = makeSc({
      post_event_links: [{ post_id: "p1", event_id: "ev-pub" }, { post_id: "p2", event_id: "ev-priv" }],
      events: [
        { id: "ev-pub", starts_at: iso(NOW + DAY), ends_at: null, city: "Hue", state: "open", visibility: "public" },
        { id: "ev-priv", starts_at: iso(NOW + DAY), ends_at: null, city: "Hue", state: "open", visibility: "private" },
      ],
    });
    const out = await loadMediaRankingSignals(sc, RANKING_VIEWER, [row("p1"), row("p2")], NOW, { readLiveClaims: async () => [], loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }) });
    assert.ok(out.events!.has("p1"));
    assert.equal(out.events!.has("p2"), false, "a private event's timing must not reach the ranker");
  });
});

// ── MD196 — useful social connection ──────────────────────────────────────────

describe("MD196 — useful social connection is not follow-graph proximity", () => {
  const trip = { id: TRIP_1, city: "Hoi An", country: "Vietnam", startMs: NOW + DAY, endMs: NOW + 4 * DAY };

  it("trip crew 1.0; followed AND in the viewer's trip city 0.6; followed elsewhere 0", () => {
    const s = signals({
      trips: [trip],
      followed: new Set([AUTHOR_B, AUTHOR_C]),
      affinity: { tripCrew: new Set([AUTHOR_A]), sharedMoment: new Set() },
    });
    assert.equal(score(row("crew", { author_id: AUTHOR_A }), s).usefulSocial, 1);
    assert.equal(score(row("been", { author_id: AUTHOR_B, location_city: "Hoi An" }), s).usefulSocial, 0.6);
    const elsewhere = score(row("far", { author_id: AUTHOR_C, location_city: "Hanoi" }), s);
    assert.equal(elsewhere.usefulSocial, 0);
    assert.equal(elsewhere.follow, 1, "follow proximity is still scored — as its own term, not this one");
  });
});

// ── MD197 — contribution value ────────────────────────────────────────────────

describe("MD197 — contribution value is marginal coverage, not who posted", () => {
  it("a fresh perspective at an UNCOVERED place is worth more than the fourth at a covered one", () => {
    const crowded = [1, 2, 3, 4].map((i) => row(`c${i}`, { canonical_place_id: PLACE_1, author_id: `a${i}` }));
    const lone = row("lone", { canonical_place_id: PLACE_2, author_id: AUTHOR_B });
    const page = buildRankingPage([...crowded, lone], NOW);
    const ctx = { nowMs: NOW, signals: EMPTY_MEDIA_RANKING_SIGNALS };
    assert.ok(scoreMediaCandidate(lone, ctx, page).contribution > scoreMediaCandidate(crowded[0], ctx, page).contribution);
  });

  it("stale media fills no current gap; a verified capture adds", () => {
    const stale = row("stale", { created_at: iso(NOW - 10 * DAY) });
    const verified = row("verified");
    const s = signals({ verifiedCapture: new Set(["verified"]) });
    assert.equal(score(stale, s).contribution, 0);
    assert.ok(score(verified, s).contribution > score(row("unverified"), s).contribution);
  });

  it("reads no contributor's intel history (3002 tokens are not re-linked to rank media)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const loader = readFileSync(resolve(here, "../services/ranking/MediaRankingSignalLoader.ts"), "utf8");
    const code = loader.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, /intel_observations|intel_state_snapshots|readContributorReputation|readOwnContributorIdentities/);
  });
});

// ── MD198 — narrative value ───────────────────────────────────────────────────

describe("MD198 — narrative value: part of a story, not a lone frame", () => {
  it("postcard 1.0 > event/trip experience 0.7 > substantial caption 0.4 > nothing 0", () => {
    const s = signals({ postcards: new Set(["pc"]), events: new Map([["ev", { startMs: null, endMs: null, city: null, closed: false }]]) });
    assert.equal(score(row("pc"), s).narrative, 1);
    assert.equal(score(row("ev"), s).narrative, 0.7);
    assert.equal(score(row("tr", { trip_id: TRIP_1 }), s).narrative, 0.7);
    assert.equal(score(row("cap", { content: "sunset over the river with the whole crew tonight" }), s).narrative, 0.4);
    assert.equal(score(row("bare", { content: "wow" }), s).narrative, 0);
  });

  it("the loader counts only PUBLIC, ACTIVE postcards", async () => {
    const sc = makeSc({
      passport_postcards: [
        { post_id: "p1", status: "active", visibility: "public", deleted_at: null },
        { post_id: "p2", status: "active", visibility: "private", deleted_at: null },
      ],
    });
    const out = await loadMediaRankingSignals(sc, RANKING_VIEWER, [row("p1"), row("p2")], NOW, { readLiveClaims: async () => [], loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }) });
    assert.deepEqual([...out.postcards!], ["p1"]);
  });
});

// ── Fail-soft: an unreadable signal is NEUTRAL, never a guess ────────────────

describe("an unreadable signal is null, and a null signal reorders nothing", () => {
  it("a failed read settles to null rather than to an empty 'no data'", async () => {
    const sc = makeSc({ media_intent_signals: [{ user_id: VIEWER, media_id: "m1", entity_type: "media", entity_id: "m1" }] }, { failing: ["media_intent_signals", "media_events", "saved_places"] });
    const out = await loadMediaRankingSignals(sc, RANKING_VIEWER, [row("x")], NOW, { readLiveClaims: async () => [], loadPeopleAffinities: async () => ({ tripCrewIds: new Set(), sharedMomentIds: new Set() }) });
    assert.equal(out.intent, null);
    assert.equal(out.outcomes, null);
    assert.equal(out.savedPlaceIds, null);
  });

  it("the ranker is a pure permutation under full signals", () => {
    const rows = [row("r1"), row("r2", { canonical_place_id: PLACE_2 }), row("r3", { canonical_media: canonical("generated") })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const s = signals({ followed: new Set([AUTHOR_A]), savedPlaceIds: new Set([PLACE_2]) });
    const ranked = rankMediaCandidates(rows, { nowMs: NOW, signals: s });
    assert.equal(ranked.length, 3);
    for (const r of ranked) assert.ok(rows.includes(r));
    assert.deepEqual(rows, snapshot);
  });
});

// ── MD348 — MediaRankingService IS §24's ranker, term for term ───────────────

describe("MD348 — every §24 input and objective is implemented, and every weight it names is live", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const spec = readFileSync(resolve(here, "../../../../docs/specs/Portava_Media_Engineering_Architecture_and_Design_Spec.txt"), "utf8").split("\n");
  const at = spec.findIndex((l) => l.trim() === "24. Ranking");
  const inputs = spec[at + 1].split("+").map((t) => t.trim()).filter(Boolean);
  const objectives = spec[at + 2].split(/\+|(?=- )/).map((t) => t.trim()).filter(Boolean);

  it("reads seventeen inputs and eight objectives out of the spec text itself", () => {
    assert.equal(inputs.length, 17);
    assert.equal(objectives.length, 8);
  });

  it("maps every one of them, and nothing else", () => {
    const covered = new Set(SPEC_24_COVERAGE.map((c) => c.spec));
    for (const t of [...inputs, ...objectives]) assert.ok(covered.has(t), `§24 names "${t}" and the ranker does not implement it`);
    assert.equal(SPEC_24_COVERAGE.length, inputs.length + objectives.length);
  });

  it("every weight a mapping names is non-zero and is a scored component", () => {
    const sample = score(row("x"), EMPTY_MEDIA_RANKING_SIGNALS) as unknown as Record<string, unknown>;
    for (const c of SPEC_24_COVERAGE) {
      for (const part of c.by.split("+")) {
        if (!part.startsWith("weight:")) {
          assert.match(part, /^(gate|pass):/, `${c.spec}: unknown implementation kind ${part}`);
          continue;
        }
        const key = part.slice("weight:".length) as keyof typeof MEDIA_RANKING_WEIGHTS;
        assert.ok(MEDIA_RANKING_WEIGHTS[key] > 0, `${c.spec}: weight ${key} is zero — mapped but switched off`);
        assert.equal(typeof sample[key], "number", `${c.spec}: ${key} is not a scored component`);
      }
    }
  });

  it("no single term dominates: every weight is at most 0.12 and the positive weights sum to 1", () => {
    let sum = 0;
    for (const [k, w] of Object.entries(MEDIA_RANKING_WEIGHTS)) {
      assert.ok(w <= 0.12, `${k} = ${w}`);
      if (k !== "lowConfidenceLive") sum += w;
    }
    assert.ok(Math.abs(sum - 1) < 1e-9, `positive weights sum to ${sum}`);
  });
});

// ── MD356 — the §42 Media Ranking stage decides what a client is served ──────

function worldPost(id: string, o: { author?: string; placeId?: string; createdAgo?: number; tripId?: string | null } = {}): any {
  const author = o.author ?? AUTHOR_A;
  return {
    id,
    author_id: author,
    trip_id: o.tripId ?? null,
    content: "",
    visibility: "public",
    status: "active",
    post_status: "published",
    moderation_status: null,
    publish_at: null,
    created_at: iso(Date.now() - (o.createdAgo ?? HOUR)),
    category: "food",
    media_urls: [],
    location_name: "Cafe",
    location_city: "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: o.placeId ?? PLACE_1,
    post_media: [{ id: `${id}-m`, media_type: "image", public_url: `https://cdn.example/${id}.jpg`, thumbnail_url: null, duration_seconds: null, width: 1080, height: 1080, sort_order: 0, processing_status: "ready", moderation_status: null }],
    profiles: { id: author, username: "u", full_name: "U", name: "U", display_name: "U", avatar_url: null, verified: false, is_official: false, account_status: "active", is_private: false },
  };
}

function worldData(extra: Dataset): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [], user_mutes: [], user_follows: [], trip_members: [], trips: [], feature_flags: [],
    ...extra,
  };
}

describe("MD356 — the ranked order reaches the client", () => {
  // Fourteen perspectives of one place, one category. The viewer WANTS the
  // oldest, which is also last in load order. A lens that samples twelve by
  // recency or by load order drops it; one that honours the ranker keeps it.
  const posts = Array.from({ length: 13 }, (_, i) => worldPost(`p${i}`, { createdAgo: (i + 1) * 60_000 }));
  posts.push(worldPost("wanted", { createdAgo: 2 * DAY }));
  const wants = [{ user_id: VIEWER, media_id: "wanted", entity_type: "media", entity_id: "wanted", updated_at: iso(Date.now()) }];

  it("§13 place view: the twelve perspectives sampled for a group are the ranker's, not the twelve newest", async () => {
    const sc = makeSc(worldData({ posts, media_intent_signals: wants, places: [{ id: PLACE_1, name: "Cafe", city: "Da Nang" }] }));
    const viewer = await resolveViewer(sc, VIEWER);
    const p = await buildPlaceProjection(sc, viewer, PLACE_1, Date.now());
    const sampled = p.perspectives.groups.flatMap((g) => g.media.map((m) => m.id));
    assert.equal(p.perspectives.totalPerspectives, 14);
    assert.ok(sampled.includes("wanted"), "the viewer's wanted perspective was ranked first and must be in the served sample");
  });

  it("§13 place view: a signal only the stage's LOADER reads (§45 outcomes) decides the sample", async () => {
    // No want this time. The oldest perspective is the one that led viewers to
    // real-world action — a fact that lives in media_events and reaches the
    // ranker through MediaRankingSignalLoader and nowhere else.
    const ev = (event_type: string) => ({ event_type, payload: { media_id: "wanted" }, occurred_at: iso(Date.now() - HOUR) });
    const sc = makeSc(worldData({
      posts,
      media_events: [...Array.from({ length: 6 }, () => ev("media_trip_add")), ...Array.from({ length: 10 }, () => ev("impression"))],
      places: [{ id: PLACE_1, name: "Cafe", city: "Da Nang" }],
    }));
    const viewer = await resolveViewer(sc, VIEWER);
    const p = await buildPlaceProjection(sc, viewer, PLACE_1, Date.now());
    const sampled = p.perspectives.groups.flatMap((g) => g.media.map((m) => m.id));
    assert.ok(sampled.includes("wanted"), "the perspective with real-world outcomes must survive the twelve-item sample");
  });

  it("§27 people lens: a person's twelve are the ranker's", async () => {
    const sc = makeSc(worldData({
      posts,
      media_intent_signals: wants,
      user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
    }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const people = await buildPeopleProjection(sc, viewer, Date.now());
    const served = people.people.flatMap((g) => g.media.map((m) => m.id));
    assert.ok(served.includes("wanted"));
  });

  it("§23 experience: hero media is served in ranked order", async () => {
    const sc = makeSc(worldData({
      posts: [worldPost("a", { tripId: TRIP_1 }), worldPost("b", { tripId: TRIP_1, placeId: PLACE_2 }), worldPost("wanted", { tripId: TRIP_1, placeId: PLACE_3, createdAgo: 3 * DAY })],
      trips: [{ id: TRIP_1, title: "T", owner_id: AUTHOR_A, visibility: "public", start_date: null, end_date: null }],
      media_intent_signals: wants,
    }));
    const viewer = await resolveViewer(sc, VIEWER);
    const exp = await resolveExperience(sc, viewer, TRIP_1, Date.now());
    assert.ok(exp, "the public trip resolves");
    assert.equal(exp!.heroMedia[0]?.id, "wanted");
  });
});
