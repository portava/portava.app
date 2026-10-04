/**
 * Who a Trail's EVENT and ROUTE members are served to (census-discovery §64,
 * DC-20; the defect is §61.4's "found, not fixed" and §61.12 question 4).
 *
 * `servableMembers` applied post visibility and failed it closed, but served an
 * event or a route plan to every viewer as long as its row existed: a
 * friends-only, invite-only, draft, cancelled or archived event, and another
 * traveller's route plan, with its host or owner id. The same helper is the
 * attach gate, so such content could also be attached by anyone.
 *
 * The rules pinned here are the product's own, found before any was written:
 *
 *   EVENT  served to everyone only when the database's own public-read policy
 *          admits it — `events_public_read`, 2033_rls_hardening.sql:266:
 *          visibility 'public' AND state IN (open, full, waitlist, started,
 *          completed) AND the host not blocked either way — and the viewer is
 *          not banned from it (routes/events.ts checkEventEligibility, the gate
 *          the detail route applies) and the event declares no viewer gate the
 *          Trail does not resolve (age, trust, verified). Otherwise its HOST
 *          only, the posts' author exception. Friends, invitees and co-hosts
 *          are NOT resolved, as followers and trip members are not for posts.
 *   ROUTE  served to its owner; and to an ACCEPTED member of its trip
 *          (lib/http.ts requireTripMember, the rule migration 2334's RLS and
 *          GET /route-plans/:id both apply) when the plan is active or
 *          completed. Never to anyone else; a draft or cancelled plan only to
 *          its owner. Membership is resolved fail-closed.
 *
 * And the numbers a viewer is shown count only what that viewer is served:
 * GET …/:id's `memberCount` and §12 word, and GET …/trending's boolean.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import {
  getTrail, getTrailModules, trailTrending, servableMembers, type MemberRow,
} from "../services/trails/TrailService.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";

const u = (n: string) => `11111111-1111-4111-8111-1111111111${n}`;
const HOST = u("f1");
const STRANGER = u("f2");
const FRIEND = u("f3");
const INVITEE = u("f4");
const COHOST = u("f5");
const OWNER = u("f6");
const CREW = u("f7");
const PENDING = u("f8");
const TRIP_OWNER = u("f9");
const INVITED_ROLE = u("fa");
const REMOVED = u("fb");
const BANNED = u("fc");
const PEOPLE = [HOST, STRANGER, FRIEND, INVITEE, COHOST, OWNER, CREW, PENDING, TRIP_OWNER, INVITED_ROLE, REMOVED, BANNED];

const T = "22222222-2222-4222-8222-2222222222f1";
const EVENT = "66666666-6666-4666-8666-6666666666f1";
const EVENT_2 = "66666666-6666-4666-8666-6666666666f2";
const ROUTE = "77777777-7777-4777-8777-7777777777f1";
const TRIP = "88888888-8888-4888-8888-8888888888f1";
const PLACE = "33333333-3333-4333-8333-3333333333f1";
const POST = "55555555-5555-4555-8555-5555555555f1";

/** A fixed clock for every service-level reading, so a golden is a golden. */
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** The routes read the wall clock; route-level rows are placed against it. */
const ago = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type Row = Record<string, any>;

