/**
 * Rent-a-Buddy safety endpoints must not report success when the write failed.
 *
 * ── THE DEFECT THIS IS WRITTEN AGAINST (2026-08-29) ─────────────────────────
 * Three safety endpoints awaited their writes without destructuring `error` and
 * then returned `{ ok: true }` unconditionally:
 *
 *   POST /rent-a-buddy/bookings/:id/safety/feel-unsafe
 *   POST /rent-a-buddy/bookings/:id/safety/end-early
 *   POST /rent-a-buddy/bookings/:id/safety/emergency-phrase
 *
 * supabase-js RESOLVES with { data: null, error } on a rejected write rather
 * than throwing, so a rejection produced a 200 that was byte-identical to
 * success. The `rent_buddy_safety_events` row is the ONLY notification anyone
 * gets — there is no push and no page; its sole consumer is the admin queue
 * behind GET /admin/safety/events?status=open. A traveller who said they felt
 * unsafe, or who triggered the duress phrase, was told the safety team had been
 * notified when nothing had been recorded and nobody had been told.
 *
 * These assert on the STATUS CODE, not on the call returning — which is the
 * whole point: the old code "succeeded" every time.
 *
 * Run: node --import tsx/esm --test src/test/rentBuddySafetyWriteFailure.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

const ME = "11111111-1111-1111-1111-111111111111";
const BUDDY = "22222222-2222-2222-2222-222222222222";
const BOOKING = "33333333-3333-3333-3333-333333333333";
const TOK = "tok-me";

/** Tables whose writes should be rejected, to simulate a DB fault. */
let failWritesOn = new Set<string>();
/** Every write the handler attempted, so a test can prove it was even tried. */
let attempted: string[] = [];

const DB_ERROR = { message: "permission denied for table", code: "42501", details: "", hint: "" };

function makeClient() {
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        if (table === "rent_buddy_bookings") {
          return Promise.resolve({
            data: { id: BOOKING, traveler_id: ME, buddy_id: BUDDY, status: "in_progress" },
            error: null,
          });
        }
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: true }, error: null });
        }
        if (table === "rent_buddy_profiles") {
          return Promise.resolve({ data: { user_id: BUDDY }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: { id: ME, account_status: "active" }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      single: () => b.maybeSingle(),
      insert: (_row: any) => {
        attempted.push(`insert:${table}`);
        const settled = failWritesOn.has(table)
          ? { data: null, error: DB_ERROR }
          : { data: null, error: null };
        // Mirrors PostgREST: thenable, and .select().single() is also chainable.
        return Object.assign(Promise.resolve(settled), {
          select: () => Object.assign(Promise.resolve(settled), { single: () => Promise.resolve(settled) }),
        });
      },
      update: (_patch: any) => {
        attempted.push(`update:${table}`);
        const settled = failWritesOn.has(table)
          ? { data: null, error: DB_ERROR }
          : { data: null, error: null };
        const chain: any = Object.assign(Promise.resolve(settled), {
          eq: () => chain,
          select: () => Object.assign(Promise.resolve(settled), { single: () => Promise.resolve(settled) }),
        });
        return chain;
      },
    };
    return b;
  }

  return {
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: (token: string) =>
        Promise.resolve(
          token === TOK
            ? { data: { user: { id: ME } }, error: null }
            : { data: { user: null }, error: { message: "bad token" } },
        ),
    },
  } as any;
}

let base: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", rentABuddyRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(() => {
  server.close();
  _clearTestClient();
  _setTestServiceClient(null as any);
});

beforeEach(() => {
  failWritesOn = new Set();
  attempted = [];
  const c = makeClient();
  _setTestClient(c, true);
  _setTestServiceClient(c);
});

function post(path: string, body: any = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOK}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SAFETY = `/rent-a-buddy/bookings/${BOOKING}/safety`;

describe("a rejected safety-event write must not return 200", () => {
  it("feel-unsafe reports the failure instead of {ok:true}", async () => {
    failWritesOn.add("rent_buddy_safety_events");
    const res = await post(`${SAFETY}/feel-unsafe`, { note: "he followed me" });

    assert.notEqual(res.status, 200, "a traveller must not be told the safety team was notified when nothing was written");
    assert.ok(attempted.includes("insert:rent_buddy_safety_events"), "the write must actually have been attempted");
  });

  it("emergency-phrase reports the failure instead of the reassuring prompt", async () => {
    failWritesOn.add("rent_buddy_safety_events");
    const res = await post(`${SAFETY}/emergency-phrase`);

    assert.notEqual(res.status, 200);
    const body: any = await res.json().catch(() => ({}));
    assert.notEqual(body.travelerOnly, true, "the duress prompt must not be shown when the duress event was not recorded");
  });

  it("feel-unsafe also fails when only the booking flag is rejected", async () => {
    // The safety event lands but the booking is left un-flagged, so the admin
    // queue cannot correlate it. Still a failure, not a success.
    failWritesOn.add("rent_buddy_bookings");
    const res = await post(`${SAFETY}/feel-unsafe`);
    assert.notEqual(res.status, 200);
  });
});

describe("the happy path is unchanged", () => {
  it("feel-unsafe returns 200 and writes both rows when the DB is healthy", async () => {
    const res = await post(`${SAFETY}/feel-unsafe`, { note: "ok" });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(attempted.includes("insert:rent_buddy_safety_events"));
    assert.ok(attempted.includes("update:rent_buddy_bookings"));
  });

  it("emergency-phrase still returns the traveller-only prompt when healthy", async () => {
    const res = await post(`${SAFETY}/emergency-phrase`);
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.travelerOnly, true);
    assert.ok(Array.isArray(body.options) && body.options.length > 0);
  });

  it("the safety event is written BEFORE the booking flag", async () => {
    // Ordering matters: the event is the authoritative notification, so it must
    // not be skipped by an earlier failure of the secondary write.
    await post(`${SAFETY}/feel-unsafe`);
    const ev = attempted.indexOf("insert:rent_buddy_safety_events");
    const flag = attempted.indexOf("update:rent_buddy_bookings");
    assert.ok(ev !== -1 && flag !== -1);
    assert.ok(ev < flag, `expected the safety event first, got ${JSON.stringify(attempted)}`);
  });
});
