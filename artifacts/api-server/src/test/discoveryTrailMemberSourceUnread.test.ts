/**
 * census-discovery §105 (DV-83 round 9, register D-W11X2-60): the Discovery Trail
 * read routes when a member SOURCE read fails.
 *
 * `servableMembers` withholds every member of a table whose read failed (fail closed,
 * §64) and names the read in its `unread` set. Before §105 no read path passed that
 * set, so GET …/:id/modules, …/trending, …/:id and the two "more" routes served a
 * timed-out read as a complete Trail: 200, no refusal, a measured `trending: false`,
 * "Quiet right now" over one member of two. The independent round-8 verifier's probe
 * (V8-TR0..3) is copied in here as TR0..TR3; the rest pin the other paths.
 *
 * The refusal names ONE generic source, `trail_member_sources`, and never the table:
 * which read failed would tell a viewer what KIND of member a Trail holds, and §64's
 * rule is that a member withheld for privacy is indistinguishable from an absent one.
 * A privacy withhold is not a failed read and draws no refusal (TR6).
 *
 * Harness (makeDb, trail, member, event) copied from discoveryTrailMemberVisibility.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import trailsRouter from "../routes/trails.js";
import { getTrail, encodeMemberCursor, type MemberRow } from "../services/trails/TrailService.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";

const u = (n: string) => `11111111-1111-4111-8111-1111111111${n}`;
const HOST = u("f1");
const STRANGER = u("f2");
const PEOPLE = [HOST, STRANGER];
const T = "22222222-2222-4222-8222-2222222222f1";
const EVENT = "66666666-6666-4666-8666-6666666666f1";
const PLACE = "33333333-3333-4333-8333-3333333333f1";
const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
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
      lt(c: string, v: any) { filters.push((r) => String(r[c] ?? "") < String(v)); return b; },
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

const app = express();
app.use(express.json());
app.use(trailsRouter);
const server = http.createServer(app);
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server.close(); _clearTestClient(); });
async function call(path: string, as: string): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${as}` } });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}
const surge = () => Array.from({ length: 8 }, (_, i) => ({
  id: `re${i}`, surface: "discovery", item_id: EVENT, outcome: "save", served_at: ago(3_600_000 + i), outcome_at: ago(3_500_000 + i),
}));
const seed = (over: Record<string, Row[]> = {}) => ({
  trails: [trail()],
  content_trails: [
    member("m-pl", { source_type: "place", source_id: PLACE, contributor_id: null, created_at: ago(9 * 86_400_000) }),
    member("m-e", { created_at: ago(3_600_000) }),
  ],
  events: [event()], rank_events: surge(), ...over,
});
const saidIncomplete = (b: any) => b?.refusal != null || b?.partial === true || b?.coverage != null;
const MODULES = `/v1/discovery/trails/${T}/modules`;
const TRENDING = `/v1/discovery/trails/${T}/trending`;
const DETAIL = `/v1/discovery/trails/${T}`;
const MORE = `/v1/discovery/trails/${T}/more`;
const PLACE_MORE = `/v1/discovery/trails/${T}/places/${PLACE}/more`;
const itemIds = (b: any) => (b?.modules ?? []).flatMap((m: any) => m.items.map((i: any) => i.id));

/** The one refusal shape every Trail read answers a failed member read with. */
function assertMemberRefusal(b: any, route: string, coverage: "partial" | "nothing"): void {
  assert.ok(b?.refusal, "a refusal travels beside the body");
  assert.equal(b.refusal.class, "transient_db");
  assert.equal(b.refusal.code, "trail_member_sources_unread");
  assert.equal(b.refusal.route, route);
  assert.equal(b.refusal.coverage, coverage);
  assert.deepEqual(b.refusal.failedSources, ["trail_member_sources"], "one generic source: never the table, so never the kind of member");
}
const NO_TABLE_NAMES = /"(posts|events|route_plans|discovery_places|profiles|blocks|event_roles|trip_members)"/;