/** A PostgREST-shaped fake with a real `.or()`, per-table failures and a read log. */
function makeDb(seed: Record<string, Row[]>, erroring: string[] = []) {
  const tables: Record<string, Row[]> = {
    trails: [], content_trails: [], trail_follows: [], trail_reports: [], trail_edges: [],
    trail_health_snapshots: [], rank_events: [], blocks: [], posts: [], events: [],
    route_plans: [], discovery_places: [], places: [], event_roles: [], event_rsvps: [],
    user_friendships: [], trips: [], trip_members: [],
    profiles: PEOPLE.map((id) => ({ id, account_status: "active" })),
    ...seed,
  };
  const broken = new Set(erroring);
  const reads: string[] = [];
  let n = 0;
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let range: [number, number] | null = null;
    const store = () => (tables[table] ??= []);
    const fail = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    const rows = () => {
      let out = store().filter((r) => filters.every((f) => f(r)));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return out.map((r) => ({ ...r }));
    };
    const b: any = {
      select() { reads.push(table); return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      or(expr: string) { filters.push(orPredicate(expr)); return b; },
      order() { return b; },
      limit(k: number) { limitN = k; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() {
        if (broken.has(table)) return Promise.resolve(fail());
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      insert(payload: any) {
        const list = (Array.isArray(payload) ? payload : [payload]).map((x) => ({ id: `gen-${table}-${n++}`, ...x }));
        if (!broken.has(table)) store().push(...list);
        const settled = broken.has(table) ? fail() : { data: list, error: null };
        const r: any = { select: () => r, maybeSingle: () => Promise.resolve({ ...settled, data: settled.data?.[0] ?? null }), then: (res: any) => Promise.resolve(settled).then(res) };
        return r;
      },
      update(patch: Row) {
        let representation = false;
        const w: any = {
          eq(c: string, v: any) { filters.push((r) => r[c] === v); return w; },
          select() { representation = true; return w; },
          then(res: any) {
            const hit = store().filter((r) => filters.every((f) => f(r)));
            for (const r of hit) Object.assign(r, patch);
            return Promise.resolve({ data: representation ? hit.map((r) => ({ ...r })) : null, error: null }).then(res);
          },
        };
        return w;
      },
      then(res: (r: any) => any, rej?: (e: any) => any) {
        return Promise.resolve(broken.has(table) ? fail() : { data: rows(), error: null }).then(res, rej);
      },
    };
    return b;
  }
  const auth = {
    async getUser(token: string) {
      return tables.profiles!.some((p) => p.id === token)
        ? { data: { user: { id: token } }, error: null }
        : { data: { user: null }, error: { message: "invalid token" } };
    },
  };
  return { from, auth, _tables: tables, _reads: reads };
}

const trail = (over: Row = {}): Row => ({
  id: T, slug: "slug-f1", title: "Trail f1", description: null,
  destination: "bangkok", place_scope: null, parent_trail_id: null,
  lifecycle_status: "active", created_by: STRANGER,
  created_at: at(86_400_000), updated_at: at(86_400_000), ...over,
});

const member = (id: string, over: Partial<MemberRow> & Row = {}): MemberRow => ({
  id, trail_id: T, source_type: "event", source_id: EVENT,
  relationship: "supporting", signal: null, source: "user", confidence: 0.8,
  contributor_id: HOST, content_state: "just_arrived", created_at: at(3_600_000), ...over,
} as MemberRow);

/** An events row as production stores it: every column `servableMembers` may read. */
const event = (over: Row = {}): Row => ({
  id: EVENT, host_id: HOST, visibility: "public", state: "open",
  verified_only: false, trust_score_min: null, age_min: null, age_max: null,
  circle_id: null, trip_id: null, ...over,
});

const route = (over: Row = {}): Row => ({
  id: ROUTE, owner_user_id: OWNER, trip_id: null, circle_id: null, status: "active", ...over,
});

/** The relationships the rest of the product resolves and a Trail does not. */
const RELATIONSHIPS = (): Record<string, Row[]> => ({
  user_friendships: [{ user_a: HOST, user_b: FRIEND }],
  event_rsvps: [{ event_id: EVENT, user_id: INVITEE, status: "going" }],
  event_roles: [{ event_id: EVENT, user_id: COHOST, role: "co_host" }],
});

const CREW_ROWS = (): Record<string, Row[]> => ({
  trips: [{ id: TRIP, owner_id: TRIP_OWNER }],
  trip_members: [
    { trip_id: TRIP, user_id: CREW, role: "member", status: "accepted" },
    { trip_id: TRIP, user_id: PENDING, role: "member", status: "invited" },
    { trip_id: TRIP, user_id: INVITED_ROLE, role: "invited", status: "accepted" },
    { trip_id: TRIP, user_id: REMOVED, role: "member", status: "removed" },
  ],
});

async function servedTo(db: any, members: MemberRow[], viewer: string | null, unread?: Set<string>): Promise<string[]> {
  return (await servableMembers(db, members, viewer, NOW, unread)).map((m) => m.id).sort();
}

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });

async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const EVENT_STATES = ["draft", "open", "full", "waitlist", "started", "completed", "cancelled", "archived"] as const;
/** `events_public_read`'s allowlist (2033_rls_hardening.sql:266), the one the rule reuses. */
const PUBLIC_READ_STATES = new Set(["open", "full", "waitlist", "started", "completed"]);

describe("E — an EVENT member is served per the product's public-read rule, else to its host only", () => {
  it("E1. every visibility × every state × anonymous, host, stranger, friend, invitee, co-host", async () => {
    const viewers: Array<[string, string | null]> = [
      ["anonymous", null], ["host", HOST], ["stranger", STRANGER],
      ["friend of the host", FRIEND], ["invitee (RSVP)", INVITEE], ["co-host", COHOST],
    ];
    const wrong: string[] = [];
    for (const visibility of ["public", "friends_only", "invite_only"]) {
      for (const state of EVENT_STATES) {
        const db = makeDb({ events: [event({ visibility, state })], ...RELATIONSHIPS() });
        for (const [who, viewer] of viewers) {
          const expected = viewer === HOST || (visibility === "public" && PUBLIC_READ_STATES.has(state));
          const got = (await servedTo(db, [member("m-e")], viewer)).length === 1;
          if (got !== expected) wrong.push(`${visibility}/${state} → ${who}: ${got ? "served" : "withheld"}`);
        }
      }
    }
    assert.deepEqual(wrong, [], "the Trail disagreed with the product's rule");
  });

  it("E1b. a visibility the rule does not know — the API vocabulary's `circle` and `trip` — is its host's only", async () => {
    // routes/events.ts accepts five values; the database enum holds three today
    // (baseline event_visibility). Whatever widens first, the Trail fails closed.
    for (const visibility of ["circle", "trip", "something_new"]) {
      const db = makeDb({ events: [event({ visibility, circle_id: STRANGER, trip_id: TRIP })], ...RELATIONSHIPS() });
      assert.deepEqual(await servedTo(db, [member("m-e")], STRANGER), [], visibility);
      assert.deepEqual(await servedTo(db, [member("m-e")], HOST), ["m-e"], visibility);
    }
  });

  it("E2. a public, live event with a viewer gate the Trail does not resolve (age, trust, verified) is its host's only", async () => {
    for (const gate of [{ age_min: 18 }, { age_max: 30 }, { trust_score_min: 60 }, { verified_only: true }]) {
      const db = makeDb({ events: [event(gate)] });
      assert.deepEqual(await servedTo(db, [member("m-e")], STRANGER), [], JSON.stringify(gate));
      assert.deepEqual(await servedTo(db, [member("m-e")], null), [], `${JSON.stringify(gate)} (anonymous)`);
      assert.deepEqual(await servedTo(db, [member("m-e")], HOST), ["m-e"], `${JSON.stringify(gate)} (host)`);
    }
  });

  it("E3. a viewer the host BANNED is not served the event; everyone else is", async () => {
    const db = makeDb({ events: [event()], event_roles: [{ event_id: EVENT, user_id: BANNED, role: "banned" }] });
    assert.deepEqual(await servedTo(db, [member("m-e")], BANNED), []);
    assert.deepEqual(await servedTo(db, [member("m-e")], STRANGER), ["m-e"]);
    assert.deepEqual(await servedTo(db, [member("m-e")], null), ["m-e"]);
  });

  it("E4. an unreadable ban list withholds the event from every viewer but its host, and is named", async () => {
    const db = makeDb({ events: [event()] }, ["event_roles"]);
    const unread = new Set<string>();
    assert.deepEqual(await servedTo(db, [member("m-e")], STRANGER, unread), []);
    assert.deepEqual([...unread], ["event_roles"]);
    const hostUnread = new Set<string>();
    assert.deepEqual(await servedTo(db, [member("m-e")], HOST, hostUnread), ["m-e"], "the host's own event needs no ban read");
    assert.deepEqual([...hostUnread], []);
    const anonUnread = new Set<string>();
    assert.deepEqual(await servedTo(db, [member("m-e")], null, anonUnread), ["m-e"], "no one to be banned: no read, nothing withheld");
    assert.deepEqual([...anonUnread], []);
  });

  it("E5. an unreadable events table withholds every event member, the host's too, and is named", async () => {
    const db = makeDb({ events: [event()] }, ["events"]);
    const unread = new Set<string>();
    assert.deepEqual(await servedTo(db, [member("m-e")], HOST, unread), []);
    assert.deepEqual([...unread], ["events"]);
  });

  it("E6. a PUBLIC event linked to a circle or a trip is public: circle_id / trip_id alone scope nothing in the product", async () => {
    // 2033's events_public_read, canViewEvent, the /events feed and Discovery
    // search all read `visibility` alone; POST /events/:id/link-circle keeps an
    // event public unless the host asks for `setCircleVisibility`.
    const db = makeDb({ events: [event({ circle_id: HOST, trip_id: TRIP })] });
    assert.deepEqual(await servedTo(db, [member("m-e")], STRANGER), ["m-e"]);
  });
});

