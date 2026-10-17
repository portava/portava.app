import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  DiscoveryServePoint, _resetServeRequestTableLatch, invalidateServeLogFlagCache,
  logDiscoveryServe, type DiscoveryServeLogParams,
} from "../lib/discoveryServeLog.js";
import {
  _resetRankEventsRejections, _resetRecommendationIdSchemaLatch, rankEventsRejectionSnapshot,
} from "../lib/rankEventsProvenance.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { isDuplicateDiscoveryExposureRow, servedRecommendationId } from "../lib/discoveryRecommendationRecord.js";

const modulePath = process.env.DISCOVERY_PGLITE_MODULE;
const ALICE = "a11ce000-0000-4000-8000-000000000001";
const BOB = "b0b00000-0000-4000-8000-000000000002";
const PARAMS: DiscoveryServeLogParams = {
  userId: ALICE,
  sessionId: "5e551011-0000-4000-8000-000000000001",
  servedAt: "2026-10-16T10:00:00.123Z",
  servePoint: DiscoveryServePoint.COLD_FETCH_LEGACY_RANK,
  items: [{ id: "node/1001" }, { id: "node/1002" }],
};

interface SqlDatabase {
  exec(statement: string): Promise<unknown>;
  query<Row = Record<string, unknown>>(statement: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

interface StoredExposure {
  id: string;
  user_id: string;
  item_id: string;
  position: number;
  outcome: string;
  recommendation_id: string;
}

interface SqlFailure {
  code: string;
  message: string;
  detail?: string;
  constraint?: string;
}

type InsertRow = Record<string, unknown>;

const COLUMNS = [
  "id", "user_id", "item_id", "item_kind", "position", "features", "outcome",
  "served_at", "surface", "session_id", "recommendation_id", "schema_version", "privacy_class",
];
const INSERT_SQL = `INSERT INTO rank_events (${COLUMNS.join(", ")})
  SELECT ${COLUMNS.map((column) => column === "id" ? "COALESCE(entry.id, gen_random_uuid())" : `entry.${column}`).join(", ")}
  FROM jsonb_populate_recordset(NULL::rank_events, $1::jsonb) AS entry`;

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function sqlAdapter(database: SqlDatabase, beforeInsert?: () => Promise<void>) {
  const attempts: InsertRow[][] = [];
  const errors: Array<SqlFailure & { details?: string }> = [];
  const increments: Array<{ p_item_id: string; p_viewer_id: string }> = [];
  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        const query = {
          select() { return query; },
          eq(column: string, flag: string) {
            assert.equal(column, "flag");
            assert.equal(flag, "discovery_serve_log_enabled");
            return query;
          },
          async maybeSingle() { return { data: { enabled: true }, error: null }; },
        };
        return query;
      }
      assert.equal(table, "rank_events");
      return {
        async insert(rows: InsertRow[]) {
          attempts.push(structuredClone(rows));
          await beforeInsert?.();
          try {
            await database.query(INSERT_SQL, [JSON.stringify(rows)]);
            return { error: null };
          } catch (caught) {
            const failure = caught as SqlFailure;
            const error = {
              code: failure.code, message: failure.message,
              details: failure.detail, constraint: failure.constraint,
            };
            errors.push(error);
            return { error };
          }
        },
      };
    },
    async rpc(name: string, parameters: Record<string, unknown>) {
      if (name === "record_discovery_serve_request") return { data: "written", error: null };
      assert.equal(name, "increment_distribution_stats");
      increments.push(parameters as { p_item_id: string; p_viewer_id: string });
      return { data: null, error: null };
    },
  };
  return { client, attempts, errors, increments };
}

