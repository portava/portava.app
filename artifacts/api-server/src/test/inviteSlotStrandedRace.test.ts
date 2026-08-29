/**
 * inviteSlotStrandedRace.test.ts
 *
 * Tests the post-race stranded-slot scenario described in migration 0111.
 *
 * When two concurrent accept calls race for the last slot, the second caller
 * gets 'limit_reached'.  If the first caller's trip_members INSERT then fails
 * (transient DB error, process kill, etc.) the slot is stranded:
 *   • use_count is incremented in trip_invite_links
 *   • a trip_invite_link_attempts row exists for (link_id, user_id)
 *   • no trip_members row exists for (trip_id, user_id)
 *
 * reconcile_invite_link_slots() is supposed to find and fix exactly these rows.
 *
 * This suite uses a *stateful* fake DB that simulates the SQL function's
 * behavior so we can:
 *   - Seed concrete state (attempt rows, link rows, member rows)
 *   - Run the reconciler path (via reconcileInviteSlots() and the admin
 *     POST /admin/trips/reconcile-invite-slots endpoint)
 *   - Assert the state changes afterwards:
 *       • use_count is decremented back to 0
 *       • the stranded attempt row is deleted
 *       • fresh attempt rows (within min_age_minutes) are untouched
 *       • attempt rows that have a matching member row are untouched
 *
 * Run: node --import tsx/esm --test src/test/inviteSlotStrandedRace.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import { reconcileInviteSlots } from "../lib/inviteSlotReconciler.js";

// ── Fixed IDs ──────────────────────────────────────────────────────────────────

const ADMIN_ID = "aa000000-0000-0000-0000-000000000001";
const LINK_ID  = "bb000000-0000-0000-0000-000000000002";
const USER_A   = "cc000000-0000-0000-0000-000000000003";
const USER_B   = "dd000000-0000-0000-0000-000000000004";
const TRIP_ID  = "ee000000-0000-0000-0000-000000000005";

/** 60 minutes in the past — safely beyond the default 5-minute age gate. */
function oldTimestamp(): string {
  return new Date(Date.now() - 60 * 60 * 1_000).toISOString();
}

/** 30 seconds in the past — within any reasonable min_age_minutes gate. */
function freshTimestamp(): string {
  return new Date(Date.now() - 30 * 1_000).toISOString();
}

// ── Stateful DB simulator ──────────────────────────────────────────────────────

/**
 * Simulates the in-memory state of the three tables touched by
 * reconcile_invite_link_slots.
 *
 * makeStatefulClient() returns both the fake Supabase client AND direct
 * accessors to the in-memory table state so tests can inspect changes after
 * the reconciler runs.
 */
interface LinkRow {
  id: string;
  trip_id: string;
  use_count: number;
}

interface AttemptRow {
  link_id: string;
  user_id: string;
  claimed_at: string;
}

interface MemberRow {
  trip_id: string;
  user_id: string;
  role: string;
}

interface StatefulDB {
  links: LinkRow[];
  attempts: AttemptRow[];
  members: MemberRow[];
}

function makeStatefulClient(db: StatefulDB, opts: { isAdmin?: boolean } = {}): any {
  const { isAdmin = true } = opts;

  /**
   * Simulates the SQL logic of reconcile_invite_link_slots(min_age_minutes):
   *
   *   SELECT a.link_id, a.user_id, a.claimed_at, til.trip_id
   *   FROM trip_invite_link_attempts a
   *   JOIN trip_invite_links til ON til.id = a.link_id
   *   WHERE a.claimed_at < now() - (min_age_minutes || ' minutes')::interval
   *     AND NOT EXISTS (SELECT 1 FROM trip_members tm
   *                     WHERE tm.trip_id = til.trip_id AND tm.user_id = a.user_id)
   *   FOR UPDATE OF a SKIP LOCKED
   *
   * For each stranded row:
   *   UPDATE trip_invite_links SET use_count = GREATEST(0, use_count - 1)
   *   DELETE FROM trip_invite_link_attempts WHERE link_id = ... AND user_id = ...
   */
  function simulateReconcile(minAgeMinutes: number): any[] {
    const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1_000);
    const fixed: any[] = [];

    const stranded = db.attempts.filter((a) => {
      // Age gate: claimed_at must be older than the cutoff
      if (new Date(a.claimed_at) >= cutoff) return false;

      // Linked invite link must exist
      const link = db.links.find((l) => l.id === a.link_id);
      if (!link) return false;

      // No matching member row for this (trip_id, user_id) pair
      const hasMember = db.members.some(
        (m) => m.trip_id === link.trip_id && m.user_id === a.user_id,
      );
      return !hasMember;
    });

    for (const a of stranded) {
      const link = db.links.find((l) => l.id === a.link_id)!;

      // Decrement use_count (floor at 0)
      link.use_count = Math.max(0, link.use_count - 1);

      // Delete the attempt row
      const idx = db.attempts.indexOf(a);
      if (idx !== -1) db.attempts.splice(idx, 1);

      fixed.push({
        link_id:    a.link_id,
        user_id:    a.user_id,
        claimed_at: a.claimed_at,
        trip_id:    link.trip_id,
      });
    }

    return fixed;
  }

  function profileBuilder() {
    const b: any = {
      select:      () => b,
      eq:          () => b,
      maybeSingle: () =>
        Promise.resolve({
          data: { id: ADMIN_ID, role: isAdmin ? "admin" : "user" },
          error: null,
        }),
    };
    return b;
  }

  return {
    auth: {
      getUser: async () => ({
        data: { user: { id: ADMIN_ID } },
        error: null,
      }),
    },

    from: (table: string) => {
      if (table === "profiles") return profileBuilder();
      // All other table access (not exercised by the reconcile path)
      const b: any = {
        select: () => b,
        eq:     () => b,
        then:   (resolve: any) => Promise.resolve({ data: [], error: null }).then(resolve),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return b;
    },

    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "reconcile_invite_link_slots") {
        const minAge = (args["min_age_minutes"] as number) ?? 5;
        const rows = simulateReconcile(minAge);
        return { data: rows, error: null };
      }
      if (fn === "cleanup_stale_invite_link_attempts") {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    },
  };
}

