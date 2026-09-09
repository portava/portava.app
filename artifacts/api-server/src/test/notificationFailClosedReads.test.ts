/**
 * notificationFailClosedReads — what each read in the pipeline does when the
 * database answers with an ERROR rather than with rows.
 *
 * ── THE SHAPE OF THE FAILURE BEING TESTED ────────────────────────────────────
 * supabase-js RESOLVES on a database error. It does not throw and it does not
 * reject: a failed read arrives as `{ data: null, error }`, which is the SAME
 * `data` an empty table returns. Every `try/catch` wrapped around a supabase
 * read in this pipeline is therefore dead code for the case it was written for,
 * and every read whose `.error` went unchecked could not tell
 *
 *      "this user has no preferences row"        (answer: use the defaults)
 * from "the preferences table cannot be read"    (answer: we do not know)
 *
 * For a notification pipeline that difference is the whole job: DEFAULTS say
 * pushEnabled: true, so an unreadable consent table read as CONSENT GRANTED.
 *
 * Every case below drives production code with `makeFailClosedClient`, which
 * injects exactly that resolved-error shape (it never throws — a test that
 * passed because its double threw would be exercising a path production does
 * not take). The doubles are contract-checked against the real installed
 * supabase-js by src/test/supabaseContract.test.ts.
 *
 * ── THE DECISION EACH CASE PINS DOWN ─────────────────────────────────────────
 * Fail-closed is NOT applied uniformly, because uniform fail-closed silently
 * drops a safe_return alert when a preferences table blinks:
 *
 *   preferences unreadable + ordinary priority -> push/email/telegraph declined
 *   preferences unreadable + urgent / admin    -> DELIVERED (the safety override
 *                                                 does not consult preferences,
 *                                                 so an unreadable preferences
 *                                                 row cannot change its answer)
 *   and in both cases the outcome is RECORDED — declining is logged as 'failed'
 *   with 'preferences_unreadable', never as 'suppressed', which is the status
 *   that means "the user asked us not to".
 *
 * Run: node --import tsx/esm --test src/test/notificationFailClosedReads.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { _setTestFetch } from "../lib/push.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter, _resetCleanupFailureCount } from "../services/notifications/NotificationRouter.js";
import { NotificationPreferenceService } from "../services/notifications/NotificationPreferenceService.js";
import { NotificationDigestService } from "../services/notifications/NotificationDigestService.js";
import { RealtimeActivityService, activityBus } from "../services/notifications/RealtimeActivityService.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";

const USER_ID  = "bb000000-0000-4000-8000-000000000001";
const NOTIF_ID = "bb000000-0000-4000-8000-000000000002";

const DB_DOWN = { message: "connection terminated unexpectedly", code: "57P01" };

/** Records every Expo push dispatch so "was a push sent?" is measured. */
let expoCalls = 0;
function okExpoFetch(): typeof fetch {
  return (async (_u: any, init: any) => {
    expoCalls += 1;
    const messages: Array<{ to: string }> = JSON.parse((init as any).body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t1" })) }),
    } as any;
  }) as any;
}

function notif(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id:           NOTIF_ID,
    userId:       USER_ID,
    category:     "trips",
    eventType:    "trip.invite_received",   // defaultChannels ['in_app','push']
    priority:     "normal",
    title:        "Trip invitation",
    body:         "You received a trip invitation.",
    actionUrl:    null,
    imageUrl:     null,
    sourceType:   null,
    sourceId:     null,
    actorId:      null,
    metadata:     {},
    privacyLevel: "standard",
    readAt:       null,
    dismissedAt:  null,
    expiresAt:    null,
    createdAt:    new Date().toISOString(),
    ...over,
  };
}

/** Delivery-attempt rows the router wrote, for the channel asked about. */
function attempts(inserted: Record<string, any[]>, channel: string) {
  return (inserted["notification_delivery_attempts"] ?? []).filter((a) => a.channel === channel);
}

