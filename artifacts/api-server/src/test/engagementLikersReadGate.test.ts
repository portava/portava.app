/**
 * engagementLikersReadGate — GET /api/engagement/likes?targetType=memory_like (and highlight_like)
 * answers whether a Memory's likers may be listed with the Memory's OWN read
 * decision, the one GET /memories/:id makes (census-highlights-memories §BQ).
 *
 * ── THE DEFECT (found by B58 lane MEM-ACL-2, "Adjacent finding") ─────────────
 * The route's gate for `memory_like` was
 *
 *     .from("memories").select("id, owner_id, visibility").eq("id", targetId).maybeSingle();
 *     return v.owner_id === viewerId || v.visibility === "public";
 *
 * It read no `state`, no `hidden_user_ids` and no `blocks`. So the likers of a
 * MODERATOR-REMOVED public Memory, of a DRAFT or DELETED one, of one whose owner
 * HID it from this viewer, and of one whose owner and viewer had BLOCKED each
 * other were all listable — while GET /memories/:id answered every one of those
 * `404 not_found`. The likers route was a door into a Memory the Memory's own
 * read refuses.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *  1. Every state GET /memories/:id refuses, this route refuses with the SAME
 *     404 body — measured against the real GET /memories/:id on the same seed,
 *     not against a copy of its rule.
 *  2. A missing Memory and an unreadable one get byte-identical answers, so the
 *     gate is no existence oracle.
 *  3. A reader of a NON-public Memory (a mutual follower of a friends_only one)
 *     is NOT newly admitted: the old owner-only rule for non-public Memories is
 *     kept (403, which reveals nothing — that reader may read the Memory). That
 *     is the fail-closed default; whether such a reader may see the likers is an
 *     owner question, not a widening this fix takes.
 *  4. An unreadable `memories` read REFUSES (503) — never admits and never
 *     answers not_found — and an unreadable block read at the gate DENIES with
 *     the 404 GET /memories/:id gives (its isBlocked fails closed).
 *  5. The roster's own block read is still reached and still refuses when it
 *     fails, for a non-owner who passed the gate.
 *
 * The SAME shape held for `highlight_like` (owner || public over id, owner_id,
 * visibility), and the second half of this file holds it to the Highlight's own
 * engagement gate (`decideHighlightViewAccess`), measured against the real
 * GET /highlights/:id/actions, which sits behind that gate.
 *
 * Every case drives the real app (app.js) over the fail-closed PostgREST double.
 *
 * Run: node --import tsx/esm --test src/test/engagementLikersReadGate.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { makeFailClosedClient, type FakeReadContext, type FakeDbError } from "./helpers/failClosedSupabase.js";

const VIEWER = "00000000-0000-0000-0000-0000000000a1";
const OWNER = "00000000-0000-0000-0000-0000000000a2";
const LIKER = "00000000-0000-0000-0000-0000000000a3";
const MEM = "20000000-0000-0000-0000-000000000001";
const MISSING = "20000000-0000-0000-0000-0000000000ff";
const HL = "30000000-0000-0000-0000-000000000001";
const HL_MISSING = "30000000-0000-0000-0000-0000000000ff";
const TOKEN = "tok-mlg-viewer";
const OWNER_TOKEN = "tok-mlg-owner";

const FAIL: FakeDbError = { message: "connection terminated unexpectedly", code: "57P01" };

interface SeedOpts {
  /** Overrides on the one Memory; `null` = the Memory does not exist. */
  memory?: Record<string, unknown> | null;
  /** Overrides on the one Highlight; `null` = it does not exist. */
  highlight?: Record<string, unknown> | null;
  /** §11 owner controls (highlight_resurfacing_preferences rows). */
  controls?: Array<Record<string, unknown>>;
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  follows?: Array<{ follower_id: string; following_id: string }>;
  failOn?: (c: FakeReadContext) => FakeDbError | null;
}