describe("Discovery retry identity on executed PGlite SQL (single connection)", { skip: !modulePath }, () => {
  let database: SqlDatabase;

  before(async () => {
    const { PGlite } = await import(pathToFileURL(modulePath!).href);
    database = new PGlite();
    await database.exec(`
      CREATE TABLE rank_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        item_id text NOT NULL,
        item_kind text,
        position integer NOT NULL,
        features jsonb NOT NULL DEFAULT '{}'::jsonb,
        outcome text NOT NULL DEFAULT 'impression',
        served_at timestamptz NOT NULL,
        surface text NOT NULL,
        session_id uuid,
        recommendation_id text,
        schema_version integer,
        privacy_class text
      );
      CREATE UNIQUE INDEX rank_events_recommendation_idempotency_idx
        ON rank_events (recommendation_id, outcome);
    `);
  });

  after(async () => { await database?.close(); });

  beforeEach(async () => {
    invalidateServeLogFlagCache();
    _resetServeRequestTableLatch();
    _resetRecommendationIdSchemaLatch();
    _resetRankEventsRejections();
    _resetStopConditionsForTest();
    await database.exec(`
      DROP TRIGGER IF EXISTS force_unexpected_id ON rank_events;
      DROP FUNCTION IF EXISTS force_unexpected_id();
      TRUNCATE rank_events;
    `);
  });

  async function storedRows() {
    return (await database.query<StoredExposure>(`
      SELECT id, user_id, item_id, position, outcome, recommendation_id
      FROM rank_events ORDER BY user_id, position
    `)).rows;
  }

  it("delayed concurrent call copies cannot resurrect any exposure after EVERY outcome advances", { timeout: 10_000 }, async () => {
    const copies = 4;
    const waiting = latch();
    const resume = latch();
    let delay = false;
    let parked = 0;
    const adapter = sqlAdapter(database, async () => {
      if (!delay) return;
      parked += 1;
      if (parked === copies) waiting.release();
      await resume.wait;
    });
    await logDiscoveryServe(adapter.client, PARAMS);
    const original = await storedRows();
    assert.equal(original.length, PARAMS.items.length);
    assert.equal(adapter.increments.length, PARAMS.items.length);

    delay = true;
    const pending = Promise.all(Array.from({ length: copies }, () =>
      logDiscoveryServe(adapter.client, { ...PARAMS })));
    try {
      await waiting.wait;
      await database.exec("UPDATE rank_events SET outcome = 'save'");
    } finally {
      resume.release();
      await pending;
    }

    assert.deepEqual(await storedRows(), original.map((row) => ({ ...row, outcome: "save" })));
    assert.equal(adapter.attempts.length, copies + 1);
    assert.equal(adapter.errors.length, copies);
    assert.ok(adapter.errors.every((error) => error.code === "23505" && error.constraint === "rank_events_pkey"));
    assert.equal(adapter.increments.length, PARAMS.items.length);
    assert.deepEqual(rankEventsRejectionSnapshot(), []);
  });

  it("concurrent mixed-user copies retain separate keys and one SQL exposure per viewer and position", { timeout: 10_000 }, async () => {
    const adapter = sqlAdapter(database);
    const viewers = [ALICE, BOB];
    await Promise.all(viewers.flatMap((userId) => Array.from({ length: 3 }, () =>
      logDiscoveryServe(adapter.client, { ...PARAMS, userId }))));
    const original = await storedRows();
    assert.equal(original.length, viewers.length * PARAMS.items.length);
    assert.equal(new Set(original.map((row) => row.id)).size, original.length);
    assert.equal(new Set(original.map((row) => row.recommendation_id)).size, original.length);
    for (const row of original) {
      assert.equal(row.recommendation_id, servedRecommendationId({
        userId: row.user_id, sessionId: PARAMS.sessionId!, servedAt: PARAMS.servedAt!,
      }, row.position, row.item_id));
    }
    await database.exec("UPDATE rank_events SET outcome = 'save'");
    await Promise.all(viewers.map((userId) => logDiscoveryServe(adapter.client, { ...PARAMS, userId })));
    assert.deepEqual(await storedRows(), original.map((row) => ({ ...row, outcome: "save" })));
    assert.equal(adapter.attempts.length, 8);
    assert.equal(adapter.errors.length, 6);
    assert.equal(adapter.increments.length, original.length);
    for (const userId of viewers) {
      assert.deepEqual(adapter.increments.filter((increment) => increment.p_viewer_id === userId)
        .map((increment) => increment.p_item_id).sort(), PARAMS.items.map((item) => item.id).sort());
    }
    assert.deepEqual(rankEventsRejectionSnapshot(), []);
  });

  it("an actual unexpected primary-key collision against another viewer remains a rejection", async () => {
    const adapter = sqlAdapter(database);
    await logDiscoveryServe(adapter.client, { ...PARAMS, userId: BOB });
    const original = await storedRows();
    assert.equal(original.length, PARAMS.items.length);
    const unexpectedId = original[0]!.id;
    assert.match(unexpectedId, /^[0-9a-f-]{36}$/);
    await database.exec(`
      CREATE FUNCTION force_unexpected_id() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.id := '${unexpectedId}'::uuid;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER force_unexpected_id BEFORE INSERT ON rank_events
        FOR EACH ROW EXECUTE FUNCTION force_unexpected_id();
    `);
    await logDiscoveryServe(adapter.client, PARAMS);

    assert.equal(adapter.errors.length, 1);
    const error = adapter.errors[0]!;
    assert.equal(error.code, "23505");
    assert.equal(error.constraint, "rank_events_pkey");
    assert.equal(error.details, `Key (id)=(${unexpectedId}) already exists.`);
    assert.equal(isDuplicateDiscoveryExposureRow(error, adapter.attempts[1]!), false);
    assert.equal(isDuplicateDiscoveryExposureRow(error, adapter.attempts[0]!), true);
    assert.deepEqual(await storedRows(), original);
    assert.equal(adapter.increments.length, original.length);
    assert.deepEqual(rankEventsRejectionSnapshot(), [{
      writer: "lib/discoveryServeLog.ts", constraint: "rank_events_pkey", code: "23505",
      count: 1, rows: PARAMS.items.length,
    }]);
  });
});