describe("R — a ROUTE member is served to its owner, and to its trip's accepted crew when active or completed", () => {
  it("R1. every status × with and without a trip × owner, stranger, anonymous, crew, pending, invited, removed, trip owner", async () => {
    const viewers: Array<[string, string | null]> = [
      ["owner", OWNER], ["stranger", STRANGER], ["anonymous", null], ["accepted crew", CREW],
      ["pending invitee (status invited)", PENDING], ["invitee (role invited)", INVITED_ROLE],
      ["removed member", REMOVED], ["trip owner with no membership row", TRIP_OWNER],
    ];
    const wrong: string[] = [];
    for (const status of ["draft", "active", "completed", "cancelled"]) {
      for (const tripId of [null, TRIP]) {
        const db = makeDb({ route_plans: [route({ status, trip_id: tripId })], ...CREW_ROWS() });
        for (const [who, viewer] of viewers) {
          const crew = viewer === CREW || viewer === TRIP_OWNER;
          const expected = viewer === OWNER || (tripId !== null && crew && (status === "active" || status === "completed"));
          const got = (await servedTo(db, [member("m-r", { source_type: "route", source_id: ROUTE, contributor_id: OWNER })], viewer)).length === 1;
          if (got !== expected) wrong.push(`${status}/${tripId ? "trip" : "no trip"} → ${who}: ${got ? "served" : "withheld"}`);
        }
      }
    }
    assert.deepEqual(wrong, [], "the Trail disagreed with requireTripMember's crew");
  });

  it("R2. an unreadable trip_members withholds the trip route from every viewer but its owner, and is named", async () => {
    const m = [member("m-r", { source_type: "route", source_id: ROUTE, contributor_id: OWNER })];
    const db = makeDb({ route_plans: [route({ trip_id: TRIP })], ...CREW_ROWS() }, ["trip_members"]);
    const unread = new Set<string>();
    assert.deepEqual(await servedTo(db, m, CREW, unread), []);
    assert.deepEqual([...unread], ["trip_members"]);
    const ownerUnread = new Set<string>();
    assert.deepEqual(await servedTo(db, m, OWNER, ownerUnread), ["m-r"]);
    assert.deepEqual([...ownerUnread], [], "the owner's own route needs no membership read");
  });

  it("R3. an unreadable trips (the owner fallback) withholds the route from the trip owner, and is named", async () => {
    const m = [member("m-r", { source_type: "route", source_id: ROUTE, contributor_id: OWNER })];
    const db = makeDb({ route_plans: [route({ trip_id: TRIP })], ...CREW_ROWS() }, ["trips"]);
    const unread = new Set<string>();
    assert.deepEqual(await servedTo(db, m, TRIP_OWNER, unread), []);
    assert.deepEqual([...unread], ["trips"]);
  });

  it("R4. no membership is read for a route no one but its owner could be served", async () => {
    const m = [member("m-r", { source_type: "route", source_id: ROUTE, contributor_id: OWNER })];
    for (const r of [route({ trip_id: null }), route({ trip_id: TRIP, status: "draft" })]) {
      const db = makeDb({ route_plans: [r], ...CREW_ROWS() });
      assert.deepEqual(await servedTo(db, m, STRANGER), []);
      assert.ok(!db._reads.includes("trip_members") && !db._reads.includes("trips"), JSON.stringify(r));
    }
  });
});

