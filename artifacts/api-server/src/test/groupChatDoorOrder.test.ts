/**
 * Opening a trip or circle chat through the REAL app, in the real mount order: an
 * invitee is told to accept the invite, and a member reads through the thread reader.
 *
 * THE DEFECT
 * ==========
 * routes/messaging.ts (mounted before routes/groupChat.ts; both register
 * GET /trips/:tripId/chat and GET /circles/:circleId/chat) answered a person holding
 * a live, pending invite `403 forbidden "You must be an accepted trip member…"`, which
 * useGroupChat renders as "No longer a member" — a dead end. groupChat.ts's §20.7
 * answer never ran, and could not have helped as written: its `pending_invite` error
 * code is not one the client knows (services/messaging.ts mapApiError), so it would
 * have read as a server error. useGroupChat shows its accept-the-invite state for a
 * `forbidden` whose message names the invite.
 *
 * THE FIRST FIX, REVERTED
 * =======================
 * Mounting groupChat.ts first (2026-10-22) made its nested { thread, messages } page
 * the answer for MEMBERS too — a page from fetchMessagesForThread, with no media or
 * reply columns and no identity withheld across blocks, which GroupChatScreen renders
 * as-is. messaging.ts's flat answer sends the client through the thread reader, which
 * has all three. So messaging.ts keeps the door and now answers the invitee itself.
 *
 * Run: node --import tsx/esm --test src/test/groupChatDoorOrder.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const OWNER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const INVITEE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const STRANGER = "cccccccc-3333-4333-8333-cccccccccccc";
const TRIP = "dddddddd-4444-4444-8444-dddddddddddd";
const MEMBER = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const THREAD = "ffffffff-6666-4666-8666-ffffffffffff";
const TOKENS: Record<string, string> = { "invitee-tok": INVITEE, "stranger-tok": STRANGER, "member-tok": MEMBER };

function makeClient() {
  const db: Record<string, any[]> = {
    trips: [{ id: TRIP, owner_id: OWNER, title: "Hoi An", destination_city: "Hoi An" }],
    trip_members: [{ trip_id: TRIP, user_id: INVITEE, role: "invited", status: "pending" }, { trip_id: TRIP, user_id: MEMBER, role: "member", status: "accepted" }],
    message_threads: [{ id: THREAD, trip_id: TRIP, thread_type: "trip", title: "Hoi An" }],
    message_thread_members: [{ thread_id: THREAD, user_id: MEMBER, left_at: null }],
    circle_memberships: [],
    circle_invites: [{ id: "inv-1", owner_id: OWNER, recipient_id: INVITEE, status: "pending" }],
  };
  function builder(table: string): any {
    let rows = [...(db[table] ?? [])];
    const b: any = {
      select: () => b, order: () => b, limit: () => b, range: () => b, neq: () => b, not: () => b, upsert: () => b, update: () => b,
      eq: (col: string, val: any) => { rows = rows.filter((r) => r[col] === val); return b; },
      in: (col: string, vals: any[]) => { rows = rows.filter((r) => vals.includes(r[col])); return b; },
      is: (col: string, val: any) => { rows = rows.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (f: any, r: any) => Promise.resolve({ data: rows, error: null }).then(f, r),
    };
    return b;
  }
  return {
    auth: {
      getUser: async (token: string) =>
        TOKENS[token] ? { data: { user: { id: TOKENS[token] } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

let server: Server; let port = 0;
async function get(path: string, tok: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("GET trip/circle chat through the mounted app — who answers, and with what", () => {
  before(() => new Promise<void>((resolve) => { _setTestClient(makeClient() as any, true); server = createServer(app); server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }); }));
  after(() => new Promise<void>((resolve) => { _setTestClient(null as any, false); _setTestServiceClient(null as any); server.close(() => resolve()); }));

  /** useGroupChat.ts: a `forbidden` whose message mentions "pending" or "invite" is the accept-the-invite state. */
  const clientSeesPendingInvite = (b: any) => b?.error === "forbidden" && /pending|invite/.test(String(b?.message ?? ""));

  it("a pending trip invitee is told to accept the invite, in the shape the client acts on", async () => {
    const r = await get(`/trips/${TRIP}/chat`, "invitee-tok");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.reason, "pending_invite", JSON.stringify(r.body));
    assert.ok(clientSeesPendingInvite(r.body), `useGroupChat would not show the invite state for ${JSON.stringify(r.body)}`);
  });

  it("a pending circle invitee too", async () => {
    const r = await get(`/circles/${OWNER}/chat`, "invitee-tok");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.reason, "pending_invite", JSON.stringify(r.body));
    assert.ok(clientSeesPendingInvite(r.body), JSON.stringify(r.body));
  });

  it("a stranger still gets the plain refusal — never the invite state", async () => {
    const r = await get(`/trips/${TRIP}/chat`, "stranger-tok");
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body?.error, "forbidden", JSON.stringify(r.body));
    assert.ok(!clientSeesPendingInvite(r.body), `a stranger must not be invited to accept: ${JSON.stringify(r.body)}`);
  });

  it("a member gets the flat answer and NO message page, so the client reads page 1 through the thread reader", async () => {
    const r = await get(`/trips/${TRIP}/chat`, "member-tok");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.threadId, THREAD);
    assert.equal(r.body?.threadType, "trip");
    assert.equal("messages" in (r.body ?? {}), false, `a page here is rendered as-is, without media, replies or identity withholding: ${JSON.stringify(r.body)}`);
    assert.equal("thread" in (r.body ?? {}), false, "the nested shape makes useGroupChat skip the thread reader");
  });
});