// ── Test server for admin endpoint tests ───────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => server.close());

function postReconcile(body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(new URL(base).port),
        path: "/admin/trips/reconcile-invite-slots",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer fake-admin-token",
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
    if (payload) r.write(payload);
    r.end();
  });
}

function setClients(client: any) {
  _setTestClient(client, true);
  _setTestServiceClient(client);
}

// ── Admin endpoint: post-race stranded-slot tests ──────────────────────────────

describe("POST /admin/trips/reconcile-invite-slots — post-race stranded-slot scenario", () => {

  it("releases a stranded slot: decrements use_count and deletes the attempt row", async () => {
    // Seed state: use_count=1 (slot claimed), one attempt row, no member row
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: oldTimestamp() }],
      members:  [],
    };
    setClients(makeStatefulClient(db));

    const r = await postReconcile();

    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 1, "one stranded slot should be released");
    assert.equal(r.body.slots.length, 1);
    assert.equal(r.body.slots[0].linkId, LINK_ID);
    assert.equal(r.body.slots[0].userId, USER_A);
    assert.equal(r.body.slots[0].tripId, TRIP_ID);

    // State assertions: use_count back to 0, attempt row deleted
    assert.equal(db.links[0].use_count, 0, "use_count must be decremented to 0");
    assert.equal(db.attempts.length, 0, "stranded attempt row must be deleted");
  });

  it("does not touch a fresh attempt row within the age gate (in-flight guard)", async () => {
    // Seed state: attempt row claimed only 30 seconds ago — still in-flight
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: freshTimestamp() }],
      members:  [],
    };
    setClients(makeStatefulClient(db));

    const r = await postReconcile({ minAgeMinutes: 5 });

    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 0, "fresh in-flight attempt must not be released");

    // State must be unchanged
    assert.equal(db.links[0].use_count, 1, "use_count must remain 1 for fresh attempt");
    assert.equal(db.attempts.length, 1, "fresh attempt row must not be deleted");
  });

  it("does not touch an attempt that has a matching member row (successful join)", async () => {
    // Seed state: attempt row exists but so does a member row → successful join,
    // not a stranded slot
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: oldTimestamp() }],
      members:  [{ trip_id: TRIP_ID, user_id: USER_A, role: "member" }],
    };
    setClients(makeStatefulClient(db));

    const r = await postReconcile();

    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 0, "successfully joined member must not be treated as stranded");
    assert.equal(db.links[0].use_count, 1, "use_count must not change for a valid member");
    assert.equal(db.attempts.length, 1, "attempt row for successful join must not be deleted");
  });

  it("releases all stranded slots from a multi-user capacity race", async () => {
    // Both USER_A and USER_B claimed a slot; both member INSERTs failed
    const db: StatefulDB = {
      links: [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 2 }],
      attempts: [
        { link_id: LINK_ID, user_id: USER_A, claimed_at: oldTimestamp() },
        { link_id: LINK_ID, user_id: USER_B, claimed_at: oldTimestamp() },
      ],
      members: [],
    };
    setClients(makeStatefulClient(db));

    const r = await postReconcile();

    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 2, "all two stranded slots must be released");
    assert.equal(r.body.slots.length, 2);

    // use_count must drop from 2 to 0; both attempt rows deleted
    assert.equal(db.links[0].use_count, 0, "use_count must be decremented for each stranded slot");
    assert.equal(db.attempts.length, 0, "all stranded attempt rows must be deleted");
  });

  it("only releases old stranded slots and leaves fresh ones intact (mixed state)", async () => {
    // USER_A: old stranded slot (should be fixed)
    // USER_B: fresh attempt (should be left alone — may still be in flight)
    const db: StatefulDB = {
      links: [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 2 }],
      attempts: [
        { link_id: LINK_ID, user_id: USER_A, claimed_at: oldTimestamp() },
        { link_id: LINK_ID, user_id: USER_B, claimed_at: freshTimestamp() },
      ],
      members: [],
    };
    setClients(makeStatefulClient(db));

    const r = await postReconcile({ minAgeMinutes: 5 });

    assert.equal(r.status, 200);
    assert.equal(r.body.fixed, 1, "only the old stranded slot should be released");

    // use_count decremented once (for USER_A only)
    assert.equal(db.links[0].use_count, 1, "use_count decremented only for the old slot");
    // USER_B's attempt row still present
    assert.equal(db.attempts.length, 1, "fresh attempt row must remain");
    assert.equal(db.attempts[0].user_id, USER_B, "fresh attempt belongs to USER_B");
  });

  it("respects a custom minAgeMinutes threshold from the request body", async () => {
    // Attempt was claimed 4 minutes ago. With default threshold (5 min) it should
    // NOT be touched; with threshold=3 it should be released.
    const fourMinutesAgo = new Date(Date.now() - 4 * 60 * 1_000).toISOString();
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: fourMinutesAgo }],
      members:  [],
    };
    setClients(makeStatefulClient(db));

    // With threshold=5 (default): attempt is only 4 min old, should be untouched
    const r5 = await postReconcile({ minAgeMinutes: 5 });
    assert.equal(r5.body.fixed, 0, "4-min-old attempt must not be fixed with minAgeMinutes=5");
    assert.equal(db.links[0].use_count, 1, "use_count unchanged with threshold=5");
    assert.equal(db.attempts.length, 1, "attempt row preserved with threshold=5");

    // Now run with threshold=3: attempt is 4 min old → should be released
    const r3 = await postReconcile({ minAgeMinutes: 3 });
    assert.equal(r3.body.fixed, 1, "4-min-old attempt must be fixed with minAgeMinutes=3");
    assert.equal(db.links[0].use_count, 0, "use_count decremented with threshold=3");
    assert.equal(db.attempts.length, 0, "attempt row deleted with threshold=3");
  });
});

