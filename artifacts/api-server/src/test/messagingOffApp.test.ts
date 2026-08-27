/**
 * Off-app solicitation detection — messaging route integration tests.
 *
 * Offenses are only attributed when the MESSAGE SENDER is the buddy account for
 * that booking. A traveler can write flagged phrases without triggering buddy
 * suspension (the system only polices the service provider, not the customer).
 *
 * Run: node --import tsx/esm --test src/test/messagingOffApp.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter from "../routes/messaging.js";

const BUDDY_TOKEN    = "msg-offapp-buddy-token";
const TRAVELER_TOKEN = "msg-offapp-traveler-token";
const BUDDY_USER     = "buddy-offapp-user-1";
const TRAVELER_ID    = "traveler-offapp-1";
const BUDDY_PROF     = "buddy-offapp-profile-1";
const BOOKING_ID     = "booking-offapp-1";
const THREAD_ID      = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

let server: http.Server;
let base: string;

interface OffAppState {
  profiles:       Record<string, any>;
  buddyProfiles:  Record<string, any>;
  bookings:       Record<string, any>;
  threadMembers:  any[];
  bookingEvents:  any[];
  messages:       any[];
}

let state: OffAppState = {
  profiles:      {},
  buddyProfiles: {},
  bookings:      {},
  threadMembers: [],
  bookingEvents: [],
  messages:      [],
};

function makeClient() {
  function fakeTable(table: string) {
    return {
      _table: table,
      _filters: [] as Array<[string, string, any]>,
      _insertData: null as any,
      _updateData: null as any,
      _maybeSingle: false,
      _count: false,

      select(cols?: string, opts?: any) { if (opts?.count) this._count = true; return this; },
      insert(data: any) { this._insertData = data; return this; },
      update(data: any) { this._updateData = data; return this; },
      eq(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      neq(col: string, val: any) { this._filters.push(["neq", col, val]); return this; },
      in(col: string, vals: any[]) { this._filters.push(["in", col, vals]); return this; },
      is(col: string, val: any) { this._filters.push(["eq", col, val]); return this; },
      or() { return this; }, // block-guard's fail-closed blocks lookup — no blocks in these fixtures
      maybeSingle() { this._maybeSingle = true; return this; },
      single() { this._maybeSingle = true; return this; },
      order() { return this; },
      limit() { return this; },
      range() { return this; },

      async then(resolve: (v: any) => void) {
        const result = await this._resolve();
        resolve(result);
        return result;
      },

      async _resolve(): Promise<any> {
        const t = this._table;

        if (this._insertData !== null) {
          const rows = Array.isArray(this._insertData) ? this._insertData : [this._insertData];
          const generated = rows.map((r: any) => ({ id: `gen-${Math.random().toString(36).slice(2)}`, ...r }));
          if (t === "buddy_booking_events") {
            generated.forEach((r: any) => state.bookingEvents.push(r));
          }
          if (t === "messages") {
            generated.forEach((r: any) => state.messages.push(r));
          }
          if (this._maybeSingle) return { data: generated[0] ?? null, error: null };
          return { data: null, error: null };
        }

        if (this._updateData !== null) {
          if (t === "rent_buddy_profiles") {
            for (const [, col, val] of this._filters) {
              if (col === "id" && state.buddyProfiles[val]) {
                Object.assign(state.buddyProfiles[val], this._updateData);
              }
            }
          }
          return { data: null, error: null };
        }

        if (t === "profiles") {
          const eqId = this._filters.find(([op, col]) => op === "eq" && col === "id");
          if (eqId && this._maybeSingle) return { data: state.profiles[eqId[2]] ?? null, error: null };
          return { data: Object.values(state.profiles), error: null };
        }

        if (t === "message_thread_members") {
          let rows = [...state.threadMembers];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "neq") rows = rows.filter((r: any) => r[col] !== val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (t === "blocks") {
          // The block guard's .or() is a no-op in this fake, so it returns every
          // seeded block; that is enough for a 1:1 thread with a single block row.
          return { data: (state.blocks ?? []), error: null };
        }

        if (t === "rent_buddy_bookings") {
          let rows = Object.values(state.bookings);
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "in") rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "buddy_booking_events") {
          let rows = [...state.bookingEvents];
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
            if (op === "in") rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, count: rows.length, error: null };
        }

        if (t === "rent_buddy_profiles") {
          let rows = Object.values(state.buddyProfiles);
          for (const [op, col, val] of this._filters) {
            if (op === "eq") rows = rows.filter((r: any) => r[col] === val);
          }
          if (this._maybeSingle) return { data: rows[0] ?? null, error: null };
          return { data: rows, error: null };
        }

        if (this._maybeSingle) return { data: null, error: null };
        return { data: [], count: 0, error: null };
      },
    };
  }

  return {
    from: (table: string) => fakeTable(table),
    auth: {
      getUser: async (token: string) => {
        if (token === BUDDY_TOKEN)    return { data: { user: { id: BUDDY_USER } }, error: null };
        if (token === TRAVELER_TOKEN) return { data: { user: { id: TRAVELER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
  };
}

function setupState() {
  state = {
    profiles: {
      [BUDDY_USER]:  { id: BUDDY_USER,  preferred_language: "en" },
      [TRAVELER_ID]: { id: TRAVELER_ID, preferred_language: "en" },
    },
    buddyProfiles: {
      [BUDDY_PROF]: { id: BUDDY_PROF, user_id: BUDDY_USER, status: "active", admin_status: "active" },
    },
    bookings: {
      [BOOKING_ID]: {
        id: BOOKING_ID,
        traveler_id: TRAVELER_ID,
        buddy_id: BUDDY_PROF,
        telegraph_thread_id: THREAD_ID,
        status: "accepted",
      },
    },
    threadMembers: [
      { thread_id: THREAD_ID, user_id: BUDDY_USER,  left_at: null },
      { thread_id: THREAD_ID, user_id: TRAVELER_ID, left_at: null },
    ],
    bookingEvents: [],
    messages:      [],
    blocks:        [],
  };
  const client = makeClient();
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
}

function sendMessageWith(token: string, body: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ body });
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path: `/api/threads/${THREAD_ID}/messages`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${token}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

const sendBuddyMessage    = (body: string) => sendMessageWith(BUDDY_TOKEN, body);
const sendTravelerMessage = (body: string) => sendMessageWith(TRAVELER_TOKEN, body);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", messagingRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

beforeEach(() => setupState());

describe("Off-app solicitation detection — messaging route", () => {
  it("BLOCKS a send through a pre-existing 1:1 thread when the members have a block", async () => {
    // Blocking never closed existing threads, so a blocked user could keep DMing.
    (state as any).blocks.push({ blocker_id: TRAVELER_ID, blocked_id: BUDDY_USER });
    const r = await sendMessageWith(BUDDY_TOKEN, "hello there");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(state.messages.length, 0, "no message written when blocked");
  });

  it("buddy sends clean travel message — no warning event created", async () => {
    const r = await sendBuddyMessage("What time should we meet at the train station?");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 80));
    const warnings = state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
    assert.equal(warnings.length, 0, "no warning for normal travel message");
  });

  it("buddy sends off-app phrase — warning event is created", async () => {
    const r = await sendBuddyMessage("Hey, just pay me directly via venmo instead of through the app.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 80));
    const warnings = state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
    assert.equal(warnings.length, 1, "one solicitation warning expected");
    assert.ok(warnings[0]?.metadata?.excerpt, "warning should include an excerpt");
  });

  it("off-app solicitation does not block the message (still returns 201)", async () => {
    const r = await sendBuddyMessage("Pay outside the app and I can give you a discount.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.id ?? r.body.message, "response should include the saved message");
  });

  it("traveler sends off-app phrase — no warning (sender is not the buddy)", async () => {
    const r = await sendTravelerMessage("Can I cashapp you directly? Would prefer off-app payment.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 80));
    const warnings = state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
    assert.equal(warnings.length, 0, "traveler off-app phrase must NOT create a buddy warning");
  });

  it("buddy is suspended after reaching the offense threshold", async () => {
    state.bookings["booking-offapp-2"] = { id: "booking-offapp-2", buddy_id: BUDDY_PROF, telegraph_thread_id: null };
    state.bookings["booking-offapp-3"] = { id: "booking-offapp-3", buddy_id: BUDDY_PROF, telegraph_thread_id: null };
    state.bookingEvents = [BOOKING_ID, "booking-offapp-2"].map((bid) => ({
      id: `prior-${bid}`,
      booking_id: bid,
      event: "off_app_solicitation_warning",
    }));

    const r = await sendBuddyMessage("My telegram handle is @somehandle — message me there to arrange payment.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 120));

    assert.equal(state.buddyProfiles[BUDDY_PROF]?.status, "suspended", "buddy should be suspended after 3 offenses");
    const autoSuspend = state.bookingEvents.find((e) => e.event === "buddy_auto_suspended");
    assert.ok(autoSuspend, "auto-suspension event should be logged");
  });

  it("off-app pattern: 'off-app' phrase triggers warning when buddy sends", async () => {
    const r = await sendBuddyMessage("Let's go off-app for this payment.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 80));
    const warnings = state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
    assert.ok(warnings.length >= 1, "off-app phrase should trigger warning");
  });

  it("off-app pattern: 'pay me directly' phrase triggers warning when buddy sends", async () => {
    const r = await sendBuddyMessage("Please pay me directly and I'll confirm the booking.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 80));
    const warnings = state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
    assert.ok(warnings.length >= 1, "'pay me directly' should trigger warning");
  });

  it("no warning when thread has no linked buddy booking", async () => {
    state.bookings = {};
    const r = await sendBuddyMessage("I can cashapp you the payment, no app needed.");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 80));
    const warnings = state.bookingEvents.filter((e) => e.event === "off_app_solicitation_warning");
    assert.equal(warnings.length, 0, "no warning if thread is not a buddy booking thread");
  });
});
