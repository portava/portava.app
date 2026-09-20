/**
 * census-compass CX-08 — Sensing §15 `:176`:
 *
 *   "Attention Engine is mandatory: World changes route through relevance,
 *    novelty, urgency, half-life, user availability, interruption cost and
 *    attention budget before NOTIFY / WALL / SILENT / IGNORE."
 *
 * Before this suite: lib/attentionEngine.ts existed with all seven factors and
 * the four routes, and ONE caller — routes/wallMoments.ts, dark behind two
 * FALSE flags. The push path that is ON in production
 * (NotificationRouter → evaluateNotification) never consulted it: a world
 * change that passed the hard filters was `sent`, full stop. This suite pins
 * that the engine is now MANDATORY on that path for the world-change classes
 * (`recommendation`, `discovery`), that the four routes map onto four
 * outcomes, and that the hard filters keep absolute precedence.
 *
 * What WALL means here, stated so nobody credits a surface that does not
 * exist: the notification row NotificationService already persisted is the
 * durable in-app surface; WALL keeps the change there and does not push.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 the attention step removed (world change falls through to sent) → red
 *   M2 an unreadable preferences row read as "available"                → red
 *   M3 an unreadable interruption count read as zero                     → red
 *   M4 `WALL` mapped onto "sent"                                          → red
 *   M5 the router treats "wall" as "sent" (pushes)                        → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassNotificationAttention.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateNotification,
  isWorldChangeType,
  readAttentionDeclaration,
  worldChangeFactors,
  ATTENTION_BY_EVENT_TYPE,
  WORLD_CHANGE_TYPES,
  PRIORITY_LEVELS,
  type NotificationPayload,
  type NotificationType,
} from "../compass/CompassNotificationEngine.js";
import {
  ATTENTION_BUDGET_PER_WINDOW,
  ATTENTION_ROUTES,
  HALF_LIFE_STALE_RATIO,
  routeAttentionSubject,
} from "../lib/attentionEngine.js";
import { _setTestFetch } from "../lib/push.js";
import { NotificationRouter, _resetCleanupFailureCount } from "../services/notifications/NotificationRouter.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const USER = "aa000000-0000-4000-8000-000000000001";
const NOON = 12 * 60;
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

// ── A fake that answers exactly what evaluateNotification reads ──────────────
interface FakeOpts {
  /** Interruptions delivered in the window; `"unreadable"` makes the count read fail. */
  delivered?: number | "unreadable";
  /** Make the preferences reads fail (availability UNKNOWN). */
  prefsUnreadable?: boolean;
  mutedCategories?: string[];
}
function makeDb(opts: FakeOpts = {}) {
  const decisions: any[] = [];
  const delivered = opts.delivered ?? 0;
  const client: any = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const resolve = (): any => {
        if (table === "compass_user_preferences") {
          if (opts.prefsUnreadable) return { data: null, error: { message: "unreadable", code: "08006" } };
          return { data: { compass_enabled: true, exclude_budget_styles: opts.mutedCategories ?? [], muted_topics: [], category_weights: {} }, error: null };
        }
        if (table === "notification_preferences") {
          if (opts.prefsUnreadable) return { data: null, error: { message: "unreadable", code: "08006" } };
          return { data: null, error: null };
        }
        if (table === "notifications") {
          if (delivered === "unreadable") return { data: null, count: null, error: { message: "unreadable" } };
          return { data: [], count: delivered, error: null };
        }
        if (table === "feature_flags") return { data: null, error: null };
        if (table === "blocks") return { data: null, error: null };
        if (table === "user_account_states") return { data: null, error: null };
        return { data: null, error: null };
      };
      const chain: any = {
        select() { return chain; },
        eq(k: string, v: unknown) { filters[k] = v; return chain; },
        in() { return chain; }, gte() { return chain; }, or() { return chain; }, order() { return chain; }, limit() { return chain; },
        maybeSingle() { return Promise.resolve(resolve()); },
        single() { return Promise.resolve(resolve()); },
        then(onF: any, onR: any) { return Promise.resolve(resolve()).then(onF, onR); },
        insert(row: any) {
          if (table === "compass_notification_decisions") decisions.push(row);
          const r = { data: null, error: null };
          const p: any = Promise.resolve(r);
          p.select = () => ({ single: () => Promise.resolve({ data: { id: "x" }, error: null }) });
          return p;
        },
      };
      return chain;
    },
  };
  return { client, decisions };
}