// ── reconcileInviteSlots() directly: stateful fake verifications ───────────────

describe("reconcileInviteSlots() — stateful post-race verification", () => {

  it("decrements use_count and removes attempt row for a stranded slot", async () => {
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: oldTimestamp() }],
      members:  [],
    };
    const client = makeStatefulClient(db);

    const result = await reconcileInviteSlots({ client, minAgeMinutes: 5 });

    assert.equal(result.fixed, 1);
    assert.equal(result.error, null);
    // State: use_count returned to 0, attempt row gone
    assert.equal(db.links[0].use_count, 0, "use_count must be decremented");
    assert.equal(db.attempts.length, 0, "attempt row must be deleted");
  });

  it("leaves fresh attempt rows intact — age gate protects in-flight requests", async () => {
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: freshTimestamp() }],
      members:  [],
    };
    const client = makeStatefulClient(db);

    const result = await reconcileInviteSlots({ client, minAgeMinutes: 5 });

    assert.equal(result.fixed, 0, "fresh slot must not be touched");
    assert.equal(db.links[0].use_count, 1, "use_count unchanged for fresh attempt");
    assert.equal(db.attempts.length, 1, "fresh attempt row must survive");
  });

  it("does not release a slot when the member row exists (successful join)", async () => {
    const db: StatefulDB = {
      links:    [{ id: LINK_ID, trip_id: TRIP_ID, use_count: 1 }],
      attempts: [{ link_id: LINK_ID, user_id: USER_A, claimed_at: oldTimestamp() }],
      members:  [{ trip_id: TRIP_ID, user_id: USER_A, role: "member" }],
    };
    const client = makeStatefulClient(db);

    const result = await reconcileInviteSlots({ client, minAgeMinutes: 5 });

    assert.equal(result.fixed, 0);
    assert.equal(db.links[0].use_count, 1, "use_count must remain for a valid join");
    assert.equal(db.attempts.length, 1, "attempt row for valid join must not be removed");
  });
});
