/**
 * Telegraph §5 — the share contract, and §5.3's revocation.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §5    one consistent share contract for all eligible Portava content
 *   §5.1  interface TelegraphShareable — getSharePreview / getCurrentState /
 *          getAvailableActions / getDeepLink
 *   §5.2  four layers, of which the third is "what the recipient is CURRENTLY
 *          authorized to see"
 *   §5.3  "If the source becomes deleted, private or unauthorized, the
 *          Telegraph reference must degrade to an unavailable state. Telegraph
 *          is never a backdoor into revoked source content."
 *   §6.2  the PORTAVA_OBJECT message kind
 *
 * THE DEFECT UNDER TEST. Shared cards were frozen snapshots — the sender's
 * JSON, rendered forever, with no refetch and no authorization call. The
 * assertions below are about the thing that makes that impossible: an
 * unavailable reference carries `projection: null`, `actions: []` and NOTHING
 * from the source row. A test that only checked `available === false` would
 * pass on an implementation that still handed back the title.
 *
 * SHOWN RED before commit, each reverted:
 *   • `loadPost` returning AVAILABLE regardless of `deleted_at` →
 *     "a deleted post degrades" RED (pass 31 / fail 3).
 *   • the backdoor, which takes TWO edits to open because the design closes it
 *     twice: `loadPost` building a projection for the deleted row AND
 *     `resolveShareProjections` carrying it on the unavailable branch →
 *     "AN UNAVAILABLE REFERENCE CARRIES NOTHING" RED (pass 32 / fail 2).
 *     Carrying the projection through ALONE stays green, because a loader
 *     never constructs one for an object it is refusing — that redundancy is
 *     deliberate and this mutation is how it was measured.
 *   • dropping the sender-side `getCurrentState` check in POST /share →
 *     "you may not share what you cannot open" RED (pass 33 / fail 1).
 *   • all nine `if (error)` guards in shareables.ts disabled →
 *     the four fail-closed tests RED (pass 30 / fail 4).
 *
 * Run: node --import tsx/esm --test src/test/telegraphShare.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import {
  buildPortavaObjectBody,
  deepLinkFor,
  isShareable,
  parsePortavaObjectBody,
  resolveShareProjections,
  shareActionsFor,
  shareableFor,
  SHAREABLE_OBJECT_TYPES,
} from "../services/telegraph/shareables.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const THREAD = "dddddddd-0000-4000-8000-00000000000d"; // Alice + Bob
const THREAD_E2EE = "dddddddd-0000-4000-8000-00000000000e";
const THREAD_NONE = "dddddddd-0000-4000-8000-00000000000f"; // Alice is not a member

const POST_OK = "11110000-0000-4000-8000-000000000001";
const POST_DELETED = "11110000-0000-4000-8000-000000000002";
const POST_PRIVATE = "11110000-0000-4000-8000-000000000003";
const TRIP_PRIVATE = "22220000-0000-4000-8000-000000000001";
const TRIP_MEMBER = "22220000-0000-4000-8000-000000000002";
const EVENT_DRAFT = "33330000-0000-4000-8000-000000000001";
const MEETUP_UNINVITED = "44440000-0000-4000-8000-000000000001";
const GEM_PENDING = "55550000-0000-4000-8000-000000000001";
const GEM_ACTIVE = "55550000-0000-4000-8000-000000000002";
const MEMORY_FRIENDS = "66660000-0000-4000-8000-000000000001";
const MEMORY_PUBLIC = "66660000-0000-4000-8000-000000000002";
const PROFILE_BLOCKED = CAROL;
const BOOKING_OTHER = "77770000-0000-4000-8000-000000000001";

interface State {
  errorTable?: string;
  killSwitch?: boolean;
  blocked?: boolean;
}

function fixture(state: State): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "disable_messaging", enabled: state.killSwitch === true }],
    message_threads: [
      { id: THREAD, is_e2ee: false },
      { id: THREAD_E2EE, is_e2ee: true },
      { id: THREAD_NONE, is_e2ee: false },
    ],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null },
      { thread_id: THREAD_E2EE, user_id: ALICE, left_at: null },
      { thread_id: THREAD_E2EE, user_id: BOB, left_at: null },
      { thread_id: THREAD_NONE, user_id: BOB, left_at: null },
      { thread_id: THREAD_NONE, user_id: CAROL, left_at: null },
    ],
    messages: [],
    blocks: state.blocked ? [{ blocker_id: BOB, blocked_id: ALICE }] : [],
    posts: [
      { id: POST_OK, author_id: BOB, content: "A bar with no sign", visibility: "public", status: "active", deleted_at: null, media_urls: ["https://x/1.jpg"], updated_at: "2026-05-01T00:00:00.000Z" },
      { id: POST_DELETED, author_id: BOB, content: "Gone", visibility: "public", status: "deleted", deleted_at: "2026-05-02T00:00:00.000Z", media_urls: [], updated_at: "2026-05-02T00:00:00.000Z" },
      { id: POST_PRIVATE, author_id: BOB, content: "Private now", visibility: "private", status: "active", deleted_at: null, media_urls: [], updated_at: "2026-05-03T00:00:00.000Z" },
    ],
    trips: [
      { id: TRIP_PRIVATE, owner_id: CAROL, title: "Carol's trip", destination_city: "Hue", start_date: "2026-06-01", end_date: "2026-06-05", status: "planning", visibility: "private", cover_url: null, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: TRIP_MEMBER, owner_id: BOB, title: "Da Nang", destination_city: "Da Nang", start_date: "2026-06-10", end_date: "2026-06-20", status: "active", visibility: "private", cover_url: null, updated_at: "2026-05-04T00:00:00.000Z" },
    ],
    trip_members: [
      { trip_id: TRIP_MEMBER, user_id: ALICE, status: "accepted", role: "member" },
      { trip_id: TRIP_MEMBER, user_id: BOB, status: "accepted", role: "owner" },
    ],
    events: [
      { id: EVENT_DRAFT, host_id: CAROL, title: "Unannounced", city: "Hoi An", starts_at: "2026-07-01T12:00:00.000Z", state: "draft", visibility: "public", cover_url: null, updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    event_attendees: [],
    meetups: [
      { id: MEETUP_UNINVITED, creator_id: CAROL, title: "Private dinner", location_name: "X", starts_at: "2026-07-01T12:00:00.000Z", status: "active", visibility: "invitees", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    meetup_invites: [],
    hidden_gems: [
      { id: GEM_PENDING, name: "Unreviewed gem", city: "Hue", neighborhood: null, category: "bar", status: "pending", sensitivity_level: "public", merged_into: null, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: GEM_ACTIVE, name: "Rooftop", city: "Hue", neighborhood: "Old town", category: "bar", status: "active", sensitivity_level: "public", merged_into: null, updated_at: "2026-05-02T00:00:00.000Z" },
    ],
    places: [],
    memories: [
      { id: MEMORY_FRIENDS, owner_id: BOB, title: "Friends only", caption: null, visibility: "friends_only", allowed_user_ids: [], hidden_user_ids: [], state: "published", location_city: "Hue", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: MEMORY_PUBLIC, owner_id: BOB, title: "Public memory", caption: null, visibility: "public", allowed_user_ids: [], hidden_user_ids: [], state: "published", location_city: "Hue", updated_at: "2026-05-02T00:00:00.000Z" },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, account_status: "active", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: BOB, handle: "bob", name: "Bob", avatar_url: null, account_status: "active", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: CAROL, handle: "carol", name: "Carol", avatar_url: null, account_status: "active", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
    rent_buddy_bookings: [
      { id: BOOKING_OTHER, buddy_id: CAROL, traveler_id: BOB, city: "Hue", category: "food", booking_date: "2026-07-02", status: "confirmed", updated_at: "2026-05-01T00:00:00.000Z" },
    ],
  };
}

function makeClient(state: State) {
  const db = fixture(state);
  const inserted: Array<{ table: string; row: any }> = [];

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let pendingInsert: any = null;
    let pendingUpdate: any = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () =>
      state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;

    const target: any = {
      select() { return proxy; },
      insert(row: any) {
        pendingInsert = { id: `msg-${inserted.length + 1}`, ...row };
        inserted.push({ table, row: pendingInsert });
        (db[table] ??= []).push(pendingInsert);
        return proxy;
      },
      update(patch: any) { pendingUpdate = patch; return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: pendingInsert ?? rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        if (pendingUpdate) {
          const applied = rowsNow();
          for (const r of applied) Object.assign(r, pendingUpdate);
          return Promise.resolve({ data: applied, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: pendingInsert ? [pendingInsert] : rowsNow(), error: null }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    _inserted: inserted,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let base = "";

function useState(state: State) {
  const c = makeClient(state);
  _setTestClient(c, true);
  return c;
}

async function post(path: string, asUser: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use("/api", telegraphShareRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── §5.1 the contract ────────────────────────────────────────────────────────

describe("§5.1 TelegraphShareable", () => {
  it("has all four methods for every shareable family", async () => {
    const c = useState({});
    for (const t of SHAREABLE_OBJECT_TYPES) {
      const s = shareableFor(c as any, t, POST_OK);
      assert.ok(s, `${t} has no shareable`);
      assert.equal(typeof s!.getSharePreview, "function");
      assert.equal(typeof s!.getCurrentState, "function");
      assert.equal(typeof s!.getAvailableActions, "function");
      assert.equal(typeof s!.getDeepLink, "function");
    }
  });

  it("covers all five §5 object families", () => {
    const has = (t: string) => SHAREABLE_OBJECT_TYPES.includes(t as any);
    assert.ok(has("POST") && has("PROFILE") && has("MEMORY"), "Social");
    assert.ok(has("TRIP") && has("EVENT") && has("MEETUP"), "Travel");
    assert.ok(has("PLACE") && has("HIDDEN_GEM") && has("MEETUP_POINT"), "Places");
    assert.ok(has("BOOKING") && has("BUDDY_SERVICE"), "Services");
  });

  it("getDeepLink points at routes the client actually has", () => {
    assert.equal(deepLinkFor("POST", "p1"), "/post/p1");
    assert.equal(deepLinkFor("TRIP", "t1"), "/trip/t1");
    assert.equal(deepLinkFor("EVENT", "e1"), "/event/e1");
    assert.equal(deepLinkFor("MEETUP", "m1"), "/meetup/m1");
    assert.equal(deepLinkFor("PLACE", "pl1"), "/place/pl1");
    assert.equal(deepLinkFor("HIDDEN_GEM", "g1"), "/gems/g1");
    assert.equal(deepLinkFor("MEMORY", "me1"), "/memory/me1");
    assert.equal(deepLinkFor("PROFILE", "u1"), "/u/u1");
  });

  it("getAvailableActions draws only from §8.1's fourteen", () => {
    const ALL = new Set([
      "ADD_TO_TRIP", "CREATE_PLAN", "JOIN_PLAN", "LEAVE_PLAN", "MEET_HERE", "SHARE_PLACE",
      "SHARE_ROUTE", "VOTE", "SHARE_AVAILABILITY", "SHARE_LOCATION", "SPLIT_RIDE",
      "CHECK_IN_SAFE", "RETURN_TO_GROUP", "DO_THIS_NOW",
    ]);
    for (const t of SHAREABLE_OBJECT_TYPES) {
      for (const a of shareActionsFor(t)) assert.ok(ALL.has(a), `${t} offers a non-§8.1 action: ${a}`);
    }
  });

  it("an unknown family is not shareable and has no shareable", () => {
    const c = useState({});
    assert.equal(isShareable("SOMETHING_ELSE"), false);
    assert.equal(shareableFor(c as any, "NEIGHBORHOOD", "x"), null);
  });
});

// ── §5.3 revocation ──────────────────────────────────────────────────────────

async function resolveOne(c: any, objectType: any, objectId: string, viewer: string) {
  const [r] = await resolveShareProjections(c as any, viewer, THREAD, [{ objectType, objectId }]);
  return r!;
}

describe("§5.3 revocation — a revoked source degrades, carrying nothing", () => {
  it("a deleted post degrades", async () => {
    const c = useState({});
    const r = await resolveOne(c, "POST", POST_DELETED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
  });

  it("a post made private degrades for everyone but its author", async () => {
    const c = useState({});
    assert.equal((await resolveOne(c, "POST", POST_PRIVATE, ALICE)).available, false);
    const c2 = useState({});
    assert.equal((await resolveOne(c2, "POST", POST_PRIVATE, BOB)).available, true, "the author still sees it");
  });

  it("AN UNAVAILABLE REFERENCE CARRIES NOTHING — this is the backdoor test", async () => {
    const c = useState({});
    const r = await resolveOne(c, "POST", POST_DELETED, ALICE);
    assert.equal(r.projection, null, "no title, no image, no subtitle may survive revocation");
    assert.deepEqual(r.actions, []);
    const serialised = JSON.stringify(r);
    assert.ok(!serialised.includes("Gone"), "the post body leaked through a revoked reference");
  });

  it("a private trip degrades for a non-member and resolves for a member", async () => {
    const c = useState({});
    assert.equal((await resolveOne(c, "TRIP", TRIP_PRIVATE, ALICE)).available, false);
    const c2 = useState({});
    const ok = await resolveOne(c2, "TRIP", TRIP_MEMBER, ALICE);
    assert.equal(ok.available, true);
    assert.equal(ok.available === true && ok.projection.title, "Da Nang");
  });

  it("a draft event degrades for anyone but its host", async () => {
    const c = useState({});
    assert.equal((await resolveOne(c, "EVENT", EVENT_DRAFT, ALICE)).available, false);
    const c2 = useState({});
    assert.equal((await resolveOne(c2, "EVENT", EVENT_DRAFT, CAROL)).available, true);
  });

  it("a meetup you were never invited to degrades", async () => {
    const c = useState({});
    const r = await resolveOne(c, "MEETUP", MEETUP_UNINVITED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
  });

  it("a gem that is pending moderation is not shareable; an active one is", async () => {
    const c = useState({});
    assert.equal((await resolveOne(c, "HIDDEN_GEM", GEM_PENDING, ALICE)).available, false);
    const c2 = useState({});
    assert.equal((await resolveOne(c2, "HIDDEN_GEM", GEM_ACTIVE, ALICE)).available, true);
  });

  it("a friends_only Memory degrades rather than being approximated", async () => {
    const c = useState({});
    const r = await resolveOne(c, "MEMORY", MEMORY_FRIENDS, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    const c2 = useState({});
    assert.equal((await resolveOne(c2, "MEMORY", MEMORY_PUBLIC, ALICE)).available, true);
  });

  it("a booking is visible to its two parties and nobody else", async () => {
    const c = useState({});
    assert.equal((await resolveOne(c, "BOOKING", BOOKING_OTHER, ALICE)).available, false);
    const c2 = useState({});
    assert.equal((await resolveOne(c2, "BOOKING", BOOKING_OTHER, BOB)).available, true);
  });

  it("a profile that has blocked the viewer degrades", async () => {
    const c = useState({});
    (c as any)._db.blocks.push({ blocker_id: PROFILE_BLOCKED, blocked_id: ALICE });
    const r = await resolveOne(c, "PROFILE", PROFILE_BLOCKED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
  });

  it("a reference to something that does not exist is not_found, not a blank card", async () => {
    const c = useState({});
    const r = await resolveOne(c, "POST", "99990000-0000-4000-8000-000000000009", ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "not_found");
  });
});

describe("§5.3 fail-closed — an unreadable source is UNAVAILABLE, never available", () => {
  for (const [table, type, id] of [
    ["posts", "POST", POST_OK],
    ["trips", "TRIP", TRIP_MEMBER],
    ["hidden_gems", "HIDDEN_GEM", GEM_ACTIVE],
    ["memories", "MEMORY", MEMORY_PUBLIC],
  ] as const) {
    it(`an unreadable ${table} degrades with reason "unknown"`, async () => {
      const c = useState({ errorTable: table });
      const r = await resolveOne(c, type, id, ALICE);
      assert.equal(r.available, false, `${table}: a DB error must not read as "available"`);
      assert.equal(r.available === false && r.reason, "unknown");
      assert.equal(r.projection, null);
    });
  }
});

// ── §6.2 envelope ────────────────────────────────────────────────────────────

describe("the PORTAVA_OBJECT envelope is a reference, not a copy", () => {
  it("round-trips", () => {
    const b = buildPortavaObjectBody("PLACE", "p1", "  look at this  ");
    assert.equal(b.kind, "PORTAVA_OBJECT");
    assert.equal(b.caption, "look at this");
    const back = parsePortavaObjectBody(JSON.stringify(b));
    assert.deepEqual(back, b);
  });

  it("carries no title, image or status — nothing that could go stale", () => {
    const b = buildPortavaObjectBody("POST", POST_OK, null) as any;
    assert.deepEqual(Object.keys(b).sort(), ["caption", "kind", "objectId", "objectType", "shareProjectionVersion"]);
  });

  it("refuses a future envelope version rather than half-reading it", () => {
    assert.equal(parsePortavaObjectBody({ kind: "PORTAVA_OBJECT", objectType: "POST", objectId: "x", shareProjectionVersion: "2" }), null);
  });

  it("refuses an unknown object family and malformed bodies", () => {
    assert.equal(parsePortavaObjectBody({ kind: "PORTAVA_OBJECT", objectType: "WAT", objectId: "x", shareProjectionVersion: "1" }), null);
    assert.equal(parsePortavaObjectBody("not json"), null);
    assert.equal(parsePortavaObjectBody(null), null);
    assert.equal(parsePortavaObjectBody({ kind: "other" }), null);
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

describe("POST /threads/:id/share", () => {
  it("writes a PORTAVA_OBJECT message carrying a reference", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/share`, ALICE, { objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE, caption: "here" });
    assert.equal(r.status, 201);
    assert.equal(r.body.msgType, "portava_object");
    assert.equal(r.body.subtype, "hidden_gem");
    assert.equal(r.body.share.objectId, GEM_ACTIVE);
    const written = (c as any)._inserted.find((i: any) => i.table === "messages");
    assert.ok(written, "a row must actually be written");
    const body = JSON.parse(written.row.body);
    assert.equal(body.kind, "PORTAVA_OBJECT");
    assert.equal(body.objectId, GEM_ACTIVE);
    assert.ok(!("title" in body), "the envelope must not copy the object");
  });

  it("you may not share what you cannot open", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD}/share`, ALICE, { objectType: "TRIP", objectId: TRIP_PRIVATE });
    assert.equal(r.status, 403);
    assert.equal((c as any)._inserted.filter((i: any) => i.table === "messages").length, 0);
  });

  it("a non-member is refused", async () => {
    useState({});
    const r = await post(`/threads/${THREAD_NONE}/share`, ALICE, { objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE });
    assert.equal(r.status, 403);
  });

  it("the messaging kill switch stops it, like every other write", async () => {
    useState({ killSwitch: true });
    const r = await post(`/threads/${THREAD}/share`, ALICE, { objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE });
    assert.equal(r.status, 404, "feature_disabled");
  });

  it("a block on a 1:1 thread stops it", async () => {
    useState({ blocked: true });
    const r = await post(`/threads/${THREAD}/share`, ALICE, { objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE });
    assert.equal(r.status, 403);
  });

  it("an E2EE thread refuses a plaintext envelope instead of writing one", async () => {
    const c = useState({});
    const r = await post(`/threads/${THREAD_E2EE}/share`, ALICE, { objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE });
    assert.equal(r.status, 422, "e2ee_thread");
    assert.equal((c as any)._inserted.filter((i: any) => i.table === "messages").length, 0);
  });

  it("an unknown object family is a 400 naming what IS shareable", async () => {
    useState({});
    const r = await post(`/threads/${THREAD}/share`, ALICE, { objectType: "SPACESHIP", objectId: "x" });
    assert.equal(r.status, 400);
    assert.ok(String(r.body.message).includes("HIDDEN_GEM"));
  });
});

describe("POST /threads/:id/share-projections", () => {
  it("resolves a batch for the caller and refuses a non-member", async () => {
    useState({});
    const ok = await post(`/threads/${THREAD}/share-projections`, ALICE, {
      refs: [
        { objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE, messageId: "m1" },
        { objectType: "POST", objectId: POST_DELETED, messageId: "m2" },
      ],
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.projections.length, 2);
    assert.equal(ok.body.projections[0].available, true);
    assert.equal(ok.body.projections[0].messageId, "m1");
    assert.equal(ok.body.projections[1].available, false);
    assert.equal(ok.body.projections[1].projection, null);

    useState({});
    const no = await post(`/threads/${THREAD_NONE}/share-projections`, ALICE, {
      refs: [{ objectType: "HIDDEN_GEM", objectId: GEM_ACTIVE }],
    });
    assert.equal(no.status, 403);
  });

  it("names an unsupported family instead of dropping it silently", async () => {
    useState({});
    const r = await post(`/threads/${THREAD}/share-projections`, ALICE, {
      refs: [{ objectType: "SPACESHIP", objectId: "x" }],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.unsupported, [{ objectType: "SPACESHIP", objectId: "x" }]);
    assert.deepEqual(r.body.projections, []);
  });

  it("an empty or oversized batch is a 400", async () => {
    useState({});
    assert.equal((await post(`/threads/${THREAD}/share-projections`, ALICE, { refs: [] })).status, 400);
    const many = Array.from({ length: 101 }, () => ({ objectType: "POST", objectId: POST_OK }));
    assert.equal((await post(`/threads/${THREAD}/share-projections`, ALICE, { refs: many })).status, 400);
  });
});