function client(o: SeedOpts = {}) {
  const profile = (id: string, username: string) => ({
    id, username, handle: username, name: username, display_name: username, avatar_url: null,
    account_status: "active", verified: false, is_private: false,
  });
  return makeFailClosedClient({
    rows: {
      profiles: [profile(VIEWER, "viewer"), profile(OWNER, "owner"), profile(LIKER, "liker")],
      memories: o.memory === null ? [] : [{
        id: MEM, owner_id: OWNER, visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
        trip_id: null, state: "published", title: "Lisbon", caption: null,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        ...(o.memory ?? {}),
      }],
      // A real liker: without one, an empty roster would be the true answer anyway.
      memory_likes: [{ memory_id: MEM, user_id: LIKER, created_at: "2026-01-02T00:00:00Z" }],
      highlights: o.highlight === null ? [] : [{
        id: HL, owner_id: OWNER, visibility: "public", expires_at: "2099-01-01T00:00:00Z",
        deleted_at: null, archived_at: null, created_at: "2026-01-01T00:00:00Z",
        ...(o.highlight ?? {}),
      }],
      highlight_likes: [{ highlight_id: HL, user_id: LIKER, created_at: "2026-01-02T00:00:00Z" }],
      highlight_resurfacing_preferences: o.controls ?? [],
      highlight_projection_policies: [],
      circle_memberships: [],
      blocks: o.blocks ?? [],
      user_follows: o.follows ?? [],
      friend_requests: [],
      profile_privacy_settings: [],
    },
    users: { [TOKEN]: VIEWER, [OWNER_TOKEN]: OWNER },
    failOn: o.failOn ?? (() => null),
  });
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function call(path: string, token = TOKEN): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}`, connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const likers = (id = MEM, token = TOKEN) => call(`/api/engagement/likes?targetType=memory_like&targetId=${id}`, token);
const memoryRead = (id = MEM, token = TOKEN) => call(`/api/memories/${id}`, token);

/** The states GET /memories/:id refuses a non-owner, each one listable through this route before the fix. */
const REFUSED: Array<{ name: string; seed: SeedOpts }> = [
  { name: "moderator-removed public Memory (state 'removed')", seed: { memory: { state: "removed" } } },
  { name: "DRAFT public Memory (state 'draft')", seed: { memory: { state: "draft" } } },
  { name: "deleted public Memory (state 'deleted')", seed: { memory: { state: "deleted" } } },
  { name: "public Memory whose owner hid it from this viewer (hidden_user_ids)", seed: { memory: { hidden_user_ids: [VIEWER] } } },
  { name: "public Memory whose OWNER blocked the viewer", seed: { blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }] } },
  { name: "public Memory whose owner the VIEWER blocked", seed: { blocks: [{ blocker_id: VIEWER, blocked_id: OWNER }] } },
  { name: "friends_only Memory, viewer not a mutual follower", seed: { memory: { visibility: "friends_only" } } },
  { name: "only_me Memory", seed: { memory: { visibility: "only_me" } } },
];

describe("§BQ the likers of a Memory are listable only when the Memory itself is readable", () => {
  it("CONTROL: a published public Memory's likers are listed to a stranger (the fixture CAN produce one)", async () => {
    _setTestClient(client(), true);
    const r = await likers();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER]);
    assert.notEqual((await memoryRead()).status, 404, "and the Memory itself is readable to this viewer");
  });

  for (const c of REFUSED) {
    it(`${c.name}: GET /memories/:id refuses it, and so does the likers route, with the SAME 404 body`, async () => {
      _setTestClient(client(c.seed), true);
      const mem = await memoryRead();
      assert.equal(mem.status, 404, `premise: the Memory read refuses this state (${JSON.stringify(mem.body)})`);
      const r = await likers();
      assert.equal(r.status, 404, `the likers of a Memory this viewer cannot read were served: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, mem.body, "the likers route answers exactly as the Memory read does");
      assert.equal(r.body.users, undefined, "no roster");
    });
  }

  it("NO EXISTENCE ORACLE: a Memory that does not exist and one this viewer cannot read get byte-identical answers", async () => {
    _setTestClient(client({ memory: null }), true);
    const missing = await likers(MISSING);
    const missingMem = await memoryRead(MISSING);
    _setTestClient(client({ memory: { state: "removed" } }), true);
    const removed = await likers();
    _setTestClient(client({ blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }] }), true);
    const blocked = await likers();
    assert.equal(missing.status, 404);
    assert.deepEqual(missing, removed);
    assert.deepEqual(missing, blocked);
    assert.deepEqual(missing.body, missingMem.body, "and the same body GET /memories/:id gives a missing Memory");
  });

  it("the OWNER still lists the likers of their own moderator-removed Memory, as GET /memories/:id still serves it to them", async () => {
    _setTestClient(client({ memory: { state: "removed" } }), true);
    const r = await likers(MEM, OWNER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER]);
  });

  it("the OWNER still lists the likers of their own only_me Memory (main's owner rule, kept)", async () => {
    _setTestClient(client({ memory: { visibility: "only_me" } }), true);
    const r = await likers(MEM, OWNER_TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER]);
  });

  it("a DELETED Memory is gone for its owner too, exactly as GET /memories/:id answers its owner", async () => {
    _setTestClient(client({ memory: { state: "deleted" } }), true);
    const mem = await memoryRead(MEM, OWNER_TOKEN);
    assert.equal(mem.status, 404, `premise: the owner's own read refuses a deleted Memory (${JSON.stringify(mem.body)})`);
    const r = await likers(MEM, OWNER_TOKEN);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual(r.body, mem.body);
  });

  it("NOT WIDENED: a mutual follower who may read a friends_only Memory still gets main's 403, not its likers (owner question)", async () => {
    _setTestClient(client({
      memory: { visibility: "friends_only" },
      follows: [{ follower_id: OWNER, following_id: VIEWER }, { follower_id: VIEWER, following_id: OWNER }],
    }), true);
    assert.notEqual((await memoryRead()).status, 404, "premise: this viewer may read the Memory");
    const r = await likers();
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.users, undefined);
  });
});