const rec = (data: Record<string, unknown> = {}): NotificationPayload =>
  ({ type: "recommendation", title: "Han Market is busy", body: "Live", data: { notificationId: "n-1", ...data } });

describe("A. vocabulary — the four routes are four outcomes, and the class is the world-change classes", () => {
  it("the engine's routes are exactly NOTIFY / WALL / SILENT / IGNORE and the outcome union carries wall / silent / ignore", () => {
    assert.deepEqual([...ATTENTION_ROUTES], ["NOTIFY", "WALL", "SILENT", "IGNORE"]);
    const src = strip(readFileSync(join(SRC, "compass", "CompassNotificationEngine.ts"), "utf8"));
    for (const o of ['"wall"', '"silent"', '"ignore"']) assert.ok(src.includes(o), `${o} missing from NotificationOutcome`);
  });

  it("world changes are recommendation and discovery; people acting (messages, bookings, social, safety) are not", () => {
    assert.deepEqual([...WORLD_CHANGE_TYPES], ["recommendation", "discovery"]);
    for (const t of Object.keys(PRIORITY_LEVELS) as NotificationType[]) {
      assert.equal(isWorldChangeType(t), t === "recommendation" || t === "discovery", t);
    }
  });

  it("the engine is CALLED by the notification engine (the call site the row said did not exist)", () => {
    const src = strip(readFileSync(join(SRC, "compass", "CompassNotificationEngine.ts"), "utf8"));
    assert.match(src, /import \{[\s\S]*?routeAttentionSubject[\s\S]*?\} from "\.\.\/lib\/attentionEngine\.js"/);
    assert.match(src, /routeAttentionSubject\(/);
    const call = src.indexOf("routeAttentionSubject(");
    const finalSent = src.lastIndexOf('return decide("sent");');
    assert.ok(call > 0 && call < finalSent, "the attention step must sit BEFORE the unconditional send");
  });
});

describe("B. declaration and defaults", () => {
  it("reads only what validates: an unknown relevance word is not a relevance, urgency is clamped, a half window is no window", () => {
    assert.deepEqual(readAttentionDeclaration({ attention: { relevance: "vip", urgency: 7, relevanceWindow: { from: "x" }, alreadySeen: "yes" } }), { urgency: 1 });
    assert.deepEqual(readAttentionDeclaration({ attention: { relevance: "saved", urgency: -1, subjectId: "s", alreadySeen: true, relevanceWindow: { from: iso(0), until: iso(30) } } }),
      { relevance: "saved", urgency: 0, subjectId: "s", alreadySeen: true, relevanceWindow: { from: iso(0), until: iso(30) } });
    assert.deepEqual(readAttentionDeclaration(undefined), {});
  });

  it("declaration beats the event table beats the priority beats the generic default", () => {
    assert.deepEqual(worldChangeFactors(rec()), { relevance: "followed", urgency: 0.5 });
    assert.deepEqual(worldChangeFactors(rec({ priority: "high" })), { relevance: "followed", urgency: 0.8 });
    assert.deepEqual(worldChangeFactors(rec({ eventType: "compass.sense.leave_earlier", priority: "low" })), { relevance: "trip_stop", urgency: 0.9 });
    assert.deepEqual(worldChangeFactors(rec({ eventType: "compass.sense.leave_earlier", attention: { relevance: "nearby", urgency: 0.2 } })), { relevance: "nearby", urgency: 0.2 });
  });

  it("digests never interrupt; every Compass producer in the table has a relevance the engine knows", () => {
    for (const key of ["compass.daily_brief", "digest.compass"]) {
      const f = ATTENTION_BY_EVENT_TYPE[key]!;
      assert.equal(routeAttentionSubject({ id: key, urgency: f.urgency, safety: false, relevanceWindow: null }, { relevance: f.relevance, seenMomentIds: new Set(), available: true, notifiesInWindow: 0 }, NOW).route, "WALL");
    }
  });
});

describe("C. the engine is mandatory — a world change that passed every filter is routed, not sent", () => {
  it("an UNDECLARED recommendation reaches the WALL and is not pushed (an undeclared relation may not interrupt)", async () => {
    const { client, decisions } = makeDb();
    const d = await evaluateNotification(client, USER, rec(), { nowMinutes: NOON });
    assert.equal(d.outcome, "wall", JSON.stringify(d));
    assert.equal(d.attention?.route, "WALL");
    assert.deepEqual(d.attention?.reasons, ["relevant"]);
    assert.match(d.suppressionReason ?? "", /^attention:wall:/);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, "wall");
    assert.match(String(decisions[0].suppression_reason), /^attention:wall:relevant/);
  });

  it("a declared saved-place change with urgency at the floor is NOTIFY → sent, with every factor on the decision", async () => {
    const { client } = makeDb();
    const d = await evaluateNotification(client, USER, rec({ attention: { relevance: "saved", urgency: 0.8 } }), { nowMinutes: NOON });
    assert.equal(d.outcome, "sent");
    assert.equal(d.suppressionReason, null);
    assert.equal(d.attention?.route, "NOTIFY");
    assert.deepEqual(Object.keys(d.attention!.factors).sort(), ["availability", "budget", "halfLife", "interruptionCost", "novelty", "relevance", "urgency"]);
  });

  it("interruption cost: at the budget the same change defers to the WALL; one under it still pushes", async () => {
    const at = await evaluateNotification(makeDb({ delivered: ATTENTION_BUDGET_PER_WINDOW }).client, USER, rec({ attention: { relevance: "saved", urgency: 0.8 } }), { nowMinutes: NOON });
    assert.equal(at.outcome, "wall");
    assert.deepEqual(at.attention?.reasons, ["budget_exhausted_deferred_to_wall"]);
    const under = await evaluateNotification(makeDb({ delivered: ATTENTION_BUDGET_PER_WINDOW - 1 }).client, USER, rec({ attention: { relevance: "saved", urgency: 0.8 } }), { nowMinutes: NOON });
    assert.equal(under.outcome, "sent");
  });

  it("an UNREADABLE interruption count is the budget spent — never a licence to push", async () => {
    const d = await evaluateNotification(makeDb({ delivered: "unreadable" }).client, USER, rec({ attention: { relevance: "saved", urgency: 0.9 } }), { nowMinutes: NOON });
    assert.equal(d.outcome, "wall");
    assert.deepEqual(d.attention?.reasons, ["budget_exhausted_deferred_to_wall"]);
  });

  it("UNREADABLE preferences are UNKNOWN availability → WALL; an unreadable consent is never read as consent", async () => {
    const d = await evaluateNotification(makeDb({ prefsUnreadable: true }).client, USER, rec({ attention: { relevance: "saved", urgency: 0.9 } }), { nowMinutes: NOON });
    assert.notEqual(d.outcome, "sent");
    assert.equal(d.outcome, "wall");
    assert.deepEqual(d.attention?.reasons, ["availability_unknown_deferred_to_wall"]);
    assert.equal(d.attention?.factors.availability, null);
  });

  it("novelty: a change the producer says was already seen is IGNORE", async () => {
    const d = await evaluateNotification(makeDb().client, USER, rec({ attention: { relevance: "saved", urgency: 0.9, subjectId: "place-1", alreadySeen: true } }), { nowMinutes: NOON });
    assert.equal(d.outcome, "ignore");
    assert.deepEqual(d.attention?.reasons, ["already_seen"]);
  });

  it("half-life: an expired window is IGNORE; a window mostly spent is SILENT; NO window is not decayed", async () => {
    const expired = await evaluateNotification(makeDb().client, USER, rec({ attention: { relevance: "saved", urgency: 0.9, relevanceWindow: { from: iso(-60), until: iso(-1) } } }), { nowMinutes: NOON });
    assert.equal(expired.outcome, "ignore");
    const late = await evaluateNotification(makeDb().client, USER, rec({ attention: { relevance: "saved", urgency: 0.9, relevanceWindow: { from: iso(-100 * HALF_LIFE_STALE_RATIO - 5), until: iso(100 - 100 * HALF_LIFE_STALE_RATIO - 5) } } }), { nowMinutes: NOON });
    assert.equal(late.outcome, "silent", JSON.stringify(late.attention));
    const none = await evaluateNotification(makeDb().client, USER, rec({ attention: { relevance: "saved", urgency: 0.9 } }), { nowMinutes: NOON });
    assert.equal(none.outcome, "sent");
    assert.equal(none.attention?.factors.halfLife, 0);
  });

  it("the event table routes the Sense producers without a declaration: leave-earlier pushes, a free block goes to the WALL", async () => {
    const leave = await evaluateNotification(makeDb().client, USER, rec({ eventType: "compass.sense.leave_earlier" }), { nowMinutes: NOON });
    assert.equal(leave.outcome, "sent");
    const block = await evaluateNotification(makeDb().client, USER, rec({ eventType: "compass.sense.free_time_block" }), { nowMinutes: NOON });
    assert.equal(block.outcome, "wall");
  });

  it("a discovery is a world change too", async () => {
    const d = await evaluateNotification(makeDb().client, USER, { type: "discovery", title: "New place nearby", body: "…", data: {} }, { nowMinutes: NOON });
    assert.equal(d.outcome, "wall");
    assert.equal(d.attention?.route, "WALL");
  });
});

