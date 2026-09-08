/**
 * notificationPushTokenRegistryUnreadable — "no push tokens" must mean NO PUSH
 * TOKENS, not "we could not read the table".
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * NotificationRouter.sendPush gathered the user's tokens with
 *
 *     const { data: devices } = await this.db.from('notification_devices')…
 *     const { data: profile } = await this.db.from('profiles')…
 *
 * — `error` never bound on either. supabase-js RESOLVES on a database error, so
 * an unreadable notification_devices arrived as `data: null`, the token list came
 * out EMPTY, and the next branch wrote
 *
 *     status: 'suppressed', error_message: 'no push tokens'
 *
 * into notification_delivery_attempts. That is the exact row a user who has
 * never installed the app produces. notification_delivery_attempts is the ledger
 * an operator reads to answer "why did this alert not arrive?", and for an
 * outage it answered "that person has no device registered" — terminal, and
 * wrong. route() had already been fixed to log 'failed'/'preferences_unreadable'
 * rather than 'suppressed' when consent could not be read; the token registry is
 * the other half of the same claim.
 *
 * ── WHY A REAL CLIENT AND A COUNTING FETCH ───────────────────────────────────
 * The measurement is "what row was actually POSTed to
 * notification_delivery_attempts", so the harness records real HTTP traffic from
 * a real `createClient`, as src/test/notificationIssuance.test.ts does. A
 * hand-written double cannot show which request was issued.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ──────────────────────────────────────
 *  * Asserting only "not sent" would pass against the broken code, which also
 *    does not send. Every case asserts the EXACT (status, error_message) pair.
 *  * A test that only failed the read would pass trivially if the router simply
 *    stopped writing attempts. Case 2 and 3 are positive controls: an EMPTY but
 *    readable registry must still produce 'suppressed'/'no push tokens', and a
 *    readable registry with a token must still produce 'sent'. The broken build
 *    produces case 2's answer for case 1, so the two cannot both pass on it.
 *  * The read is failed by its EXACT projected column (select=push_token), not
 *    by table name: notification_devices is read elsewhere in the pipeline and a
 *    blanket table failure would prove something weaker.
 *  * A vacuity guard asserts the recorder actually saw the notification_devices
 *    request in the failing case — otherwise "no push attempt of the wrong shape"
 *    could be satisfied by a harness that observed nothing.
 *
 * Run: node --import tsx/esm --test src/test/notificationPushTokenRegistryUnreadable.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

import { _setTestFetch } from "../lib/push.js";
import { NotificationRouter, _resetCleanupFailureCount } from "../services/notifications/NotificationRouter.js";
import type { NotificationRow } from "../services/notifications/NotificationService.js";

const SUPA_URL = "http://supabase.test";
const SUPA_KEY = "test-service-role-key";

const USER_ID  = "bb000000-0000-4000-8000-000000000001";
const NOTIF_ID = "bb000000-0000-4000-8000-000000000002";
const TOKEN    = "ExponentPushToken[real-device-token]";

interface Call { method: string; path: string; query: string; body: any }

let calls: Call[] = [];
let lifetimeCalls = 0;

type Responder = (c: Call) => unknown;

function recordingFetch(respond: Responder): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const raw = typeof input === "string" ? input : (input?.url ?? String(input));
    const u = new URL(raw);
    let body: any = null;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
    }
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: u.pathname,
      query: u.search,
      body,
    };
    calls.push(call);
    lifetimeCalls += 1;
    const payload = respond(call);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? []), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function realClient(respond: Responder) {
  return createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: recordingFetch(respond) },
  });
}

/** A PostgREST failure: HTTP 500 with an error body. supabase-js RESOLVES on it. */
function dbFailure(): Response {
  return new Response(
    JSON.stringify({ message: "canceling statement due to statement timeout", code: "57014" }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}

/** Is this the sendPush device-token read? Keyed on the exact projected column. */
const isDeviceTokenRead = (c: Call) =>
  c.method === "GET" &&
  c.path === "/rest/v1/notification_devices" &&
  c.query.includes("select=push_token");

/** Is this the sendPush legacy-profile read? Keyed on the exact projected column. */
const isLegacyTokenRead = (c: Call) =>
  c.method === "GET" &&
  c.path === "/rest/v1/profiles" &&
  c.query.includes("select=expo_push_token");

interface Fixture {
  failDeviceRead?: boolean;
  failLegacyRead?: boolean;
  deviceTokens?: string[];
  legacyToken?: string | null;
}

function responderFor(f: Fixture): Responder {
  return (c) => {
    if (isDeviceTokenRead(c)) {
      if (f.failDeviceRead) return dbFailure();
      return (f.deviceTokens ?? []).map((t) => ({ push_token: t }));
    }
    if (isLegacyTokenRead(c)) {
      if (f.failLegacyRead) return dbFailure();
      return f.legacyToken ? [{ expo_push_token: f.legacyToken }] : [];
    }
    if (c.path === "/rest/v1/feature_flags") {
      return [{ flag: "push_notifications_enabled", enabled: true }];
    }
    if (c.method === "POST" && c.path === "/rest/v1/notification_delivery_attempts") {
      return { id: "attempt-1" };
    }
    return [];
  };
}

/**
 * `urgent` + `safety` maps to the Compass emergency_safety level, which the
 * intelligence gate lets through without further DB gates, and it is the
 * priority whose delivery matters most — a safe-return alert.
 */
const ALERT: NotificationRow = {
  id:           NOTIF_ID,
  userId:       USER_ID,
  category:     "safety",
  eventType:    "safe_return.missed",
  priority:     "urgent",
  title:        "Check in",
  body:         "You missed a check-in",
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
};

function pushAttempts(): Array<{ status: string; error_message: string | null }> {
  return calls
    .filter((c) => c.method === "POST" && c.path === "/rest/v1/notification_delivery_attempts")
    .map((c) => c.body)
    .filter((b: any) => b?.channel === "push")
    .map((b: any) => ({ status: b.status, error_message: b.error_message ?? null }));
}

beforeEach(() => {
  calls = [];
  _resetCleanupFailureCount();
  // Expo is a different host with a different fetch; keep it off the recorder.
  _setTestFetch((async (_u: any, init: any) => {
    const messages: Array<{ to: string }> = JSON.parse((init as any).body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: messages.map(() => ({ status: "ok", id: "t1" })) }),
    } as any;
  }) as any);
});

