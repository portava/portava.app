/**
 * Trust engine — the emission chain, end to end, and the two properties that
 * make it safe to switch on: idempotency and fail-closed reads.
 *
 *   triggering action → recordTrustEvent → trust_events row
 *                     → runTrustMaintenance (dirty user) → recalculateTrustScore
 *                     → trust_profiles row (score, level, evidence)
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────────
 * Production, 2026-09-07: the engine has been ON since 2026-07-17 and the ledger
 * holds five events. Every service in the chain had unit tests; nothing exercised
 * the chain from a real trigger through to a persisted profile, and nothing
 * pinned what happens when a link in that chain CANNOT READ. Four fail-open
 * guards were found in this repo today from exactly that: supabase-js resolves
 * `{ data: null, error }` on a database error, and an unread `error` reads as an
 * empty result. In this engine that meant:
 *
 *   - isDuplicate         → "not a duplicate"   → the same event written twice
 *   - loadEvents          → "no events"         → profile overwritten with 50s and
 *                                                 evidence_count = 0 ("measured, empty")
 *   - loadCaps            → "no caps"           → an uncapped score persisted over a
 *                                                 live ceiling
 *   - getPendingEvents    → []                  → a broken queue rendered as an
 *                                                 empty one
 *   - confirmEvent update → (unchecked)         → cap applied against a still-pending
 *                                                 event; a re-confirm caps it again
 *
 * Each of those is asserted here in its fixed direction, with the fake client
 * injecting a resolved `{ error }` — never a throw — because that is the shape
 * the real client produces.
 *
 * The chain is driven from the two Trust-OWNED entry points that have a real
 * production trigger: `recordLocationTrustEvent` (called by
 * services/location/LocationSafetyService on an impossible-speed finding) and
 * `recordStampVerifiedTrustEvent` (the Trust half of STAMP_VERIFIED; the call
 * belongs to Passport's StampAwardEngine and is the one line that surface must
 * add). Both are exercised with their real provenance: actor = the subject
 * user, source = the object that triggered it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  recordTrustEvent,
  recordLocationTrustEvent,
  recordStampVerifiedTrustEvent,
  TRUST_EVENT_TYPES,
} from "../services/trust/TrustEventService.js";
import { recalculateTrustScore, getTrustProfile } from "../services/trust/TrustScoreService.js";
import { confirmEvent, getPendingEvents, getOpenReviews } from "../services/trust/TrustAdminService.js";
import { getActiveCaps } from "../services/trust/TrustCapService.js";
import { runGamingDetectionScan } from "../services/trust/TrustGamingDetectionService.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

const OWNER = "00000000-0000-0000-0000-00000000c0de";
const ADMIN = "00000000-0000-0000-0000-0000000000ad";
const STAMP_ID = "00000000-0000-0000-0000-00000000517a";

// ── Fake client with resolved-error injection ────────────────────────────────

type Store = Record<string, any[]>;
type Op = "select" | "insert" | "update" | "upsert";

interface Fake {
  client: any;
  tables: Store;
  /** Make the NEXT `op` on `table` resolve `{ data: null, error }` (not throw). */
  failNext(table: string, op: Op, message?: string): void;
}