describe("X — attach and suggest: an actor may attach their OWN non-public content, which no one else is then served", () => {
  it("X1. A attaches A's friends-only event; B's module listing does not hold it, A's does; B cannot attach it", async () => {
    const db = makeDb({ trails: [trail()], events: [event({ visibility: "friends_only" })], ...RELATIONSHIPS() });
    _setTestClient(db, true);
    const r = await call("POST", `/v1/discovery/trails/${T}/content`, HOST, { labels: [{ sourceType: "event", sourceId: EVENT, relationship: "supporting" }] });
    assert.equal(r.status, 201, r.text);
    const ids = async (as: string) => (await call("GET", `/v1/discovery/trails/${T}/modules`, as)).body.modules
      .flatMap((m: any) => m.items.map((i: any) => i.sourceId));
    assert.deepEqual(await ids(HOST), [EVENT]);
    assert.deepEqual(await ids(STRANGER), []);
    assert.deepEqual(await ids(FRIEND), [], "a friend of the host is not resolved in a public space");
    const b = await call("POST", `/v1/discovery/trails/${T}/suggestions`, STRANGER, { labels: [{ sourceType: "event", sourceId: EVENT_2, relationship: "supporting" }] });
    const seen = await call("POST", `/v1/discovery/trails/${T}/suggestions`, STRANGER, { labels: [{ sourceType: "event", sourceId: EVENT, relationship: "signal", signal: "x" }] });
    assert.equal(seen.status, b.status, "the unseen and the absent get one answer");
    assert.deepEqual(seen.body.contentRefusals.map((x: any) => x.reason), ["unknown_content"]);
  });

  it("X2. an owner attaches their own DRAFT route; only the owner is served it", async () => {
    const db = makeDb({ trails: [trail()], route_plans: [route({ status: "draft", trip_id: TRIP })], ...CREW_ROWS() });
    _setTestClient(db, true);
    const r = await call("POST", `/v1/discovery/trails/${T}/content`, OWNER, { labels: [{ sourceType: "route", sourceId: ROUTE, relationship: "supporting" }] });
    assert.equal(r.status, 201, r.text);
    const ids = async (as: string) => (await call("GET", `/v1/discovery/trails/${T}/modules`, as)).body.modules
      .flatMap((m: any) => m.items.map((i: any) => i.sourceId));
    assert.deepEqual(await ids(OWNER), [ROUTE]);
    assert.deepEqual(await ids(CREW), [], "a draft is not the crew's until it is accepted");
    assert.deepEqual(await ids(STRANGER), []);
  });

  it("X3. an unreadable ban list admits NOTHING at attach: 503, retryable, no row", async () => {
    const db = makeDb({ trails: [trail()], events: [event({ host_id: OWNER })] }, ["event_roles"]);
    _setTestClient(db, true);
    const r = await call("POST", `/v1/discovery/trails/${T}/content`, STRANGER, { labels: [{ sourceType: "event", sourceId: EVENT, relationship: "supporting" }] });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.message, "the content could not be verified; nothing was attached");
    assert.equal(db._tables.content_trails!.length, 0);
  });
});