describe("§BQ fail closed on every read the gate makes", () => {
  it("an unreadable `memories` REFUSES with 503 — it neither admits nor claims the Memory is missing", async () => {
    _setTestClient(client({ failOn: (c) => (c.table === "memories" ? FAIL : null) }), true);
    const r = await likers();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.users, undefined);
  });

  it("an unreadable block read AT THE GATE denies with GET /memories/:id's own 404 (isBlocked fails closed)", async () => {
    // Only the gate's pair read (eq + eq) fails; the roster's scoped read (`.in`) stays healthy,
    // so a 404 here can only come from the gate.
    const gateBlocksFail = (c: FakeReadContext) =>
      c.table === "blocks" && !c.filters.some((f) => f.op === "in") ? FAIL : null;
    _setTestClient(client({ failOn: gateBlocksFail }), true);
    const mem = await memoryRead();
    const r = await likers();
    assert.equal(mem.status, 404, `premise: the Memory read denies on an unreadable block read (${JSON.stringify(mem.body)})`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual(r.body, mem.body);
  });

  it("the ROSTER's block read is still reached by a non-owner who passed the gate, and still refuses when it fails", async () => {
    const rosterBlocksFail = (c: FakeReadContext) =>
      c.table === "blocks" && c.filters.some((f) => f.op === "in") ? FAIL : null;
    _setTestClient(client({ failOn: rosterBlocksFail }), true);
    const r = await likers();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.message, "Could not verify who is blocked. Please try again.", "the roster's refusal, not the gate's");
  });

  it("the roster still drops a liker the viewer blocked (the list's own block filter is unchanged)", async () => {
    _setTestClient(client({ blocks: [{ blocker_id: VIEWER, blocked_id: LIKER }] }), true);
    const r = await likers();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.users, []);
  });
});

// ── highlight_like: the same door, the Highlight's own gate ─────────────────────

const hlLikers = (id = HL, token = TOKEN) => call(`/api/engagement/likes?targetType=highlight_like&targetId=${id}`, token);
/** Read-only, and behind `resolveViewAccess` — the gate in front of every Highlight engagement route. */
const hlGate = (id = HL, token = TOKEN) => call(`/api/highlights/${id}/actions`, token);

const HL_REFUSED: Array<{ name: string; seed: SeedOpts }> = [
  { name: "DELETED public Highlight (deleted_at set)", seed: { highlight: { deleted_at: "2026-01-05T00:00:00Z" } } },
  { name: "EXPIRED public Highlight", seed: { highlight: { expires_at: "2026-01-02T00:00:00Z" } } },
  { name: "ARCHIVED public Highlight", seed: { highlight: { archived_at: "2026-01-05T00:00:00Z" } } },
  {
    name: "public Highlight its owner set KEEP_PRIVATE_FOREVER (§11)",
    seed: { controls: [{ id: "c1", owner_id: OWNER, control: "KEEP_PRIVATE_FOREVER", subject_type: "highlight", subject_id: HL }] },
  },
  { name: "public Highlight whose OWNER blocked the viewer", seed: { blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }] } },
  { name: "public Highlight whose owner the VIEWER blocked", seed: { blocks: [{ blocker_id: VIEWER, blocked_id: OWNER }] } },
  { name: "private Highlight", seed: { highlight: { visibility: "private" } } },
];

