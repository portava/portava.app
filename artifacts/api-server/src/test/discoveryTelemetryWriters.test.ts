/**
 * census-discovery §48 — the two Discovery telemetry WRITERS, pinned at the
 * writer (lib/discoveryServeLog.ts, lib/rankLog.ts).
 *
 *   W1  DV-38/39: the version and class are WRITTEN as columns; every exposure
 *       carries its request's id and size (DV-06); an unclassified key is
 *       REFUSED before insert and named on the row.
 *   W2  DV-37: a replay (23505 on 2891's index) is a duplicate — not counted as
 *       a lost write, and the denominator does not move twice. A 23505 on any
 *       OTHER constraint is still a rejection.
 *   W3–W6 the per-request row: anonymous (no user-keyed row, user_id null, and
 *       a coordinate cannot even reach its context hash); an empty serve; the
 *       latch where 3376 is absent; nothing at all with the flag off.
 *   W7–W9 lib/rankLog.logImpression on Discovery: the id at the SERVED position,
 *       the PDE model, grounded reasons only, the screen; pulse untouched; a
 *       replay moves no denominator; a missing 2890/2891 degrades once.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  logDiscoveryServe, DiscoveryServePoint, invalidateServeLogFlagCache, _resetServeRequestTableLatch,
  serveContextHash, buildServeRequestRow,
} from "../lib/discoveryServeLog.js";
import { logImpression } from "../lib/rankLog.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  rankEventsRejectionSnapshot, _resetRankEventsRejections, _resetRecommendationIdSchemaLatch,
} from "../lib/rankEventsProvenance.js";
import { servedRecommendationId, serveIdFor } from "../lib/discoveryRecommendationRecord.js";
import { DISCOVERY_PDE_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";
import type { ScoredCandidate, RankCandidate } from "../lib/portavaRank.js";

const USER = "a11ce000-0000-4000-8000-00000000000a";
const ARBITER_DUP = { code: "23505", message: 'duplicate key value violates unique constraint "rank_events_recommendation_idempotency_idx"' };

function fake(opts: {
  flag?: boolean;
  insertErrors?: unknown[];
  rpcAnswer?: (name: string, params: any) => { data: unknown; error: unknown };
} = {}) {
  const inserts: Array<{ table: string; rows: any[] }> = [];
  const rpcs: Array<{ name: string; params: any }> = [];
  const errors = [...(opts.insertErrors ?? [])];
  const client: any = {
    from(table: string) {
      if (table === "feature_flags") {
        const q: any = {
          select: () => q, eq: () => q,
          maybeSingle: async () => ({ data: opts.flag === false ? null : { enabled: true }, error: null }),
        };
        return q;
      }
      return {
        insert(rows: any) {
          const list = Array.isArray(rows) ? rows : [rows];
          inserts.push({ table, rows: list });
          const error = errors.length > 0 ? errors.shift() : null;
          return Promise.resolve({ data: null, error });
        },
      };
    },
    rpc: async (name: string, params: any) => {
      rpcs.push({ name, params });
      return opts.rpcAnswer ? opts.rpcAnswer(name, params) : { data: "written", error: null };
    },
  };
  return {
    client, inserts, rpcs,
    rankRows: () => inserts.filter((i) => i.table === "rank_events").flatMap((i) => i.rows),
    rpcNamed: (n: string) => rpcs.filter((r) => r.name === n),
  };
}

const E = { sessionId: "5e551011-0000-4000-8000-00000000000a", servedAt: "2026-09-27T10:00:00.000Z" };
const ITEMS = [{ id: "node/1" }, { id: "db/22222222-2222-2222-2222-222222222222" }, { id: "way/3" }];

beforeEach(() => {
  invalidateServeLogFlagCache();
  _resetServeRequestTableLatch();
  _resetRankEventsRejections();
  _resetRecommendationIdSchemaLatch();
});
afterEach(() => _setTestServiceClient(null as any));

describe("§48 — lib/discoveryServeLog", () => {
  it("W1. the version and class are columns, every exposure names its request, and an unclassified key is refused", async () => {
    const f = fake();
    await logDiscoveryServe(f.client, {
      userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E,
      context: { destination: "Lisbon", mystery: "leak?", lat: 38.7 },
    });
    const rows = f.rankRows();
    assert.equal(rows.length, 3);
    const serveId = serveIdFor({ userId: USER, ...E });
    for (const r of rows) {
      assert.equal(r.schema_version, 1, "DV-38: written, not defaulted");
      assert.equal(r.privacy_class, "raw_behavioral_event", "DV-39: written, not defaulted");
      assert.equal(r.features.serveId, serveId, "DV-06: the exposure names its request");
      assert.equal(r.features.servedCount, 3, "DV-06: and carries the request's size");
      assert.equal(r.features.destination, "Lisbon", "a classified key is kept");
      assert.equal("mystery" in r.features, false, "DV-39: an unclassified key never reaches storage");
      assert.equal("lat" in r.features, false, "04 §12: a position never reaches storage");
      assert.deepEqual(r.features.privacyRefused, ["mystery"], "the refusal is visible on the row, by name only");
      assert.deepEqual(r.features.privacyDropped, ["lat"]);
      assert.equal(r.recommendation_id, servedRecommendationId({ userId: USER, ...E }, r.position, r.item_id));
    }
    const req = f.rpcNamed("record_discovery_serve_request");
    assert.equal(req.length, 1);
    assert.equal(req[0]!.params.p_row.id, serveId);
    assert.equal(req[0]!.params.p_row.served_count, 3);
  });

  it("W2. a REPLAY is a duplicate: no rejection counted, no second denominator increment; another 23505 is a rejection", async () => {
    const replay = fake({ insertErrors: [ARBITER_DUP] });
    await logDiscoveryServe(replay.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    assert.deepEqual(rankEventsRejectionSnapshot(), [], "the index refusing a replay is idempotency working, not a lost write");
    assert.equal(replay.rpcNamed("increment_distribution_stats").length, 0, "the replay moved no denominator");

    const fresh = fake();
    await logDiscoveryServe(fresh.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    assert.equal(fresh.rpcNamed("increment_distribution_stats").length, 3, "control: a first landing does move it, once per item");

    const pkey = fake({ insertErrors: [{ code: "23505", message: 'duplicate key value violates unique constraint "rank_events_pkey"' }] });
    await logDiscoveryServe(pkey.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    assert.equal(rankEventsRejectionSnapshot().length, 1, "a primary-key collision is a real refusal and is counted");
    assert.equal(rankEventsRejectionSnapshot()[0]!.constraint, "rank_events_pkey");
  });

  it("W3. an ANONYMOUS serve writes no rank_events row and one per-request row with user_id null — and a coordinate cannot reach its hash", async () => {
    const f = fake();
    await logDiscoveryServe(f.client, {
      userId: "", servePoint: DiscoveryServePoint.COMMUNITY, items: ITEMS, route: "/discovery/community", ...E,
      context: { city: "Lisbon", lat: 38.7123 },
    });
    assert.deepEqual(f.rankRows(), [], "nobody to attribute an exposure row to");
    const req = f.rpcNamed("record_discovery_serve_request");
    assert.equal(req.length, 1);
    const row = req[0]!.params.p_row;
    assert.equal(row.user_id, null);
    assert.equal(row.viewer_class, "anonymous");
    assert.deepEqual(row.item_ids, ITEMS.map((i) => i.id));
    assert.equal(row.context_hash, serveContextHash({ city: "Lisbon" }), "the coordinate was withheld BEFORE hashing");
    assert.equal(JSON.stringify(row).includes("38.7123"), false);
  });

  it("W4. a signed-in serve of NOTHING is still a request: served_count 0, no item rows", async () => {
    const f = fake();
    await logDiscoveryServe(f.client, { userId: USER, servePoint: DiscoveryServePoint.FEED, items: [], ...E });
    assert.deepEqual(f.rankRows(), []);
    const row = f.rpcNamed("record_discovery_serve_request")[0]!.params.p_row;
    assert.equal(row.served_count, 0);
    assert.equal(row.viewer_class, "signed_in");
    assert.equal(row.user_id, USER);
  });

  it("W5. where 3376 is absent the per-request writer says so once and stops asking; item rows are unaffected", async () => {
    const f = fake({ rpcAnswer: () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) });
    await logDiscoveryServe(f.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    await logDiscoveryServe(f.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    assert.equal(f.rpcNamed("record_discovery_serve_request").length, 1, "latched after the first PGRST202");
    assert.equal(f.rankRows().length, 6, "both serves' exposure rows landed");
  });

  it("W6. with the flag off NOTHING is written — anonymous, empty or signed-in", async () => {
    const f = fake({ flag: false });
    await logDiscoveryServe(f.client, { userId: "", servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    await logDiscoveryServe(f.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: [], ...E });
    await logDiscoveryServe(f.client, { userId: USER, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, ...E });
    assert.deepEqual(f.inserts, []);
    assert.deepEqual(f.rpcNamed("record_discovery_serve_request"), []);
  });

  it("W6b. the per-request row satisfies every CHECK 3376 declares (shape, pairing, counts, vocabularies)", () => {
    for (const userId of [USER, null]) {
      const row = buildServeRequestRow({ userId, ...E, servePoint: DiscoveryServePoint.SEARCH, items: [{ id: "c", kind: null }, { id: "db/x" }] });
      assert.match(row.id as string, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(row.viewer_class === "anonymous", row.user_id === null);
      assert.equal((row.item_ids as string[]).length, row.served_count);
      assert.equal((row.item_kinds as string[]).length, row.served_count);
      assert.deepEqual(row.item_kinds, ["", "gem"], "a kind-less search result is '' — never NULL, which the CHECK refuses");
      assert.ok((row.serve_point as number) >= 1 && (row.serve_point as number) <= 12);
    }
  });
});

function scored(id: string, features: Record<string, number>): ScoredCandidate<RankCandidate> {
  return { candidate: { id, kind: "place" } as RankCandidate, score: 1, features };
}

async function settle() { await new Promise((r) => setTimeout(r, 20)); }

describe("§48 — lib/rankLog.logImpression on Discovery", () => {
  it("W7. the id is minted at the SERVED position; the PDE model is named; only grounded reasons; the screen applies", async () => {
    const f = fake();
    _setTestServiceClient(f.client);
    const exposure = { userId: USER, ...E };
    // The served page has an item the ranker said nothing about in the MIDDLE,
    // so the scored subset's index is NOT the served position.
    const servedIds = ["db/a", "node/unscored", "db/b"];
    await logImpression(
      [scored("db/a", { distance: 0.4, trust: 0.9, seenPenalty: -0.2 }), scored("db/b", { interestTag: 0.3 })],
      USER, "discovery", E.sessionId,
      { servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK, route: "GET /discovery", rankedInRequest: true, mystery: "x" },
      { servedAt: E.servedAt, servedIds },
    );
    await settle();
    const rows = f.rankRows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.position), [0, 2], "db/b was SERVED at position 2");
    assert.equal(rows[1].recommendation_id, servedRecommendationId(exposure, 2, "db/b"), "the id the response carried for position 2");
    assert.equal(rows[1].features.recommendationId, rows[1].recommendation_id);
    assert.equal(rows[0].features.modelVersion, DISCOVERY_PDE_MODEL_VERSION);
    assert.deepEqual(rows[0].features.reasonCodes, ["nearby_now"], "trust and a penalty are never reasons FOR");
    assert.deepEqual(rows[1].features.reasonCodes, ["saved_similar"]);
    assert.equal(rows[0].features.servedCount, 3, "the request served three, whatever the ranker scored");
    assert.equal("mystery" in rows[0].features, false);
    assert.deepEqual(rows[0].features.privacyRefused, ["mystery"]);
    assert.equal(rows[0].schema_version, 1);
    const req = f.rpcNamed("record_discovery_serve_request");
    assert.equal(req.length, 1);
    assert.deepEqual(req[0]!.params.p_row.item_ids, servedIds, "the request row is the page, not the ranked subset");
  });

  it("W8. pulse rows are byte-for-byte the historical shape: no token, no record keys, no request row", async () => {
    const f = fake();
    _setTestServiceClient(f.client);
    await logImpression([scored("post-1", { recency: 0.5, lat: 1 as any })], USER, "pulse");
    await settle();
    const row = f.rankRows()[0]!;
    assert.equal("recommendation_id" in row, false);
    assert.equal("schema_version" in row, false);
    assert.deepEqual(Object.keys(row.features).sort(), ["recency"], "only the ranker's own (coordinate-stripped) features");
    assert.deepEqual(f.rpcNamed("record_discovery_serve_request"), []);
  });

  it("W9. a replayed batch moves no denominator; a database without 2890/2891 is retried once without the three columns", async () => {
    const replay = fake({ insertErrors: [ARBITER_DUP] });
    _setTestServiceClient(replay.client);
    await logImpression([scored("db/a", { distance: 0.4 })], USER, "discovery", E.sessionId,
      { servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK }, { servedAt: E.servedAt, servedIds: ["db/a"] });
    await settle();
    assert.equal(replay.rpcNamed("increment_distribution_stats").length, 0, "the replay already moved it once");

    const old = fake({ insertErrors: [{ code: "PGRST204", message: "Could not find the 'recommendation_id' column of 'rank_events' in the schema cache" }] });
    _setTestServiceClient(old.client);
    await logImpression([scored("db/a", { distance: 0.4 })], USER, "discovery", E.sessionId,
      { servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK }, { servedAt: E.servedAt, servedIds: ["db/a"] });
    await settle();
    const [first, second] = old.inserts.filter((i) => i.table === "rank_events");
    assert.ok(first && second, "one attempt and one retry");
    assert.ok("recommendation_id" in first.rows[0]);
    for (const col of ["recommendation_id", "schema_version", "privacy_class"]) {
      assert.equal(col in second.rows[0], false, `${col} is OMITTED on the retry, never nulled`);
    }
    assert.equal(second.rows[0].features.recommendationId, first.rows[0].recommendation_id, "the token survives in features");
    assert.equal(old.rpcNamed("increment_distribution_stats").length, 1, "the retried batch landed and counted once");
  });
});
