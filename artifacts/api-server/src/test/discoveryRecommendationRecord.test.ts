/**
 * census-discovery §48 — the served-recommendation CONTRACT
 * (lib/discoveryRecommendationRecord.ts), pinned as pure properties.
 *
 * The route-level proof that these properties survive the real serve paths is
 * src/test/discoveryRecommendationPropagationE2E.test.ts; the database-level
 * proof of the constraints and the arbitration is src/test/db/. This file pins
 * what a contract must mean before anything is wired to it:
 *
 *   K1–K5   the id: every item, anonymous included; the exposure not the item;
 *           signed-in ids unchanged; instants canonicalised; per-request id
 *   K6–K8   the nine-field record, recoverable from the row and from the
 *           anonymous per-request row
 *   K9      the binding: cross-viewer, anonymous, stale, mismatched, duplicate
 *   K10     versioning agrees with the writer AND with migration 3375's CHECK
 *   K11–K13 privacy: every column and every ranker key classified; the screen
 *           refuses unclassified and precise-location keys
 *   K14     the replay predicate reads only 2891's index
 *   K15     one exposure per response object
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANONYMOUS_VIEWER_KEY, DISCOVERY_EVENT_SCHEMA_VERSION, DISCOVERY_EVENT_PRIVACY_CLASS,
  DISCOVERY_FEATURE_KEY_CLASSES, RANK_EVENTS_COLUMN_CLASSES, RECOMMENDATION_PROPAGATION_RULES,
  SUPPORTED_EVENT_SCHEMA_VERSIONS, bindOutcomeToExposure, canonicalServedAt, checkEventSchemaVersion,
  exposureForResponse, featureKeyClass, isDuplicateExposureReplay, mintServeExposure,
  recommendationRecordFromRankEventsRow, recommendationRecordsFor, recommendationRecordsFromServeRequest,
  screenFeaturesForStorage, serveIdFor, servedRecommendationId, stampServedRecommendations,
  unclassifiedColumns, type ServeExposure,
} from "../lib/discoveryRecommendationRecord.js";
import { recommendationIdFor, RECOMMENDATION_RECORD_FIELDS } from "../lib/discoveryRecommendationId.js";
import {
  DISCOVERY_EVENT_SCHEMA_VERSION as SERVE_LOG_SCHEMA_VERSION,
  DISCOVERY_EVENT_PRIVACY_CLASS as SERVE_LOG_PRIVACY_CLASS,
} from "../lib/discoveryServeLog.js";
import { scoreCandidate, PLACE_ENGAGEMENT_BOOST_THRESHOLD } from "../lib/portavaRank.js";
import { PRODUCTION_SNAPSHOT_URL } from "../lib/capability/snapshots/current.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../migrations");

const ALICE = "a11ce000-0000-4000-8000-000000000001";
const BOB   = "b0b00000-0000-4000-8000-000000000002";
const E: ServeExposure = { userId: ALICE, sessionId: "5e551011-0000-4000-8000-000000000001", servedAt: "2026-09-27T10:00:00.123Z" };

describe("§48 K1–K5 — the recommendation id", () => {
  it("K1. every served item is stamped, in order, and a REPEATED item gets two ids", () => {
    const items = [{ id: "db/a" }, { id: "node/1" }, { id: "db/a" }];
    const stamped = stampServedRecommendations(items, E);
    assert.equal(stamped.length, 3);
    assert.ok(stamped.every((s) => /^[A-Za-z0-9_-]{22}$/.test(s.recommendationId)));
    assert.equal(new Set(stamped.map((s) => s.recommendationId)).size, 3, "the same place at two positions is two exposures");
    assert.deepEqual(stamped.map((s) => s.id), items.map((i) => i.id), "order and ids preserved");
    assert.equal((items[0] as any).recommendationId, undefined, "the input is not mutated");
  });

  it("K2. an ANONYMOUS serve is stamped too, under a viewer key no UUID can equal", () => {
    const anon = mintServeExposure(null);
    const s = stampServedRecommendations([{ id: "x" }], anon);
    assert.match(s[0]!.recommendationId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(anon.userId, null);
    assert.doesNotMatch(ANONYMOUS_VIEWER_KEY, /^[0-9a-f-]{36}$/i, "never a UUID, so never a real viewer");
    const same = { ...anon, userId: ALICE };
    assert.notEqual(servedRecommendationId(anon, 0, "x"), servedRecommendationId(same, 0, "x"),
      "an anonymous id can never coincide with a signed-in viewer's id for the same exposure");
  });

  it("K3. a signed-in id is byte-identical to recommendationIdFor — no id already handed out changes", () => {
    assert.equal(
      servedRecommendationId(E, 3, "db/a"),
      recommendationIdFor({ userId: ALICE, sessionId: E.sessionId, servedAt: E.servedAt, surface: "discovery", position: 3, itemId: "db/a" }),
    );
  });

  it("K4. the id binds the EXPOSURE: viewer, session, instant, position and item each change it", () => {
    const base = servedRecommendationId(E, 0, "i");
    assert.notEqual(servedRecommendationId({ ...E, userId: BOB }, 0, "i"), base);
    assert.notEqual(servedRecommendationId({ ...E, sessionId: "other" }, 0, "i"), base);
    assert.notEqual(servedRecommendationId({ ...E, servedAt: "2026-09-27T10:00:00.124Z" }, 0, "i"), base);
    assert.notEqual(servedRecommendationId(E, 1, "i"), base);
    assert.notEqual(servedRecommendationId(E, 0, "j"), base);
  });

  it("K4b. PostgREST's '+00:00' spelling of the same instant yields the SAME id — a read-back re-derivation matches", () => {
    assert.equal(canonicalServedAt("2026-09-27T10:00:00.123+00:00"), "2026-09-27T10:00:00.123Z");
    assert.equal(
      servedRecommendationId({ ...E, servedAt: "2026-09-27T10:00:00.123+00:00" }, 2, "i"),
      servedRecommendationId(E, 2, "i"),
    );
    assert.equal(canonicalServedAt("not a time"), "not a time", "total: an unparseable value passes through");
  });

  it("K5. the per-request id is deterministic, in its own domain, and differs per request", () => {
    assert.equal(serveIdFor(E), serveIdFor({ ...E }));
    assert.match(serveIdFor(E), /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(serveIdFor(E), serveIdFor({ ...E, sessionId: "x" }));
    const itemIds = stampServedRecommendations([{ id: "a" }, { id: "b" }], E).map((s) => s.recommendationId);
    assert.ok(!itemIds.includes(serveIdFor(E)), "a request id never equals one of its items' ids");
  });
});

describe("§48 K6–K8 — the nine-field record", () => {
  it("K6. every one of 04 §5's nine fields, plus the denominator, is on each record", () => {
    const recs = recommendationRecordsFor(E, [{ id: "db/a", kind: "gem" }, { id: "node/1", kind: "place" }], {
      reasonCodesById: { "db/a": ["nearby_now"] },
    });
    assert.equal(recs.length, 2);
    const r = recs[0]!;
    assert.equal(RECOMMENDATION_RECORD_FIELDS.length, 9);
    assert.equal(r.recommendation_id, servedRecommendationId(E, 0, "db/a"));
    assert.equal(r.user_id, ALICE);
    assert.equal(r.session_id, E.sessionId);
    assert.equal(r.candidate_type, "gem");
    assert.equal(r.candidate_id, "db/a");
    assert.equal(r.surface, "discovery");
    assert.equal(r.rank_position, 0);
    assert.ok(r.model_version.length > 0);
    assert.deepEqual(r.reason_codes, ["nearby_now"]);
    assert.equal(r.served_at, E.servedAt);
    assert.equal(r.served_count, 2, "DV-06 — every record carries its request's size");
    assert.equal(r.serve_id, serveIdFor(E));
    assert.deepEqual(recs[1]!.reason_codes, [], "an item the ranker grounded nothing for claims nothing");
  });

  it("K7. the record is recoverable from a rank_events row AS READ BACK (column wins; '+00:00' instant)", () => {
    const rid = servedRecommendationId(E, 1, "node/1");
    const row = {
      surface: "discovery", user_id: ALICE, session_id: E.sessionId, item_id: "node/1", item_kind: "place", position: 1,
      served_at: "2026-09-27T10:00:00.123+00:00", recommendation_id: rid, schema_version: 1, privacy_class: "raw_behavioral_event",
      features: { recommendationId: rid, modelVersion: "m", reasonCodes: ["trending_local"], serveId: serveIdFor(E), servedCount: 4 },
    };
    const rec = recommendationRecordFromRankEventsRow(row)!;
    assert.equal(rec.recommendation_id, rid);
    assert.equal(rec.served_at, E.servedAt, "canonicalised on the way back");
    assert.equal(rec.served_count, 4);
    assert.equal(recommendationRecordFromRankEventsRow({ ...row, surface: "pulse" }), null, "not a Discovery exposure");
    assert.equal(recommendationRecordFromRankEventsRow({ ...row, recommendation_id: null, features: {} }), null,
      "a row that cannot name its own id is not the record 04 §5 asks for — never re-derived here");
  });

  it("K8. an ANONYMOUS serve's per-request row reproduces every id its response carried, with user_id null", () => {
    const anon = mintServeExposure(null, null, new Date("2026-09-27T11:00:00.000Z"));
    const items = [{ id: "db/a" }, { id: "node/7" }];
    const response = stampServedRecommendations(items, anon).map((s) => s.recommendationId);
    const row = {
      id: serveIdFor(anon), user_id: null, viewer_class: "anonymous", session_id: anon.sessionId,
      served_at: "2026-09-27T11:00:00+00:00", item_ids: ["db/a", "node/7"], item_kinds: ["gem", "place"], model_version: "m",
    };
    const recs = recommendationRecordsFromServeRequest(row);
    assert.deepEqual(recs.map((r) => r.recommendation_id), response);
    assert.ok(recs.every((r) => r.user_id === null), "never a sentinel user");
    assert.deepEqual(recs.map((r) => r.candidate_type), ["gem", "place"]);
  });
});

describe("§48 K9 — an outcome binds to the exposure its id names, for THIS viewer only", () => {
  const up = ["impression", "tap"];
  const row = { id: "r1", user_id: ALICE, item_id: "db/a", surface: "discovery", outcome: "impression" };
  const body = { item_id: "db/a", surface: "discovery", outcome: "save" };
  it("bound", () => assert.deepEqual(bindOutcomeToExposure({ callerUserId: ALICE, body, row, upgradable: up }), { kind: "bound", rowId: "r1" }));
  it("no row (cross-viewer lookup, unknown or anonymous id) → not_found", () =>
    assert.deepEqual(bindOutcomeToExposure({ callerUserId: BOB, body, row: null, upgradable: up }), { kind: "not_found" }));
  it("a row owned by somebody else is refused even if a lookup lost its user filter", () =>
    assert.deepEqual(bindOutcomeToExposure({ callerUserId: BOB, body, row, upgradable: up }), { kind: "not_found" }));
  it("a different item or surface → mismatch", () => {
    assert.deepEqual(bindOutcomeToExposure({ callerUserId: ALICE, body: { ...body, item_id: "db/b" }, row, upgradable: up }), { kind: "mismatch", field: "item_id" });
    assert.deepEqual(bindOutcomeToExposure({ callerUserId: ALICE, body: { ...body, surface: "pulse" }, row, upgradable: up }), { kind: "mismatch", field: "surface" });
  });
  it("the outcome already recorded → duplicate; moved past it → not_upgradable (stale)", () => {
    assert.deepEqual(bindOutcomeToExposure({ callerUserId: ALICE, body, row: { ...row, outcome: "save" }, upgradable: up }), { kind: "duplicate", rowId: "r1" });
    assert.deepEqual(bindOutcomeToExposure({ callerUserId: ALICE, body, row: { ...row, outcome: "attended" }, upgradable: up }), { kind: "not_upgradable", current: "attended" });
  });
  it("the propagation rules name every hop, and the binding hop names the refusals", () => {
    assert.deepEqual(RECOMMENDATION_PROPAGATION_RULES.map((r) => r.hop), [1, 2, 3, 4, 5]);
    assert.match(RECOMMENDATION_PROPAGATION_RULES[3]!.rule, /another viewer's id.*credits nothing/);
  });
});

describe("§48 K10 — versioned (DV-38): the contract, the writer and migration 3375 agree", () => {
  it("absent ⇒ current; supported ⇒ accepted; unknown, fractional or stringly ⇒ refused", () => {
    assert.deepEqual(checkEventSchemaVersion(undefined), { ok: true, version: 1, defaulted: true });
    assert.deepEqual(checkEventSchemaVersion(1), { ok: true, version: 1, defaulted: false });
    for (const bad of [2, 0, -1, 1.5, "1", {}, true]) assert.equal(checkEventSchemaVersion(bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  });
  it("the writer's constant is the contract's, and 3375's CHECK admits exactly the supported set", () => {
    assert.equal(SERVE_LOG_SCHEMA_VERSION, DISCOVERY_EVENT_SCHEMA_VERSION);
    assert.ok(SUPPORTED_EVENT_SCHEMA_VERSIONS.includes(DISCOVERY_EVENT_SCHEMA_VERSION));
    const sql = readFileSync(resolve(MIGRATIONS, "3375_rank_events_schema_version_admitted.sql"), "utf8");
    const m = /CHECK \(schema_version IN \(([0-9, ]+)\)\)/.exec(sql);
    assert.ok(m, "3375 declares the version CHECK");
    assert.deepEqual(m![1]!.split(",").map((s) => Number(s.trim())), [...SUPPORTED_EVENT_SCHEMA_VERSIONS],
      "bump the version and the migration together — a version the database refuses, or admits with no reader, is the defect");
  });
});

describe("§48 K11–K13 — privacy-classified (DV-39): each field has a class, and the unclassified never reach storage", () => {
  it("K11. every rank_events column production carries is classified", () => {
    const snap = JSON.parse(readFileSync(PRODUCTION_SNAPSHOT_URL, "utf8"));
    const cols: string[] = snap.tables.rank_events;
    assert.ok(cols.length >= 19, "precondition: the snapshot has the 2890/2891 columns");
    assert.deepEqual(unclassifiedColumns(Object.fromEntries(cols.map((c) => [c, 1]))), [],
      "a column production holds with no class is a field nobody decided the privacy of");
    assert.equal(DISCOVERY_EVENT_PRIVACY_CLASS, SERVE_LOG_PRIVACY_CLASS);
  });

  it("K12. every feature key the ranker can emit is classified — a new one must be classified before it is stored", () => {
    const now = Date.now();
    const s = scoreCandidate(
      { id: "c", kind: "event", authorId: "a", tags: ["t"], category: "food", city: "Lisbon", neighborhood: "Alfama",
        distanceKm: 1, startsAt: new Date(now + 3_600_000).toISOString(), createdAt: new Date(now).toISOString(),
        authorTrustScore: 50, verified: true, hasCapacity: true, isOfficialPublisher: true, placeId: "p" } as any,
      { followedIds: new Set(["a"]), mutualIds: new Set(["a"]), engagedAuthorIds: new Set(["a"]), interestTags: new Set(["t"]),
        categoryAffinities: { food: 1 }, city: "Lisbon", neighborhood: "Alfama", seenIds: new Set(["c"]),
        localMomentum: { c: 1 }, trailAffinity: { c: 1 }, placeAffinities: { p: PLACE_ENGAGEMENT_BOOST_THRESHOLD }, nowMs: now } as any,
      undefined, true,
    );
    const keys = Object.keys(s.features);
    assert.ok(keys.includes("officialPublisher") && keys.includes("placeEngagement"), "precondition: the conditional keys were reached");
    const unclassified = keys.filter((k) => featureKeyClass(k) === null);
    assert.deepEqual(unclassified, [], "classify these in DISCOVERY_FEATURE_KEY_CLASSES — until then the writers refuse to store them");
  });

  it("K13. the screen keeps classified keys and REFUSES unclassified and precise-location ones, by name only", () => {
    const { kept, refused } = screenFeaturesForStorage({ destination: "Lisbon", distance: 0.3, lat: 38.7, homeLat: 1, mystery: "x", sessionNote: 7 });
    assert.deepEqual(Object.keys(kept).sort(), ["destination", "distance"]);
    assert.deepEqual(refused.sort(), ["homeLat", "lat", "mystery", "sessionNote"]);
    assert.equal(featureKeyClass("lat"), "precise_location");
    assert.equal(featureKeyClass("latitude"), "precise_location", "a key whose class says 'safe' cannot launder a position");
    assert.ok(Object.values(DISCOVERY_FEATURE_KEY_CLASSES).every((c) => c !== "precise_location"), "no registry entry may classify a position as storable");
    assert.deepEqual(unclassifiedColumns({ user_id: 1, surprise_column: 1 }), ["surprise_column"]);
    assert.ok(Object.keys(RANK_EVENTS_COLUMN_CLASSES).includes("recommendation_id"));
  });
});

describe("§48 K14–K15", () => {
  it("K14. only a 23505 on 2891's (recommendation_id, outcome) index is a replay", () => {
    assert.equal(isDuplicateExposureReplay({ code: "23505", message: 'duplicate key value violates unique constraint "rank_events_recommendation_idempotency_idx"' }), true);
    assert.equal(isDuplicateExposureReplay({ code: "23505", message: "dup", details: "Key (recommendation_id, outcome)=(x, impression) already exists." }), true);
    assert.equal(isDuplicateExposureReplay({ code: "23505", message: 'duplicate key value violates unique constraint "rank_events_pkey"' }), false,
      "a primary-key collision is a real refusal, not an idempotent replay");
    assert.equal(isDuplicateExposureReplay({ code: "23514", message: "rank_events_recommendation_idempotency_idx" }), false);
    assert.equal(isDuplicateExposureReplay(null), false);
  });

  it("K15. one exposure per response object, however many call sites ask", () => {
    const resA = {};
    const resB = {};
    const a1 = exposureForResponse(resA, ALICE, "s-1");
    const a2 = exposureForResponse(resA, BOB, "s-2");
    assert.equal(a1, a2, "the first minting IS the exposure");
    assert.equal(a1.sessionId, "s-1");
    assert.notEqual(exposureForResponse(resB, ALICE), a1);
    assert.equal(exposureForResponse({}, null).userId, null);
    assert.equal(exposureForResponse({}, "").userId, null, "an empty id is anonymous, never a viewer named ''");
  });
});
