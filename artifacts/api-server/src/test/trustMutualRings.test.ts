/**
 * Trust engine — the mutual-ring gaming scan, and the counterpart it needs.
 *
 * ── THE DEFECT THIS EXISTS FOR ───────────────────────────────────────────────
 *
 * `TrustGamingDetectionService.detectMutualRings` was dead twice over:
 *
 *   1. It filtered `trust_events.source_type = 'user_action'`. `recordTrustEvent`
 *      defaults `sourceType` to 'system', and not one production call site has
 *      ever passed 'user_action' — the emitted values are trips | events |
 *      booking | hidden_gem | review | message_request | geofence_checkin |
 *      passport | gps | moderation | admin | appeal | safe_return | local_guide
 *      | pulse_post. Production data confirms it: the only source_type values
 *      present are 'event' and 'pulse_post'. The column carries no CHECK
 *      constraint, so the filter did not error — it matched zero rows, forever.
 *
 *   2. The pair analysis keyed on `source_id`, which is the OBJECT id (booking,
 *      gem, review row, geofence) because it is the dedup key. `totalPerUser`
 *      is keyed by USER id, so the reverse lookup always missed and the reverse
 *      rate was always 0. Removing only the source_type filter would have left
 *      the detector exactly as incapable.
 *
 * Both are fixed. The tests below pin the fix in both directions: the scan must
 * flag a genuine reciprocal pair, and must NOT flag the shapes that look
 * superficially similar (a one-sided relationship, a self-reference, a user
 * with a broad ordinary history).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGamingDetectionScan } from "../services/trust/TrustGamingDetectionService.js";
import { recordTrustEvent, COUNTERPARTY_METADATA_KEY } from "../services/trust/TrustEventService.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");

const USER_A = "user-ring-a";
const USER_B = "user-ring-b";
const USER_C = "user-ring-c";

const MUTUAL_THRESHOLD = 0.8;

interface FakeTables {
  feature_flags: any[];
  trust_settings: any[];
  trust_events: any[];
  trust_reviews: any[];
  plan_attendance_events: any[];
}

function makeTables(): FakeTables {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: true },
    ],
    trust_settings: [{
      id: 1,
      gaming_checkin_cluster_limit: 5,
      gaming_mutual_rate_threshold: MUTUAL_THRESHOLD,
      // Set far above anything these fixtures accumulate so the rapid-jump
      // detector cannot manufacture the review this suite is asserting on.
      gaming_rapid_jump_points: 100_000,
    }],
    trust_events: [],
    trust_reviews: [],
    plan_attendance_events: [],
  };
}

function makeClient(tables: FakeTables) {
  let seq = 1;
  function from(table: keyof FakeTables) {
    const store = tables[table] as any[];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;

    const builder: any = {
      select() { return builder; },
      insert(row: any) {
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r);
        pendingInsert = r;
        return builder;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return one(); },
      single() { return one(); },
      then(onF: any, onR: any) { return list().then(onF, onR); },
    };
    async function one() {
      if (pendingInsert) return { data: pendingInsert, error: null };
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return { data: rows[0] ?? null, error: null };
    }
    async function list() {
      if (pendingInsert) return { data: [pendingInsert], error: null };
      const rows = store.filter((r) => filters.every((f) => f(r)));
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }
  return { from } as any;
}

/**
 * Seed one positive trust event through the SERVICE, not by pushing a row —
 * so the metadata shape under test is the one production actually writes, and
 * a change to how the counterpart is stored breaks this suite rather than
 * quietly desynchronising it.
 */
async function seedPositive(
  client: any,
  userId: string,
  counterpartyUserId: string | undefined,
  sourceId: string,
) {
  return recordTrustEvent(client, {
    userId,
    eventType: "rent_buddy_positive_review",
    category: "community_value",
    delta: 4,
    severity: "minor",
    sourceType: "review",
    sourceId,
    ...(counterpartyUserId ? { counterpartyUserId } : {}),
  });
}

/** Smallest count that clears a strict `rate > threshold` on both sides. */
function ringSize(): number {
  // rate = ring / (ring + 1 unrelated event). Solve for the smallest integer
  // where ring/(ring+1) > threshold, derived from the configured threshold so a
  // change to the setting cannot make this fixture silently stop clearing it.
  let n = 1;
  while (n / (n + 1) <= MUTUAL_THRESHOLD) n += 1;
  return n;
}

describe("recordTrustEvent — the counterpart it records", () => {
  it("stores counterpartyUserId in metadata under the shared key", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    const r = await seedPositive(client, USER_A, USER_B, "review-1");
    assert.equal(r.ok, true);
    const row = tables.trust_events[0];
    assert.equal(row.metadata[COUNTERPARTY_METADATA_KEY], USER_B);
    // source_id keeps meaning "the object", so dedup is unaffected.
    assert.equal(row.source_id, "review-1");
  });

  it("omits the key entirely when there is no counterpart", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    await seedPositive(client, USER_A, undefined, "review-1");
    assert.equal(tables.trust_events[0].metadata[COUNTERPARTY_METADATA_KEY], undefined);
  });

  it("never overwrites an explicit metadata value of the same key", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    await recordTrustEvent(client, {
      userId: USER_A, eventType: "x", category: "community_value",
      delta: 1, severity: "minor", sourceId: "s1",
      counterpartyUserId: USER_B,
      metadata: { [COUNTERPARTY_METADATA_KEY]: USER_C },
    });
    assert.equal(tables.trust_events[0].metadata[COUNTERPARTY_METADATA_KEY], USER_C);
  });
});