describe("V — revocation both ways, with no cache between reads", () => {
  it("V1. public → friends_only withholds on the NEXT read; friends_only → public serves again", async () => {
    const db = makeDb({ trails: [trail()], content_trails: [member("m-e", { created_at: ago(3_600_000) })], events: [event()] });
    _setTestClient(db, true);
    const ids = async () => (await call("GET", `/v1/discovery/trails/${T}/modules`, STRANGER)).body.modules
      .flatMap((m: any) => m.items.map((i: any) => i.id));
    assert.deepEqual(await ids(), ["m-e"]);
    db._tables.events![0]!.visibility = "friends_only";
    assert.deepEqual(await ids(), [], "a flip to friends_only is honoured on the next read");
    db._tables.events![0]!.visibility = "public";
    assert.deepEqual(await ids(), ["m-e"], "and the flip back is too");
    db._tables.events![0]!.state = "cancelled";
    assert.deepEqual(await ids(), [], "a cancellation is honoured on the next read");
  });

  it("V2. retries: the same request twice is the same bytes; a failed read does not stick to the next request", async () => {
    const seed = () => ({
      trails: [trail()],
      content_trails: [member("m-e", { created_at: ago(3_600_000) }), member("m-r", { source_type: "route", source_id: ROUTE, contributor_id: OWNER, created_at: ago(7_200_000) })],
      events: [event()], route_plans: [route({ trip_id: TRIP })], ...CREW_ROWS(),
    });
    const db = makeDb(seed());
    _setTestClient(db, true);
    const a = await call("GET", `/v1/discovery/trails/${T}/modules`, CREW);
    const b = await call("GET", `/v1/discovery/trails/${T}/modules`, CREW);
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text);
    assert.deepEqual(a.body.modules[0].items.map((i: any) => i.id), ["m-e", "m-r"]);

    _setTestClient(makeDb(seed(), ["trip_members", "event_roles"]), true);
    const failed = await call("GET", `/v1/discovery/trails/${T}/modules`, CREW);
    assert.deepEqual(failed.body.modules[0].items, [], "both members are withheld while their reads fail");
    // RESTATED by census-discovery §105 (DV-83 round 9, D-W11X2-60). This case used to stop at the
    // line above, and so pinned the defect the round-8 verifier found: a failed read served as a
    // complete, empty Trail page. Withholding stays right (fail closed, §64); what changed is that the
    // page now SAYS it is a failed read, with one generic source that names no member kind.
    assert.equal(failed.body.refusal?.coverage, "nothing", "a page emptied by failed reads is refused, never a complete empty page");
    assert.deepEqual(failed.body.refusal?.failedSources, ["trail_member_sources"]);
    _setTestClient(db, true);
    assert.equal((await call("GET", `/v1/discovery/trails/${T}/modules`, CREW)).text, a.text, "a recovered read serves again");
  });
});