beforeEach(() => {
  expoCalls = 0;
  _resetCleanupFailureCount();
  _setTestFetch(okExpoFetch());
});
afterEach(() => { _setTestFetch(null); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. PREFERENCES — an unreadable consent row is not consent
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationRouter — unreadable preferences must not read as consent", () => {
  it("declines push for an ordinary notification and records it as 'failed', not 'suppressed'", async () => {
    const inserted: Record<string, any[]> = {};
    let devicesRead = 0;
    const db = makeFailClosedClient({
      rows: { feature_flags: [{ flag: "push_notifications_enabled", enabled: true }] },
      inserted,
      failOn: (ctx: FakeReadContext) => {
        if (ctx.table === "notification_devices") devicesRead += 1;
        return ctx.table === "notification_preferences" ? DB_DOWN : null;
      },
    });

    await new NotificationRouter(db).route(notif());

    assert.equal(expoCalls, 0, "no push may be dispatched while consent is unknown");
    assert.equal(devicesRead, 0, "push tokens must not even be looked up");

    const push = attempts(inserted, "push");
    assert.equal(push.length, 1, `expected exactly one push delivery attempt, got ${push.length}`);
    assert.equal(
      push[0].status, "failed",
      "an outage must not be filed under 'suppressed' — that status means the user opted out",
    );
    assert.equal(push[0].error_message, "preferences_unreadable");
  });

  it("still delivers an URGENT notification — an outage must not silently drop a safety alert", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        feature_flags:        [{ flag: "push_notifications_enabled", enabled: true }],
        notification_devices: [{ user_id: USER_ID, push_token: "ExponentPushToken[safety]" }],
      },
      inserted,
      failOn: (ctx: FakeReadContext) => (ctx.table === "notification_preferences" ? DB_DOWN : null),
    });

    await new NotificationRouter(db).route(
      notif({ category: "safe_return", eventType: "safe_return.missed", priority: "urgent" }),
    );

    assert.equal(expoCalls, 1, "an urgent safety notification must still be pushed");
    const push = attempts(inserted, "push");
    assert.equal(push.length, 1);
    assert.equal(push[0].status, "sent");
  });

  it("treats an unreadable CATEGORY override table the same way", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { feature_flags: [{ flag: "push_notifications_enabled", enabled: true }] },
      inserted,
      failOn: (ctx: FakeReadContext) =>
        ctx.table === "notification_category_preferences" ? DB_DOWN : null,
    });

    await new NotificationRouter(db).route(notif());

    assert.equal(expoCalls, 0, "an unreadable mute list must not read as 'nothing is muted'");
    const push = attempts(inserted, "push");
    assert.equal(push.length, 1);
    assert.equal(push[0].status, "failed");
    assert.equal(push[0].error_message, "preferences_unreadable");
  });

  it("delivers normally when both preference reads SUCCEED — the gate is the failure, not the code path", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        feature_flags:        [{ flag: "push_notifications_enabled", enabled: true }],
        notification_devices: [{ user_id: USER_ID, push_token: "ExponentPushToken[healthy]" }],
      },
      inserted,
    });

    await new NotificationRouter(db).route(notif());

    assert.equal(expoCalls, 1, "a healthy read must still deliver — otherwise the case above proves nothing");
    assert.equal(attempts(inserted, "push")[0].status, "sent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE DELIVERY LEDGER MUST NOT CLAIM SENDS THAT DID NOT HAPPEN
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationRouter — telegraph delivery", () => {
  it("records 'failed', never 'sent', when the system-message insert errors", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
        notification_category_preferences: [
          { user_id: USER_ID, category: "telegraph", in_app_enabled: true, push_enabled: false, email_enabled: false, digest_enabled: false },
        ],
      },
      inserted,
      failWritesOn: (table) => (table === "messages" ? DB_DOWN : null),
    });

    await new NotificationRouter(db).route(
      notif({ category: "telegraph", eventType: "telegraph.message", sourceId: "thread-1" }),
    );

    const tg = attempts(inserted, "telegraph");
    assert.equal(tg.length, 1, `expected one telegraph attempt, got ${tg.length}`);
    assert.equal(
      tg[0].status, "failed",
      "the ledger claimed 'sent' for a system message the database refused",
    );
  });

  it("records 'sent' when the insert succeeds — so the case above is not just 'telegraph never works'", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
        notification_category_preferences: [
          { user_id: USER_ID, category: "telegraph", in_app_enabled: true, push_enabled: false, email_enabled: false, digest_enabled: false },
        ],
      },
      inserted,
    });

    await new NotificationRouter(db).route(
      notif({ category: "telegraph", eventType: "telegraph.message", sourceId: "thread-1" }),
    );

    const tg = attempts(inserted, "telegraph");
    assert.equal(tg.length, 1);
    assert.equal(tg[0].status, "sent");
    assert.equal((inserted["messages"] ?? []).length, 1, "the system message must actually be inserted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE DEDUPE LEDGER — both halves must fail in the same direction
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationDeduplicationService — an unreadable ledger is 'already sent'", () => {
  it("treats an unreadable daily count as a spent Compass budget (no notification written)", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      inserted,
      failOn: (ctx: FakeReadContext) => (ctx.table === "notifications" ? DB_DOWN : null),
    });

    const row = await new NotificationService(db).create({
      userId:    USER_ID,
      eventType: "compass.recommendation",
      params:    { title: "A place", body: "Nearby" },
    });

    assert.equal(row, null, "an unreadable rate-limit ledger must suppress, not wave through");
    assert.equal(
      (inserted["notifications"] ?? []).length, 0,
      "no notification row may be written when the budget is unknown",
    );
  });

  it("writes the notification when the same read SUCCEEDS and the budget is unspent", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: { notifications: [] }, inserted });

    await new NotificationService(db).create({
      userId:    USER_ID,
      eventType: "compass.recommendation",
      params:    { title: "A place", body: "Nearby" },
    });

    assert.equal(
      (inserted["notifications"] ?? []).length, 1,
      "with a readable, empty ledger the notification must go through",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A PREFERENCE WRITE THAT FAILED MUST NOT REPORT SUCCESS
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationPreferenceService.upsertCategoryPreferences", () => {
  it("throws when the upsert errors instead of returning as though it stored the mute", async () => {
    const db = makeFailClosedClient({
      failWritesOn: (table) => (table === "notification_category_preferences" ? DB_DOWN : null),
    });
    await assert.rejects(
      () => new NotificationPreferenceService(db).upsertCategoryPreferences(USER_ID, "trips" as any, { pushEnabled: false }),
      /category preference upsert failed/,
      "a discarded write error told the user 'ok' for a mute that was never stored",
    );
  });

  it("resolves when the upsert succeeds", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({ inserted });
    await new NotificationPreferenceService(db).upsertCategoryPreferences(USER_ID, "trips" as any, { pushEnabled: false });
    assert.equal((inserted["notification_category_preferences"] ?? []).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. AN UNKNOWN UNREAD COUNT MUST NOT CLEAR THE BADGE
// ─────────────────────────────────────────────────────────────────────────────

describe("RealtimeActivityService.emitUnreadUpdate", () => {
  it("emits NOTHING when the count cannot be read (a wrong zero clears the badge)", async () => {
    const seen: any[] = [];
    const unsub = activityBus.subscribe((e) => { if (e.type === "unread_count.updated") seen.push(e); });
    try {
      const db = makeFailClosedClient({ failOn: () => DB_DOWN });
      await new RealtimeActivityService(db).emitUnreadUpdate(USER_ID);
      assert.equal(seen.length, 0, `an unknown count was broadcast as a real one: ${JSON.stringify(seen)}`);
    } finally { unsub(); }
  });

  it("emits the real count when the read succeeds", async () => {
    const seen: any[] = [];
    const unsub = activityBus.subscribe((e) => { if (e.type === "unread_count.updated") seen.push(e); });
    try {
      const db = makeFailClosedClient({
        rows: { notifications: [
          { id: "n1", user_id: USER_ID, read_at: null, dismissed_at: null },
          { id: "n2", user_id: USER_ID, read_at: null, dismissed_at: null },
        ] },
      });
      await new RealtimeActivityService(db).emitUnreadUpdate(USER_ID);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].payload.unreadCount, 2);
    } finally { unsub(); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. "NOBODY TO NOTIFY" vs "THE RECIPIENT LIST IS UNREADABLE"
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationDigestService.runForAllUsers", () => {
  it("reports the recipient list as UNREADABLE rather than as zero users", async () => {
    const db = makeFailClosedClient({
      failOn: (ctx: FakeReadContext) => (ctx.table === "notification_preferences" ? DB_DOWN : null),
    });
    const res = await new NotificationDigestService(db).runForAllUsers();
    assert.equal(res.usersProcessed, 0);
    assert.equal(
      res.recipientsUnreadable, true,
      "a failed run reported itself as a clean run over zero users; a scheduler cannot retry that",
    );
  });

  it("reports a genuinely empty recipient list as readable and empty", async () => {
    const db = makeFailClosedClient({ rows: { notification_preferences: [] } });
    const res = await new NotificationDigestService(db).runForAllUsers();
    assert.equal(res.usersProcessed, 0);
    assert.equal(res.recipientsUnreadable, false, "no users with digests on is not an outage");
  });
});