describe("D. precedence — the hard filters and the non-world classes are untouched", () => {
  it("an SOS is sent with the budget spent and the preferences unreadable; attention is not consulted", async () => {
    const d = await evaluateNotification(makeDb({ delivered: 99, prefsUnreadable: true }).client, USER, { type: "emergency_safety", title: "SOS", body: "…" }, { nowMinutes: NOON });
    assert.equal(d.outcome, "sent");
    assert.equal(d.attention, null);
  });

  it("a direct message is not a world change: sent regardless of the budget, attention null", async () => {
    const d = await evaluateNotification(makeDb({ delivered: 99 }).client, USER, { type: "message_normal", title: "Hi", body: "…", data: {} }, { nowMinutes: NOON });
    assert.equal(d.outcome, "sent");
    assert.equal(d.attention, null);
  });

  it("a muted category is still suppressed BEFORE attention; the decision carries no attention", async () => {
    const d = await evaluateNotification(makeDb({ mutedCategories: ["nightlife"] }).client, USER, { ...rec({ attention: { relevance: "saved", urgency: 0.9 } }), category: "nightlife" }, { nowMinutes: NOON });
    assert.equal(d.outcome, "suppressed_category_muted");
    assert.equal(d.attention, null);
  });

  it("with no database (unit callers) a declared urgent change is still routed, on zero cost and known availability", async () => {
    const d = await evaluateNotification(null, USER, rec({ attention: { relevance: "trip_stop", urgency: 1 } }), { nowMinutes: NOON });
    assert.equal(d.outcome, "sent");
    assert.equal(d.attention?.factors.interruptionCost, 0);
  });
});

