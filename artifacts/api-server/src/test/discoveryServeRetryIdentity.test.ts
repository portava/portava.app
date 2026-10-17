import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DiscoveryServePoint, _resetServeRequestTableLatch, invalidateServeLogFlagCache,
  logDiscoveryServe, type DiscoveryServeLogParams,
} from "../lib/discoveryServeLog.js";
import {
  bindOutcomeToExposure, discoveryExposureRowIdFor, isDuplicateDiscoveryExposureRow,
  recommendationRecordsFromServeRequest, servedRecommendationId, stampServedRecommendations,
} from "../lib/discoveryRecommendationRecord.js";
import {
  _resetRankEventsRejections, _resetRecommendationIdSchemaLatch, rankEventsRejectionSnapshot,
} from "../lib/rankEventsProvenance.js";
import { logImpression } from "../lib/rankLog.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import type { RankCandidate, ScoredCandidate } from "../lib/portavaRank.js";

const ALICE = "a11ce000-0000-4000-8000-000000000001";
const BOB = "b0b00000-0000-4000-8000-000000000002";
const PARAMS: DiscoveryServeLogParams = {
  userId: ALICE,
  sessionId: "5e551011-0000-4000-8000-000000000001",
  servedAt: "2026-10-16T10:00:00.123Z",
  servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
  items: [{ id: "node/1001" }, { id: "node/1002" }],
};

type StoredRow = Record<string, any>;

function constraintClient(options: {
  flag?: boolean;
  fatigueFlag?: boolean;
  advanceFirstInsert?: boolean;
  rejectFirstInsert?: boolean;
  loseFirstInsertResponse?: boolean;
  missingSchema?: boolean;
} = {}) {
  const rows: StoredRow[] = [];
  const requests = new Map<string, StoredRow>();
  const increments: StoredRow[] = [];
  const fatigue: StoredRow[] = [];
  const attempts: StoredRow[][] = [];
  const advance = () => rows.forEach((row) => { row.outcome = "save"; });
  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        const query = {
          select() { return query; },
          eq(_column: string, flag: string) { query.flag = flag; return query; },
          flag: "",
          async maybeSingle() {
            const enabled = query.flag === "CREATOR_FATIGUE_ENABLED" ? options.fatigueFlag === true
              : options.flag !== false && query.flag === "discovery_serve_log_enabled";
            return { data: { enabled }, error: null };
          },
        };
        return query;
      }
      assert.equal(table, "rank_events");
      return {
        async insert(batch: StoredRow[]) {
          attempts.push(structuredClone(batch));
          if (options.missingSchema && batch.some((row) => "recommendation_id" in row)) {
            return { error: { code: "42703", message: "column rank_events.recommendation_id does not exist" } };
          }
          if (options.rejectFirstInsert && attempts.length === 1) {
            return { error: { code: "57014", message: "statement timeout" } };
          }
          for (const row of batch) {
            if (row.id && rows.some((stored) => stored.id === row.id)) {
              return { error: { code: "23505", message: 'duplicate key value violates unique constraint "rank_events_pkey"', details: `Key (id)=(${row.id}) already exists.` } };
            }
            if (row.recommendation_id && rows.some((stored) => stored.recommendation_id === row.recommendation_id && stored.outcome === row.outcome)) {
              return { error: { code: "23505", message: 'duplicate key value violates unique constraint "rank_events_recommendation_idempotency_idx"' } };
            }
          }
          rows.push(...structuredClone(batch).map((row) => ({ ...row, id: row.id ?? randomUUID() })));
          if (options.advanceFirstInsert && attempts.length === 1) advance();
          if (options.loseFirstInsertResponse && attempts.length === 1) throw new Error("commit response lost");
          return { error: null };
        },
      };
    },
    async rpc(name: string, args: StoredRow) {
      if (name === "record_discovery_serve_request") {
        const row = args.p_row;
        if (requests.has(row.id)) return { data: "duplicate", error: null };
        requests.set(row.id, structuredClone(row));
        return { data: "written", error: null };
      }
      if (name === "increment_creator_fatigue_batch") {
        fatigue.push(args);
        return { data: null, error: null };
      }
      assert.equal(name, "increment_distribution_stats");
      increments.push(args);
      return { data: null, error: null };
    },
  };
  return { client, rows, requests, increments, fatigue, attempts, advance };
}

beforeEach(() => {
  invalidateServeLogFlagCache();
  _resetServeRequestTableLatch();
  _resetRecommendationIdSchemaLatch();
  _resetRankEventsRejections();
});
afterEach(() => _setTestServiceClient(null as any));

const writers = {
  serve: async (client: any, params: DiscoveryServeLogParams) => logDiscoveryServe(client, params),
  ranked: async (client: any, params: DiscoveryServeLogParams) => {
    _setTestServiceClient(client);
    const scored = params.items.map((item) => ({
      candidate: { id: item.id, kind: "place" }, features: {}, score: 1,
    })) as ScoredCandidate<RankCandidate>[];
    await logImpression(scored, params.userId, "discovery", params.sessionId, { servePoint: params.servePoint }, {
      servedAt: params.servedAt, servedIds: params.items.map((item) => item.id),
    });
  },
};