describe("census-discovery §105 (DV-83, D-W11X2-60): a Trail read with a member source unread", () => {
  it("TR0 CONTROL: healthy reads serve the public event member everywhere, with no refusal", async () => {
    _setTestClient(makeDb(seed()), true);
    const mods = await call(MODULES, STRANGER);
    const trend = await call(TRENDING, STRANGER);
    const detail = await call(DETAIL, STRANGER);
    assert.ok(itemIds(mods.body).includes("m-e"));
    assert.equal(trend.body.trending, true);
    assert.equal(detail.body.memberCount, 2);
    for (const r of [mods, trend, detail]) { assert.equal(r.status, 200); assert.ok(!("refusal" in r.body), "a healthy read carries no refusal key: its bytes are unchanged"); }
  });

  it("TR1 (V8-TR1) GET …/:id/modules: the events read fails → the place member is served as PARTIAL, never a complete page", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(MODULES, STRANGER);
    assert.equal(r.status, 200);
    assert.ok(!itemIds(r.body).includes("m-e"), "the unverified member stays withheld (fail closed, §64)");
    assert.ok(itemIds(r.body).includes("m-pl"), "the member that was read is served");
    assert.ok(saidIncomplete(r.body), "a failed events read is served as a complete Trail page");
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/modules", "partial");
    assert.doesNotMatch(r.text, NO_TABLE_NAMES);
  });

  it("TR1b GET …/:id/modules: every member source unread → coverage nothing", async () => {
    _setTestClient(makeDb(seed(), ["events", "discovery_places"]), true);
    const r = await call(MODULES, STRANGER);
    assert.equal(r.status, 200);
    assert.deepEqual(itemIds(r.body), []);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/modules", "nothing");
  });

  it("TR2 (V8-TR2) GET …/:id/trending: the events read fails → trending is unknown (null), never a measured false", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(TRENDING, STRANGER);
    assert.equal(r.status, 200);
    assert.ok(!(r.body.trending === false && r.body.items.length === 0 && !saidIncomplete(r.body)),
      "a failed events read is served as a measured 'not trending' with an empty list");
    assert.equal(r.body.trending, null);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/trending", "nothing");
    assert.doesNotMatch(r.text, NO_TABLE_NAMES);
    assert.doesNotMatch(r.text, /momentum/, "`11` §4's tripwire still holds on the refusal path");
  });

  it("TR2b GET …/:id/trending: nothing servable because the only member's read failed → still null, not the empty Trail's false", async () => {
    _setTestClient(makeDb(seed({ content_trails: [member("m-e", { created_at: ago(3_600_000) })] }), ["events"]), true);
    const r = await call(TRENDING, STRANGER);
    assert.equal(r.body.trending, null);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/trending", "nothing");
  });

  it("TR3 (V8-TR3) GET …/:id: the events read fails → no count or §12 word over a short member set", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(DETAIL, STRANGER);
    assert.equal(r.status, 200);
    assert.ok(!(r.body.memberCount === 1 && !saidIncomplete(r.body)), "a failed events read is served as memberCount 1 of 2");
    assert.equal(r.body.memberCount, null, "an unmeasured count is not stated");
    assert.equal(r.body.status, null, "nor is a §12 word computed over it");
    assert.equal(r.body.trail.id, T, "the Trail itself was read and is served");
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id", "partial");
  });

  it("TR4 GET …/:id/more: the events read fails → a refusal, never a complete 'nothing held back'", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(MORE, STRANGER);
    assert.equal(r.status, 200);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/more", "nothing");
  });

  it("TR5 GET …/:id/places/:placeId/more: the events read fails → a refusal", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(PLACE_MORE, STRANGER);
    assert.equal(r.status, 200);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/places/:placeId/more", "nothing");
  });

  it("TR6 a PRIVACY withhold is not a failed read: a friends-only event draws no refusal (§64: withheld = absent)", async () => {
    _setTestClient(makeDb(seed({ events: [event({ visibility: "friends_only" })] })), true);
    const withheld = await call(MODULES, STRANGER);
    _setTestClient(makeDb(seed({ content_trails: [member("m-pl", { source_type: "place", source_id: PLACE, contributor_id: null, created_at: ago(9 * 86_400_000) })], events: [] })), true);
    const absent = await call(MODULES, STRANGER);
    assert.ok(!("refusal" in withheld.body));
    assert.deepEqual(itemIds(withheld.body), itemIds(absent.body), "a withheld member reads exactly as an absent one");
    _setTestClient(makeDb(seed({ events: [event({ visibility: "friends_only" })] })), true);
    for (const p of [TRENDING, DETAIL, MORE]) assert.ok(!("refusal" in (await call(p, STRANGER)).body), `${p}: no refusal for a privacy withhold`);
  });

  it("TR7 the viewer's block list unread → a refusal (every person-carrying member was withheld)", async () => {
    _setTestClient(makeDb(seed(), ["blocks"]), true);
    const r = await call(MODULES, STRANGER);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/modules", "partial");
  });

  it("TR8 creator standing unread → the detail read names it (service level: the route's auth reads profiles too)", async () => {
    const r = await getTrail(makeDb(seed(), ["profiles"]), T, Date.now(), { viewerId: STRANGER });
    assert.equal(r.refusal, null);
    assert.deepEqual(r.membersUnread, ["profiles"], "internally named, so the route can refuse; the wire names only trail_member_sources");
    const ok = await getTrail(makeDb(seed()), T, Date.now(), { viewerId: STRANGER });
    assert.ok(!("membersUnread" in ok));
  });

  it("TR9 a recovered read serves the complete page again (the refusal does not stick)", async () => {
    const good = makeDb(seed());
    _setTestClient(good, true);
    const a = await call(MODULES, STRANGER);
    _setTestClient(makeDb(seed(), ["events"]), true);
    assert.ok((await call(MODULES, STRANGER)).body.refusal);
    _setTestClient(good, true);
    const again = await call(MODULES, STRANGER);
    assert.ok(!("refusal" in again.body));
    assert.deepEqual(again.body.modules, a.body.modules);
  });
});