describe("E. router coupling — WALL keeps the in-app row and does not push", () => {
  const TOKEN = "ExponentPushToken[attention-test-device]";
  const NOTIF: NotificationRow = {
    id: "ee000000-0000-4000-8000-000000000002", userId: USER, title: "Compass pick", body: "…",
    // An event with no template row, so the router's default channels apply
    // (in_app + push); category "compass" maps it to the `recommendation` class.
    category: "compass", eventType: "compass.live_pick", priority: "normal",
    // The full NotificationRow, not a convenient subset. `readAt: null` is what
    // "unread" IS on this row — there is no `isRead` field, and inventing one
    // described a row the read boundary never emits. `metadata: {}`, not null,
    // for the same reason: NotificationService maps `r.metadata ?? {}`.
    readAt: null, dismissedAt: null, privacyLevel: "standard",
    imageUrl: null, sourceType: null, actorId: null,
    actionUrl: null, sourceId: null, metadata: {}, expiresAt: null, createdAt: new Date().toISOString(),
  };
  function routerDb(delivered = 0) {
    const attempts: any[] = [];
    let devicesQueried = false;
    const client: any = {
      from(table: string) {
        const filters: Record<string, unknown> = {};
        const resolve = (): any => {
          if (table === "notification_preferences") return { data: null, error: null };
          if (table === "notification_category_preferences") return { data: [], error: null };
          if (table === "notification_devices") { devicesQueried = true; return { data: [{ push_token: TOKEN }], error: null }; }
          // Only the push kill switch is ON; a COMPASS_*_SAFETY_BLOCK row does not exist.
          if (table === "feature_flags") return filters.flag === "push_notifications_enabled" ? { data: { enabled: true }, error: null } : { data: null, error: null };
          if (table === "notifications") return { data: [], count: delivered, error: null };
          if (table === "compass_user_preferences") return { data: { compass_enabled: true, exclude_budget_styles: [], muted_topics: [], category_weights: {} }, error: null };
          return { data: null, error: null };
        };
        const chain: any = {
          select() { return chain; }, eq(k: string, v: unknown) { filters[k] = v; return chain; }, in() { return chain; }, gte() { return chain; },
          maybeSingle() { return Promise.resolve(resolve()); }, single() { return Promise.resolve(resolve()); },
          then(onF: any, onR: any) { return Promise.resolve(resolve()).then(onF, onR); },
        };
        return {
          ...chain,
          insert(row: any) {
            if (table === "notification_delivery_attempts") attempts.push(row);
            const r = { data: { id: "attempt-1" }, error: null };
            return Object.assign(Promise.resolve(r), { select() { return { single() { return Promise.resolve(r); } }; } });
          },
          delete() { return { eq() { return { in() { return Promise.resolve({ error: null }); } }; } }; },
          update() { return { eq() { return Promise.resolve({ error: null }); }, in() { return Promise.resolve({ error: null }); } }; },
        };
      },
    };
    return { client, attempts, devicesQueried: () => devicesQueried };
  }
  let expoCalled = false;
  beforeEach(() => {
    _resetCleanupFailureCount();
    expoCalled = false;
    _setTestFetch((async (_url: any, init: any) => {
      expoCalled = true;
      const messages: Array<{ to: string }> = JSON.parse((init as any).body);
      return { ok: true, status: 200, json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t1" })) }) } as any;
    }) as any);
  });
  afterEach(() => _setTestFetch(null));

  it("an undeclared Compass recommendation: in_app logged sent, push logged suppressed with the attention route, Expo never called", async () => {
    const { client, attempts, devicesQueried } = routerDb();
    await new NotificationRouter(client).route(NOTIF);
    const inApp = attempts.find((a) => a.channel === "in_app");
    const push = attempts.find((a) => a.channel === "push");
    assert.equal(inApp?.status, "sent", "the durable in-app row is the WALL");
    assert.equal(push?.status, "suppressed");
    assert.match(String(push?.error_message ?? ""), /^attention:wall:relevant/);
    assert.equal(expoCalled, false);
    assert.equal(devicesQueried(), false, "no token is even looked up for a WALL route");
  });

  it("the same row declaring a saved place and an urgent change is pushed", async () => {
    const { client, attempts } = routerDb();
    await new NotificationRouter(client).route({ ...NOTIF, metadata: { attention: { relevance: "saved", urgency: 0.9 } } });
    assert.equal(attempts.find((a) => a.channel === "push")?.status, "sent");
    assert.equal(expoCalled, true);
  });
});
