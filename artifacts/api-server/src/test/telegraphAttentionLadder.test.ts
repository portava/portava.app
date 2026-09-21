/**
 * telegraphAttentionLadder — Telegraph §19's six attention bands, measured
 * where they are supposed to make a difference.
 *
 * ── WHAT WAS WRONG, AND WHAT "FIXED" IS ALLOWED TO MEAN ──────────────────────
 * census-telegraph T255: `important` "exists and is used for coordination-shaped
 * events but it carries NO DELIVERY DIFFERENCE from `normal` — only `urgent`
 * changes behaviour. It is a label, not a priority."
 *
 * The tempting repair is "P1 bypasses quiet hours". That would be wrong, and
 * these tests are written so that it stays wrong: NotificationPreferenceService
 * draws the override line at `urgent` + `admin` deliberately, and a second
 * override would make the first meaningless. The band therefore changes exactly
 * one thing — HOW LONG ONE NOTIFICATION SUPPRESSES THE NEXT — and every
 * behavioural case below drives the REAL NotificationDeduplicationService
 * against a real in-memory `notifications` table, never a mock of it.
 *
 * ── THE FOUR QUESTIONS ───────────────────────────────────────────────────────
 *  1. Is the ladder's shape §19's shape? (order, windows, persistence)
 *  2. Does every event type the ladder names EXIST? The first draft of
 *     EVENT_BAND named `meetup.time_changed`, `meetup.location_changed` and
 *     `trip.plan_changed` — none of which are in this repository. A band keyed
 *     on a name nothing can emit is a policy that silently does nothing, so
 *     "has a template" is asserted per key rather than assumed.
 *  3. Does a P1 coordination event survive where a P2 message does not?
 *  4. Does a P0 safety event survive where an unclaimed event does not?
 *
 * The double is `makeLayoverDb`, the table-backed supabase-js surface that
 * src/test/supabaseContract.test.ts runs against the REAL installed client
 * every CI run — so `.gt('created_at', …)`, thenable execution and the
 * resolved-not-thrown error shape are the client's behaviour, not a guess.
 *
 * Run: node --import tsx/esm --test src/test/telegraphAttentionLadder.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  ATTENTION_BANDS,
  BAND_POLICY,
  EVENT_BAND,
  DECLARED_NOT_EMITTED,
  bandFor,
  dedupeWindowFor,
  isDigestible,
  type AttentionBand,
} from "../domain/telegraph/policies/attentionLadder.js";
import { getTemplate } from "../services/notifications/NotificationTemplateService.js";
import { NotificationDeduplicationService } from "../services/notifications/NotificationDeduplicationService.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { NotificationDigestService } from "../services/notifications/NotificationDigestService.js";
import { _setTestFetch } from "../lib/push.js";

const USER = "cc000000-0000-4000-8000-000000000001";
const SOURCE = "cc000000-0000-4000-8000-0000000000aa";

/** One prior notification, written `minutesAgo` minutes before now. */
function prior(eventType: string, category: string, minutesAgo: number) {
  return {
    id: `n-${eventType}-${minutesAgo}`,
    user_id: USER,
    category,
    event_type: eventType,
    source_type: "thread",
    source_id: SOURCE,
    created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
  };
}

/**
 * Ask the REAL service whether a notification would be suppressed, given one
 * prior notification of the same shape `minutesAgo` minutes back.
 */
async function checkAfter(eventType: string, category: string, minutesAgo: number) {
  const db = makeLayoverDb({ notifications: [prior(eventType, category, minutesAgo)] });
  const svc = new NotificationDeduplicationService(db as any);
  return svc.check({
    userId: USER,
    category,
    eventType,
    sourceType: "thread",
    sourceId: SOURCE,
  });
}

