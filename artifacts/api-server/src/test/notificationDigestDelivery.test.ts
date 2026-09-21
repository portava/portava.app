/**
 * notificationDigestDelivery — the delivery claim the digest makes, measured.
 *
 * ── THE CLAIM ────────────────────────────────────────────────────────────────
 * A digest is named after the day it summarises:
 * `sourceId = "<category>_<YYYY-MM-DD>"`. That name is a promise of AT MOST ONE
 * digest per (user, category, day).
 *
 * Nothing implemented it. The only thing between two runs was
 * NotificationDeduplicationService's general dedupe, whose window is
 * DEFAULT_DEDUP_WINDOW_MS = 30 minutes — so two runs 31 minutes apart (a
 * retried cron, an operator re-poking POST /internal/notifications/digest, a
 * second instance picking up the schedule) each wrote their own digest for the
 * same day. A 30-minute window cannot enforce a per-day claim.
 *
 * ── HOW THE SECOND RUN IS MADE TO SEE THE FIRST ──────────────────────────────
 * `makeFailClosedClient` RECORDS writes rather than applying them, so a second
 * run would not otherwise observe the first run's row. `landWrites()` below
 * copies the recorded insert payload — PRODUCTION'S OWN PAYLOAD, verbatim —
 * into the readable rows, adding only what the database itself would supply
 * (id, created_at). Nothing about the dedupe key is hand-written here: if
 * production stops writing `source_id`, or writes a different one, the
 * idempotency case goes red instead of passing on a fixture that agrees with
 * itself.
 *
 * Run: node --import tsx/esm --test src/test/notificationDigestDelivery.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { _setTestFetch } from "../lib/push.js";
import { NotificationDigestService } from "../services/notifications/NotificationDigestService.js";

const USER_ID = "dd000000-0000-4000-8000-000000000001";
const DB_DOWN = { message: "connection terminated unexpectedly", code: "57P01" };

function isoAt(daysAgo: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** A source notification eligible for a digest (normal priority, undismissed). */
function source(id: string, category: string, createdAt: string) {
  return {
    id, user_id: USER_ID, category,
    event_type: `${category}.something`,
    title: `Update ${id}`, body: `Body ${id}`,
    priority: "normal", dismissed_at: null, created_at: createdAt,
  };
}

interface Harness {
  db: any;
  rows: Record<string, any[]>;
  inserted: Record<string, any[]>;
  /** Make everything written so far readable, as the database would. */
  landWrites(): void;
  /** Digest notifications written so far. */
  digests(): any[];
}

function harness(
  seedNotifications: any[],
  failOn?: (ctx: FakeReadContext) => any,
): Harness {
  const rows: Record<string, any[]> = {
    notifications: [...seedNotifications],
    notification_preferences: [{ user_id: USER_ID, digests_enabled: true }],
    notification_category_preferences: [],
    notification_devices: [],
    feature_flags: [{ flag: "push_notifications_enabled", enabled: false }],
  };
  const inserted: Record<string, any[]> = {};
  const db = makeFailClosedClient({ rows, inserted, failOn });
  let landed = 0;
  return {
    db, rows, inserted,
    landWrites() {
      const all = inserted["notifications"] ?? [];
      for (; landed < all.length; landed += 1) {
        rows.notifications.push({
          ...all[landed],
          id:         `landed-${landed}`,
          created_at: new Date().toISOString(),
        });
      }
    },
    digests() {
      return (inserted["notifications"] ?? []).filter((r) => r.source_type === "digest");
    },
  };
}