for (const [name, write] of Object.entries(writers)) {
  describe(`Discovery ${name} semantic retry identity`, () => {
    it("does not resurrect impressions after EVERY outcome has advanced", async () => {
      const fake = constraintClient();
      await write(fake.client, PARAMS);
      const firstIds = fake.rows.map((row) => row.id);
      fake.advance();
      await write(fake.client, PARAMS);
      assert.equal(fake.rows.length, PARAMS.items.length);
      assert.deepEqual(fake.rows.map((row) => row.id), firstIds);
      assert.ok(fake.rows.every((row) => row.outcome === "save"));
      assert.equal(fake.requests.size, 1);
      assert.equal(fake.increments.length, PARAMS.items.length);
      assert.deepEqual(rankEventsRejectionSnapshot(), []);
    });

    it("arbitrates concurrent copies even when outcomes advance before the delayed insert", async () => {
      const fake = constraintClient({ advanceFirstInsert: true });
      await Promise.all([write(fake.client, PARAMS), write(fake.client, { ...PARAMS })]);
      assert.equal(fake.rows.length, PARAMS.items.length);
      assert.equal(fake.increments.length, PARAMS.items.length);
      assert.equal(fake.requests.size, 1);
      assert.deepEqual(rankEventsRejectionSnapshot(), []);
    });

    it("arbitrates ordinary concurrent copies without relying on a process-local cache", async () => {
      const fake = constraintClient();
      await Promise.all(Array.from({ length: 8 }, () => write(fake.client, { ...PARAMS })));
      assert.equal(fake.rows.length, PARAMS.items.length);
      assert.equal(fake.increments.length, PARAMS.items.length);
      assert.equal(fake.attempts.length, 8);
      assert.deepEqual(rankEventsRejectionSnapshot(), []);
    });

    it("does not resurrect a single-item serve or a partially advanced batch", async () => {
      for (const items of [[PARAMS.items[0]!], PARAMS.items]) {
        const fake = constraintClient();
        const params = { ...PARAMS, items };
        await write(fake.client, params);
        fake.rows[0]!.outcome = "tap";
        await write(fake.client, params);
        assert.equal(fake.rows.length, items.length);
        assert.equal(fake.rows[0]!.outcome, "tap");
        assert.equal(fake.increments.length, items.length);
      }
    });

    it("does not use a duplicate request receipt to skip recovery of a failed item insert", async () => {
      const fake = constraintClient({ rejectFirstInsert: true });
      await write(fake.client, PARAMS);
      assert.equal(fake.requests.size, 1);
      assert.equal(fake.rows.length, 0);
      await write(fake.client, PARAMS);
      assert.equal(fake.rows.length, PARAMS.items.length);
      assert.equal(fake.requests.size, 1);
      assert.equal(fake.increments.length, PARAMS.items.length);
    });

    it("does not create a second exposure after a commit response is lost", async () => {
      const fake = constraintClient({ loseFirstInsertResponse: true });
      await write(fake.client, PARAMS);
      fake.advance();
      await write(fake.client, PARAMS);
      assert.equal(fake.rows.length, PARAMS.items.length);
      assert.equal(fake.increments.length, 0, "lost acknowledgements cannot certify the separate counter write");
    });

    it("isolates concurrent viewers and preserves the client recommendation tokens", async () => {
      const fake = constraintClient();
      await Promise.all([write(fake.client, PARAMS), write(fake.client, { ...PARAMS, userId: BOB })]);
      assert.equal(fake.rows.length, 4);
      assert.equal(new Set(fake.rows.map((row) => row.id)).size, 4);
      assert.equal(fake.requests.size, 2);
      for (const row of fake.rows) {
        assert.equal(row.recommendation_id, servedRecommendationId({
          userId: row.user_id, sessionId: PARAMS.sessionId!, servedAt: PARAMS.servedAt!,
        }, row.position, row.item_id));
        assert.deepEqual(bindOutcomeToExposure({
          callerUserId: row.user_id === ALICE ? BOB : ALICE,
          body: { item_id: row.item_id, surface: "discovery", outcome: "save" },
          row, upgradable: ["impression"],
        }), { kind: "not_found" });
      }
    });

    it("keeps repeated positions and genuinely new serves distinct", async () => {
      const fake = constraintClient();
      const params = { ...PARAMS, items: [PARAMS.items[0]!, PARAMS.items[0]!] };
      await write(fake.client, params);
      await write(fake.client, { ...params, servedAt: "2026-10-16T10:00:00.124Z" });
      assert.equal(fake.rows.length, 4);
      assert.equal(new Set(fake.rows.map((row) => row.recommendation_id)).size, 4);
      assert.equal(new Set(fake.rows.map((row) => row.id)).size, 4);
    });

    it("retains the pre-provenance fallback payload when the schema is absent", async () => {
      const fake = constraintClient({ missingSchema: true });
      await write(fake.client, PARAMS);
      assert.equal(fake.attempts.length, 2);
      assert.equal(fake.rows.length, PARAMS.items.length);
      for (const row of fake.attempts[1]!) {
        for (const column of ["id", "recommendation_id", "schema_version", "privacy_class"]) {
          assert.equal(column in row, false);
        }
      }
      await write(fake.client, PARAMS);
      assert.equal(fake.attempts.length, 3);
      assert.ok(fake.attempts[2]!.every((row) => !("id" in row) && !("recommendation_id" in row)));
    });
  });
}