function makeFake(seed: Partial<Store> = {}): Fake {
  const tables: Store = {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: true },
    ],
    trust_settings: [{ id: 1, decay_half_life_days: 90 }],
    trust_events: [], trust_caps: [], trust_restrictions: [], trust_profiles: [],
    trust_reviews: [], trust_admin_actions: [], plan_attendance_events: [],
    ...seed,
  };
  const failures = new Map<string, string>();
  let seq = 1;

  function from(table: string) {
    const store = (tables[table] ??= []);
    const filters: Array<(r: any) => boolean> = [];
    let op: Op = "select";
    let payload: any = null;
    let limitN: number | null = null;
    let order: { col: string; asc: boolean } | null = null;

    const builder: any = {
      select() { return builder; },
      insert(row: any) { op = "insert"; payload = row; return builder; },
      update(p: any)   { op = "update"; payload = p;   return builder; },
      upsert(row: any, opts?: any) { op = "upsert"; payload = { row, key: opts?.onConflict ?? "id" }; return builder; },
      eq(c: string, v: any)    { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any)   { filters.push((r) => r[c] !== v); return builder; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      is(c: string, v: any)    { filters.push((r) => v === null ? r[c] == null : r[c] === v); return builder; },
      gt(c: string, v: any)    { filters.push((r) => r[c] > v); return builder; },
      lt(c: string, v: any)    { filters.push((r) => r[c] < v); return builder; },
      not(c: string, _o: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      or(expr: string) {
        // Only the caps/restrictions expiry shape is used: "expires_at.is.null,expires_at.gt.<iso>"
        const m = /^(\w+)\.is\.null,\1\.gt\.(.+)$/.exec(expr);
        if (m) { const col = m[1]; const iso = m[2]; filters.push((r) => r[col] == null || r[col] > iso); }
        return builder;
      },
      order(col: string, o?: any) { order = { col, asc: o?.ascending !== false }; return builder; },
      limit(n: number) { limitN = n; return builder; },
      range() { return builder; },
      maybeSingle() { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      single()      { return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (order) rows = [...rows].sort((a, b) => (a[order!.col] < b[order!.col] ? -1 : 1) * (order!.asc ? 1 : -1));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      const key = `${table}:${op}`;
      const msg = failures.get(key);
      if (msg) { failures.delete(key); return { data: null, error: { code: "57014", message: msg } }; }
      if (op === "insert") {
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...payload };
        store.push(r); return { data: [r], error: null };
      }
      if (op === "upsert") {
        const { row, key: k } = payload;
        const i = store.findIndex((r) => r[k] === row[k]);
        if (i >= 0) { store[i] = { ...store[i], ...row }; return { data: [store[i]], error: null }; }
        const r = { id: `fake-${seq++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); return { data: [r], error: null };
      }
      if (op === "update") {
        const rows = matched(); rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, error: null };
      }
      const rows = matched();
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }

  return {
    client: { from },
    tables,
    failNext(table, op, message = `injected ${table}.${op} failure`) { failures.set(`${table}:${op}`, message); },
  };
}

// ── 1. Stamp award → stamp_verified → maintenance → profile ─────────────────

describe("chain: verified stamp award → trust_events → maintenance → trust_profiles", () => {
  it("a verified award writes one event with the owner as actor and the stamp as source, and a pass turns it into a profile", async () => {
    const f = makeFake();
    const r = await recordStampVerifiedTrustEvent(f.client, {
      userId: OWNER, userStampId: STAMP_ID, tier: "verified",
      stampSourceType: "trips", stampDefinitionId: "def-1", awardedByAdminId: null,
    });
    assert.equal(r.ok, true);

    const events = f.tables.trust_events;
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.user_id, OWNER, "the stamp OWNER is the subject");
    assert.equal(e.event_type, "stamp_verified");
    assert.equal(e.category, TRUST_EVENT_TYPES.STAMP_VERIFIED.category);
    assert.equal(e.delta, TRUST_EVENT_TYPES.STAMP_VERIFIED.delta);
    assert.equal(e.source_type, "passport");
    assert.equal(e.source_id, STAMP_ID, "keyed on the user_stamps row");
    assert.equal(e.status, "applied");
    assert.equal(e.metadata.stampSourceType, "trips");

    // No profile yet — this is the production state for 56 of 58 users.
    assert.equal(await getTrustProfile(f.client, OWNER), null);

    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.skipped, undefined);
    assert.equal(pass.eventsSeen, 1, "the pass saw the event");
    assert.equal(pass.usersRecalculated, 1);
    assert.equal(pass.recalcFailures, 0);

    const profile = await getTrustProfile(f.client, OWNER);
    assert.ok(profile, "a profile now exists");
    assert.ok(profile!.categories.passport_authenticity > 50, "passport_authenticity moved above neutral");
    assert.equal(profile!.categories.plan_attendance, 50, "an unrelated category stays neutral");
    assert.equal(profile!.evidenceCount, 1, "evidence is measured, not null");
    assert.ok(profile!.evidenceWeight! > 0.99 && profile!.evidenceWeight! <= 1, "one fresh event weighs ~1");
    assert.ok(typeof profile!.public_level === "string");
  });

  it("an admin-awarded stamp still credits the OWNER; the admin is provenance, not subject", async () => {
    const f = makeFake();
    await recordStampVerifiedTrustEvent(f.client, {
      userId: OWNER, userStampId: STAMP_ID, tier: "verified",
      stampSourceType: "admin", awardedByAdminId: ADMIN,
    });
    const e = f.tables.trust_events[0];
    assert.equal(e.user_id, OWNER);
    assert.equal(e.metadata.awardedByAdminId, ADMIN);
  });

  it("a self-reported (decorative) stamp is NOT evidence: nothing is written, and the skip says why", async () => {
    const f = makeFake();
    const r = await recordStampVerifiedTrustEvent(f.client, {
      userId: OWNER, userStampId: STAMP_ID, tier: "reported", stampSourceType: "self_reported",
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipReason, "not_verified");
    assert.equal(f.tables.trust_events.length, 0);
  });
});

// ── 2. Idempotency ───────────────────────────────────────────────────────────

describe("idempotency: the same trigger processed twice awards once and scores once", () => {
  it("re-emitting the same stamp is a dedup skip; a second pass recalculates nobody and the score is unchanged", async () => {
    const f = makeFake();
    const input = { userId: OWNER, userStampId: STAMP_ID, tier: "verified" as const, stampSourceType: "trips" };
    assert.equal((await recordStampVerifiedTrustEvent(f.client, input)).ok, true);
    await runTrustMaintenance(f.client);
    const first = await getTrustProfile(f.client, OWNER);

    // The award path retried / the webhook was redelivered / the worker crashed after insert.
    const again = await recordStampVerifiedTrustEvent(f.client, input);
    assert.equal(again.ok, false);
    assert.equal(again.skipReason, "dedup");
    assert.equal(f.tables.trust_events.length, 1, "still one event");

    const pass2 = await runTrustMaintenance(f.client);
    assert.equal(pass2.usersRecalculated, 0, "nobody is dirty: the profile is newer than the newest event");
    const second = await getTrustProfile(f.client, OWNER);
    assert.equal(second!.overall_score, first!.overall_score);
    assert.equal(second!.evidenceCount, 1);
  });

  it("a forced recalculation is a pure recompute of the ledger — running it N times does not compound", async () => {
    const f = makeFake();
    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: STAMP_ID, tier: "verified", stampSourceType: "trips" });
    const a = await recalculateTrustScore(f.client, OWNER);
    const b = await recalculateTrustScore(f.client, OWNER);
    const c = await recalculateTrustScore(f.client, OWNER);
    assert.equal(a.overall_score, b.overall_score);
    assert.equal(b.overall_score, c.overall_score);
    assert.equal(f.tables.trust_profiles.length, 1, "one profile row, upserted, never duplicated");
  });

  it("two DIFFERENT stamps for the same owner are two events (dedup is per source, not per user)", async () => {
    const f = makeFake();
    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: STAMP_ID, tier: "verified", stampSourceType: "trips" });
    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: "another-stamp", tier: "verified", stampSourceType: "events" });
    assert.equal(f.tables.trust_events.length, 2);
  });
});

// ── 3. Location finding → pending_review → queue → confirm → cap → profile ───

describe("chain: GPS impossible-speed finding → pending_review → queue → confirm → ceiling → capped profile", () => {
  it("runs the serious-event path end to end, and a second confirm cannot double-cap", async () => {
    const f = makeFake();
    // Real caller: LocationSafetyService.checkAndRecordSnapshot on a high-confidence impossible speed.
    await recordLocationTrustEvent(f.client, OWNER, "impossible_speed", "high");

    const [e] = f.tables.trust_events;
    assert.equal(e.event_type, "gps_impossible_speed");
    assert.equal(e.severity, "serious");
    assert.equal(e.status, "pending_review", "serious findings are not scored until adjudicated");
    assert.equal(e.source_type, "gps");

    // Queued where an admin can actually list it.
    const reviews = await getOpenReviews(f.client);
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].source_event_id, e.id);
    assert.equal(reviews[0].review_type, "event_review");
    assert.equal((await getPendingEvents(f.client)).length, 1);

    // A maintenance pass before adjudication: pending events do not make a user dirty.
    const pre = await runTrustMaintenance(f.client);
    assert.equal(pre.usersRecalculated, 0);
    assert.equal(pre.eventsSeen, 0, "pending_review is not scoreable");

    await confirmEvent(f.client, ADMIN, e.id, "verified against telemetry");
    assert.equal(e.status, "confirmed");
    assert.equal(e.reviewed_by, ADMIN);

    const caps = await getActiveCaps(f.client, OWNER);
    assert.equal(caps.length, 1);
    assert.equal(caps[0].category, "location_honesty");
    assert.equal(caps[0].ceilingScore, 55);
    assert.equal(caps[0].sourceEventId, e.id, "the cap is traceable to the finding");

    const profile = await getTrustProfile(f.client, OWNER);
    assert.ok(profile);
    assert.ok(profile!.categories.location_honesty <= 55, "the ceiling holds");
    assert.ok(profile!.categories.location_honesty < 50, "and the -8 bit at full strength");
    assert.equal(f.tables.trust_reviews[0].status, "resolved");
    assert.equal(f.tables.trust_admin_actions.length, 1);

    // Idempotency of adjudication: the event is no longer pending.
    await assert.rejects(() => confirmEvent(f.client, ADMIN, e.id, "again"), /not pending review/);
    assert.equal(f.tables.trust_caps.length, 1, "no second ceiling");
    assert.equal(f.tables.trust_admin_actions.length, 1, "no second audit row");
  });

  it("the same finding on the same day is deduplicated; the next day is a new finding", async () => {
    const f = makeFake();
    await recordLocationTrustEvent(f.client, OWNER, "impossible_speed", "high");
    await recordLocationTrustEvent(f.client, OWNER, "impossible_speed", "high");
    assert.equal(f.tables.trust_events.length, 1);
    assert.equal(f.tables.trust_reviews.length, 1, "one review per event, not per attempt");
  });
});

// ── 4. Fail-closed reads ─────────────────────────────────────────────────────

describe("fail-closed: a read that cannot be performed never reads as an empty result", () => {
  it("dedup read failure → the event is NOT written (no double award on a flaky ledger)", async () => {
    const f = makeFake();
    f.failNext("trust_events", "select", "statement timeout");
    const r = await recordTrustEvent(f.client, {
      userId: OWNER, eventType: "stamp_verified", category: "passport_authenticity",
      delta: 3, severity: "minor", sourceType: "passport", sourceId: STAMP_ID,
    });
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
    assert.equal(r.skipReason, "dedup_unverifiable");
    assert.equal(f.tables.trust_events.length, 0);
  });

  it("trust_events read failure during recalculation → throws; the existing profile is NOT overwritten with neutral 50s", async () => {
    const f = makeFake();
    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: STAMP_ID, tier: "verified", stampSourceType: "trips" });
    const good = await recalculateTrustScore(f.client, OWNER);
    assert.ok(good.categories.passport_authenticity > 50);

    f.failNext("trust_events", "select", "connection reset");
    await assert.rejects(() => recalculateTrustScore(f.client, OWNER), /trust_events read failed/);

    const after = await getTrustProfile(f.client, OWNER);
    assert.equal(after!.categories.passport_authenticity, good.categories.passport_authenticity, "profile untouched");
    assert.equal(after!.evidenceCount, 1, "evidence not falsely re-measured as 0");
  });

  it("trust_caps read failure during recalculation → throws; an uncapped score is never persisted over a live ceiling", async () => {
    const f = makeFake();
    await recordLocationTrustEvent(f.client, OWNER, "impossible_speed", "high");
    await confirmEvent(f.client, ADMIN, f.tables.trust_events[0].id, "confirmed");
    // Push the category up with positive evidence that the ceiling must clamp.
    for (let i = 0; i < 6; i++) {
      await recordTrustEvent(f.client, {
        userId: OWNER, eventType: "checkin_verified", category: "location_honesty",
        delta: 2, severity: "minor", sourceType: "hidden_gem", sourceId: `gem-${i}`,
      });
    }
    const capped = await recalculateTrustScore(f.client, OWNER);
    assert.ok(capped.capsApplied.includes("location_honesty") || capped.categories.location_honesty <= 55);

    f.failNext("trust_caps", "select", "timeout");
    await assert.rejects(() => recalculateTrustScore(f.client, OWNER), /trust_caps read failed/);
    const after = await getTrustProfile(f.client, OWNER);
    assert.ok(after!.categories.location_honesty <= 55, "still capped");
  });

  it("trust_settings read failure → throws (defaults are not a substitute for an admin's weights)", async () => {
    const f = makeFake();
    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: STAMP_ID, tier: "verified", stampSourceType: "trips" });
    f.failNext("trust_settings", "select", "timeout");
    await assert.rejects(() => recalculateTrustScore(f.client, OWNER), /trust_settings read failed/);
    assert.equal(f.tables.trust_profiles.length, 0, "nothing persisted");
  });

  it("the scheduler counts a failed recalculation instead of writing through it", async () => {
    const f = makeFake();
    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: STAMP_ID, tier: "verified", stampSourceType: "trips" });
    // First trust_events select in the pass is findDirtyUsers (succeeds); the
    // next is loadEvents inside recalculateTrustScore — that one fails.
    let calls = 0;
    const orig = f.client.from;
    f.client.from = (t: string) => {
      if (t === "trust_events" && ++calls === 2) f.failNext("trust_events", "select", "timeout");
      return orig(t);
    };
    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.eventsSeen, 1);
    assert.equal(pass.usersRecalculated, 0);
    assert.equal(pass.recalcFailures, 1);
    assert.equal(f.tables.trust_profiles.length, 0, "no neutral profile was fabricated");
  });

  it("pending-events queue read failure → throws, never an empty queue", async () => {
    const f = makeFake();
    f.failNext("trust_events", "select", "timeout");
    await assert.rejects(() => getPendingEvents(f.client), /trust_events read failed/);
    f.failNext("trust_reviews", "select", "timeout");
    await assert.rejects(() => getOpenReviews(f.client), /trust_reviews read failed/);
  });

  it("confirmEvent: a failed status update stops BEFORE the cap, so a retry cannot double-cap", async () => {
    const f = makeFake();
    await recordLocationTrustEvent(f.client, OWNER, "impossible_speed", "high");
    const e = f.tables.trust_events[0];
    f.failNext("trust_events", "update", "timeout");
    await assert.rejects(() => confirmEvent(f.client, ADMIN, e.id, "x"), /status update failed/);
    assert.equal(e.status, "pending_review", "still pending");
    assert.equal(f.tables.trust_caps.length, 0, "no cap");
    assert.equal(f.tables.trust_admin_actions.length, 0, "no audit row claiming it happened");

    // The retry succeeds exactly once.
    await confirmEvent(f.client, ADMIN, e.id, "x");
    assert.equal(f.tables.trust_caps.length, 1);
  });

  it("the engine flag read failing is OFF for that call — and the event is skipped as flag_off, not written", async () => {
    const f = makeFake();
    f.failNext("feature_flags", "select", "timeout");
    const r = await recordTrustEvent(f.client, {
      userId: OWNER, eventType: "stamp_verified", category: "passport_authenticity",
      delta: 3, severity: "minor", sourceType: "passport", sourceId: STAMP_ID,
    });
    assert.equal(r.skipReason, "flag_off");
    assert.equal(f.tables.trust_events.length, 0);
  });
});

// ── 5. Vacuity is visible ────────────────────────────────────────────────────

describe("vacuity: an empty scan and an empty pass say so", () => {
  it("the gaming scan reports what it examined, and calls an all-empty scan vacuous", async () => {
    const f = makeFake();
    const empty = await runGamingDetectionScan(f.client);
    assert.equal(empty.flaggedUsers, 0);
    assert.equal(empty.vacuous, true);
    assert.deepEqual(empty.inputs, { checkins: 0, positiveEvents: 0, scoredEvents: 0 });

    await recordStampVerifiedTrustEvent(f.client, { userId: OWNER, userStampId: STAMP_ID, tier: "verified", stampSourceType: "trips" });
    const fed = await runGamingDetectionScan(f.client);
    assert.equal(fed.vacuous, false);
    assert.equal(fed.inputs!.positiveEvents, 1);
    assert.equal(fed.inputs!.scoredEvents, 1);
    assert.equal(fed.inputs!.checkins, 0);
  });

  it("a detector whose query failed reports null, not 0 — 'could not look' is not 'saw nothing'", async () => {
    const f = makeFake();
    f.failNext("plan_attendance_events", "select", "timeout");
    const r = await runGamingDetectionScan(f.client);
    assert.equal(r.inputs!.checkins, null);
    assert.equal(r.inputs!.positiveEvents, 0);
  });

  it("a maintenance pass over an empty ledger reports eventsSeen 0 and a vacuous scan — the production signature", async () => {
    const f = makeFake();
    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.eventsSeen, 0);
    assert.equal(pass.usersRecalculated, 0);
    assert.equal(pass.gamingVacuous, true);
    assert.deepEqual(pass.gamingInputs, { checkins: 0, positiveEvents: 0, scoredEvents: 0 });
  });

  it("a pass whose event read failed reports eventsSeen null, distinct from 0", async () => {
    const f = makeFake();
    f.failNext("trust_events", "select", "timeout");
    const pass = await runTrustMaintenance(f.client);
    assert.equal(pass.eventsSeen, null);
  });
});