// ── §105 sweep (D-W11X2-60): the Trail's ACTIVITY read (`rank_events`) ──
// `trending_now`'s order, §9's exploration denominators and GET …/trending's list are read
// from `rank_events`. A failed read left `trending_now` and the trending list EMPTY with no
// refusal (only `readingProvenance: null` hinted at it). It is now refused as `trail_activity`
// — not a member source, and naming it discloses nothing about the Trail's members.
describe("census-discovery §105 sweep (DV-83, D-W11X2-60): the Trail activity read unread", () => {
  it("TR10 GET …/:id/modules: rank_events fails → the members are served, refused partial naming trail_activity", async () => {
    _setTestClient(makeDb(seed(), ["rank_events"]), true);
    const r = await call(MODULES, STRANGER);
    assert.equal(r.status, 200);
    assert.ok(itemIds(r.body).includes("m-e"));
    assert.equal(r.body.refusal?.coverage, "partial");
    assert.deepEqual(r.body.refusal?.failedSources, ["trail_activity"]);
  });

  it("TR11 GET …/:id/trending: rank_events fails → trending unknown and the empty list refused, naming trail_activity", async () => {
    _setTestClient(makeDb(seed(), ["rank_events"]), true);
    const r = await call(TRENDING, STRANGER);
    assert.equal(r.body.trending, null);
    assert.deepEqual(r.body.items, []);
    assert.equal(r.body.refusal?.coverage, "nothing", "an empty list over a failed activity read is not 'nothing is surging'");
    assert.deepEqual(r.body.refusal?.failedSources, ["trail_activity"]);
  });

  it("TR12 both a member source and the activity read fail → both generic sources, in order", async () => {
    _setTestClient(makeDb(seed(), ["events", "rank_events"]), true);
    const r = await call(MODULES, STRANGER);
    assert.deepEqual(r.body.refusal?.failedSources, ["trail_member_sources", "trail_activity"]);
  });
});

// ── §105: the paths a mutation must not slip through ──
// The window cursor ("members older than the window", §86.14), the exploration branch
// (3485's flag on), and a trending read refused after the modules read succeeded.
describe("census-discovery §105 (DV-83, D-W11X2-60): cursor pages, exploration, and a refused trending read", () => {
  const cursor = () => encodeMemberCursor({ created_at: new Date(Date.now() - 1000).toISOString(), id: "99999999-9999-4999-8999-999999999999" });

  it("TR13 GET …/:id/more?cursor=: the events read fails → a refusal on the older-members page", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(`${MORE}?cursor=${cursor()}`, STRANGER);
    assert.equal(r.status, 200, r.text);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/more", "partial");
  });

  it("TR14 GET …/:id/places/:placeId/more?cursor=: the events read fails → a refusal", async () => {
    _setTestClient(makeDb(seed(), ["events"]), true);
    const r = await call(`${PLACE_MORE}?cursor=${cursor()}`, STRANGER);
    assert.equal(r.status, 200, r.text);
    assertMemberRefusal(r.body, "GET /v1/discovery/trails/:id/places/:placeId/more", "partial");
  });

  it("TR14c CONTROL: the same cursor pages with every read healthy carry no refusal", async () => {
    _setTestClient(makeDb(seed()), true);
    for (const p of [`${MORE}?cursor=${cursor()}`, `${PLACE_MORE}?cursor=${cursor()}`]) {
      const r = await call(p, STRANGER);
      assert.equal(r.status, 200, r.text);
      assert.ok(!("refusal" in r.body), p);
    }
  });

  it("TR15 exploration on (3485): the events read fails → partial; the activity read fails → trail_activity", async () => {
    const flags = { feature_flags: [{ flag: "discovery_trail_exploration_enabled", enabled: true }] };
    _setTestClient(makeDb(seed(flags), ["events"]), true);
    const m = await call(MODULES, STRANGER);
    assertMemberRefusal(m.body, "GET /v1/discovery/trails/:id/modules", "partial");
    _setTestClient(makeDb(seed(flags), ["rank_events"]), true);
    const a = await call(MODULES, STRANGER);
    assert.deepEqual(a.body.refusal?.failedSources, ["trail_activity"]);
    _setTestClient(makeDb(seed(flags)), true);
    assert.ok(!("refusal" in (await call(MODULES, STRANGER)).body), "CONTROL: exploration on, every read healthy");
  });

  it("TR16 GET …/:id/more: the trending read is refused after the modules read succeeded → refused, never a list set missing trending", async () => {
    const db = makeDb(seed());
    let trailReads = 0;
    const from = db.from;
    _setTestClient({ ...db, from: (t: string) => {
      if (t === "trails" && ++trailReads >= 2) return makeDb(seed(), ["trails"]).from(t);
      return from(t);
    } }, true);
    const r = await call(MORE, STRANGER);
    assert.notEqual(r.status, 200, `a refused trending read was dropped from the lists silently: ${r.text}`);
  });
});
