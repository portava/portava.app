/**
 * trustChainEndToEnd — the Trust chain from a real user action to the number a
 * reader is actually shown, and what a REPLAY of that action does to it.
 *
 *   PATCH /api/trips/:tripId  status → completed        (routes/trips.ts:769, :967)
 *     → awardTripCompletionStamps                        (routes/trips.ts:109)
 *     → StampAwardEngine.awardStamp → _awardStampCore    (services/passport/StampAwardEngine.ts:799, :153)
 *     → recordStampVerifiedTrustEvent                    (services/trust/TrustEventService.ts:561)
 *     → recordTrustEvent → trust_events                  (services/trust/TrustEventService.ts:266)
 *     → runTrustMaintenance (dirty user)                 (lib/trustMaintenanceScheduler.ts:517)
 *     → recalculateTrustScore → trust_profiles           (services/trust/TrustScoreService.ts:282)
 *     → getDisplayTrustScore / computeTrustScore         (TrustScoreService.ts:381, lib/trustScore.ts:124)
 *     → GET /passport/:userId/projection → mobile TrustScreen
 *
 * ── WHY THIS SUITE EXISTS, GIVEN THE ONES THAT ALREADY DO ────────────────────
 * Two suites already cover the two HALVES of this chain, and neither covers the
 * seam between them:
 *
 *   trustStampVerified.test.ts     drives the real award engine and follows it
 *                                  to a PERSISTED trust_profiles row. It stops
 *                                  at the row; it never asks what a reader sees.
 *   passportTrustConsistency.test  proves the three reader surfaces agree — but
 *                                  starts from a HAND-SEEDED trust_profiles row
 *                                  (`dbWithProfile(77.6)`), so it cannot notice
 *                                  if the writer stops producing a row those
 *                                  readers can use.
 *
 * A field the writer stops persisting and the readers substitute a default for
 * is invisible to both: the write half asserts the columns it wrote, the read
 * half asserts a row it wrote itself. This suite joins them on ONE store — the
 * award engine writes it, the maintenance pass scores it, and the reader that
 * the identity card, TrustScreen and the Rent-a-Buddy card all call reads it.
 * `public_level` is the concrete case: drop it from recalculateTrustScore's
 * upsert and both existing suites stay green while every reader silently shows
 * "New Traveler" to a scored traveller. That revert fails THIS suite.
 *
 * ── WHAT IS COUNTED, AND WHY EXACTLY-ONE IS THE CLAIM ────────────────────────
 * One qualifying action must produce exactly one of each artefact, and a replay
 * of that same action must still leave exactly one of each, all the way to the
 * displayed number:
 *
 *   stamp_award_events  1   — the engine's idempotency key
 *                             `${userId}:${definitionId}:${sourceType}:${sourceId}`
 *                             (StampAwardEngine.ts:136). Never hand-written in
 *                             this file: the engine writes the key and the
 *                             engine reads it back, so a fixture cannot skip
 *                             the branch it means to test.
 *   user_stamps         1   — the passport row
 *   trust_events        1   — stamp_verified, keyed on the user_stamps row
 *   trust_profiles      1   — upserted on user_id, a pure recompute of the ledger
 *   evidence_count      1   — one stamp is one piece of evidence
 *   the displayed score —   — byte-identical across the replay
 *
 * The emitter is fire-and-forget by design (a stamp must never be lost to trust
 * bookkeeping, StampAwardEngine.ts:769), so `awarded: true` says nothing about
 * the ledger. Every assertion here inspects the store after the promise chain
 * has drained.
 *
 * The fake resolves `{ data, error }` the way postgrest-js does and never
 * throws, so the fail-closed branches are the real ones. It is local to this
 * file rather than shared: the point of the suite is that ONE store carries the
 * award, the score and the read.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustChainEndToEnd.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { awardStamp, type AwardInput } from "../services/passport/StampAwardEngine.js";
import { recordStampVerifiedTrustEvent } from "../services/trust/TrustEventService.js";
import {
  getTrustProfile,
  getDisplayTrustScore,
  isPublicTrustLevel,
  PUBLIC_TRUST_LEVELS,
} from "../services/trust/TrustScoreService.js";
import { computeTrustScore } from "../lib/trustScore.js";
import { publicTrustLabel } from "../services/trust/TrustPrivacyGuard.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

// ── Ids ──────────────────────────────────────────────────────────────────────

const OWNER   = "20000000-0000-4000-8000-000000000001";
const TRIP_ID = "20000000-0000-4000-8000-0000000000a1";

/** The slugs routes/trips.ts:150-177 actually pushes for one completed trip. */
const TRIP_SLUGS = ["first_trip_completed", "weekend_wanderer", "international_voyager", "solo_traveler"] as const;

