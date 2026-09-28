/**
 * census-discovery §53 — A24: Invisible mode on every Discovery PEOPLE surface,
 * and the opt-out read that answered an outage with a silent `[]`.
 *
 * Telegraph :621 — *"Unavailable or Invisible revokes Nearby, Discovery, and
 * Compass availability projections promptly."* `lib/invisibleMode.ts` is the one
 * definition of Invisible (location off, sharing paused, or discovery visibility
 * `nobody`; an unreadable row engages it). Discovery's people search read only
 * `allow_profile_discovery`, so an invisible person was still listed.
 *
 * Every people surface is covered, for two different viewers:
 *   GET /discovery/search?type=travelers | buddies | all
 *   GET /discovery/suggest (the Travelers and Buddies groups)
 *   GET /discovery/people/:userId/passport (the card a row opens)
 *
 * and the negative paths the row asks for: cross-viewer denial, revocation in
 * BOTH directions on the very next request (nothing is cached), the state read
 * failing (withheld AND reported), the same request twice, and the viewer never
 * hidden from themself.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryPeopleInvisible.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { readDiscoveryInvisiblePeople, withDiscoveryInvisibleGate } from "../lib/discoveryPeoplePrivacy.js";
import {
  VIEWER,
  VIEWER_TOKEN,
  emptyCalls,
  emptyState,
  kitGet,
  makeKitClient,
  startKitServer,
  type KitState,
} from "./discoverySearchTestKit.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

// ── The cast ─────────────────────────────────────────────────────────────────
const V1 = VIEWER;                                   // viewer one (the kit's)
const V2 = "aa000000-0000-4000-a000-000000000002";   // viewer two
const TOK2 = "tok-viewer-two";
const VIS = "c1000000-0000-4000-a000-000000000001";  // explicit visible consent row
const DEF = "c2000000-0000-4000-a000-000000000002";  // no consent row (product default)
const OFF = "c3000000-0000-4000-a000-000000000003";  // location_mode = off
const PAU = "c4000000-0000-4000-a000-000000000004";  // sharing_paused = true
const NOB = "c5000000-0000-4000-a000-000000000005";  // discovery_visibility = nobody

const VISIBLE = [VIS, DEF];
const INVISIBLE = [OFF, PAU, NOB];
const PEOPLE = [...VISIBLE, ...INVISIBLE];
const NAME: Record<string, string> = { [VIS]: "vis", [DEF]: "def", [OFF]: "off", [PAU]: "paused", [NOB]: "nobody" };

const FUTURE = new Date(Date.now() + 20 * 86_400_000).toISOString();

function person(id: string, handle: string, buddy: boolean) {
  return {
    id, handle, username: handle, name: `Zork ${handle}`, display_name: null, avatar_url: null,
    is_private: false, home_city: null, home_country: null, account_status: "active", verified: false,
    is_official: false, show_profile_picture_publicly: true,
    buddy_verified_at: buddy ? "2026-01-01T00:00:00Z" : null,
  };
}

function marketplace(userId: string) {
  return {
    id: `rbp-${userId.slice(0, 8)}`, user_id: userId, categories: ["city"], category_approvals: {},
    nightlife_admin_approved: false, status: "active", admin_status: "active", risk_hold: false,
    risk_review_status: "normal", verification_status: "unverified", id_verified: false, phone_verified: false,
  };
}

function consentRows() {
  return [
    { user_id: VIS, location_mode: "city", sharing_paused: false, discovery_visibility: "everyone" },
    { user_id: OFF, location_mode: "off", sharing_paused: false, discovery_visibility: "everyone" },
    { user_id: PAU, location_mode: "city", sharing_paused: true, discovery_visibility: "everyone" },
    { user_id: NOB, location_mode: "city", sharing_paused: false, discovery_visibility: "nobody" },
  ];
}

function world(): KitState {
  return emptyState({
    rows: {
      profiles: [
        person(V1, "viewer_one", false),
        person(V2, "viewer_two", false),
        ...PEOPLE.map((id) => person(id, `zork_${NAME[id]}`, true)),
      ],
      location_preferences: consentRows(),
      rent_buddy_profiles: PEOPLE.map(marketplace),
      rent_buddy_user_limits: [],
      blocks: [], user_privacy_settings: [], profile_privacy_settings: [],
      user_follows: [], friend_requests: [], user_friendships: [], event_rsvps: [],
      // One non-people row, so a `partial` fan-out can be seen to still serve.
      events: [{
        id: "event-zork", title: "zork event", host_id: VIS, cover_url: null, city: "Lisbon", country: "PT",
        starts_at: FUTURE, visibility: "public", state: "open", created_at: "2026-01-01T00:00:00Z",
        location_lat: 38.7, location_lng: -9.1, show_exact_location: true,
      }],
      canonical_locations: [], hashtags: [], stamp_definitions: [],
    },
  });
}

let state: KitState;
let calls = emptyCalls();

function install(s: KitState = world()): KitState {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
  _resetRateLimit();
  state = s;
  calls = emptyCalls();
  const client: any = makeKitClient(state, calls);
  client.auth.getUser = async (tok: string) =>
    tok === VIEWER_TOKEN ? { data: { user: { id: V1 } }, error: null }
      : tok === TOK2 ? { data: { user: { id: V2 } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } };
  _setTestClient(client, true);
  return state;
}

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => server.close());

const peopleOnly = (ids: string[]) => ids.filter((id) => PEOPLE.includes(id));

async function search(type: string, token: string) {
  const { status, body } = await kitGet(base, `/discovery/search?q=zork&type=${type}&limit=50`, token);
  return { status, body, ids: ((body?.results ?? []) as any[]).map((r) => String(r.id)) };
}
async function suggest(token: string) {
  const { status, body } = await kitGet(base, `/discovery/suggest?q=zork`, token);
  const people = ((body?.groups ?? []) as any[])
    .filter((g) => g.type === "travelers" || g.type === "buddies")
    .flatMap((g) => (g.items as any[]).map((it) => String(it.id)));
  return { status, body, ids: people };
}

/** Every people surface, as the set of person ids each one served. */
async function surfaces(token: string): Promise<Record<string, string[]>> {
  const t = await search("travelers", token);
  const b = await search("buddies", token);
  const a = await search("all", token);
  const s = await suggest(token);
  for (const r of [t, b, a, s]) assert.equal(r.status, 200);
  return {
    travelers: peopleOnly(t.ids), buddies: peopleOnly(b.ids), all: peopleOnly(a.ids), suggest: peopleOnly(s.ids),
  };
}

