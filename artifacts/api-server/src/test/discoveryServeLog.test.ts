/**
 * discoveryServeLog — Stage 0 serve-point instrumentation
 *
 * The property that matters most here is the FIRST one: with the
 * `discovery_serve_log_enabled` flag absent — which is its state in production
 * the moment this code lands — the module must perform NO write whatsoever.
 * That is what makes introducing Stage 0 behaviour-preserving.
 *
 * Tests:
 *  A. Flag absent (no row)            → zero inserts
 *  B. Flag present but false          → zero inserts
 *  C. Flag true                       → exactly one row per served item
 *  D. position mirrors served order
 *  E. servePoint is recorded on every row
 *  F. rankedInRequest is false for serve points 1-4, true for 5 and 6
 *  G. item_kind maps db/ → gem and OSM ids → place (matches discovery.ts:1329)
 *  H. surface is always 'discovery' (a value the CHECK already permits)
 *  I. Empty item list                  → zero inserts
 *  J. An insert ERROR is reported, not swallowed  (the 0202 lesson)
 *  K. An insert THROWING never propagates to the caller
 *  L. The flag read is cached — a second call inside the TTL re-reads nothing
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryServeLog.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  logDiscoveryServe,
  invalidateServeLogFlagCache,
  DiscoveryServePoint,
  DISCOVERY_SERVE_LOG_FLAG,
} from "../lib/discoveryServeLog.js";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-000000000001";

interface Captured { table: string; rows: any[]; }

/**
 * Minimal Supabase stub: answers the feature_flags lookup isFlagEnabled makes,
 * and captures rank_events inserts.
 */
function makeClient(opts: {
  flagRow?:     { enabled: boolean } | null;
  flagError?:   unknown;
  insertError?: unknown;
  insertThrows?: boolean;
}) {
  const captured: Captured[] = [];
  let flagReads = 0;

  const client = {
    from(table: string) {
      if (table === "feature_flags") {
        return {
          select() { return this; },
          eq()     { return this; },
          maybeSingle() {
            flagReads += 1;
            return Promise.resolve({
              data:  opts.flagRow ?? null,
              error: opts.flagError ?? null,
            });
          },
        };
      }
      return {
        insert(rows: any[]) {
          if (opts.insertThrows) throw new Error("insert exploded");
          captured.push({ table, rows });
          return Promise.resolve({ error: opts.insertError ?? null });
        },
      };
    },
  };

  return { client, captured, flagReads: () => flagReads };
}

const ITEMS = [
  { id: "node/1001" },
  { id: "db/22222222-2222-2222-2222-222222222222" },
  { id: "way/3003" },
];

describe("discoveryServeLog — inert until the flag is seeded", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("A. writes nothing when the flag row is absent", async () => {
    const { client, captured } = makeClient({ flagRow: null });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0, "a missing flag row must produce no write");
  });

  it("B. writes nothing when the flag is explicitly false", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: false } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });

  it("B2. writes nothing when the flag read errors (fail-closed)", async () => {
    const { client, captured } = makeClient({ flagError: { message: "boom" } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });
});

describe("discoveryServeLog — row shape once enabled", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("C/D/E/H. one row per item, positioned, marked, on surface 'discovery'", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L2_FRESH, items: ITEMS,
      context: { destination: "lisbon", category: "for_you" },
    });

    assert.equal(captured.length, 1, "exactly one insert call");
    const rows = captured[0]!.rows;
    assert.equal(captured[0]!.table, "rank_events");
    assert.equal(rows.length, ITEMS.length, "one row per served item");

    rows.forEach((r: any, idx: number) => {
      assert.equal(r.position, idx, "position mirrors served order");
      assert.equal(r.surface, "discovery");
      assert.equal(r.outcome, "impression");
      assert.equal(r.user_id, USER_ID);
      assert.equal(r.features.servePoint, DiscoveryServePoint.CACHE_A_L2_FRESH);
      assert.equal(r.features.route, "GET /discovery");
      assert.equal(r.features.destination, "lisbon");
    });

    // One session id for the whole batch — "single open" semantics.
    const sessions = new Set(rows.map((r: any) => r.session_id));
    assert.equal(sessions.size, 1, "one session_id per batch");
  });

  it("F. rankedInRequest is false for cache serves and true for the ranking serves", async () => {
    const unranked = [
      DiscoveryServePoint.CACHE_A_L1,
      DiscoveryServePoint.CACHE_A_L2_FRESH,
      DiscoveryServePoint.CACHE_A_L2_STALE,
      DiscoveryServePoint.CACHE_B_HIT,
    ];
    for (const sp of unranked) {
      invalidateServeLogFlagCache();
      const { client, captured } = makeClient({ flagRow: { enabled: true } });
      await logDiscoveryServe(client, { userId: USER_ID, servePoint: sp, items: ITEMS });
      assert.equal(
        captured[0]!.rows[0].features.rankedInRequest, false,
        `serve point ${sp} runs no ranker in-request`,
      );
    }

    // Serve point 4 replays a Compass order but invokes no ranker in THIS
    // request — the distinction the Phase -1 proof corrected from three to four.
    invalidateServeLogFlagCache();
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.COMPASS_FRESH_RANK, items: ITEMS,
    });
    assert.equal(captured[0]!.rows[0].features.rankedInRequest, true);
  });

  it("G. item_kind maps db/ to gem and OSM ids to place", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    const kinds = captured[0]!.rows.map((r: any) => r.item_kind);
    assert.deepEqual(kinds, ["place", "gem", "place"]);
    // Every value must satisfy the CHECK at 0153_add_rank_events.sql:18.
    const allowed = new Set(["post", "event", "plan", "buddy", "place", "gem"]);
    for (const k of kinds) assert.ok(allowed.has(k), `${k} violates the item_kind CHECK`);
  });

  it("I. writes nothing for an empty served list", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: [],
    });
    assert.equal(captured.length, 0);
  });

  it("I2. writes nothing without a user id (rank_events.user_id is NOT NULL)", async () => {
    const { client, captured } = makeClient({ flagRow: { enabled: true } });
    await logDiscoveryServe(client, {
      userId: "", servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
    });
    assert.equal(captured.length, 0);
  });
});

describe("discoveryServeLog — failure handling", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("J. a rejected insert does not throw (and is reported, not swallowed)", async () => {
    const { client } = makeClient({
      flagRow: { enabled: true },
      insertError: { message: "new row violates check constraint" },
    });
    await assert.doesNotReject(() =>
      logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });

  it("K. a throwing insert never propagates to the caller", async () => {
    const { client } = makeClient({ flagRow: { enabled: true }, insertThrows: true });
    await assert.doesNotReject(() =>
      logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });

  it("K2. a null client is a no-op", async () => {
    await assert.doesNotReject(() =>
      logDiscoveryServe(null, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      }),
    );
  });
});

describe("discoveryServeLog — flag read caching", () => {
  beforeEach(() => invalidateServeLogFlagCache());

  it("L. reads the flag once across repeated serves inside the TTL", async () => {
    const { client, captured, flagReads } = makeClient({ flagRow: { enabled: true } });
    for (let i = 0; i < 4; i++) {
      await logDiscoveryServe(client, {
        userId: USER_ID, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS,
      });
    }
    assert.equal(captured.length, 4, "every serve still logs");
    assert.equal(flagReads(), 1, "the flag is read once, not once per serve");
  });

  it("L2. the flag name is the one this module documents", () => {
    assert.equal(DISCOVERY_SERVE_LOG_FLAG, "discovery_serve_log_enabled");
  });
});