const DEF_IDS: Record<string, string> = Object.fromEntries(
  TRIP_SLUGS.map((s, i) => [s, `2ccccccc-0000-4000-8000-00000000000${i + 1}`]),
);

// ── Fake client: one in-memory store for the whole chain ─────────────────────

type Row = Record<string, any>;
type Store = Record<string, Row[]>;

interface Fake {
  client: any;
  tables: Store;
}

function makeFake(): Fake {
  const tables: Store = {
    feature_flags: [
      { flag: "stamp_system_v2_enabled", enabled: true },
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
    ],
    trust_settings: [{ id: 1, decay_half_life_days: 90 }],
    stamp_definitions: TRIP_SLUGS.map((slug) => ({
      id: DEF_IDS[slug], slug, name: slug, stamp_type: "trip", is_active: true,
      is_repeatable: false, max_awards_per_user: null, visibility_default: "public",
      criteria_type: "count", criteria: null,
    })),
    trips: [{ id: TRIP_ID, status: "completed" }],
    profiles: [{ id: OWNER, role: "user", account_status: "active" }],
    user_stamps: [], stamp_award_events: [], stamp_progress: [], stamp_milestones: [],
    universal_stamp_catalog: [], stamp_generation_queue: [], passport_telemetry_events: [],
    trust_events: [], trust_caps: [], trust_restrictions: [], trust_profiles: [],
    trust_reviews: [], trust_admin_actions: [],
  };
  let seq = 1;

  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;

    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      upsert(row: any, opts?: any) { op = "upsert"; payload = { row, key: String(opts?.onConflict ?? "id") }; return b; },
      delete() { op = "delete"; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return b; },
      gte(c: string, v: any) { filters.push((r) => r[c] >= v); return b; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return b; },
      lte(c: string, v: any) { filters.push((r) => r[c] <= v); return b; },
      not(c: string, o: string, v: any) { filters.push((r) => (o === "is" && v === null ? r[c] != null : r[c] !== v)); return b; },
      or(expr: string) {
        const m = /^(\w+)\.is\.null,\1\.gt\.(.+)$/.exec(expr);
        if (m) { const col = m[1]!; const iso = m[2]!; filters.push((r) => r[col] == null || r[col] > iso); }
        return b;
      },
      ilike() { return b; }, like() { return b; },
      order(col: string, o?: any) { order = { col, asc: o?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      range() { return b; },
      maybeSingle() { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      single() { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    function matched(): Row[] {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (order) rows = [...rows].sort((a, c) => (a[order!.col] < c[order!.col] ? -1 : 1) * (order!.asc ? 1 : -1));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    async function run(): Promise<{ data: any; error: any; count?: number }> {
      if (op === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((p: any) => ({
          id: `fake-${seq++}`, created_at: new Date().toISOString(), ...p,
        }));
        // The real database refuses a second row on
        // `stamp_award_events_idempotency_key_key` with 23505; the engine reads
        // that as already_awarded. Modelling it here is what makes the replay
        // cases exercise the engine's race branch instead of a fake that
        // cheerfully accepts duplicates.
        if (table === "stamp_award_events") {
          for (const r of rows) {
            if (r.idempotency_key && store.some((e) => e.idempotency_key === r.idempotency_key)) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
          }
        }
        store.push(...rows);
        return { data: rows, error: null };
      }
      if (op === "upsert") {
        const { row, key } = payload as { row: Row; key: string };
        const cols = key.split(",").map((c) => c.trim());
        const j = store.findIndex((r) => cols.every((c) => r[c] === row[c]));
        if (j >= 0) { store[j] = { ...store[j], ...row }; return { data: [store[j]], error: null }; }
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r);
        return { data: [r], error: null };
      }
      if (op === "update") {
        const rows = matched(); rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, error: null };
      }
      if (op === "delete") {
        const rows = matched(); for (const r of rows) store.splice(store.indexOf(r), 1);
        return { data: rows, error: null };
      }
      const rows = matched().map((r) => ({ ...r }));
      return { data: rows, error: null, count: rows.length };
    }
    return b;
  }

  return {
    tables,
    client: { from, rpc: async () => ({ data: null, error: { code: "PGRST202", message: "function not found" } }) },
  };
}

/** Let the engine's fire-and-forget emitter chain drain before counting rows. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 15));
}

/** One award, exactly as routes/trips.ts shapes it (definitionSlug, not stampCode). */
function award(f: Fake, slug: string, over: Partial<AwardInput> = {}) {
  return awardStamp(f.client, {
    userId: OWNER,
    definitionSlug: slug,
    sourceType: "trips",
    sourceId: TRIP_ID,
    city: "Lisbon",
    country: "Portugal",
    ...over,
  });
}

/**
 * The real batch routes/trips.ts:182 issues on one completed trip: every slug
 * concurrently through Promise.allSettled, all sharing the trip as source.
 */
function deliverTripCompletion(f: Fake) {
  return Promise.allSettled(TRIP_SLUGS.map((slug) => award(f, slug)));
}

const stampVerified = (f: Fake) => f.tables.trust_events!.filter((e) => e.event_type === "stamp_verified");

/** What every Trust reader surface shows for this user, read together. */
async function readerView(f: Fake) {
  const [display, card, profile] = await Promise.all([
    getDisplayTrustScore(f.client, OWNER),
    computeTrustScore(OWNER, f.client),
    getTrustProfile(f.client, OWNER),
  ]);
  return { display, card, profile };
}

// The engine reports failures in its structured console vocabulary; capture it
// so a "success" that actually logged stamp.award.trust_event_failed cannot
// pass as a success.
let engineLog: Array<Record<string, unknown>> = [];
const realConsoleError = console.error;
beforeEach(() => {
  engineLog = [];
  console.error = (...a: any[]) => {
    try { engineLog.push(JSON.parse(String(a[0]))); } catch { /* non-JSON noise from other side effects */ }
  };
});
afterEach(() => { console.error = realConsoleError; });

const trustFailures = () => engineLog.filter((l) => l["event"] === "stamp.award.trust_event_failed");

// ─────────────────────────────────────────────────────────────────────────────
// 1. One qualifying action, all the way to the number a reader is shown.
// ─────────────────────────────────────────────────────────────────────────────

describe("one qualifying award → one stamp → one trust event → one profile → one displayed number", () => {
  it("carries a real award through the maintenance pass into every Trust reader", async () => {
    const f = makeFake();

    const r = await award(f, "first_trip_completed");
    assert.equal(r.awarded, true, `the award itself must succeed: ${r.reason}`);
    await settle();

    // Producer: exactly one of each artefact.
    assert.equal(f.tables.stamp_award_events!.length, 1, "one award event (the engine's idempotency anchor)");
    assert.equal(f.tables.user_stamps!.length, 1, "one passport row");
    const evs = stampVerified(f);
    assert.equal(evs.length, 1, `one stamp_verified event, got ${JSON.stringify(f.tables.trust_events!.map((e) => e.event_type))}`);
    assert.equal(evs[0]!.source_id, r.userStampId, "the event is keyed on the user_stamps row just written");
    assert.equal(evs[0]!.status, "applied", "minor → applied, so it is scoreable");
    assert.equal(trustFailures().length, 0, "a working chain logs no trust_event_failed");

    // Before the consumer runs there is nothing for a reader to read — and the
    // reader says so rather than inventing a number.
    const before = await readerView(f);
    assert.equal(before.profile, null, "no profile before the pass");
    assert.equal(before.display, null, "no fabricated score before the pass");
    assert.equal(before.card.score, null, "the identity card agrees at null");

    // Consumer: the maintenance pass finds the user dirty and scores them.
    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.skipped, undefined, "the pass ran");
    assert.equal(pass.eventsSeen, 1, "the pass saw the event (0 here would be the starvation signature)");
    assert.equal(pass.usersRecalculated, 1);
    assert.equal(pass.recalcFailures, 0);

    assert.equal(f.tables.trust_profiles!.length, 1, "one profile row, not one per pass");
    const row = f.tables.trust_profiles![0]!;
    assert.equal(row.user_id, OWNER);
    assert.equal(row.evidence_count, 1, "one stamp is exactly one piece of evidence");
    assert.ok(row.passport_authenticity > 50, `passport_authenticity moved above neutral, got ${row.passport_authenticity}`);

    // ── THE SEAM THIS SUITE EXISTS FOR ───────────────────────────────────────
    // The row the writer just produced, read back through the helpers every
    // user-facing surface calls: getDisplayTrustScore (TrustScreen self view,
    // PassportProjectionService.buildTrust:1016) and computeTrustScore (the
    // owner identity card GET /me/profile + GET /passport, and the
    // Rent-a-Buddy card — lib/trustScore.ts:124).
    const after = await readerView(f);
    assert.ok(after.profile, "the reader can load the profile the pass wrote");
    assert.equal(after.display, Math.round(Number(row.overall_score)), "the displayed score IS the persisted overall_score, rounded");
    assert.equal(after.card.score, after.display, "the identity card shows the same number as TrustScreen");

    // The LABEL is the half a seeded-profile test cannot check: it is derived
    // from `public_level`, which only the writer produces. A writer that stops
    // persisting it leaves every reader showing "New Traveler" to a scored
    // traveller, and no assertion on the score would notice.
    // Membership in the DECLARED vocabulary, not merely "a non-empty string".
    // publicTrustLabel answers an unrecognised level with the "New Traveler"
    // default rather than complaining, so a writer that persists a level
    // outside PUBLIC_TRUST_LEVELS degrades every reader's label silently. The
    // weaker assertion could not ask that question — and, being weaker than
    // publicTrustLabel's own parameter, it did not typecheck either.
    const persistedLevel: unknown = row.public_level;
    if (!isPublicTrustLevel(persistedLevel)) {
      assert.fail(
        `the pass persisted a public_level from the declared vocabulary ` +
        `(${PUBLIC_TRUST_LEVELS.join("|")}), got ${JSON.stringify(persistedLevel)}`,
      );
    }
    assert.equal(after.card.label, publicTrustLabel(persistedLevel), "the label is derived from the persisted level");
    assert.notEqual(
      after.card.label, "New Traveler",
      "a traveller with a scored profile is not shown the no-profile default",
    );

    // The breakdown is a view of the persisted categories, not a second sum.
    const factor = after.card.breakdown.factors.find((x) => x.key === "passport_authenticity");
    assert.ok(factor, "the breakdown carries the category the stamp moved");
    assert.equal(factor!.points, Math.round(Number(row.passport_authenticity)), "the factor is the persisted category, rounded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Replay of the same action changes nothing a reader can see.
// ─────────────────────────────────────────────────────────────────────────────

describe("a replay of the same award leaves exactly one of each — and the same number", () => {
  it("the identical award, redelivered and rescored, moves nothing", async () => {
    const f = makeFake();

    await award(f, "first_trip_completed");
    await settle();
    await runTrustMaintenance(f.client);
    const first = await readerView(f);
    const firstRow = { ...f.tables.trust_profiles![0]! };
    assert.ok(first.display !== null, "a number to compare against");

    // The replay: the same PATCH retried, the same job redelivered.
    const again = await award(f, "first_trip_completed");
    assert.equal(again.awarded, false, "a replay is not a second award");
    assert.equal(again.reason, "already_awarded", "the engine's idempotency key short-circuits before the emitter");
    await settle();

    const pass2 = await runTrustMaintenance(f.client);
    assert.equal(pass2.recalcFailures, 0);

    assert.equal(f.tables.stamp_award_events!.length, 1, "still one award event");
    assert.equal(f.tables.user_stamps!.length, 1, "still one passport row");
    assert.equal(stampVerified(f).length, 1, "still one trust event — a retry is not new evidence");
    assert.equal(f.tables.trust_profiles!.length, 1, "still one profile row");
    assert.equal(f.tables.trust_profiles![0]!.evidence_count, 1, "still one piece of evidence");
    assert.equal(trustFailures().length, 0, "a dedup skip is not reported as a failure");

    const second = await readerView(f);
    assert.equal(second.display, first.display, "the displayed score is unchanged by the replay");
    assert.equal(second.card.label, first.card.label, "the label is unchanged");
    assert.deepEqual(second.card.breakdown, first.card.breakdown, "no category moved");
    assert.equal(
      f.tables.trust_profiles![0]!.passport_authenticity, firstRow.passport_authenticity,
      "the category the stamp moved did not move again",
    );
  });

  it("the emitter message itself redelivered for the same stamp is a dedup skip, and the reader is unchanged", async () => {
    const f = makeFake();
    const r = await award(f, "first_trip_completed");
    await settle();
    await runTrustMaintenance(f.client);
    const first = await readerView(f);

    // Duplicate DELIVERY of the fire-and-forget message: the identical call the
    // engine makes at StampAwardEngine.ts:769, arriving twice.
    const dup = await recordStampVerifiedTrustEvent(f.client, {
      userId: OWNER,
      userStampId: r.userStampId!,
      tier: "verified",
      stampSourceType: "trips",
      stampDefinitionId: DEF_IDS["first_trip_completed"]!,
    });
    assert.deepEqual(dup, { ok: false, skipped: true, skipReason: "dedup" }, "the Trust dedup key refuses it");
    assert.equal(stampVerified(f).length, 1);

    await runTrustMaintenance(f.client);
    const second = await readerView(f);
    assert.equal(second.display, first.display);
    assert.equal(second.card.label, first.card.label);
    assert.equal(f.tables.trust_profiles![0]!.evidence_count, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The real batch: one trip completion is several concurrent awards.
// ─────────────────────────────────────────────────────────────────────────────

describe("the trip-completion batch — several stamps at once, delivered twice", () => {
  it("N slugs on one trip are N stamps and N events; one profile counts them all", async () => {
    const f = makeFake();
    const N = TRIP_SLUGS.length;

    await deliverTripCompletion(f);
    await settle();

    assert.equal(f.tables.user_stamps!.length, N, "one stamp per qualifying slug");
    assert.equal(stampVerified(f).length, N, "each distinct stamp is its own evidence");
    // Dedup is per STAMP, never per user: N distinct source ids, no collisions.
    assert.deepEqual(
      stampVerified(f).map((e) => e.source_id).sort(),
      f.tables.user_stamps!.map((s) => s.id).sort(),
      "every event points at a distinct user_stamps row",
    );
    assert.equal(trustFailures().length, 0);

    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.eventsSeen, N);
    assert.equal(pass.usersRecalculated, 1, "N events for one user is one recalculation");
    assert.equal(f.tables.trust_profiles!.length, 1);
    assert.equal(f.tables.trust_profiles![0]!.evidence_count, N);

    const first = await readerView(f);
    assert.equal(first.display, Math.round(Number(f.tables.trust_profiles![0]!.overall_score)));

    // The WHOLE batch redelivered — the completion handler running twice.
    await deliverTripCompletion(f);
    await settle();
    await runTrustMaintenance(f.client);

    assert.equal(f.tables.stamp_award_events!.length, N, "still N award events");
    assert.equal(f.tables.user_stamps!.length, N, "still N stamps");
    assert.equal(stampVerified(f).length, N, "still N trust events");
    assert.equal(f.tables.trust_profiles!.length, 1, "still one profile");
    assert.equal(f.tables.trust_profiles![0]!.evidence_count, N, "still N pieces of evidence");
    assert.equal(trustFailures().length, 0);

    const second = await readerView(f);
    assert.equal(second.display, first.display, "the displayed score survives the redelivery unchanged");
    assert.deepEqual(second.card.breakdown, first.card.breakdown);
  });
});