describe("A24 — an invisible person is absent from every Discovery people surface, for every other viewer", () => {
  it("I1 each of the three Invisible reasons withholds the person on travelers, buddies, all and suggest — for BOTH viewers; the visible controls are served", async () => {
    for (const token of [VIEWER_TOKEN, TOK2]) {
      install();
      const got = await surfaces(token);
      for (const [surface, ids] of Object.entries(got)) {
        for (const inv of INVISIBLE) {
          assert.ok(!ids.includes(inv), `${token}: ${surface} served invisible person ${NAME[inv]}`);
        }
        for (const vis of VISIBLE) {
          assert.ok(ids.includes(vis), `${token}: ${surface} withheld visible person ${NAME[vis]} (control)`);
        }
      }
    }
  });

  it("I2 the consent read carries every candidate but never the viewer, and the same select list Telegraph's reachable-people query uses", async () => {
    install();
    await search("travelers", VIEWER_TOKEN);
    const reads = calls.selects.filter((s) => s.table === "location_preferences");
    assert.ok(reads.length >= 1, "the people search never read location consent — Invisible was not consulted");
    assert.deepEqual(reads.map((r) => r.cols), reads.map(() => "user_id, location_mode, sharing_paused, discovery_visibility"));
  });

  it("I3 revocation, invisible → visible: turning Invisible OFF restores the person on the very next request, on every surface", async () => {
    install();
    const first = await surfaces(TOK2);
    for (const ids of Object.values(first)) assert.ok(!ids.includes(OFF), "precondition: hidden");
    state.rows.location_preferences!.find((r) => r.user_id === OFF)!.location_mode = "city";
    const next = await surfaces(TOK2);
    for (const [surface, ids] of Object.entries(next)) {
      assert.ok(ids.includes(OFF), `${surface}: still hidden after Invisible was turned off — something kept the old answer`);
    }
  });

  it("I4 revocation, visible → invisible: going Invisible hides the person on the very next request, on every surface", async () => {
    install();
    const first = await surfaces(TOK2);
    for (const ids of Object.values(first)) assert.ok(ids.includes(VIS), "precondition: served");
    state.rows.location_preferences!.find((r) => r.user_id === VIS)!.sharing_paused = true;
    const next = await surfaces(TOK2);
    for (const [surface, ids] of Object.entries(next)) {
      assert.ok(!ids.includes(VIS), `${surface}: still served after the person went Invisible — something kept the old answer`);
    }
  });

  it("I5 the same request twice gives the same privacy result (retry-safe)", async () => {
    install();
    const a = await surfaces(VIEWER_TOKEN);
    const b = await surfaces(VIEWER_TOKEN);
    assert.deepEqual(b, a);
  });
});

