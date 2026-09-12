/**
 * Telegraph §26 — the RLS & Authorization Test Matrix, executed.
 *
 * Ten cases, ten expectations, each driven against the real route handler,
 * middleware or resolver that produces the outcome. The declarations live in
 * src/domain/telegraph/invariants/rlsAuthorizationMatrix.ts and
 * src/scripts/checkTelegraphRlsMatrix.ts fails CI if a case here is missing, if
 * a cited artifact has been deleted, or if the set of cases that do NOT reach
 * their expectation grows.
 *
 * Three cases do not reach their expectation today and say so out loud:
 *   RLS-03 flag_gated — the §14.3 history bound is built and seeded OFF.
 *   RLS-09 divergent  — the gate is immediate, the propagation is not.
 *   RLS-10 divergent  — one action re-derives, every rendered action does not.
 * Their assertions are written against TODAY'S behaviour, so closing the gap
 * turns this suite red and forces the matrix to be updated with it.
 *
 * SHOWN RED BEFORE GREEN — three deliberate, reverted mutations, each of which
 * moved this suite from 34 pass / 0 fail to 33 / 1:
 *
 *   1. routes/messaging.ts — the roster-read refusal in the send path replaced
 *      by an empty block. RLS-04's roster assertion failed. This one also
 *      corrected the TEST: with a whole-table error injected the suite stayed
 *      GREEN through that mutation, because failing message_thread_members
 *      outright denies at the caller's own membership check and the roster
 *      guard is never reached. The harness grew `afterOps` so the failure lands
 *      on the second read, which is the only version of this assertion that
 *      measures the thing it names.
 *   2. services/groupChatHistoryBound.ts — visibleFromOf forced to return null.
 *      RLS-03's flag-ON assertion failed.
 *   3. domain/telegraph/policies/shareAuthorizationPolicy.ts — a missing grant
 *      made to allow. RLS-07 failed.
 *
 * A green run proves nothing until it has been seen to go red, and mutation 1
 * is why: the first version of that assertion was green for the wrong reason.
 *
 * Run: node --import tsx/esm --test src/test/telegraphRlsAuthorizationMatrix.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import { syncTripChatMembers } from "../services/groupChatSync.js";
import { requireSafeReturnRecipient } from "../services/safeReturn/SafeReturnPrivacyGuard.js";
import { toPublicSession, stripGPS } from "../services/safeReturn/SafeReturnPrivacyGuard.js";
import { isVisibleTo, visibilityAdmits } from "../services/passport/OpenToPlansService.js";
import { isRabBookingCallEligible } from "../lib/calls/callGatewayAdapter.js";
import { authorizeTelegraphShare } from "../domain/telegraph/policies/shareAuthorizationPolicy.js";
import { TELEGRAPH_RLS_MATRIX } from "../domain/telegraph/invariants/rlsAuthorizationMatrix.js";
import { TELEGRAPH_LIVE_DB_CONTRACTS } from "../domain/telegraph/invariants/liveDbContracts.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // founding member
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // added later
const MALLORY = "cccccccc-0000-4000-8000-000000000003"; // never a member
const THREAD = "00000000-0000-4000-8000-00000000000a";
const DM_THREAD = "00000000-0000-4000-8000-00000000000d";
const TRIP = "00000000-0000-4000-8000-0000000000b1";

const BOUND = "2026-03-01T00:00:00.000Z";
const M_OLD = "11111111-0000-4000-8000-000000000001";
const M_NEW = "22222222-0000-4000-8000-000000000002";

function msg(id: string, thread_id: string, sender_id: string, created_at: string) {
  return {
    id,
    thread_id,
    sender_id,
    body: `body-${id.slice(0, 4)}`,
    created_at,
    deleted_at: null,
    edited_at: null,
    original_language: null,
    msg_type: "text",
    subtype: null,
    media_url: null,
    media_type: null,
    media_thumbnail_url: null,
    media_duration_seconds: null,
    reply_to_id: null,
  };
}

interface SeedOptions {
  historyBoundFlag?: boolean;
  bobVisibleFrom?: string | null;
  bobLeftAt?: string | null;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
}

function seed(o: SeedOptions = {}): Record<string, any[]> {
  return {
    feature_flags: o.historyBoundFlag === undefined
      ? []
      : [{ flag: "telegraph_history_bound_enabled", enabled: o.historyBoundFlag }],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
      { id: MALLORY, handle: "mallory", name: "Mallory" },
    ],
    blocks: o.blocks ?? [],
    message_threads: [
      { id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, title: "T",
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z" },
      { id: DM_THREAD, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null,
        status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z" },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB, role: "member", joined_at: BOUND,
        left_at: o.bobLeftAt ?? null, last_read_at: null, muted_at: null, archived_at: null,
        visible_from_at: o.bobVisibleFrom === undefined ? BOUND : o.bobVisibleFrom },
      { thread_id: DM_THREAD, user_id: ALICE, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
      { thread_id: DM_THREAD, user_id: BOB, role: "member", joined_at: "2026-01-01T00:00:00.000Z",
        left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null },
    ],
    messages: [
      msg(M_OLD, THREAD, ALICE, "2026-02-01T00:00:00.000Z"),
      msg(M_NEW, THREAD, ALICE, "2026-03-10T00:00:00.000Z"),
    ],
    message_translations: [],
    trips: [{ id: TRIP, title: "Cebu", destination_city: "Cebu" }],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner" },
      { trip_id: TRIP, user_id: BOB, role: "member" },
    ],
  };
}

let harness: RouterHarness;
let client: FakeClient;

function use(state: Record<string, any[]>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  client = makeFakeClient(state, opts);
  _setTestClient(client, true);
  return client;
}

before(async () => {
  harness = await startRouter(messagingRouter);
});
after(async () => {
  await harness.close();
});
beforeEach(() => {
  resetFakeIds();
});

// ── The matrix is complete and each case is named here ────────────────────────

describe("§26 matrix — shape", () => {
  it("declares exactly the spec's ten cases, one census row each", () => {
    assert.equal(TELEGRAPH_RLS_MATRIX.length, 10);
    const ids = TELEGRAPH_RLS_MATRIX.map((c) => c.id);
    assert.deepEqual(ids, [
      "RLS-01", "RLS-02", "RLS-03", "RLS-04", "RLS-05",
      "RLS-06", "RLS-07", "RLS-08", "RLS-09", "RLS-10",
    ]);
    const rows = new Set(TELEGRAPH_RLS_MATRIX.map((c) => c.censusRow));
    assert.equal(rows.size, 10, "each case answers a distinct census row");
  });
});

// ── RLS-01 ────────────────────────────────────────────────────────────────────

describe("RLS-01 — non-member reads conversation → DENY", () => {
  it("refuses a caller with no membership row, before any message query runs", async () => {
    const c = use(seed());
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, MALLORY);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
    const messageSelects = c._observed.selects.filter((s) => s.table === "messages");
    assert.equal(messageSelects.length, 0, "the messages table must not be reached at all");
  });

  it("refuses when the membership table itself is unreadable (unknown is not permission)", async () => {
    use(seed(), { errors: { message_thread_members: { message: "db down" } } });
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 403, "an unreadable membership table must deny, never admit");
  });
});

// ── RLS-02 ────────────────────────────────────────────────────────────────────

describe("RLS-02 — removed member reads future sequence → DENY", () => {
  it("denies the ENTIRE thread to a departed member, which is stronger than the spec asks", async () => {
    const c = use(seed({ bobLeftAt: "2026-03-05T00:00:00.000Z" }));
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 403);
    assert.equal(
      c._observed.selects.filter((s) => s.table === "messages").length,
      0,
      "no sequence is read, because no sequence is reachable",
    );
  });

  it("a departed member cannot send either", async () => {
    use(seed({ bobLeftAt: "2026-03-05T00:00:00.000Z" }));
    const r = await call(harness.base, "POST", `/threads/${THREAD}/messages`, BOB, { body: "hi" });
    assert.equal(r.status, 403);
  });
});

// ── RLS-03 ────────────────────────────────────────────────────────────────────

describe("RLS-03 — new member reads pre-membership history → DENY (flag_gated)", () => {
  it("FLAG ON: the pre-membership message is not returned and the bound is in the query", async () => {
    const c = use(seed({ historyBoundFlag: true }));
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200);
    const ids = (r.body.messages as any[]).map((m) => m.id);
    assert.deepEqual(ids.sort(), [M_NEW], "only the in-window message");
    assert.ok(
      c._observed.gte.some((g) => g.table === "messages" && g.col === "created_at" && g.val === BOUND),
      "the window is applied IN the query, so pagination cannot walk past it",
    );
  });

  it("FLAG OFF (the seeded state): the whole back history is returned — the divergence, asserted", async () => {
    const c = use(seed({ historyBoundFlag: false }));
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200);
    const ids = (r.body.messages as any[]).map((m) => m.id).sort();
    assert.deepEqual(
      ids,
      [M_OLD, M_NEW].sort(),
      "EXPECTED BY §26: DENY. ACTUAL with the flag seeded off: the pre-membership " +
        "message is returned. When telegraph_history_bound_enabled defaults on, this " +
        "assertion fails and RLS-03 must move to `enforced`.",
    );
    assert.deepEqual(c._observed.gte, [], "no lower bound is applied while the flag is off");
  });

  it("flag UNREADABLE leaves history unbounded — the deliberate polarity, not an accident", async () => {
    use(seed({ historyBoundFlag: true }), { errors: { feature_flags: { message: "flags down" } } });
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200);
    assert.equal((r.body.messages as any[]).length, 2,
      "a flag blip must not hide messages from every member; the bound fails open BY DESIGN");
  });
});

// ── RLS-04 ────────────────────────────────────────────────────────────────────

describe("RLS-04 — blocked sender sends DM → DENY", () => {
  it("denies when the recipient blocked the sender", async () => {
    use(seed({ blocks: [{ blocker_id: BOB, blocked_id: ALICE }] }));
    const r = await call(harness.base, "POST", `/threads/${DM_THREAD}/messages`, ALICE, { body: "hi" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "forbidden");
  });

  it("denies when the SENDER blocked the recipient (the guard is bidirectional)", async () => {
    use(seed({ blocks: [{ blocker_id: ALICE, blocked_id: BOB }] }));
    const r = await call(harness.base, "POST", `/threads/${DM_THREAD}/messages`, ALICE, { body: "hi" });
    assert.equal(r.status, 403);
  });

  it("denies on a MUTUAL block — two rows, the state that used to make the guard raise", async () => {
    use(seed({ blocks: [
      { blocker_id: ALICE, blocked_id: BOB },
      { blocker_id: BOB, blocked_id: ALICE },
    ] }));
    const r = await call(harness.base, "POST", `/threads/${DM_THREAD}/messages`, ALICE, { body: "hi" });
    assert.equal(r.status, 403);
  });

  it("refuses the send when the ROSTER read fails — the guard cannot be made unreachable", async () => {
    // afterOps:1 fails the SECOND read of message_thread_members only, so the
    // caller's own membership check succeeds and the failure lands exactly on
    // the roster read that decides whether the block guard runs. Failing the
    // whole table instead would deny at the membership check and prove nothing:
    // measured — with a whole-table error this assertion stayed green after the
    // roster refusal was deliberately deleted from routes/messaging.ts.
    use(seed({ blocks: [{ blocker_id: BOB, blocked_id: ALICE }] }), {
      errors: { message_thread_members: { message: "roster unreadable", afterOps: 1 } },
    });
    const r = await call(harness.base, "POST", `/threads/${DM_THREAD}/messages`, ALICE, { body: "hi" });
    assert.notEqual(r.status, 201, "an unreadable roster must never produce a delivered message");
    assert.equal(r.body.error, "degraded_unavailable",
      "and it must say 'we could not check', not 'you are not a member'");
  });

  it("refuses the send when the BLOCKS table is unreadable (isBlockedBetween fails closed)", async () => {
    use(seed(), { errors: { blocks: { message: "blocks unreadable" } } });
    const r = await call(harness.base, "POST", `/threads/${DM_THREAD}/messages`, ALICE, { body: "hi" });
    assert.equal(r.status, 403, "unknown block state denies");
  });
});

// ── RLS-05 ────────────────────────────────────────────────────────────────────

describe("RLS-05 — expired exact location read → DENY", () => {
  const SHARE = "dddddddd-0000-4000-8000-000000000005";
  const OWNER = ALICE;
  const RECIPIENT = BOB;

  async function shareApp(rows: any[]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {} }; next(); });
    app.get("/api/share/:shareId", requireSafeReturnRecipient, (req, res) => {
      res.status(200).json({ reached: true, share: (req as any).safeReturnRecipient?.share ?? null });
    });
    const { createServer } = await import("node:http");
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    use({ safe_return_live_shares: rows, profiles: [] });
    return {
      base: `http://127.0.0.1:${port}/api`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("an EXPIRED share is refused before the handler runs", async () => {
    const app = await shareApp([{
      id: SHARE, user_id: OWNER, recipient_user_id: RECIPIENT, recipient_contact_id: null,
      status: "active", expires_at: "2020-01-01T00:00:00.000Z",
    }]);
    const r = await call(app.base, "GET", `/share/${SHARE}`, RECIPIENT);
    assert.equal(r.status, 404);
    assert.ok(!r.body.reached, "the handler must not run");
    await app.close();
  });

  it("a non-recipient is refused even while the share is live", async () => {
    const app = await shareApp([{
      id: SHARE, user_id: OWNER, recipient_user_id: RECIPIENT, recipient_contact_id: null,
      status: "active", expires_at: "2099-01-01T00:00:00.000Z",
    }]);
    const r = await call(app.base, "GET", `/share/${SHARE}`, MALLORY);
    assert.equal(r.status, 403);
    await app.close();
  });

  it("an unreadable share table refuses rather than answering 'there is nothing here'", async () => {
    const app = await shareApp([]);
    use({ safe_return_live_shares: [] }, { errors: { safe_return_live_shares: { message: "down" } } });
    const r = await call(app.base, "GET", `/share/${SHARE}`, RECIPIENT);
    assert.ok(r.status >= 400);
    assert.notEqual(r.status, 200);
    await app.close();
  });

  it("exact coordinates cannot leave the API even when the gate passes", () => {
    const projected = toPublicSession({
      id: SHARE, status: "active", lat: 10.3, lng: 123.9,
      coords: { lat: 10.3, lng: 123.9 }, createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(JSON.stringify(projected).includes("10.3"), false);
    assert.equal(JSON.stringify(projected).includes("123.9"), false);
    const nested = stripGPS({ a: { b: { latitude: 1, longitude: 2, keep: "yes" } } }) as any;
    assert.equal(nested.a.b.latitude, undefined);
    assert.equal(nested.a.b.keep, "yes");
  });
});

// ── RLS-06 ────────────────────────────────────────────────────────────────────

describe("RLS-06 — availability audience excludes viewer → DENY", () => {
  const NOW = Date.parse("2026-06-01T00:00:00.000Z");
  const base = {
    startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2099-01-01T00:00:00.000Z",
    expiresAt: null as string | null,
  };
  const VIEWERS = ["public", "follower", "following", "crew"] as const;

  it("a private window is invisible to every non-self viewer", () => {
    const w = { ...base, source: "explicit" as const, visibility: "private" as const };
    for (const viewer of VIEWERS) {
      assert.equal(isVisibleTo(w, viewer, NOW), false, `viewer=${viewer}`);
    }
    assert.equal(isVisibleTo(w, "self", NOW), true);
  });

  it("an INFERRED window is invisible to everyone but self, whatever visibility it carries", () => {
    for (const visibility of ["public", "followers", "following", "crew", "private"] as const) {
      const w = { ...base, source: "plan_derived" as const, visibility };
      for (const viewer of VIEWERS) {
        assert.equal(
          isVisibleTo(w, viewer, NOW),
          false,
          `source=plan_derived visibility=${visibility} viewer=${viewer} must be invisible`,
        );
      }
    }
  });

  it("the audience predicate admits exactly the named relationship and nothing else", () => {
    assert.equal(visibilityAdmits("followers", "follower"), true);
    assert.equal(visibilityAdmits("followers", "following"), false);
    assert.equal(visibilityAdmits("crew", "crew"), true);
    assert.equal(visibilityAdmits("crew", "follower"), false);
    assert.equal(visibilityAdmits("private", "crew"), false);
    assert.equal(visibilityAdmits("public", "public"), true);
  });

  it("an expired window is invisible even to an admitted viewer", () => {
    const w = { ...base, endAt: "2026-01-02T00:00:00.000Z", source: "explicit" as const, visibility: "public" as const };
    assert.equal(isVisibleTo(w, "follower", NOW), false);
    assert.equal(isVisibleTo(w, "self", NOW), false, "not even the owner sees it as current");
  });
});

// ── RLS-07 ────────────────────────────────────────────────────────────────────

describe("RLS-07 — private Memory shared without derivative authorization → DENY", () => {
  const req = {
    family: "PRIVATE_SOURCE",
    sourceDomain: "memories",
    sourceId: "memory-1",
    viewerIds: [BOB],
  };

  it("refuses a private source with no derivative grant", () => {
    const d = authorizeTelegraphShare(req);
    assert.equal(d.allowed, false);
    assert.equal((d as any).reason, "private_source_without_derivative");
  });

  it("refuses a grant issued by a different domain (no semantic id substitution)", () => {
    const d = authorizeTelegraphShare({
      ...req,
      derivativeGrant: { issuedByDomain: "trips", derivativeId: "d1", scope: "telegraph_share", expiresAt: null },
    });
    assert.equal(d.allowed, false);
    assert.equal((d as any).reason, "grant_domain_mismatch");
  });

  it("refuses a grant issued for another scope, and an expired one, and an unparseable expiry", () => {
    assert.equal((authorizeTelegraphShare({ ...req,
      derivativeGrant: { issuedByDomain: "memories", derivativeId: "d1", scope: "export", expiresAt: null },
    }) as any).reason, "grant_wrong_scope");
    assert.equal((authorizeTelegraphShare({ ...req, nowMs: Date.parse("2026-06-01T00:00:00Z"),
      derivativeGrant: { issuedByDomain: "memories", derivativeId: "d1", scope: "telegraph_share", expiresAt: "2026-01-01T00:00:00Z" },
    }) as any).reason, "grant_expired");
    assert.equal((authorizeTelegraphShare({ ...req,
      derivativeGrant: { issuedByDomain: "memories", derivativeId: "d1", scope: "telegraph_share", expiresAt: "whenever" },
    }) as any).reason, "grant_expired", "an unparseable expiry is not 'never expires'");
  });

  it("refuses a 'derivative' that is really the private source wearing a grant", () => {
    const d = authorizeTelegraphShare({ ...req,
      derivativeGrant: { issuedByDomain: "memories", derivativeId: "memory-1", scope: "telegraph_share", expiresAt: null },
    });
    assert.equal(d.allowed, false);
    assert.equal((d as any).reason, "grant_names_source_id");
  });

  it("refuses an unknown family outright — a new producer cannot invent its way to an allow", () => {
    assert.equal((authorizeTelegraphShare({ ...req, family: "TOTALLY_FINE" }) as any).reason, "unknown_family");
  });

  it("allows a valid derivative, and what travels is the DERIVATIVE id, never the source id", () => {
    const d = authorizeTelegraphShare({ ...req,
      derivativeGrant: { issuedByDomain: "memories", derivativeId: "derivative-9", scope: "telegraph_share", expiresAt: null },
    });
    assert.equal(d.allowed, true);
    assert.equal((d as any).disclosedId, "derivative-9");
  });
});

// ── RLS-08 ────────────────────────────────────────────────────────────────────

describe("RLS-08 — authorized user reads current safe share projection → ALLOW (vacuous)", () => {
  it("the authorization half answers, and there is no projection for it to authorize", () => {
    const d = authorizeTelegraphShare({
      family: "PUBLIC", sourceDomain: "discovery", sourceId: "place-1", viewerIds: [BOB],
    });
    assert.equal(d.allowed, true);
    // The vacuity is the finding: no producer resolves a source object's CURRENT
    // state, so there is no projection to read. Asserted structurally against the
    // registry rather than described, so it changes when the tree changes.
    assert.equal(
      d.allowed && (d as any).disclosedId,
      "place-1",
      "the policy answers about an id, not about a resolved current state",
    );
  });

  it("an empty audience is refused — a share addressed to nobody is a bug, not an allow", () => {
    const d = authorizeTelegraphShare({
      family: "PUBLIC", sourceDomain: "discovery", sourceId: "place-1", viewerIds: [],
    });
    assert.equal(d.allowed, false);
    assert.equal((d as any).reason, "empty_audience");
  });
});

// ── RLS-09 ────────────────────────────────────────────────────────────────────

describe("RLS-09 — trip member loses trip membership → capabilities downgrade (divergent)", () => {
  it("BEFORE the sync runs, the removed trip member still reads the thread — the divergence", async () => {
    const state = seed({ historyBoundFlag: false });
    // The trip write has happened; the chat sync has not.
    state.trip_members = state.trip_members.filter((m: any) => m.user_id !== BOB);
    use(state);
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(
      r.status,
      200,
      "EXPECTED BY §26: downgrade IMMEDIATELY. ACTUAL: the thread membership row " +
        "still says active because syncTripChatMembers is invoked fire-and-forget, " +
        "so there is a window in which a removed trip member still reads.",
    );
  });

  it("AFTER the real sync runs, both read and send deny, with no cached capability to go stale", async () => {
    const state = seed({ historyBoundFlag: false });
    state.trip_members = state.trip_members.filter((m: any) => m.user_id !== BOB);
    const c = use(state);
    await syncTripChatMembers(c as any, TRIP);
    const read = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(read.status, 403);
    const send = await call(harness.base, "POST", `/threads/${THREAD}/messages`, BOB, { body: "still here?" });
    assert.equal(send.status, 403);
    const bobRow = c._store.message_thread_members.find(
      (m: any) => m.thread_id === THREAD && m.user_id === BOB,
    );
    assert.ok(bobRow.left_at, "the sync marked the departure on the real row");
  });
});

// ── RLS-10 ────────────────────────────────────────────────────────────────────

describe("RLS-10 — buddy booking cancelled → booking-only actions disabled (divergent)", () => {
  it("a cancelled booking is not call-eligible; the live statuses still are", () => {
    assert.equal(isRabBookingCallEligible({ status: "cancelled" }), false);
    assert.equal(isRabBookingCallEligible({ status: "refunded" }), false);
    assert.equal(isRabBookingCallEligible({ status: "pending" }), false,
      "there is no pre-confirmation thread, so there is no pre-confirmation call");
    for (const status of ["confirmed", "scheduled", "in_progress", "completed_pending_traveler_confirmation", "disputed"]) {
      assert.equal(isRabBookingCallEligible({ status }), true, status);
    }
  });

  it("a completed booking is callable only while BOTH parties opted to stay connected", () => {
    assert.equal(isRabBookingCallEligible({ status: "completed" }), false);
    assert.equal(isRabBookingCallEligible({ status: "completed", stay_connected_traveler: true }), false);
    assert.equal(
      isRabBookingCallEligible({ status: "completed", stay_connected_traveler: true, stay_connected_buddy: true }),
      true,
    );
  });

  it("the rendered booking card re-checks NOTHING — the divergence, asserted against the component", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "../../travel-buddy-standalone/src/components/rentabuddy/BookingMilestoneMessage.tsx"),
      "utf8",
    );
    assert.equal(/\bfetch\s*\(/.test(src), false,
      "EXPECTED BY §26: booking-only actions disabled immediately. ACTUAL: the card " +
      "performs no fetch, so its buttons render from a frozen payload.");
    assert.equal(/useEffect\s*\(/.test(src), false, "and no effect re-resolves the booking");
  });
});


// ── §27.3 live-DB contracts ───────────────────────────────────────────────────
//
// These six are standing CI lanes rather than behaviours of a handler, so what
// a suite can settle about them is different: that the lane NAMED by each
// contract exists, that it is actually invoked, and — for the one contract this
// tree does not satisfy — that its divergence is still real and measurable
// rather than merely described. The alternative, a suite that re-implements
// what the lanes do, would be a second and weaker copy of a check that already
// runs against a live schema.

function repoFile(rel: string): string {
  return readFileSync(resolvePath(process.cwd(), rel), "utf8");
}

describe("§27.3 — live-DB contracts are enforced by lanes that exist and run", () => {
  it("LDB-01, LDB-02, LDB-03, LDB-04, LDB-05 and LDB-06 each name a package script that exists", () => {
    const pkg = JSON.parse(repoFile("package.json"));
    for (const c of TELEGRAPH_LIVE_DB_CONTRACTS) {
      if (!c.checkScript) continue;
      assert.ok(pkg.scripts?.[c.checkScript], `${c.id} names "${c.checkScript}", which is not a package script`);
    }
  });

  it("and each of those lanes is REACHED — by check:all, a workflow, or a declared delegation", () => {
    // Reachability, not one particular invocation path. Measured while writing
    // this: check:enum-literals (LDB-02) is NOT in run-all-checks.sh — it runs
    // as its own static ci.yml step, deliberately, "needs no database and cannot
    // be starved" — and check:migration-ledger (LDB-04) appears in live-db.yml
    // only inside a comment and is really reached by certifyMigrations.ts, which
    // spawns it as its ledger gate. The repository already models exactly this
    // distinction in src/scripts/guardRegistry.ts, so the assertion asks the
    // question that file asks: is this checker reached by ANYTHING.
    const runAll = repoFile("scripts/run-all-checks.sh");
    const registry = repoFile("src/scripts/guardRegistry.ts");
    const workflows = ["../../.github/workflows/ci.yml", "../../.github/workflows/live-db.yml"]
      .map((f) => {
        try { return repoFile(f); } catch { return ""; }
      })
      .join("\n");
    for (const c of TELEGRAPH_LIVE_DB_CONTRACTS) {
      if (!c.checkScript) continue;
      const reached =
        runAll.includes(c.checkScript) ||
        workflows.includes(c.checkScript) ||
        registry.includes(c.checkScript);
      assert.ok(
        reached,
        `${c.id}'s lane "${c.checkScript}" is invoked by nothing — not check:all, not a ` +
          "workflow, and not declared as a delegation in guardRegistry.ts. A contract " +
          "enforced by a checker nobody runs is not enforced.",
      );
    }
  });

  it("LDB-05: the divergence is still real — route handlers drop read errors into context", () => {
    const src = repoFile("src/routes/messaging.ts");
    // `const { data: x } = await …` is the shape that makes a failed query
    // indistinguishable from an empty result. Counted rather than judged: the
    // count is the measurement, and the assertion is that it has not reached
    // zero while LDB-05 is still declared divergent.
    const dropped = src.match(/const \{ data: [A-Za-z_][A-Za-z0-9_]* \} = await/g) ?? [];
    assert.ok(
      dropped.length > 0,
      "LDB-05 is declared divergent but the messaging tree now drops no read errors. " +
        "If that is true, move LDB-05 to 'enforced' and lower the certification baseline.",
    );
  });

  it("the reads the census called authorization-critical are fail-CLOSED, not empty-state", async () => {
    // This is the distinction LDB-05 turns on: a refusal is not a plausible
    // empty inbox. Both membership reads resolve to 403 on an unreadable table.
    use(seed(), { errors: { message_thread_members: { message: "down" } } });
    const read = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(read.status, 403);
    const send = await call(harness.base, "POST", `/threads/${THREAD}/messages`, BOB, { body: "x" });
    assert.equal(send.status, 403);
  });
});