describe("C — no public number counts a member the viewer is not served", () => {
  const hidden = () => event({ visibility: "invite_only" });

  it("C1. GET …/:id's memberCount counts what THIS viewer is served", async () => {
    const db = makeDb({
      trails: [trail()],
      content_trails: [
        member("m-pl", { source_type: "place", source_id: PLACE, contributor_id: null, created_at: ago(9 * 86_400_000) }),
        member("m-e", { created_at: ago(9 * 86_400_000) }),
      ],
      events: [hidden()],
    });
    _setTestClient(db, true);
    assert.equal((await call("GET", `/v1/discovery/trails/${T}`, STRANGER)).body.memberCount, 1);
    assert.equal((await call("GET", `/v1/discovery/trails/${T}`, HOST)).body.memberCount, 2);
  });

  it("C2. §12's word is not moved by a withheld member attached today", async () => {
    const db = makeDb({
      trails: [trail()],
      content_trails: [
        member("m-pl", { source_type: "place", source_id: PLACE, contributor_id: null, created_at: ago(30 * 86_400_000) }),
        member("m-e", { created_at: ago(60_000) }),
      ],
      events: [hidden()],
    });
    _setTestClient(db, true);
    const stranger = await call("GET", `/v1/discovery/trails/${T}`, STRANGER);
    const host = await call("GET", `/v1/discovery/trails/${T}`, HOST);
    assert.equal(host.body.status, "Fresh today", "the control: the host is served the fresh member");
    assert.notEqual(stranger.body.status, "Fresh today", "a stranger was told of a member they cannot see");
  });

  it("C3. a Trail whose only members are withheld answers …/trending exactly as an EMPTY Trail does", async () => {
    const surge = Array.from({ length: 8 }, (_, i) => ({
      id: `re${i}`, surface: "events", item_id: EVENT, outcome: "save", served_at: ago(3_600_000 + i), outcome_at: ago(3_500_000 + i),
    }));
    const withHidden = makeDb({ trails: [trail()], content_trails: [member("m-e", { created_at: ago(60_000) })], events: [hidden()], rank_events: surge });
    _setTestClient(withHidden, true);
    const stranger = await call("GET", `/v1/discovery/trails/${T}/trending`, STRANGER);
    _setTestClient(makeDb({ trails: [trail()] }), true);
    const empty = await call("GET", `/v1/discovery/trails/${T}/trending`, STRANGER);
    assert.equal(stranger.text, empty.text, "the withheld member's existence (or its surge) leaked through …/trending");
    _setTestClient(withHidden, true);
    const host = await call("GET", `/v1/discovery/trails/${T}/trending`, HOST);
    assert.equal(host.body.trending, true, "the control: the host's own surge is a reading");
  });

  it("C4. a withheld member's activity does not make a Trail of public members trending", async () => {
    const surge = Array.from({ length: 8 }, (_, i) => ({
      id: `re${i}`, surface: "events", item_id: EVENT, outcome: "save", served_at: ago(3_600_000 + i), outcome_at: ago(3_500_000 + i),
    }));
    const db = makeDb({
      trails: [trail()],
      content_trails: [
        member("m-pl", { source_type: "place", source_id: PLACE, contributor_id: null }),
        member("m-e"),
      ],
      events: [hidden()], rank_events: surge,
    });
    _setTestClient(db, true);
    const r = await call("GET", `/v1/discovery/trails/${T}/trending`, STRANGER);
    assert.equal(r.body.trending, false, "the only activity is on a member this viewer is not served");
  });
});