describe("A24 — the consent read failing withholds everyone it covered AND says so", () => {
  const FAIL = { code: "57014", message: "canceling statement due to statement timeout" };

  it("F1 type=travelers and type=buddies: no person served, and a refusal — not a silent empty list", async () => {
    for (const type of ["travelers", "buddies"]) {
      const s = world(); s.errorTables.location_preferences = FAIL; install(s);
      const r = await search(type, VIEWER_TOKEN);
      assert.equal(r.status, 200);
      assert.deepEqual(peopleOnly(r.ids), [], `${type}: a person was served with their consent unreadable`);
      assert.equal(r.body.refusal?.class, "transient_db", `${type}: the empty list does not say it is a failure`);
      assert.equal(r.body.refusal?.coverage, "nothing");
    }
  });

  it("F2 type=all: the people buckets are withheld and NAMED; the rest of the answer is still served as `partial`", async () => {
    const s = world(); s.errorTables.location_preferences = FAIL; install(s);
    const r = await search("all", VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(peopleOnly(r.ids), []);
    assert.equal(r.body.refusal?.coverage, "partial");
    assert.ok(r.body.refusal.failedSources.includes("travelers") && r.body.refusal.failedSources.includes("buddies"),
      `failedSources must name the people buckets: ${JSON.stringify(r.body.refusal?.failedSources)}`);
    assert.ok(r.ids.includes("event-zork"), "the buckets that were read are a real result and stay served");
  });

  it("F3 /discovery/suggest: the Travelers and Buddies groups are withheld and named as `partial`", async () => {
    const s = world(); s.errorTables.location_preferences = FAIL; install(s);
    const r = await suggest(VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.ids, []);
    assert.equal(r.body.refusal?.coverage, "partial");
    assert.deepEqual(
      (r.body.refusal.failedSources as string[]).filter((x) => x === "travelers" || x === "buddies"),
      ["travelers", "buddies"],
    );
  });

  it("F4 a REJECTED consent read (network reset) is handled exactly like a resolved error", async () => {
    const s = world(); s.throwTables.add("location_preferences"); install(s);
    const r = await search("travelers", VIEWER_TOKEN);
    assert.deepEqual(peopleOnly(r.ids), []);
    assert.equal(r.body.refusal?.coverage, "nothing");
  });

  it("F5 recovery: the next request after the read heals serves the visible people again — no negative caching", async () => {
    const s = world(); s.errorTables.location_preferences = FAIL; install(s);
    assert.deepEqual(peopleOnly((await search("travelers", VIEWER_TOKEN)).ids), []);
    delete state.errorTables.location_preferences;
    const healed = await search("travelers", VIEWER_TOKEN);
    assert.deepEqual(peopleOnly(healed.ids).sort(), [...VISIBLE].sort());
    assert.equal(healed.body.refusal, undefined);
  });

  it("F6 CONTROL: a readable consent table with no invisible person carries NO refusal", async () => {
    const s = world(); s.rows.location_preferences = []; install(s);
    const r = await search("travelers", VIEWER_TOKEN);
    assert.equal(r.body.refusal, undefined);
    assert.deepEqual(peopleOnly(r.ids).sort(), [...PEOPLE].sort());
  });
});

describe("§53 residual 2 — the profile-discovery opt-out read no longer answers an outage with a silent `[]`", () => {
  const FAIL = { code: "57014", message: "canceling statement due to statement timeout" };
  /** Fail only the opt-out read (the query that names allow_profile_discovery). */
  function optOutUnreadable(): KitState {
    const s = world();
    s.errorOn = ({ table, named }) =>
      table === "profile_privacy_settings" && named.has("allow_profile_discovery") ? FAIL : null;
    return s;
  }

  it("O1 type=travelers and type=buddies refuse, instead of `200 { results: [] }`", async () => {
    for (const type of ["travelers", "buddies"]) {
      install(optOutUnreadable());
      const r = await search(type, VIEWER_TOKEN);
      assert.equal(r.status, 200);
      assert.deepEqual(r.ids, []);
      assert.deepEqual(
        { class: r.body.refusal?.class, code: r.body.refusal?.code, coverage: r.body.refusal?.coverage },
        { class: "transient_db", code: "search_failed", coverage: "nothing" },
        `${type}: an unreadable opt-out answered as "nobody matches"`,
      );
    }
  });

  it("O2 type=all and suggest name the people buckets as failed", async () => {
    install(optOutUnreadable());
    const a = await search("all", VIEWER_TOKEN);
    assert.ok(a.body.refusal?.failedSources?.includes("travelers"));
    assert.ok(a.body.refusal?.failedSources?.includes("buddies"));
    const s = await suggest(VIEWER_TOKEN);
    assert.ok(s.body.refusal?.failedSources?.includes("travelers"));
    assert.ok(s.body.refusal?.failedSources?.includes("buddies"));
  });

  it("O3 CONTROL: a readable opt-out table that excludes someone carries no refusal and still excludes them", async () => {
    const s = world();
    s.rows.profile_privacy_settings = [{ user_id: VIS, allow_profile_discovery: false, show_real_name: false }];
    install(s);
    const r = await search("travelers", VIEWER_TOKEN);
    assert.equal(r.body.refusal, undefined);
    assert.ok(!r.ids.includes(VIS));
    assert.ok(r.ids.includes(DEF));
  });
});

describe("A24 — the viewer is never hidden from themself", () => {
  it("S1 the consent reader never reads, and never withholds, the viewer's own id", async () => {
    const asked: string[][] = [];
    const sc = {
      from: () => ({
        select: () => ({
          in: async (_c: string, ids: string[]) => {
            asked.push([...ids]);
            return { data: ids.map((id) => ({ user_id: id, location_mode: "off" })), error: null };
          },
        }),
      }),
    };
    const r = await readDiscoveryInvisiblePeople(sc, [V1, OFF], V1);
    assert.equal(r.ok, true);
    assert.deepEqual(asked, [[OFF]], "the viewer's own consent was read on a surface that publishes OTHER people");
    assert.ok(r.ok && !r.hidden.has(V1));
    assert.ok(r.ok && r.hidden.has(OFF));
  });

  it("S2 with only the viewer as a candidate there is no read at all", async () => {
    let reads = 0;
    const sc = { from: () => { reads++; throw new Error("must not read"); } };
    const r = await readDiscoveryInvisiblePeople(sc, [V1], V1);
    assert.deepEqual(r, { ok: true, hidden: new Set() });
    assert.equal(reads, 0);
  });

  it("S3 the card gate short-circuits for the subject themself, even when their consent is unreadable", async () => {
    const sc = { from: () => { throw new Error("must not read"); } };
    assert.deepEqual(await withDiscoveryInvisibleGate(sc, OFF, OFF, { allowed: true }), { allowed: true });
  });
});

// ── The Discovery person card ────────────────────────────────────────────────

describe("A24 — GET /discovery/people/:userId/passport (the card a people row opens)", () => {
  const TOKENS: Record<string, string> = { t1: V1, t2: V2, tOff: OFF, tVis: VIS };

  function cardDb(opts: { failReads?: Record<string, { message: string }>; consent?: any[] } = {}) {
    const profiles = [V1, V2, ...PEOPLE].map((id) => ({
      ...person(id, `h_${id.slice(0, 4)}`, false),
      cover_photo_url: null, verified_at: null, verification_level: null, current_city: null,
      passport_visibility: "public", interests: [], availability_tags: [], spoken_languages: [],
      travel_pace: null, planning_style: null, budget_style: null, travel_group_style: [],
      open_to_meet: false, created_at: "2023-01-01",
    }));
    const client: any = makePassportDb({
      profiles,
      location_preferences: opts.consent ?? consentRows(),
      profile_privacy_settings: [], user_privacy_settings: [], blocks: [], user_account_states: [],
      feature_flags: [],
    }, { failReads: opts.failReads ?? {} });
    client.auth = {
      getUser: async (tok: string) => {
        const id = TOKENS[tok];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "no user" } };
      },
    };
    return client;
  }

  let cardServer: Server;
  let cardBase = "";
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
    app.use("/api", discoverySearchRouter);
    cardServer = createServer(app);
    await new Promise<void>((r) => cardServer.listen(0, "127.0.0.1", r));
    cardBase = `http://127.0.0.1:${(cardServer.address() as any).port}/api`;
  });
  after(() => cardServer.close());

  async function card(subject: string, token: string, client: any) {
    _resetRateLimit();
    _setTestClient(client, true);
    const r = await fetch(`${cardBase}/discovery/people/${subject}/passport`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() as any };
  }

  it("C1 an invisible subject's card is refused as not-found for BOTH other viewers, each reason; a visible subject's is served", async () => {
    for (const token of ["t1", "t2"]) {
      for (const inv of INVISIBLE) {
        const r = await card(inv, token, cardDb());
        assert.equal(r.status, 404, `${token}: the card of invisible ${NAME[inv]} was served`);
      }
      for (const vis of VISIBLE) {
        const r = await card(vis, token, cardDb());
        assert.equal(r.status, 200, `${token}: visible ${NAME[vis]} refused (control)`);
      }
    }
  });

  it("C2 the subject still sees their OWN card while invisible", async () => {
    const r = await card(OFF, "tOff", cardDb());
    assert.equal(r.status, 200, "Invisible hid a person from themself");
    assert.equal(r.body.passport?.userId, OFF);
  });

  it("C3 revocation, both directions, on the next request", async () => {
    const consent = consentRows();
    const db = cardDb({ consent });
    assert.equal((await card(OFF, "t2", db)).status, 404);
    consent.find((r) => r.user_id === OFF)!.location_mode = "city";
    assert.equal((await card(OFF, "t2", db)).status, 200, "Invisible turned off, card still refused");
    consent.find((r) => r.user_id === OFF)!.location_mode = "off";
    assert.equal((await card(OFF, "t2", db)).status, 404, "Invisible turned back on, card still served");
  });

  it("C4 an unreadable consent state refuses as a retryable failure — never 404 (does-not-exist) and never 200 (published)", async () => {
    const r = await card(VIS, "t2", cardDb({ failReads: { location_preferences: { message: "boom" } } }));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.retryable, true);
    // And the subject's own card does not depend on that read at all.
    assert.equal((await card(VIS, "tVis", cardDb({ failReads: { location_preferences: { message: "boom" } } }))).status, 200);
  });

  it("C5 the shared gate's own unreadable opt-out is also a retryable failure now, not a 404", async () => {
    const r = await card(VIS, "t2", cardDb({ failReads: { profile_privacy_settings: { message: "boom" } } }));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("C6 the same card request twice gives the same answer", async () => {
    const db = cardDb();
    const a = await card(NOB, "t1", db);
    const b = await card(NOB, "t1", db);
    assert.deepEqual([a.status, b.status], [404, 404]);
  });
});
