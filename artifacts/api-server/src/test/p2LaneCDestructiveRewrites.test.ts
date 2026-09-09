/**
 * Read-modify-WRITE of a whole JSON column, where the read was unchecked.
 *
 * These are the worst shape of the write-precondition defect, and the same one
 * `stampPostAwardReadsFailClosed.test.ts` pins for stamp_progress: the code
 * reads a column, edits the value in memory, and writes the WHOLE thing back.
 * supabase-js resolves a failed read as `{ data: null }`, so `?? {}` turns an
 * unreadable column into an empty one — and the write-back then replaces the
 * user's accumulated state with whatever this one request contributed. Nothing
 * is lost in transit; it is destroyed on disk.
 *
 * Each case has a CONTROL proving the healthy path still writes, because a fix
 * that bailed out unconditionally would satisfy every failure assertion below
 * while quietly disabling the learning it protects.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneCDestructiveRewrites.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";

import { recordOutcome } from "../compass/CompassOutcomeEngine.js";
import { processFeedback } from "../compass/CompassFeedbackEngine.js";
import { flushDecayForAllUsers } from "../lib/compassSearchDecayFlushScheduler.js";

const USER = "40000000-0000-4000-a000-000000000001";

const prefsDown = (ctx: FakeReadContext) =>
  ctx.table === "compass_user_preferences"
    ? { message: "compass_user_preferences unavailable", code: "57P01" }
    : null;

// ── compass_user_preferences.category_weights, via the outcome nudge ─────────

describe("applyRankingNudge — an unreadable weights column is not an empty one", () => {
  const REC = "rec-1";
  const served = [
    {
      user_id: USER,
      recommendation_id: REC,
      item_id: "item-1",
      item_type: "event",
      // predicted 20 vs realized 100 ("returned") → |delta| 80, well over the
      // FIT_DELTA_THRESHOLD of 20, so the nudge definitely fires.
      ranking_factors: { compassMatch: 20 },
      created_at: new Date().toISOString(),
    },
  ];
  const learned = { user_id: USER, category_weights: { place: 7, trip: -4, event: 2 } };

  it("CONTROL: a readable column is nudged, and every other weight survives", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        compass_served_recommendations: served,
        compass_outcome_events: [],
        compass_user_preferences: [learned],
      },
      inserted,
    });
    const r = await recordOutcome(db, USER, { recommendationId: REC, stage: "returned" });
    assert.equal(r.recorded, true);
    assert.equal(r.weightAdjusted, true, "the nudge must still fire on the happy path");

    const writes = inserted["compass_user_preferences"] ?? [];
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].category_weights, { place: 7, trip: -4, event: 3 });
  });

  it("an unreadable column does NOT rewrite category_weights down to the single nudged key", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        compass_served_recommendations: served,
        compass_outcome_events: [],
        compass_user_preferences: [learned],
      },
      // Only compass_user_preferences fails; the served-recommendation and
      // outcome-event reads stay healthy, so the nudge really is reached.
      failOn: prefsDown,
      inserted,
    });
    const r = await recordOutcome(db, USER, { recommendationId: REC, stage: "returned" });
    assert.equal(r.recorded, true, "recording the outcome itself is unaffected");
    assert.equal(r.weightAdjusted, false, "the nudge must report itself as not applied");
    assert.equal(
      (inserted["compass_user_preferences"] ?? []).length,
      0,
      "three learned weights must not be replaced by one",
    );
  });
});

// ── compass_recent_context.signals, via the not_now feedback action ──────────

describe("processFeedback not_now — an unreadable signals blob is not an empty one", () => {
  const ctxRow = {
    user_id: USER,
    signals: { session_suppressed_ids: ["already-dismissed"], intent: "food", last_query: "ramen" },
  };
  const req = { action: "not_now", recommendationId: "item-9", itemType: "event" } as any;

  it("CONTROL: a readable blob keeps its other keys and its earlier suppressions", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { compass_recent_context: [ctxRow], compass_user_preferences: [{ user_id: USER }] },
      inserted,
    });
    await processFeedback(db, USER, req);

    const writes = inserted["compass_recent_context"] ?? [];
    assert.equal(writes.length, 1, "the happy path must still record the suppression");
    assert.deepEqual(writes[0].signals.session_suppressed_ids, ["already-dismissed", "item-9"]);
    assert.equal(writes[0].signals.intent, "food", "unrelated signal keys must survive");
    assert.equal(writes[0].signals.last_query, "ramen");
  });

  it("an unreadable compass_recent_context does NOT wipe the signals blob", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { compass_recent_context: [ctxRow], compass_user_preferences: [{ user_id: USER }] },
      failOn: (c) =>
        c.table === "compass_recent_context" ? { message: "recent_context unavailable", code: "57P01" } : null,
      inserted,
    });
    await processFeedback(db, USER, req);
    assert.equal(
      (inserted["compass_recent_context"] ?? []).length,
      0,
      "a one-key signals object must not be written over the stored one",
    );
  });
});

// ── compass_search_signal_log baselines, via the decay flush ─────────────────

describe("flushDecayForUser — an unreadable weights row must not advance log baselines", () => {
  const OLD = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const signalRows = () => [
    { user_id: USER, category: "food", last_nudge_at: OLD, search_weight: 8 },
  ];

  it("CONTROL: a readable weights row decays and resets the log baseline", async () => {
    const spec: any = {
      rows: {
        compass_search_signal_log: signalRows(),
        compass_user_preferences: [{ user_id: USER, category_weights: { food: 8 } }],
      },
    };
    const db = makeFailClosedClient(spec);
    const report = await flushDecayForAllUsers(db, 7);
    assert.equal(report.weightsUpdated, 1, "the happy path must still persist the decayed weight");
    assert.ok(report.logRowsReset > 0, "and must still advance the log baseline");
  });

  it("an unreadable compass_user_preferences leaves the decay information in the log", async () => {
    const spec: any = {
      rows: {
        compass_search_signal_log: signalRows(),
        compass_user_preferences: [{ user_id: USER, category_weights: { food: 8 } }],
      },
      // Scoped to the preferences table only — the signal-log paging read that
      // discovers the user must stay healthy or the user is never visited and
      // the case would pass without reaching the code under test.
      failOn: prefsDown,
    };
    const db = makeFailClosedClient(spec);
    const report = await flushDecayForAllUsers(db, 7);
    assert.equal(report.weightsUpdated, 0);
    assert.equal(
      report.logRowsReset,
      0,
      "baselines must not be advanced against weights that were never persisted",
    );
    assert.equal(
      (spec.updated?.["compass_search_signal_log"] ?? []).length,
      0,
      "the un-persisted decay must remain derivable by the read side",
    );
  });
});

void noopLog;
