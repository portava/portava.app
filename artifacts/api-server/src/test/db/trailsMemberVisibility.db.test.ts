/**
 * trailsMemberVisibility.db.test.ts — census-discovery §64 (DC-20): who a
 * Trail's EVENT and ROUTE members are served to, on the REAL schema (the
 * `event_visibility` / `event_state` / `route_plan_status` enums, `event_roles`,
 * `trip_members`, `trips`, and the RLS policies the rule is taken from), through
 * the real supabase-js client (trailPostgrestBridge.ts) and the real router.
 *
 *   TV1 events: every visibility × every state × anonymous, host, stranger,
 *       friend, invitee (RSVP) and co-host; and the stranger's view EQUALS what
 *       2033's `events_public_read` lets that stranger read through RLS
 *   TV2 events: a viewer gate (age, trust, verified) and a ban withhold
 *   TV3 routes: every status × with and without a trip × owner, stranger,
 *       anonymous, accepted crew, pending invitee, removed member, trip owner;
 *       and the crew's view is 2334's RLS minus draft and cancelled
 *   TV4 cross-viewer: A attaches A's own friends-only event and draft route; B's
 *       module listing holds neither, A's holds both; B's suggestion of it is
 *       refused exactly as a nonexistent id is
 *   TV5 revocation both ways by UPDATE, with no cache between reads
 *   TV6 failed reads: event_roles, trip_members and trips each withhold and are
 *       named; attach answers 503 and writes nothing
 *   TV7 counts: GET …/:id's memberCount and GET …/trending reveal no withheld
 *       member; a Trail of withheld members answers as an empty one
 *   TV8 retries: the same request twice is the same bytes
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, scalar, seedUser, asUser } from "./localDb.js";
import { makeTrailBridge, type BridgeOptions } from "./trailPostgrestBridge.js";
import { _setTestClient, _clearTestClient } from "../../lib/http.js";
import trailsRouter from "../../routes/trails.js";
import { servableMembers, type MemberRow } from "../../services/trails/TrailService.js";

const TAG = `vis${randomUUID().slice(0, 8)}`;
const users: string[] = [];
const trailIds: string[] = [];

const EVENT_STATES = ["draft", "open", "full", "waitlist", "started", "completed", "cancelled", "archived"] as const;
const PUBLIC_READ_STATES = new Set(["open", "full", "waitlist", "started", "completed"]);

function user(label: string): string {
  const id = seedUser(`${TAG}${label}`);
  users.push(id);
  return id;
}

function trail(): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trails (id, slug, title, lifecycle_status) VALUES ('${id}', '${TAG}-${id.slice(0, 8)}', '${TAG} ${id.slice(0, 8)}', 'active');`);
  trailIds.push(id);
  return id;
}

function event(host: string, visibility = "public", state = "open", gates = ""): string {
  const id = randomUUID();
  exec(`INSERT INTO public.events (id, title, host_id, visibility, state) VALUES ('${id}', '${TAG} event', '${host}', '${visibility}', '${state}');`
    + (gates ? `\nUPDATE public.events SET ${gates} WHERE id = '${id}';` : ""));
  return id;
}

/**
 * `trg_trip_owner_member` gives a new trip's owner a membership row. Production
 * also holds trips whose owner has NONE (5 of 43 when 2334 was measured), the
 * case requireTripMember answers from `trips.owner_id`; `ownerRow: false`
 * models it, so the owner fallback — and its `trips` read — is exercised.
 */
function trip(owner: string, opts: { ownerRow?: boolean } = {}): string {
  const id = randomUUID();
  exec(`INSERT INTO public.trips (id, owner_id, title, destination_city) VALUES ('${id}', '${owner}', '${TAG} trip', 'Bangkok');`
    + (opts.ownerRow === false ? `\nDELETE FROM public.trip_members WHERE trip_id = '${id}' AND user_id = '${owner}';` : ""));
  return id;
}

function crew(tripId: string, userId: string, role = "member", status = "accepted"): void {
  exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${userId}', '${role}', '${status}');`);
}

function route(owner: string, status = "active", tripId: string | null = null): string {
  const id = randomUUID();
  // 2224's route_plans_accepted_requires_evidence: an active or completed plan carries the acceptance that produced it.
  const accepted = status === "active" || status === "completed" ? `now(), '${owner}'` : "NULL, NULL";
  exec(`INSERT INTO public.route_plans (id, owner_user_id, title, status, trip_id, accepted_at, accepted_by_user_id)
        VALUES ('${id}', '${owner}', '${TAG} route', '${status}', ${tripId ? `'${tripId}'` : "NULL"}, ${accepted});`);
  return id;
}