beforeEach(() => {
  _setTestFetch((async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as any);
});
afterEach(() => { _setTestFetch(null); });

// ─────────────────────────────────────────────────────────────────────────────
// 1. AT MOST ONCE PER DAY
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationDigestService — at most one digest per (user, category, day)", () => {
  it("a second run for the same day writes NO second digest", async () => {
    const h = harness([source("n1", "trips", isoAt(1, 9)), source("n2", "trips", isoAt(1, 14))]);
    const svc = new NotificationDigestService(h.db);

    await svc.sendDailyDigest(USER_ID);
    assert.equal(h.digests().length, 1, "the first run must produce exactly one digest");
    const first = h.digests()[0];
    assert.equal(first.category, "trips");
    assert.ok(/^trips_\d{4}-\d{2}-\d{2}$/.test(first.source_id), `unexpected digest sourceId: ${first.source_id}`);

    // The row lands. The second run happens LATER THAN THE 30-MINUTE DEDUPE
    // WINDOW — the dedupe ledger cannot help here, so only the day-scoped check
    // can prevent the duplicate.
    h.landWrites();
    const realNow = Date.now;
    try {
      const t = realNow() + 31 * 60 * 1000;
      Date.now = () => t;
      await svc.sendDailyDigest(USER_ID);
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      h.digests().length, 1,
      `a re-run 31 minutes later produced ${h.digests().length} digests for one day`,
    );
  });

  it("the first run is not blocked by an unrelated day's digest", async () => {
    // Guards the case above against passing for the wrong reason: a check that
    // suppressed on ANY prior digest would also make this one produce nothing.
    const older = {
      id: "old-digest", user_id: USER_ID, category: "trips",
      event_type: "digest.trips", source_type: "digest", source_id: "trips_2001-01-01",
      title: "Your Trips digest", body: "old", priority: "low",
      dismissed_at: null, created_at: isoAt(400, 9),
    };
    const h = harness([older, source("n1", "trips", isoAt(1, 9))]);
    await new NotificationDigestService(h.db).sendDailyDigest(USER_ID);
    assert.equal(h.digests().length, 1, "yesterday's digest must still be produced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE WINDOW IS THE DAY THE DIGEST IS NAMED AFTER
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationDigestService — digest window", () => {
  it("summarises yesterday only; today's notifications are left for tomorrow's digest", async () => {
    const h = harness([
      source("y1", "trips", isoAt(1, 9)),
      source("y2", "trips", isoAt(1, 18)),
      source("t1", "trips", isoAt(0, 6)),   // today — belongs to tomorrow's digest
    ]);
    await new NotificationDigestService(h.db).sendDailyDigest(USER_ID);

    const d = h.digests();
    assert.equal(d.length, 1);
    assert.equal(
      (d[0].metadata as any).count, 2,
      `today's notification was folded into yesterday's digest (count=${(d[0].metadata as any).count})`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PARTIAL FAILURE
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationDigestService — partial failure", () => {
  it("one category's unreadable source does not stop the other categories", async () => {
    // Fail only the `pulse` source read; `trips` must still be digested.
    const h = harness(
      [source("n1", "trips", isoAt(1, 9)), source("p1", "pulse", isoAt(1, 9))],
      (ctx) => (ctx.table === "notifications" && ctx.eq("category") === "pulse" ? DB_DOWN : null),
    );
    await new NotificationDigestService(h.db).sendDailyDigest(USER_ID);

    const cats = h.digests().map((d) => d.category);
    assert.ok(cats.includes("trips"), "a healthy category must still produce its digest");
    assert.ok(!cats.includes("pulse"), "an unreadable category must not produce a digest built from no rows");
  });

  it("a category skipped by an outage stays eligible for the next run — nothing is lost", async () => {
    let failPulse = true;
    const h = harness(
      [source("p1", "pulse", isoAt(1, 9))],
      (ctx) => (failPulse && ctx.table === "notifications" && ctx.eq("category") === "pulse" ? DB_DOWN : null),
    );
    const svc = new NotificationDigestService(h.db);

    await svc.sendDailyDigest(USER_ID);
    assert.equal(h.digests().length, 0, "no digest may be written while the source is unreadable");

    h.landWrites();
    failPulse = false;
    await svc.sendDailyDigest(USER_ID);
    assert.equal(
      h.digests().length, 1,
      "the skipped day must be digested once the table is readable again",
    );
    assert.equal(h.digests()[0].category, "pulse");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CATEGORY DIGEST PREFERENCE
// ─────────────────────────────────────────────────────────────────────────────

describe("NotificationDigestService — category digest preference", () => {
  it("respects an explicit digest opt-out", async () => {
    const h = harness([source("n1", "trips", isoAt(1, 9))]);
    h.rows.notification_category_preferences.push({
      user_id: USER_ID, category: "trips",
      in_app_enabled: true, push_enabled: true, email_enabled: false, digest_enabled: false,
    });
    await new NotificationDigestService(h.db).sendDailyDigest(USER_ID);
    assert.equal(h.digests().length, 0, "a muted category digest must not be produced");
  });

  it("declines the digest when the override table is UNREADABLE rather than assuming it was not muted", async () => {
    const h = harness(
      [source("n1", "trips", isoAt(1, 9))],
      (ctx) => (ctx.table === "notification_category_preferences" ? DB_DOWN : null),
    );
    await new NotificationDigestService(h.db).sendDailyDigest(USER_ID);
    assert.equal(
      h.digests().length, 0,
      "an unreadable mute list read as 'nothing is muted' and sent digests the user had switched off",
    );
  });

  it("produces the digest when the override table is readable and empty", async () => {
    const h = harness([source("n1", "trips", isoAt(1, 9))]);
    await new NotificationDigestService(h.db).sendDailyDigest(USER_ID);
    assert.equal(h.digests().length, 1, "no override means the digest is on — otherwise the cases above prove nothing");
  });
});