it("the two Discovery writers share the same immutable exposure identity", async () => {
  for (const order of [[writers.serve, writers.ranked], [writers.ranked, writers.serve]]) {
    const fake = constraintClient();
    await order[0]!(fake.client, PARAMS);
    fake.advance();
    await order[1]!(fake.client, PARAMS);
    assert.equal(fake.rows.length, PARAMS.items.length);
    assert.equal(fake.increments.length, PARAMS.items.length);
    assert.equal(fake.requests.size, 1);
    assert.deepEqual(rankEventsRejectionSnapshot(), []);
  }
});

it("anonymous concurrent retries preserve one request and recover the served tokens without user attribution", async () => {
  const fake = constraintClient();
  const params = { ...PARAMS, userId: "" };
  await Promise.all(Array.from({ length: 8 }, () => logDiscoveryServe(fake.client, params)));
  assert.equal(fake.requests.size, 1);
  assert.equal(fake.attempts.length, 0);
  assert.equal(fake.increments.length, 0);
  const request = [...fake.requests.values()][0]!;
  assert.equal(request.user_id, null);
  const records = recommendationRecordsFromServeRequest(request);
  const stamped = stampServedRecommendations(PARAMS.items, {
    userId: null, sessionId: PARAMS.sessionId!, servedAt: PARAMS.servedAt!,
  });
  assert.deepEqual(records.map((row) => row.recommendation_id), stamped.map((item) => item.recommendationId));
  assert.ok(records.every((row) => row.user_id === null));
});

it("only a primary-key collision naming this batch's derived row is a replay", () => {
  const recommendationId = servedRecommendationId({
    userId: ALICE, sessionId: PARAMS.sessionId!, servedAt: PARAMS.servedAt!,
  }, 0, PARAMS.items[0]!.id);
  const row = { id: discoveryExposureRowIdFor(recommendationId), recommendation_id: recommendationId };
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const error = {
    code: "23505", message: 'duplicate key value violates unique constraint "rank_events_pkey"',
    details: `Key (id)=(${row.id}) already exists.`,
  };
  assert.equal(isDuplicateDiscoveryExposureRow(error, [row]), true);
  assert.equal(isDuplicateDiscoveryExposureRow(error, []), false);
  assert.equal(isDuplicateDiscoveryExposureRow(error, [{ ...row, recommendation_id: "not-a-token" }]), false);
  assert.equal(isDuplicateDiscoveryExposureRow(error, [{ ...row, recommendation_id: "A".repeat(22) }]), false);
  assert.equal(isDuplicateDiscoveryExposureRow({ ...error, code: "23514" }, [row]), false);
  assert.equal(isDuplicateDiscoveryExposureRow({ ...error, message: 'constraint "other_pkey"' }, [row]), false);
  assert.equal(isDuplicateDiscoveryExposureRow({ ...error, details: `Key (id)=(${randomUUID()}) already exists.` }, [row]), false);
  assert.equal(isDuplicateDiscoveryExposureRow({ ...error, details: null }, [row]), false);
  assert.equal(isDuplicateDiscoveryExposureRow(null, [row]), false);
});

it("the serve collection flag still prevents all writes", async () => {
  const fake = constraintClient({ flag: false });
  await logDiscoveryServe(fake.client, PARAMS);
  await logDiscoveryServe(fake.client, { ...PARAMS, userId: "" });
  assert.equal(fake.attempts.length, 0);
  assert.equal(fake.requests.size, 0);
  assert.equal(fake.increments.length, 0);
});

it("a confirmed Discovery replay does not increment creator fatigue again", async (context) => {
  const afterFlagTtl = Date.now() + 60_001;
  context.mock.method(Date, "now", () => afterFlagTtl);
  const fake = constraintClient({ fatigueFlag: true });
  _setTestServiceClient(fake.client as any);
  const scored = [{ candidate: { id: "node/1001", kind: "place", authorId: BOB }, features: {}, score: 1 }] as ScoredCandidate<RankCandidate>[];
  const write = () => logImpression(scored, ALICE, "discovery", PARAMS.sessionId, undefined, { servedAt: PARAMS.servedAt });
  await write();
  await write();
  fake.advance();
  await write();
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.increments.length, 1);
  assert.equal(fake.fatigue.length, 1);
});