describe("G — public members are served byte for byte as before", () => {
  // Captured from the code BEFORE §64 (base 9af90c0ee) over this fixture, at NOW. §68 changed exactly the two
  // provenance version strings in it (the kernel now names its own pair), and §84 renamed the feature string (D-W10-R1-16); every other byte is as captured.
  // Every member here is public and live, so the new rules must change nothing.
  const GOLDEN =
    "{\"detail\":{\"memberCount\":4,\"status\":\"Fresh today\",\"healthScale\":1},\"modules\":[{\"key\":\"just_arrived\",\"objective\":\"recency\",\"horizonMs\":604800000,\"items\":[{\"id\":\"g-place\",\"sourceType\":\"place\",\"sourceId\":\"33333333-3333-4333-8333-3333333333f1\",\"contentState\":\"just_arrived\"},{\"id\":\"g-event\",\"sourceType\":\"event\",\"sourceId\":\"66666666-6666-4666-8666-6666666666f1\",\"contentState\":\"just_arrived\"},{\"id\":\"g-event-2\",\"sourceType\":\"event\",\"sourceId\":\"66666666-6666-4666-8666-6666666666f2\",\"contentState\":\"just_arrived\"}],\"moreFromThisPlace\":{},\"explorationSlots\":[\"g-place\"]},{\"key\":\"trending_now\",\"objective\":\"momentum\",\"horizonMs\":172800000,\"items\":[{\"id\":\"g-place\",\"sourceType\":\"place\",\"sourceId\":\"33333333-3333-4333-8333-3333333333f1\",\"contentState\":\"just_arrived\"}],\"moreFromThisPlace\":{},\"explorationSlots\":null},{\"key\":\"evergreen\",\"objective\":\"durable_quality\",\"horizonMs\":null,\"items\":[{\"id\":\"g-post\",\"sourceType\":\"post\",\"sourceId\":\"55555555-5555-4555-8555-5555555555f1\",\"contentState\":\"evergreen\"}],\"moreFromThisPlace\":{},\"explorationSlots\":null},{\"key\":\"local_picks\",\"objective\":\"curation\",\"horizonMs\":null,\"items\":[],\"moreFromThisPlace\":{},\"explorationSlots\":null}],\"provenance\":{\"modelVersion\":\"discovery-place-velocity-v1\",\"featureVersion\":\"discovery-row-activity-v2\",\"window\":{\"kind\":\"bounded\",\"startMs\":1787313600000,\"endMs\":1789905600000},\"computedAt\":1789905600000},\"trending\":{\"momentum\":1,\"items\":[{\"id\":\"g-place\",\"sourceType\":\"place\",\"sourceId\":\"33333333-3333-4333-8333-3333333333f1\"},{\"id\":\"g-event\",\"sourceType\":\"event\",\"sourceId\":\"66666666-6666-4666-8666-6666666666f1\"}],\"provenance\":{\"modelVersion\":\"discovery-place-velocity-v1\",\"featureVersion\":\"discovery-row-activity-v2\",\"window\":{\"kind\":\"bounded\",\"startMs\":1787313600000,\"endMs\":1789905600000},\"computedAt\":1789905600000}}}";
  const seed = () => makeDb({
    trails: [trail()],
    content_trails: [
      member("g-place", { source_type: "place", source_id: PLACE, contributor_id: STRANGER, created_at: at(2 * 3_600_000) }),
      member("g-post", { source_type: "post", source_id: POST, contributor_id: FRIEND, content_state: "evergreen", confidence: 0.9, created_at: at(3 * 86_400_000) }),
      member("g-event", { source_type: "event", source_id: EVENT, contributor_id: HOST, created_at: at(5 * 3_600_000) }),
      member("g-event-2", { source_type: "event", source_id: EVENT_2, contributor_id: COHOST, created_at: at(20 * 3_600_000) }),
    ],
    posts: [{ id: POST, author_id: FRIEND, visibility: "public", status: "active", post_status: "published", deleted_at: null, tombstoned_at: null, publish_at: null, trip_id: null, canonical_place_id: PLACE, location_place_id: null }],
    events: [event(), event({ id: EVENT_2, host_id: COHOST, state: "completed" })],
    discovery_places: [{ id: PLACE, submitted_by: STRANGER }],
    rank_events: [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `gp${i}`, surface: "discovery", item_id: `db/${PLACE}`, outcome: "save", served_at: at(3_600_000 + i), outcome_at: at(3_500_000 + i) })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `ge${i}`, surface: "discovery", item_id: EVENT, outcome: "save", served_at: at(2 * 3_600_000 + i), outcome_at: at(2 * 3_500_000 + i) })),
    ],
  });

  it("G1. detail, modules and trending, for a stranger, at a fixed clock", async () => {
    const detail = await getTrail(seed(), T, NOW, { viewerId: STRANGER });
    const modules = await getTrailModules(seed(), T, { viewerId: STRANGER, nowMs: NOW, pageSize: 8 });
    const trending = await trailTrending(seed(), T, NOW, { viewerId: STRANGER });
    const bytes = JSON.stringify({
      detail: { memberCount: detail.memberCount, status: detail.status, healthScale: detail.healthScale },
      modules: modules.modules, provenance: modules.momentumProvenance,
      trending: { momentum: trending.momentum, items: trending.items, provenance: trending.momentumProvenance },
    });
    assert.equal(bytes, GOLDEN);
  });
});