describe("§19 attention ladder — shape", () => {
  it("is §19's six bands in §19's order", () => {
    assert.deepEqual(ATTENTION_BANDS, [
      "P0_SAFETY",
      "P1_COORDINATION",
      "P2_MESSAGE",
      "P3_MEDIA",
      "P4_EPHEMERAL",
      "P5_AI",
    ]);
  });

  it("every band has a policy, and the policy names its own band", () => {
    for (const band of ATTENTION_BANDS) {
      const p = BAND_POLICY[band];
      assert.ok(p, `${band} has no policy`);
      assert.equal(p.band, band);
      assert.ok(p.behaviour.length > 0, `${band} has no §19 behaviour text`);
    }
  });

  it("suppression is monotonic down the ladder — a lower band is never suppressed for longer than a higher one", () => {
    // This is the whole claim. §19 is an ORDER, and an order whose numbers do
    // not increase is six labels again.
    const persisted = ATTENTION_BANDS.filter((b) => BAND_POLICY[b].persisted);
    const windows = persisted.map((b) => BAND_POLICY[b].dedupeWindowMs as number);
    for (let i = 1; i < windows.length; i += 1) {
      assert.ok(
        windows[i] > windows[i - 1],
        `${persisted[i]} (${windows[i]}ms) must suppress for longer than ${persisted[i - 1]} (${windows[i - 1]}ms)`,
      );
    }
  });

  it("P0 is never suppressed and P4 is never persisted", () => {
    assert.equal(BAND_POLICY.P0_SAFETY.dedupeWindowMs, 0);
    assert.equal(BAND_POLICY.P0_SAFETY.persisted, true);
    assert.equal(BAND_POLICY.P4_EPHEMERAL.dedupeWindowMs, null);
    assert.equal(BAND_POLICY.P4_EPHEMERAL.persisted, false);
  });

  it("only the two lowest-attention bands may be delivered as a digest", () => {
    // §19: P3 is "passive/batched", P5 "lowest priority; degrade first".
    // A safety alert or a plan change arriving tomorrow morning is not a
    // delivery, it is a record.
    assert.equal(BAND_POLICY.P3_MEDIA.digestible, true);
    assert.equal(BAND_POLICY.P5_AI.digestible, true);
    for (const band of ["P0_SAFETY", "P1_COORDINATION", "P2_MESSAGE", "P4_EPHEMERAL"] as AttentionBand[]) {
      assert.equal(BAND_POLICY[band].digestible, false, `${band} must not be digest-only`);
    }
  });

  it("dedupeWindowFor distinguishes 'not claimed' from 'never suppress'", () => {
    // undefined and 0 are different instructions: collapsing them would make
    // every unclaimed event in the product unsuppressable.
    assert.equal(dedupeWindowFor("trip.invite_received"), undefined);
    assert.equal(dedupeWindowFor(undefined), undefined);
    assert.equal(dedupeWindowFor("safe_return.missed"), 0);
    assert.notEqual(dedupeWindowFor("safe_return.missed"), undefined);
    assert.equal(bandFor("nothing.at.all"), null);
    assert.equal(isDigestible("nothing.at.all"), undefined);
  });
});

describe("§19 attention ladder — every name it claims is a real name", () => {
  it("each claimed event type has a notification template, is declared-not-emitted, or is P4", () => {
    // The assertion that caught three fictional event names in the first draft.
    for (const [eventType, band] of Object.entries(EVENT_BAND)) {
      if (band === "P4_EPHEMERAL") continue;              // asserted separately, below
      if (DECLARED_NOT_EMITTED.includes(eventType)) continue;
      assert.ok(
        getTemplate(eventType) !== null,
        `EVENT_BAND names "${eventType}" (${band}) but NotificationTemplateService has no such template`,
      );
    }
  });

  it("a P4 event type must have NO template — that is what 'no persistent push' means", () => {
    const p4 = Object.entries(EVENT_BAND).filter(([, b]) => b === "P4_EPHEMERAL").map(([e]) => e);
    assert.ok(p4.length > 0, "P4 claims nothing, so nothing enforces §19's 'realtime only'");
    for (const eventType of p4) {
      assert.equal(
        getTemplate(eventType),
        null,
        `"${eventType}" is P4 (realtime only) but a notification template exists for it`,
      );
    }
  });

  it("declared-not-emitted really is not emitted", () => {
    assert.ok(DECLARED_NOT_EMITTED.length > 0);
    for (const eventType of DECLARED_NOT_EMITTED) {
      assert.ok(eventType in EVENT_BAND, `${eventType} is declared-not-emitted but not in any band`);
      assert.equal(
        getTemplate(eventType),
        null,
        `${eventType} is recorded as declared-not-emitted but a template exists — the census row is now wrong`,
      );
    }
  });

  it("every P0 event carries urgent priority in the template it maps to", () => {
    // The ladder must not disagree with the one override that already exists
    // (T254). If a P0 event were merely `important`, "P0 is interruptive" would
    // be true in this file and false in the delivery path.
    for (const [eventType, band] of Object.entries(EVENT_BAND)) {
      if (band !== "P0_SAFETY") continue;
      const tpl = getTemplate(eventType);
      assert.ok(tpl, `${eventType} has no template`);
      assert.equal(tpl!.defaultPriority, "urgent", `${eventType} is P0 but its template is not urgent`);
    }
  });
});

