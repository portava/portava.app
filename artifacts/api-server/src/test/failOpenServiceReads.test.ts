/**
 * FAIL-OPEN unchecked reads — service layer.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error; it does not throw. So
 *
 *     const { data } = await sc.from("x").select(…).eq(…);
 *
 * hands back the SAME empty result when there is genuinely no row and when the
 * table could not be read at all. Wherever the empty result is the permissive
 * answer — "not rate limited", "not a duplicate", "not yet awarded", "the kill
 * switch is off", "this GPS fix is plausible" — a transient database blip
 * silently becomes a grant.
 *
 * Every site below was carried in src/scripts/UNCHECKED_READS_ALLOWLIST.json
 * with a `FAIL-OPEN:` note. This file pins BOTH halves for each:
 *
 *   failure half   the table resolves an error → the safe answer
 *   healthy half   the table reads → behaviour is byte-for-byte what it was
 *
 * The healthy half is not padding. A "fix" that answered unsafe-always would
 * pass every failure assertion here and be a production outage; it is the pair
 * that pins the fix.
 *
 * The fake client (src/test/helpers/failClosedSupabase.ts) injects a RESOLVED
 * `{ data: null, error }`, never a rejection — a test whose fake threw would be
 * exercising a `try/catch` that production never enters.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/failOpenServiceReads.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { awardStamp, checkEligibility } from "../services/passport/StampAwardEngine.js";
import {
  checkRateLimit,
  checkCooldown,
  checkCategoryDeclineCooldown,
} from "../services/telegraphChatSuggestions.js";
import { checkAndRecordSnapshot } from "../services/location/LocationSafetyService.js";
import { NotificationDeduplicationService } from "../services/notifications/NotificationDeduplicationService.js";
import { runSense } from "../compass/CompassSenseEngine.js";
import { runLiveCheck } from "../compass/CompassLiveEngine.js";
import { evaluateNotification } from "../compass/CompassNotificationEngine.js";

const USER = "11111111-1111-1111-1111-111111111111";
const THREAD = "22222222-2222-2222-2222-222222222222";
const DEF_ID = "33333333-3333-3333-3333-333333333333";

const nowIso = () => new Date().toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// StampAwardEngine — passport_stamps_enabled kill switch (flag-table tier)
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the ONE flag in the tree whose ABSENT row means ON: stamps work
// out-of-box with no DB setup, and only an explicit `enabled = false` row
// suppresses awards. That polarity is load-bearing and is asserted here so a
// future sweep cannot "fix" it into an ordinary *_enabled flag. What must NOT
// share the absent row's meaning is a failed READ: a kill switch whose position
// cannot be determined has to be treated as thrown.

const V2_ON = { flag: "stamp_system_v2_enabled", enabled: true };

function stampClient(flagRows: any[], failFlag?: string) {
  return makeFailClosedClient({
    rows: { feature_flags: flagRows, stamp_definitions: [] },
    failOn: (ctx) =>
      failFlag && ctx.table === "feature_flags" && ctx.eq("flag") === failFlag
        ? { message: "server closed the connection unexpectedly", code: "08006" }
        : null,
  });
}

describe("StampAwardEngine — passport_stamps_enabled kill switch", () => {
  it("FAILURE: an unreadable kill-switch row does NOT award (was: read as enabled)", async () => {
    const sc = stampClient([V2_ON], "passport_stamps_enabled");
    const r = await awardStamp(sc, { userId: USER, definitionSlug: "city_explorer" });
    assert.equal(r.awarded, false);
    assert.equal(
      r.reason,
      "feature_disabled",
      "an unreadable kill switch must be treated as thrown, not as absent",
    );
  });

  it("HEALTHY: an ABSENT flag row still lets the award proceed (polarity preserved)", async () => {
    const sc = stampClient([V2_ON]);
    const r = await awardStamp(sc, { userId: USER, definitionSlug: "city_explorer" });
    // It got PAST 0b and fell over at the (empty) definition table — which is
    // the proof that the absent flag row did not suppress the award.
    assert.equal(r.reason, "definition_not_found");
  });

  it("HEALTHY: an explicit enabled=false row still suppresses awards", async () => {
    const sc = stampClient([V2_ON, { flag: "passport_stamps_enabled", enabled: false }]);
    const r = await awardStamp(sc, { userId: USER, definitionSlug: "city_explorer" });
    assert.equal(r.awarded, false);
    assert.equal(r.reason, "feature_disabled");
  });

  it("HEALTHY: an explicit enabled=true row lets the award proceed", async () => {
    const sc = stampClient([V2_ON, { flag: "passport_stamps_enabled", enabled: true }]);
    const r = await awardStamp(sc, { userId: USER, definitionSlug: "city_explorer" });
    assert.equal(r.reason, "definition_not_found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// StampAwardEngine.checkEligibility — the three "already got this?" reads
// ═══════════════════════════════════════════════════════════════════════════
//
// All three are ALLOW-table reads whose EMPTY answer is the permissive one. A
// dropped `.error` made each of them answer "eligible" for a table that simply
// could not be read.

function eligibilityClient(opts: {
  repeatable?: boolean;
  maxAwards?: number | null;
  events?: any[];
  stamps?: any[];
  fail?: "stamp_award_events" | "user_stamps";
}) {
  return makeFailClosedClient({
    rows: {
      stamp_definitions: [{
        id: DEF_ID,
        slug: "city_explorer",
        name: "City Explorer",
        is_active: true,
        is_repeatable: opts.repeatable ?? false,
        max_awards_per_user: opts.maxAwards ?? null,
        criteria_type: "manual",
        criteria: null,
      }],
      stamp_award_events: opts.events ?? [],
      user_stamps: opts.stamps ?? [],
    },
    failOn: (ctx) =>
      opts.fail && ctx.table === opts.fail
        ? { message: "canceling statement due to statement timeout", code: "57014" }
        : null,
  });
}

describe("StampAwardEngine.checkEligibility — idempotency / already-earned / cap", () => {
  it("FAILURE: unreadable stamp_award_events is NOT 'not yet awarded'", async () => {
    const r = await checkEligibility(eligibilityClient({ fail: "stamp_award_events" }), USER, "city_explorer");
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "eligibility_unavailable");
  });

  it("FAILURE: unreadable user_stamps is NOT 'not earned' (non-repeatable stamp)", async () => {
    const r = await checkEligibility(eligibilityClient({ fail: "user_stamps" }), USER, "city_explorer");
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "eligibility_unavailable");
  });

  it("FAILURE: an uncountable max_awards_per_user cap is NOT 'cap not reached'", async () => {
    const r = await checkEligibility(
      eligibilityClient({ repeatable: true, maxAwards: 2, fail: "user_stamps" }),
      USER,
      "city_explorer",
    );
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "eligibility_unavailable");
  });

  it("HEALTHY: a clean slate is still eligible", async () => {
    const r = await checkEligibility(eligibilityClient({}), USER, "city_explorer");
    assert.equal(r.eligible, true);
    assert.equal(r.reason, "eligible");
  });

  it("HEALTHY: an awarded event still reads as already_awarded", async () => {
    const r = await checkEligibility(
      eligibilityClient({ events: [{ id: "e1", idempotency_key: `${USER}:${DEF_ID}:system:none`, status: "awarded" }] }),
      USER,
      "city_explorer",
    );
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "already_awarded");
  });

  it("HEALTHY: an existing stamp still reads as already_earned", async () => {
    const r = await checkEligibility(
      eligibilityClient({ stamps: [{ id: "s1", user_id: USER, stamp_definition_id: DEF_ID, is_revoked: false }] }),
      USER,
      "city_explorer",
    );
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "already_earned");
  });

  it("HEALTHY: a reached cap still reads as max_awards_reached, and an unreached one is eligible", async () => {
    const two = [
      { id: "s1", user_id: USER, stamp_definition_id: DEF_ID, is_revoked: false },
      { id: "s2", user_id: USER, stamp_definition_id: DEF_ID, is_revoked: false },
    ];
    const hit = await checkEligibility(
      eligibilityClient({ repeatable: true, maxAwards: 2, stamps: two }),
      USER, "city_explorer",
    );
    assert.equal(hit.reason, "max_awards_reached");

    const under = await checkEligibility(
      eligibilityClient({ repeatable: true, maxAwards: 2, stamps: two.slice(0, 1) }),
      USER, "city_explorer",
    );
    assert.equal(under.eligible, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// telegraphChatSuggestions — rate limit / cooldown / decline cooldown
// ═══════════════════════════════════════════════════════════════════════════

function suggestionClient(rows: Record<string, any[]>, failTable?: string) {
  return makeFailClosedClient({
    rows,
    failOn: (ctx) =>
      failTable && ctx.table === failTable
        ? { message: "could not connect to server", code: "08001" }
        : null,
  });
}

describe("telegraphChatSuggestions.checkRateLimit", () => {
  const seed = (n: number) => ({
    telegraph_chat_suggestions: Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, user_id: USER, thread_id: THREAD, created_at: nowIso(),
    })),
  });

  it("FAILURE: an uncountable hourly cap does NOT report 'within limit'", async () => {
    const ok = await checkRateLimit(suggestionClient(seed(0), "telegraph_chat_suggestions") as any, USER, THREAD);
    assert.equal(ok, false, "count null → 0 → 'under the cap' was the fail-open answer");
  });

  it("HEALTHY: 2 in the last hour is still within limit; 3 is not", async () => {
    assert.equal(await checkRateLimit(suggestionClient(seed(2)) as any, USER, THREAD), true);
    assert.equal(await checkRateLimit(suggestionClient(seed(3)) as any, USER, THREAD), false);
  });
});

describe("telegraphChatSuggestions.checkCooldown", () => {
  const row = (id: string) => ({
    id, user_id: USER, thread_id: THREAD, intent_type: "food", status: "shown", created_at: nowIso(),
  });

  it("FAILURE: an unreadable cooldown table does NOT clear the cooldown", async () => {
    const ok = await checkCooldown(
      suggestionClient({ telegraph_chat_suggestions: [] }, "telegraph_chat_suggestions") as any,
      USER, THREAD, "food",
    );
    assert.equal(ok, false);
  });

  it("FAILURE: MULTIPLE rows in the window no longer clear the cooldown via maybeSingle", async () => {
    // The old `.maybeSingle()` raised PGRST116 on >1 row, `data` came back null,
    // and `!data` said "no cooldown" — the strongest evidence of a cooldown read
    // as its absence. `.limit(1)` removes the raise entirely.
    const ok = await checkCooldown(
      suggestionClient({ telegraph_chat_suggestions: [row("s1"), row("s2")] }) as any,
      USER, THREAD, "food",
    );
    assert.equal(ok, false, "two recent suggestions must still be a cooldown");
  });

  it("HEALTHY: no recent suggestion is safe to show; one recent is not", async () => {
    assert.equal(
      await checkCooldown(suggestionClient({ telegraph_chat_suggestions: [] }) as any, USER, THREAD, "food"),
      true,
    );
    assert.equal(
      await checkCooldown(suggestionClient({ telegraph_chat_suggestions: [row("s1")] }) as any, USER, THREAD, "food"),
      false,
    );
  });
});

describe("telegraphChatSuggestions.checkCategoryDeclineCooldown", () => {
  const decline = { user_id: USER, category: "food", signal: "dismiss", created_at: nowIso() };

  it("FAILURE: unreadable preference history does NOT re-surface a dismissed category", async () => {
    const ok = await checkCategoryDeclineCooldown(
      suggestionClient({ user_preference_events: [] }, "user_preference_events") as any,
      USER, "food",
    );
    assert.equal(ok, false);
  });

  it("HEALTHY: no decline is safe to show; a recent decline suppresses", async () => {
    assert.equal(
      await checkCategoryDeclineCooldown(suggestionClient({ user_preference_events: [] }) as any, USER, "food"),
      true,
    );
    assert.equal(
      await checkCategoryDeclineCooldown(suggestionClient({ user_preference_events: [decline] }) as any, USER, "food"),
      false,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LocationSafetyService.checkAndRecordSnapshot — anti-spoof plausibility check
// ═══════════════════════════════════════════════════════════════════════════

describe("LocationSafetyService.checkAndRecordSnapshot", () => {
  it("FAILURE: an unreadable snapshot table is NOT a clean verdict", async () => {
    const spec = {
      rows: { location_snapshots: [] as any[] },
      failOn: (ctx: any) =>
        ctx.table === "location_snapshots" && !ctx.filters.some((f: any) => f.col === "__write")
          ? { message: "deadlock detected", code: "40P01" }
          : null,
      inserted: {} as Record<string, any[]>,
    };
    // The insert path must still succeed, so only READS are failed: the fake
    // routes writes through settleWrite(), which does not consult failOn.
    const sc = makeFailClosedClient(spec);
    const r = await checkAndRecordSnapshot(sc, USER, 48.85, 2.35);
    assert.equal(r.trusted, false, "a check that did not run must not report trusted");
    assert.equal(r.suspicionReason, "plausibility_check_unavailable");
    // No trust event was written — the user is not accused of anything.
    assert.equal((spec.inserted.trust_events ?? []).length, 0);
    // The fresh snapshot is still recorded so the next check has a baseline.
    assert.equal((spec.inserted.location_snapshots ?? []).length, 1);
  });

  it("HEALTHY: no previous snapshot is genuinely trusted", async () => {
    const sc = makeFailClosedClient({ rows: { location_snapshots: [] } });
    const r = await checkAndRecordSnapshot(sc, USER, 48.85, 2.35);
    assert.equal(r.trusted, true);
    assert.equal(r.suspicionReason, undefined);
  });

  it("HEALTHY: a nearby previous snapshot is trusted; a teleport is still caught", async () => {
    const near = {
      user_id: USER, lat: 48.8555, lng: 2.3512,
      captured_at: minutesAgo(10),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const ok = await checkAndRecordSnapshot(
      makeFailClosedClient({ rows: { location_snapshots: [near] } }), USER, 48.85, 2.35,
    );
    assert.equal(ok.trusted, true);

    const far = { ...near, lat: -33.87, lng: 151.21 }; // Paris → Sydney in 10 min
    const jump = await checkAndRecordSnapshot(
      makeFailClosedClient({ rows: { location_snapshots: [far] } }), USER, 48.85, 2.35,
    );
    assert.equal(jump.trusted, false);
    assert.equal(
      jump.suspicionReason,
      "coordinate_jump",
      "a REAL suspicion must stay distinguishable from 'the check could not run'",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NotificationDeduplicationService — general dedupe
// ═══════════════════════════════════════════════════════════════════════════

describe("NotificationDeduplicationService.check", () => {
  const params = {
    userId: USER, category: "trip", eventType: "trip.reminder",
    sourceType: "trip", sourceId: "trip-1",
  };

  it("FAILURE: an unreadable notifications table suppresses rather than duplicating", async () => {
    const sc = makeFailClosedClient({
      rows: { notifications: [] },
      failOn: (ctx) => (ctx.table === "notifications" ? { message: "too many connections", code: "53300" } : null),
    });
    const r = await new NotificationDeduplicationService(sc).check(params);
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "general_dedup");
  });

  it("HEALTHY: no recent notification is not a duplicate", async () => {
    const sc = makeFailClosedClient({ rows: { notifications: [] } });
    const r = await new NotificationDeduplicationService(sc).check(params);
    assert.equal(r.isDuplicate, false);
  });

  it("HEALTHY: a matching recent notification is still a duplicate", async () => {
    const sc = makeFailClosedClient({
      rows: {
        notifications: [{
          id: "n1", user_id: USER, category: "trip", event_type: "trip.reminder",
          source_type: "trip", source_id: "trip-1", created_at: nowIso(),
        }],
      },
    });
    const r = await new NotificationDeduplicationService(sc).check(params);
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "general_dedup");
  });

  it("HEALTHY: a DIFFERENT event type about the same source is not a duplicate", async () => {
    const sc = makeFailClosedClient({
      rows: {
        notifications: [{
          id: "n1", user_id: USER, category: "trip", event_type: "trip.invite",
          source_type: "trip", source_id: "trip-1", created_at: nowIso(),
        }],
      },
    });
    const r = await new NotificationDeduplicationService(sc).check(params);
    assert.equal(r.isDuplicate, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Compass Sense / Live — nudge dedupe
// ═══════════════════════════════════════════════════════════════════════════

function senseSeed(): Record<string, any[]> {
  return {
    compass_sense_settings: [{ user_id: USER, presence_level: "active", categories: {} }],
    event_saves: [{ event_id: "evt-1", user_id: USER }],
    events: [{
      id: "evt-1", title: "Rooftop set", state: "published",
      starts_at: new Date(Date.now() + 3_600_000).toISOString(),
    }],
    compass_sense_nudges: [],
    notification_preferences: [],
  };
}

describe("CompassSenseEngine.runSense — nudge dedupe", () => {
  it("FAILURE: an unreadable dedupe ledger suppresses the nudge instead of resending it", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: senseSeed(),
      inserted,
      failOn: (ctx) =>
        ctx.table === "compass_sense_nudges" ? { message: "relation unavailable", code: "57P03" } : null,
    });
    const r = await runSense(sc, USER, { nowMs: Date.now(), hourUtc: 12, nowMinutes: 720 });
    assert.equal(r.delivered.length, 0, "an unknown dedupe state must not deliver");
    assert.equal(r.suppressed[0]?.reason, "duplicate");
    assert.equal((inserted.compass_sense_nudges ?? []).length, 0, "no duplicate durable row");
  });

  it("HEALTHY: a genuine first-time signal is still delivered and logged", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: senseSeed(), inserted });
    const r = await runSense(sc, USER, { nowMs: Date.now(), hourUtc: 12, nowMinutes: 720 });
    assert.equal(r.delivered.length, 1);
    assert.equal(r.delivered[0]?.type, "saved_event_starting");
    assert.equal((inserted.compass_sense_nudges ?? []).length, 1);
  });

  it("HEALTHY: a nudge already in the ledger is still suppressed as a duplicate", async () => {
    const rows = senseSeed();
    rows.compass_sense_nudges = [{
      id: "n1", user_id: USER, dedupe_key: "event_start:evt-1", created_at: nowIso(),
    }];
    const r = await runSense(makeFailClosedClient({ rows }), USER, { nowMs: Date.now(), hourUtc: 12, nowMinutes: 720 });
    assert.equal(r.delivered.length, 0);
    assert.equal(r.suppressed[0]?.reason, "duplicate");
  });
});

function liveSeed(): Record<string, any[]> {
  const seed = senseSeed();
  seed.compass_live_sessions = [{
    id: "live-1", user_id: USER, status: "active", trip_id: null,
    started_at: nowIso(), checks_run: 0, nudges_delivered: 0, context: {},
  }];
  return seed;
}

describe("CompassLiveEngine.runLiveCheck — nudge dedupe", () => {
  it("FAILURE: an unreadable dedupe ledger suppresses the live nudge", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: liveSeed(),
      inserted,
      failOn: (ctx) =>
        ctx.table === "compass_sense_nudges" ? { message: "relation unavailable", code: "57P03" } : null,
    });
    const r = await runLiveCheck(sc, USER, { nowMs: Date.now(), hourUtc: 12 });
    assert.equal(r.active, true, "the session must still be found — only the dedupe read failed");
    assert.equal(r.delivered.length, 0);
    assert.ok(
      r.suppressed.some((s) => s.reason === "duplicate"),
      `expected a duplicate suppression, got ${JSON.stringify(r.suppressed)}`,
    );
    assert.equal((inserted.compass_sense_nudges ?? []).length, 0);
  });

  it("HEALTHY: a first-time live nudge is still delivered", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: liveSeed(), inserted });
    const r = await runLiveCheck(sc, USER, { nowMs: Date.now(), hourUtc: 12 });
    assert.equal(r.active, true);
    assert.ok(r.delivered.length > 0, `expected at least one delivered nudge, got ${JSON.stringify(r)}`);
    assert.ok((inserted.compass_sense_nudges ?? []).length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CompassNotificationEngine.isCategoryBlocked — a category KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════════

describe("CompassNotificationEngine — category safety-block flag", () => {
  const payload = {
    type: "recommendation" as const,
    title: "Tonight nearby",
    body: "A rooftop set two streets away.",
    category: "nightlife",
  };

  it("FAILURE: an unreadable *_SAFETY_BLOCK flag is treated as THROWN", async () => {
    const sc = makeFailClosedClient({
      rows: { feature_flags: [] },
      failOn: (ctx) =>
        ctx.table === "feature_flags" && String(ctx.eq("flag") ?? "").endsWith("_SAFETY_BLOCK")
          ? { message: "server closed the connection unexpectedly", code: "08006" }
          : null,
    });
    const d = await evaluateNotification(sc, USER, payload, { nowMinutes: 720 });
    assert.equal(d.outcome, "suppressed_safety_filter");
    assert.equal(d.suppressionReason, "safety_block:nightlife");
  });

  it("HEALTHY: an absent flag row does NOT block the category", async () => {
    const sc = makeFailClosedClient({ rows: { feature_flags: [] } });
    const d = await evaluateNotification(sc, USER, payload, { nowMinutes: 720 });
    assert.notEqual(
      d.suppressionReason,
      "safety_block:nightlife",
      "no flag row must keep meaning 'not blocked'",
    );
  });

  it("HEALTHY: an explicit enabled=true flag still blocks the category", async () => {
    const sc = makeFailClosedClient({
      rows: { feature_flags: [{ flag: "COMPASS_NIGHTLIFE_SAFETY_BLOCK", enabled: true }] },
    });
    const d = await evaluateNotification(sc, USER, payload, { nowMinutes: 720 });
    assert.equal(d.outcome, "suppressed_safety_filter");
    assert.equal(d.suppressionReason, "safety_block:nightlife");
  });

  it("HEALTHY: an explicit enabled=false flag does not block", async () => {
    const sc = makeFailClosedClient({
      rows: { feature_flags: [{ flag: "COMPASS_NIGHTLIFE_SAFETY_BLOCK", enabled: false }] },
    });
    const d = await evaluateNotification(sc, USER, payload, { nowMinutes: 720 });
    assert.notEqual(d.suppressionReason, "safety_block:nightlife");
  });
});