afterEach(() => { _setTestFetch(null); });

describe("NotificationRouter.sendPush — an unreadable token registry is not an empty one", () => {
  it("records status 'failed' / 'push_tokens_unreadable' when notification_devices cannot be read", async () => {
    const sc = realClient(responderFor({ failDeviceRead: true, legacyToken: null }));
    await new NotificationRouter(sc as any).route(ALERT);

    // Vacuity guard: the harness really did serve the read we failed.
    assert.ok(
      calls.some(isDeviceTokenRead),
      "fixture check: the device-token read was never issued, so nothing was measured",
    );

    const attempts = pushAttempts();
    assert.equal(attempts.length, 1, `expected exactly one push attempt row, got ${JSON.stringify(attempts)}`);
    assert.equal(
      attempts[0]!.status, "failed",
      `an unreadable registry must be ledgered as 'failed', got '${attempts[0]!.status}' ` +
      `with '${attempts[0]!.error_message}' — 'suppressed' is the answer for a user who opted out or has no device`,
    );
    assert.equal(
      attempts[0]!.error_message, "push_tokens_unreadable",
      `the reason must name the outage; got '${attempts[0]!.error_message}'`,
    );
    assert.notEqual(
      attempts[0]!.error_message, "no push tokens",
      "'no push tokens' is the claim a user with zero devices earns; an outage must not borrow it",
    );
  });

  it("still records 'suppressed' / 'no push tokens' when the registry is READABLE and empty", async () => {
    // Positive control, and the discriminator: the broken build answers this way
    // for the failing case above too, so the two cannot both pass on it.
    const sc = realClient(responderFor({ deviceTokens: [], legacyToken: null }));
    await new NotificationRouter(sc as any).route(ALERT);

    const attempts = pushAttempts();
    assert.equal(attempts.length, 1, `expected exactly one push attempt row, got ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0]!.status, "suppressed", "a genuinely empty registry is still a suppression");
    assert.equal(attempts[0]!.error_message, "no push tokens");
  });

  it("still delivers and records 'sent' when the registry is readable and holds a token", async () => {
    // Positive control: the fix must not turn every push into a failure.
    const sc = realClient(responderFor({ deviceTokens: [TOKEN], legacyToken: null }));
    await new NotificationRouter(sc as any).route(ALERT);

    const attempts = pushAttempts();
    assert.equal(attempts.length, 1, `expected exactly one push attempt row, got ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0]!.status, "sent", `a healthy push must still be ledgered as sent`);
  });

  it("a legacy profiles read failure alone does NOT fail a push that has device tokens", async () => {
    // profiles.expo_push_token duplicates a device token for almost every user;
    // losing it while notification_devices answered is not a lost delivery.
    const sc = realClient(responderFor({ failLegacyRead: true, deviceTokens: [TOKEN] }));
    await new NotificationRouter(sc as any).route(ALERT);

    assert.ok(calls.some(isLegacyTokenRead), "fixture check: the legacy read was never issued");
    const attempts = pushAttempts();
    assert.equal(attempts.length, 1, `expected exactly one push attempt row, got ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0]!.status, "sent", "device tokens were readable — this push went out");
  });

  it("a legacy profiles read failure DOES fail the push when it is the only possible source", async () => {
    // devices answered empty, so the legacy column is the only place a token
    // could have come from — and it is unknown. "No push tokens" is unproven.
    const sc = realClient(responderFor({ failLegacyRead: true, deviceTokens: [] }));
    await new NotificationRouter(sc as any).route(ALERT);

    const attempts = pushAttempts();
    assert.equal(attempts.length, 1, `expected exactly one push attempt row, got ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0]!.status, "failed", "the token set was never established");
    assert.equal(attempts[0]!.error_message, "push_tokens_unreadable");
  });
});

describe("VACUITY GUARD", () => {
  it("the recorder observed real traffic across this file", () => {
    assert.ok(
      lifetimeCalls > 10,
      `the fetch recorder saw ${lifetimeCalls} requests; a near-zero number means the ` +
      `harness stopped observing and every assertion above is vacuous`,
    );
  });
});