describe("§19 attention ladder — the real dedupe service behaves differently per band", () => {
  it("P1 coordination survives 10 minutes; the flat 30-minute default would have swallowed it", async () => {
    // "The meetup moved to 8" then "the meetup moved to the other bar".
    const r = await checkAfter("circle.meeting_point_updated", "trips", 10);
    assert.equal(r.isDuplicate, false, "a second coordination change was suppressed");
  });

  it("P1 coordination still coalesces a double-tap inside its 60-second window", async () => {
    const r = await checkAfter("circle.meeting_point_updated", "trips", 0.5);
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "general_dedup");
  });

  it("P2 messages still coalesce at 2 minutes — a burst in one thread is one thing to look at", async () => {
    const r = await checkAfter("telegraph.message", "telegraph", 2);
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "message_coalesced");
  });

  it("P2 stops coalescing past its 5-minute window", async () => {
    const r = await checkAfter("telegraph.mention", "telegraph", 10);
    assert.equal(r.isDuplicate, false);
  });

  it("P2 mention inside 5 minutes is suppressed", async () => {
    const r = await checkAfter("telegraph.mention", "telegraph", 2);
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "general_dedup");
  });

  it("P0 safety is NEVER suppressed — a second alert one minute later still goes", async () => {
    // Previously: general_dedup, because a safe_return alert about the same
    // source inside 30 minutes matched the flat window.
    const r = await checkAfter("safe_return.missed", "safe_return", 1);
    assert.equal(r.isDuplicate, false, "a second safety alert was suppressed as a duplicate of the first");
  });

  it("P0 is not suppressed even at zero elapsed time", async () => {
    const r = await checkAfter("safe_return.trusted_circle_alert", "safe_return", 0);
    assert.equal(r.isDuplicate, false);
  });

  it("P5 AI is suppressed for a full hour, where an unclaimed event of the same age is not", async () => {
    // The contrast is the point: same table, same 45-minute gap, different band.
    const ai = await checkAfter("telegraph.ai_suggestion", "telegraph", 45);
    assert.equal(ai.isDuplicate, true, "an AI suggestion 45 minutes after the last one was delivered");
    assert.equal(ai.reason, "general_dedup");

    const unclaimed = await checkAfter("trip.invite_received", "trips", 45);
    assert.equal(unclaimed.isDuplicate, false, "the 30-minute default no longer applies to unclaimed events");
  });

  it("an unclaimed event keeps the 30-minute default exactly", async () => {
    // The ladder narrows nothing by accident.
    assert.equal(dedupeWindowFor("trip.invite_received"), undefined);
    const inside = await checkAfter("trip.invite_received", "trips", 10);
    assert.equal(inside.isDuplicate, true);
    assert.equal(inside.reason, "general_dedup");
  });

  it("P4 ephemeral is refused before any read — it is not persisted at all", async () => {
    const db = makeLayoverDb({ notifications: [] });
    const svc = new NotificationDeduplicationService(db as any);
    const r = await svc.check({
      userId: USER,
      category: "telegraph",
      eventType: "typing.started",
      sourceType: "thread",
      sourceId: SOURCE,
    });
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "ephemeral_not_persisted");
  });

  it("an unreadable notifications table still suppresses — the ladder did not undo the fail-closed direction", async () => {
    // The band changes the WINDOW. It must not change what an unknown ledger
    // means: hasRecentNotification answers "already sent" on a read error, and
    // a P1 window must not turn that into "not a duplicate".
    const db = makeLayoverDb(
      { notifications: [prior("circle.meeting_point_updated", "trips", 10)] },
      { failures: { "notifications:select": { message: "connection terminated", code: "57P01" } } },
    );
    const svc = new NotificationDeduplicationService(db as any);
    const r = await svc.check({
      userId: USER,
      category: "trips",
      eventType: "circle.meeting_point_updated",
      sourceType: "thread",
      sourceId: SOURCE,
    });
    assert.equal(r.isDuplicate, true);
    assert.equal(r.reason, "general_dedup");
  });

  it("P0 skips the read entirely, so an unreadable table cannot suppress a safety alert either", async () => {
    const db = makeLayoverDb(
      { notifications: [] },
      { failures: { "notifications:select": { message: "connection terminated", code: "57P01" } } },
    );
    const svc = new NotificationDeduplicationService(db as any);
    const r = await svc.check({
      userId: USER,
      category: "safe_return",
      eventType: "safe_return.missed",
      sourceType: "thread",
      sourceId: SOURCE,
    });
    assert.equal(r.isDuplicate, false, "an unreadable ledger swallowed a safety alert");
  });
});