describe("§BQ the likers of a Highlight are listable only through the Highlight's own engagement gate", () => {
  it("CONTROL: a live public Highlight's likers are listed to a stranger, and its gate admits them", async () => {
    _setTestClient(client(), true);
    const r = await hlLikers();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER]);
    assert.notEqual((await hlGate()).status, 404, "and the Highlight's gate admits this viewer");
  });

  for (const c of HL_REFUSED) {
    it(`${c.name}: the Highlight's gate refuses it, and so does the likers route, with the SAME 404 body`, async () => {
      _setTestClient(client(c.seed), true);
      const gate = await hlGate();
      assert.equal(gate.status, 404, `premise: the Highlight's gate refuses this state (${JSON.stringify(gate.body)})`);
      const r = await hlLikers();
      assert.equal(r.status, 404, `the likers of a Highlight this viewer cannot reach were served: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, gate.body, "the likers route answers exactly as the Highlight's gate does");
      assert.equal(r.body.users, undefined, "no roster");
    });
  }

  it("NO EXISTENCE ORACLE: a missing Highlight and an unreachable one get byte-identical answers", async () => {
    _setTestClient(client({ highlight: null }), true);
    const missing = await hlLikers(HL_MISSING);
    const missingGate = await hlGate(HL_MISSING);
    _setTestClient(client({ highlight: { deleted_at: "2026-01-05T00:00:00Z" } }), true);
    const deleted = await hlLikers();
    _setTestClient(client({ blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }] }), true);
    const blocked = await hlLikers();
    assert.equal(missing.status, 404);
    assert.deepEqual(missing, deleted);
    assert.deepEqual(missing, blocked);
    assert.deepEqual(missing.body, missingGate.body, "and the gate's own body for a missing Highlight");
  });

  it("the OWNER still lists the likers of their own expired, archived or private Highlight (main's rule; GET /highlights/:id/viewers' rule)", async () => {
    for (const over of [{ expires_at: "2026-01-02T00:00:00Z" }, { archived_at: "2026-01-05T00:00:00Z" }, { visibility: "private" }]) {
      _setTestClient(client({ highlight: over }), true);
      const r = await hlLikers(HL, OWNER_TOKEN);
      assert.equal(r.status, 200, `${JSON.stringify(over)}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.users.map((u: any) => u.id), [LIKER]);
    }
  });

  it("NOT WIDENED: a viewer the gate admits to a non-public Highlight (travelers_nearby) still gets main's 403", async () => {
    _setTestClient(client({ highlight: { visibility: "travelers_nearby" } }), true);
    assert.notEqual((await hlGate()).status, 404, "premise: the gate admits this viewer");
    const r = await hlLikers();
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "forbidden");
  });

  it("an unreadable `highlights` REFUSES with 503 — it neither admits nor claims the Highlight is missing", async () => {
    _setTestClient(client({ failOn: (c) => (c.table === "highlights" ? FAIL : null) }), true);
    const r = await hlLikers();
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("an unreadable block read AT THE GATE denies with the gate's own 404", async () => {
    const gateBlocksFail = (c: FakeReadContext) =>
      c.table === "blocks" && !c.filters.some((f) => f.op === "in") ? FAIL : null;
    _setTestClient(client({ failOn: gateBlocksFail }), true);
    const gate = await hlGate();
    const r = await hlLikers();
    assert.equal(gate.status, 404, `premise: the gate denies on an unreadable block read (${JSON.stringify(gate.body)})`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual(r.body, gate.body);
  });

  it("unreadable §11 owner controls withhold, as the gate does (a refusal we cannot see is not overridden)", async () => {
    _setTestClient(client({ failOn: (c) => (c.table === "highlight_resurfacing_preferences" && !c.filters.some((f) => f.col === "id") ? FAIL : null) }), true);
    const gate = await hlGate();
    const r = await hlLikers();
    assert.equal(gate.status, 404, `premise: ${JSON.stringify(gate.body)}`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.deepEqual(r.body, gate.body);
  });
});