describe("TrustGamingDetectionService — mutual ring scan", () => {
  it("flags a reciprocal pair that earns almost exclusively from each other", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    const n = ringSize();
    for (let i = 0; i < n; i++) {
      await seedPositive(client, USER_A, USER_B, `ab-${i}`);
      await seedPositive(client, USER_B, USER_A, `ba-${i}`);
    }
    // One ordinary event each, with no counterpart, so neither rate is a
    // degenerate 1.0 — a ring is "almost all", not necessarily "all".
    await seedPositive(client, USER_A, undefined, "solo-a");
    await seedPositive(client, USER_B, undefined, "solo-b");

    const result = await runGamingDetectionScan(client);
    assert.equal(result.ok, true);

    const rings = tables.trust_reviews.filter((r) => r.metadata?.pattern === "mutual_ring");
    assert.ok(rings.length > 0, "a mutual_ring review must be created for the pair");
    const flaggedUsers = new Set(rings.map((r) => r.user_id));
    assert.ok(flaggedUsers.has(USER_A) || flaggedUsers.has(USER_B));
    const withUser = rings[0].metadata.withUserId;
    assert.ok([USER_A, USER_B].includes(withUser), `counterpart should be the other party, got ${withUser}`);
    assert.ok(rings[0].metadata.rate > MUTUAL_THRESHOLD);
    assert.ok(rings[0].metadata.reverseRate > MUTUAL_THRESHOLD);
  });

  it("does NOT flag a one-sided relationship", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    const n = ringSize();
    // A reviews B relentlessly; B's own history is broad and unrelated.
    for (let i = 0; i < n; i++) await seedPositive(client, USER_A, USER_B, `ab-${i}`);
    for (let i = 0; i < n; i++) await seedPositive(client, USER_B, `stranger-${i}`, `bx-${i}`);

    await runGamingDetectionScan(client);
    assert.equal(
      tables.trust_reviews.filter((r) => r.metadata?.pattern === "mutual_ring").length,
      0,
      "one-sided attention is not a ring — the reverse rate must gate it",
    );
  });

  it("does NOT flag a self-referential counterpart", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    // events.ts writes sourceId: user.id on the first_event_* milestones. If a
    // counterpart were ever populated the same way, a lone user would score a
    // 100% mutual rate with herself.
    for (let i = 0; i < ringSize() + 2; i++) await seedPositive(client, USER_A, USER_A, `self-${i}`);
    await runGamingDetectionScan(client);
    assert.equal(
      tables.trust_reviews.filter((r) => r.metadata?.pattern === "mutual_ring").length,
      0,
    );
  });

  it("does NOT flag ordinary reciprocal activity inside a broad history", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    // A and B reviewed each other once, among many other counterparts.
    await seedPositive(client, USER_A, USER_B, "ab-1");
    await seedPositive(client, USER_B, USER_A, "ba-1");
    for (let i = 0; i < 10; i++) {
      await seedPositive(client, USER_A, `other-a-${i}`, `ao-${i}`);
      await seedPositive(client, USER_B, `other-b-${i}`, `bo-${i}`);
    }
    await runGamingDetectionScan(client);
    assert.equal(
      tables.trust_reviews.filter((r) => r.metadata?.pattern === "mutual_ring").length,
      0,
    );
  });

  it("ignores negative events — a ring is built from earnings", async () => {
    const tables = makeTables();
    const client = makeClient(tables);
    const n = ringSize() + 2;
    for (let i = 0; i < n; i++) {
      await recordTrustEvent(client, {
        userId: USER_A, eventType: "mutual_report", category: "community_value",
        delta: -3, severity: "minor", sourceId: `neg-a-${i}`, counterpartyUserId: USER_B,
      });
      await recordTrustEvent(client, {
        userId: USER_B, eventType: "mutual_report", category: "community_value",
        delta: -3, severity: "minor", sourceId: `neg-b-${i}`, counterpartyUserId: USER_A,
      });
    }
    await runGamingDetectionScan(client);
    assert.equal(
      tables.trust_reviews.filter((r) => r.metadata?.pattern === "mutual_ring").length,
      0,
    );
  });
});

// ── The call sites that supply a counterpart ─────────────────────────────────

describe("reciprocal surfaces record their counterpart", () => {
  /**
   * A detector that can fire but is never fed is no better than one that
   * cannot. These are static assertions on the two surfaces where two users
   * earn from each other in one transaction — the shape a ring farms.
   */
  it("the accepted connection request records each side as the other's counterpart", () => {
    const src = readFileSync(resolve(API_ROOT, "src/routes/messaging.ts"), "utf8");
    const idx = src.indexOf("telegraph_connection_accepted");
    assert.ok(idx > 0, "telegraph_connection_accepted trust event not found");
    const window = src.slice(idx - 400, idx + 900);
    const counterparts = [...window.matchAll(/counterpartyUserId:\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
    assert.equal(counterparts.length, 2, `expected both sides to record a counterpart, got ${JSON.stringify(counterparts)}`);
    assert.notEqual(counterparts[0], counterparts[1], "the two sides must name different users");
  });

  it("the rent-a-buddy review records the reviewee as the counterpart", () => {
    const src = readFileSync(resolve(API_ROOT, "src/routes/rentABuddy.ts"), "utf8");
    const idx = src.indexOf("rent_buddy_positive_review");
    assert.ok(idx > 0, "rent_buddy_positive_review trust event not found");
    const window = src.slice(idx, idx + 700);
    assert.match(
      window,
      /counterpartyUserId:\s*revieweeId/,
      "the reviewer's earning must name the reviewee, or the ring scan sees nothing",
    );
  });
});