// -----------------------------------------------------------------------------
// The other half of a band: whether it may be delivered ONLY in a digest.
//
// NotificationDigestService already refuses `urgent`/`important` rows, but that
// is a PRIORITY filter and §19's bands are not priorities. `trip.crew_message`
// is `normal` and in a digest category, so before this it could be pushed when
// it happened AND summarised again the next morning; §19 calls P2 "standard
// notification policy", which is delivery now, not a second telling tomorrow.
// -----------------------------------------------------------------------------

const DIGEST_USER = "cc000000-0000-4000-8000-0000000000d1";

function dayRow(id: string, eventType: string, priority = "normal") {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(9, 0, 0, 0);
  return {
    id,
    user_id: DIGEST_USER,
    category: "trips",
    event_type: eventType,
    title: `Title ${id}`,
    body: `Body ${id}`,
    priority,
    dismissed_at: null,
    created_at: d.toISOString(),
  };
}

function digestHarness(seed: any[]) {
  const rows: Record<string, any[]> = {
    notifications: [...seed],
    notification_preferences: [{ user_id: DIGEST_USER, digests_enabled: true }],
    notification_category_preferences: [],
    notification_devices: [],
    feature_flags: [{ flag: "push_notifications_enabled", enabled: false }],
  };
  const inserted: Record<string, any[]> = {};
  const db = makeFailClosedClient({ rows, inserted });
  return {
    db,
    digests: () => (inserted["notifications"] ?? []).filter((r: any) => r.source_type === "digest"),
  };
}

describe("§19 attention ladder — a non-digestible band is not summarised the next morning", () => {
  beforeEach(() => {
    _setTestFetch((async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as any);
  });
  afterEach(() => { _setTestFetch(null); });

  it("drops a P2 message from the digest while keeping an event the ladder does not claim", async () => {
    assert.equal(isDigestible("trip.crew_message"), false);
    assert.equal(isDigestible("trip.status_changed"), undefined);

    const h = digestHarness([
      dayRow("m1", "trip.crew_message"),
      dayRow("s1", "trip.status_changed"),
    ]);
    await new NotificationDigestService(h.db).sendDailyDigest(DIGEST_USER);

    const d = h.digests();
    assert.equal(d.length, 1, "expected exactly one trips digest");
    assert.equal((d[0].metadata as any).count, 1, "the P2 message was counted into the digest");
    assert.equal(d[0].body, "Body s1", "the digest summarised the message it was told not to");
  });

  it("writes no digest at all when every row in the day is non-digestible", async () => {
    const h = digestHarness([dayRow("m1", "trip.crew_message"), dayRow("m2", "trip.crew_message")]);
    await new NotificationDigestService(h.db).sendDailyDigest(DIGEST_USER);
    assert.equal(h.digests().length, 0, "a digest was written that would have contained only P2 messages");
  });

  it("an event the ladder does not claim is digested exactly as before", async () => {
    const h = digestHarness([dayRow("s1", "trip.status_changed"), dayRow("s2", "plan.item_added")]);
    await new NotificationDigestService(h.db).sendDailyDigest(DIGEST_USER);
    const d = h.digests();
    assert.equal(d.length, 1);
    assert.equal((d[0].metadata as any).count, 2, "the ladder narrowed a digest it does not claim");
  });
});