/** A membership row written straight to the table (the label-cap trigger still runs). */
function member(trailId: string, sourceType: string, sourceId: string, contributor: string): string {
  return scalar(`INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, source, confidence, contributor_id)
                 VALUES ('${trailId}', '${sourceType}', '${sourceId}', 'supporting', 'user', 0.8, '${contributor}') RETURNING id;`)!;
}

const membersOf = (trailId: string) => rows<MemberRow>(
  `SELECT id, trail_id, source_type, source_id, relationship, signal, source, confidence::float8 AS confidence, contributor_id, content_state, created_at
     FROM public.content_trails WHERE trail_id = '${trailId}' ORDER BY created_at, id`);

function surge(itemId: string, n = 8): void {
  exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, outcome_at, surface, schema_version, privacy_class)
        SELECT '${users[0]}', '${itemId}', 'gem', 0, '{}'::jsonb, 'save', now() - make_interval(mins => 60) - make_interval(secs => g),
               now() - make_interval(mins => 59) - make_interval(secs => g), 'discovery', 1, 'raw_behavioral_event'
          FROM generate_series(1, ${n}) g;`);
}

function useBridge(opts: BridgeOptions = {}) {
  const bridge = makeTrailBridge(opts);
  _setTestClient(bridge.client, true);
  return bridge;
}

async function served(bridgeOpts: BridgeOptions, members: MemberRow[], viewer: string | null, unread?: Set<string>): Promise<Set<string>> {
  const bridge = makeTrailBridge(bridgeOpts);
  return new Set((await servableMembers(bridge.client, members, viewer, Date.now(), unread)).map((m) => m.source_id));
}

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";

async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

const moduleSourceIds = async (t: string, as: string) => new Set<string>(
  (await call("GET", `/v1/discovery/trails/${t}/modules`, as)).body.modules.flatMap((m: any) => m.items.map((i: any) => i.sourceId)));

before(async () => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT to_regclass('public.trails') IS NOT NULL;"), "t", "2910 must be applied");
  assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'events' AND policyname = 'events_public_read';"), "1", "2033's events_public_read must be present");
  assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'route_plans' AND qual LIKE '%is_trip_crew%';"), "1", "2334's route_plans_member_select must be present");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
    server.listen(0, "127.0.0.1");
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  if (!HAVE_DB) return;
  server.close();
  _clearTestClient();
  exec(`DELETE FROM public.trails WHERE slug LIKE '${TAG}-%';`);
  exec(`DELETE FROM public.event_roles WHERE event_id IN (SELECT id FROM public.events WHERE title = '${TAG} event');
        DELETE FROM public.event_rsvps WHERE event_id IN (SELECT id FROM public.events WHERE title = '${TAG} event');
        DELETE FROM public.events WHERE title = '${TAG} event';`);
  for (const id of users) {
    exec(`DELETE FROM public.rank_events WHERE user_id = '${id}';
          DELETE FROM public.route_plans WHERE owner_user_id = '${id}';
          DELETE FROM public.user_friendships WHERE user_a = '${id}' OR user_b = '${id}';
          DELETE FROM public.trip_members WHERE user_id = '${id}';`);
  }
  for (const id of users) exec(`DELETE FROM public.trips WHERE owner_id = '${id}';`);
  for (const id of users) exec(`DELETE FROM public.profiles WHERE id = '${id}';\nDELETE FROM auth.users WHERE id = '${id}';`);
});

describe("TV — §64: a Trail serves events and routes only as the product would", { skip: !HAVE_DB }, () => {
  test("TV1. events: every visibility × every state × six viewers; the stranger's view IS 2033's events_public_read", async () => {
    const [host, stranger, friend, invitee, cohost] = [user("m1h"), user("m1s"), user("m1f"), user("m1i"), user("m1c")];
    exec(`INSERT INTO public.user_friendships (user_a, user_b) VALUES ('${host}', '${friend}');`);
    const t = trail();
    const byId = new Map<string, { visibility: string; state: string }>();
    for (const visibility of ["public", "friends_only", "invite_only"]) {
      for (const state of EVENT_STATES) {
        const e = event(host, visibility, state);
        byId.set(e, { visibility, state });
        exec(`INSERT INTO public.event_rsvps (event_id, user_id, status) VALUES ('${e}', '${invitee}', 'going');
              INSERT INTO public.event_roles (event_id, user_id, role) VALUES ('${e}', '${cohost}', 'co_host');`);
        member(t, "event", e, host);
      }
    }
    const members = membersOf(t);
    assert.equal(members.length, 24);
    const publicRead = new Set([...byId].filter(([, v]) => v.visibility === "public" && PUBLIC_READ_STATES.has(v.state)).map(([id]) => id));
    assert.equal(publicRead.size, 5);

    const viewers: Array<[string, string | null, Set<string>]> = [
      ["anonymous", null, publicRead], ["host", host, new Set(byId.keys())], ["stranger", stranger, publicRead],
      ["friend", friend, publicRead], ["invitee", invitee, publicRead], ["co-host", cohost, publicRead],
    ];
    for (const [who, viewer, expected] of viewers) {
      assert.deepEqual([...await served({}, members, viewer)].sort(), [...expected].sort(), who);
    }

    // The rule IS the database's own for a stranger: RLS (2033) admits exactly these.
    const ids = [...byId.keys()].map((id) => `'${id}'`).join(",");
    const rlsStranger = new Set(asUser(stranger, `SELECT id FROM public.events WHERE id IN (${ids});`));
    assert.deepEqual([...rlsStranger].sort(), [...publicRead].sort(), "events_public_read and the Trail disagree for a stranger");
    // A friend with no RSVP is not a participant: RLS admits them no more than a stranger.
    assert.deepEqual([...new Set(asUser(friend, `SELECT id FROM public.events WHERE id IN (${ids});`))].sort(), [...publicRead].sort());
    // RLS admits a PARTICIPANT to every one of these events (events_participant_read); the Trail does not resolve
    // participation in a public space, as it does not for a post's trip members. Recorded, and deliberate.
    assert.equal(asUser(invitee, `SELECT id FROM public.events WHERE id IN (${ids});`).length, 24);
  });

  test("TV2. events: a viewer gate (age, trust, verified) is its host's only; a banned viewer is withheld", async () => {
    const [host, stranger, banned] = [user("m2h"), user("m2s"), user("m2b")];
    const t = trail();
    const gated = [event(host, "public", "open", "age_min = 18"), event(host, "public", "open", "trust_score_min = 60"), event(host, "public", "open", "verified_only = true")];
    const open = event(host);
    exec(`INSERT INTO public.event_roles (event_id, user_id, role) VALUES ('${open}', '${banned}', 'banned');`);
    for (const e of [...gated, open]) member(t, "event", e, host);
    const members = membersOf(t);
    assert.deepEqual([...await served({}, members, stranger)], [open]);
    assert.deepEqual([...await served({}, members, null)], [open]);
    assert.deepEqual([...await served({}, members, banned)], []);
    assert.equal((await served({}, members, host)).size, 4);
  });

  test("TV3. routes: every status × with and without a trip × eight viewers; the crew's view is 2334's RLS minus draft and cancelled", async () => {
    const [owner, stranger, crewMate, pending, removed, tripOwner] = [user("m3o"), user("m3s"), user("m3c"), user("m3p"), user("m3r"), user("m3t")];
    const tr = trip(tripOwner, { ownerRow: false });
    crew(tr, owner);
    crew(tr, crewMate);
    crew(tr, pending, "member", "invited");
    crew(tr, removed, "member", "removed");
    const t = trail();
    const byId = new Map<string, { status: string; trip: boolean }>();
    for (const status of ["draft", "active", "completed", "cancelled"]) {
      for (const withTrip of [false, true]) {
        const r = route(owner, status, withTrip ? tr : null);
        byId.set(r, { status, trip: withTrip });
        member(t, "route", r, owner);
      }
    }
    const members = membersOf(t);
    const all = new Set(byId.keys());
    const crewSees = new Set([...byId].filter(([, v]) => v.trip && (v.status === "active" || v.status === "completed")).map(([id]) => id));
    assert.equal(crewSees.size, 2);
    const viewers: Array<[string, string | null, Set<string>]> = [
      ["owner", owner, all], ["stranger", stranger, new Set()], ["anonymous", null, new Set()],
      ["accepted crew", crewMate, crewSees], ["pending invitee", pending, new Set()], ["removed member", removed, new Set()],
      ["trip owner with no membership row", tripOwner, crewSees],
    ];
    for (const [who, viewer, expected] of viewers) {
      assert.deepEqual([...await served({}, members, viewer)].sort(), [...expected].sort(), who);
    }
    const ids = [...byId.keys()].map((id) => `'${id}'`).join(",");
    const rlsCrew = new Set(asUser(crewMate, `SELECT id FROM public.route_plans WHERE id IN (${ids});`));
    const tripRoutes = [...byId].filter(([, v]) => v.trip).map(([id]) => id);
    assert.deepEqual([...rlsCrew].sort(), tripRoutes.sort(), "2334 admits the crew to every trip route");
    assert.deepEqual(asUser(stranger, `SELECT id FROM public.route_plans WHERE id IN (${ids});`), [], "and a stranger to none");
    assert.ok([...crewSees].every((id) => rlsCrew.has(id)), "the Trail never serves what RLS would refuse");
  });

  test("TV4. cross-viewer: A attaches A's own friends-only event and draft route; only A is served them; B's suggestion is refused as a ghost is", async () => {
    useBridge();
    const [a, b, friendOfA] = [user("m4a"), user("m4b"), user("m4f")];
    exec(`INSERT INTO public.user_friendships (user_a, user_b) VALUES ('${a}', '${friendOfA}');`);
    const t = trail();
    const [e, r] = [event(a, "friends_only", "open"), route(a, "draft")];
    const attached = await call("POST", `/v1/discovery/trails/${t}/content`, a, {
      labels: [{ sourceType: "event", sourceId: e, relationship: "supporting" }, { sourceType: "route", sourceId: r, relationship: "supporting" }],
    });
    assert.equal(attached.status, 201, attached.text);
    assert.equal(attached.body.attached, 2);
    assert.deepEqual([...await moduleSourceIds(t, a)].sort(), [e, r].sort());
    assert.deepEqual([...await moduleSourceIds(t, b)], []);
    assert.deepEqual([...await moduleSourceIds(t, friendOfA)], [], "a friend of A is not resolved in a public space");

    const t2 = trail();
    const seen = await call("POST", `/v1/discovery/trails/${t2}/suggestions`, b, { labels: [{ sourceType: "event", sourceId: e, relationship: "supporting" }] });
    const ghost = await call("POST", `/v1/discovery/trails/${t2}/suggestions`, b, { labels: [{ sourceType: "event", sourceId: randomUUID(), relationship: "supporting" }] });
    assert.equal(seen.status, 409);
    assert.equal(seen.status, ghost.status);
    assert.equal(seen.body.error, ghost.body.error);
    assert.deepEqual(seen.body.contentRefusals.map((x: any) => x.reason), ["unknown_content"]);
    assert.equal(Number(scalar(`SELECT count(*) FROM public.content_trails WHERE trail_id = '${t2}';`)), 0);
  });

  test("TV5. revocation both ways, by UPDATE, with no cache between reads", async () => {
    useBridge();
    const [host, stranger] = [user("m5h"), user("m5s")];
    const t = trail();
    const e = event(host);
    member(t, "event", e, host);
    assert.deepEqual([...await moduleSourceIds(t, stranger)], [e]);
    exec(`UPDATE public.events SET visibility = 'friends_only' WHERE id = '${e}';`);
    assert.deepEqual([...await moduleSourceIds(t, stranger)], [], "public → friends_only is honoured on the next read");
    exec(`UPDATE public.events SET visibility = 'public' WHERE id = '${e}';`);
    assert.deepEqual([...await moduleSourceIds(t, stranger)], [e], "friends_only → public is honoured on the next read");
    exec(`UPDATE public.events SET state = 'cancelled' WHERE id = '${e}';`);
    assert.deepEqual([...await moduleSourceIds(t, stranger)], [], "a cancellation is honoured on the next read");
    assert.deepEqual([...await moduleSourceIds(t, host)], [e], "and the host still sees their own");
  });

  test("TV6. failed reads: event_roles, trip_members and trips each withhold, are named, and admit nothing at attach", async () => {
    const [host, stranger, owner, crewMate, tripOwner] = [user("m6h"), user("m6s"), user("m6o"), user("m6c"), user("m6t")];
    const tr = trip(tripOwner, { ownerRow: false });
    crew(tr, crewMate);
    const t = trail();
    const e = event(host);
    const r = route(owner, "active", tr);
    member(t, "event", e, host);
    member(t, "route", r, owner);
    const members = membersOf(t);
    const timeout = { code: "57014", message: "canceling statement due to statement timeout" };
    const cases: Array<[string, string, string]> = [["event_roles", stranger, e], ["trip_members", crewMate, r], ["trips", tripOwner, r]];
    for (const [table, viewer, id] of cases) {
      assert.ok((await served({}, members, viewer)).has(id), `${table}: the control`);
      const unread = new Set<string>();
      assert.ok(!(await served({ failTables: { [table]: timeout } }, members, viewer, unread)).has(id), `${table}: served on a failed read`);
      assert.deepEqual([...unread], [table]);
    }
    // The owner and the host need no such read.
    assert.ok((await served({ failTables: { event_roles: timeout, trip_members: timeout, trips: timeout } }, members, host)).has(e));
    assert.ok((await served({ failTables: { event_roles: timeout, trip_members: timeout, trips: timeout } }, members, owner)).has(r));

    const t2 = trail();
    for (const [table, as, sourceType, sourceId] of [["event_roles", stranger, "event", e], ["trip_members", crewMate, "route", r], ["trips", tripOwner, "route", r]]) {
      useBridge({ failTables: { [table]: timeout } });
      const res = await call("POST", `/v1/discovery/trails/${t2}/suggestions`, as, { labels: [{ sourceType, sourceId, relationship: "supporting" }] });
      assert.equal(res.status, 503, `${table}: ${res.text}`);
      assert.equal(res.body.message, "the content could not be verified; nothing was attached");
    }
    assert.equal(Number(scalar(`SELECT count(*) FROM public.content_trails WHERE trail_id = '${t2}';`)), 0);
  });

  test("TV7. counts: memberCount and …/trending reveal no withheld member; a Trail of withheld members answers as an empty one", async () => {
    useBridge();
    const [host, stranger] = [user("m7h"), user("m7s")];
    const t = trail();
    const open = event(host);
    const hidden = event(host, "invite_only", "open");
    member(t, "event", open, host);
    member(t, "event", hidden, host);
    assert.equal((await call("GET", `/v1/discovery/trails/${t}`, stranger)).body.memberCount, 1);
    assert.equal((await call("GET", `/v1/discovery/trails/${t}`, host)).body.memberCount, 2);

    const onlyHidden = trail();
    const hidden2 = event(host, "friends_only", "open");
    member(onlyHidden, "event", hidden2, host);
    surge(hidden2);
    const empty = trail();
    const a = await call("GET", `/v1/discovery/trails/${onlyHidden}/trending`, stranger);
    const b = await call("GET", `/v1/discovery/trails/${empty}/trending`, stranger);
    assert.equal(a.status, 200);
    assert.equal(a.text, b.text, "the withheld member's existence or its surge leaked through …/trending");
    assert.equal((await call("GET", `/v1/discovery/trails/${onlyHidden}/trending`, host)).body.trending, true, "the control: the host's own surge is a reading");
    assert.equal((await call("GET", `/v1/discovery/trails/${onlyHidden}`, stranger)).body.memberCount, 0);
  });

  test("TV8. retries: the same request twice is the same bytes", async () => {
    useBridge();
    const [owner, crewMate, host] = [user("m8o"), user("m8c"), user("m8h")];
    const tr = trip(owner);
    crew(tr, crewMate);
    const t = trail();
    member(t, "route", route(owner, "active", tr), owner);
    member(t, "event", event(host), host);
    const first = await call("GET", `/v1/discovery/trails/${t}/modules`, crewMate);
    const second = await call("GET", `/v1/discovery/trails/${t}/modules`, crewMate);
    assert.equal(first.status, 200);
    assert.equal(first.body.modules[0].items.length, 2);
    assert.equal(first.text, second.text);
    const d1 = await call("GET", `/v1/discovery/trails/${t}`, crewMate);
    const d2 = await call("GET", `/v1/discovery/trails/${t}`, crewMate);
    assert.equal(d1.text, d2.text);
    assert.equal(d1.body.memberCount, 2);
    // A retry after a partial failure is the healthy answer again: nothing remembers the failure.
    useBridge({ failTables: { trip_members: { code: "57014", message: "canceling statement due to statement timeout" } } });
    const degraded = await call("GET", `/v1/discovery/trails/${t}/modules`, crewMate);
    assert.equal(degraded.body.modules[0].items.length, 1, "the route is withheld while its crew cannot be read");
    useBridge();
    assert.equal((await call("GET", `/v1/discovery/trails/${t}/modules`, crewMate)).text, first.text);
  });
});
