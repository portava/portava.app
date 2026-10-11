/**
 * census-input-intelligence G116 / G98 (§18 relationship operators) and G283 /
 * G71 (§11 buddy category + availability) — lib/inputAssistance/searchScope.ts.
 *
 * Before: "people I follow", "with my crew" and "near our meeting point" parsed
 * and then constrained nothing (the gateway's SearchQueryContext had no member
 * for them), and the buddy arm read the eligibility rule with an EMPTY ask (no
 * category, no window) on every gateway serve.
 *
 * This suite drives the REAL gateway (`generateSuggestionsWithCoverage`) over the
 * shared PostgREST-shaped fake (discoverySearchTestKit.ts) and pins:
 *   S1–S3  the follow scope: only the viewer's follows, never a blocked person,
 *          no non-person type; an empty subject lists the follows.
 *   S4–S5  the crew scope: co-members of the viewer's own Trips only; a Trip the
 *          viewer is not in yields nobody and its member list is never read.
 *   S6     only the VIEWER's edges are ever read (no third party's graph).
 *   S7–S8  an unreadable graph fails closed AND says so.
 *   S9–S11 the meeting point: the viewer's own becomes the proximity origin;
 *          none ⇒ nothing; unreadable ⇒ nothing + refusal.
 *   B1–B5  the buddy ask on buddy_service and global_search.
 *   N1     a query with none of these phrases issues the same reads as before.
 *
 * No HTTP server: the gateway is called directly (no listen(2)).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/inputAssistanceSearchScope.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestionsWithCoverage } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy } from "../lib/inputAssistance/policyRegistry.js";
import { extractTemporal } from "../lib/inputAssistance/semanticParser.js";
import { invalidateBuddyLaunchGateCache } from "../lib/inputAssistance/searchCandidates.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { buddyAskFrom } from "../lib/discoveryPeopleBuddy.js";
import {
  buddyServiceCategoryFor,
  relationshipAdmitsType,
  relationshipAskFrom,
  RELATIONSHIP_SCOPE_MAX_IDS,
  readFollowScope,
} from "../lib/inputAssistance/searchScope.js";
import { parseSemanticIntent } from "../lib/inputAssistance/semanticParser.js";
import type { InputContext, SuggestSessionContext } from "../lib/inputAssistance/types.js";
import { VIEWER, emptyCalls, emptyState, makeKitClient, type KitState } from "./discoverySearchTestKit.js";

const ALICE = "e1000000-0000-4000-a000-000000000001"; // followed by the viewer
const BOB   = "e2000000-0000-4000-a000-000000000002"; // followed by the viewer, AND blocked by the viewer
const CAROL = "e3000000-0000-4000-a000-000000000003"; // crew: member of the viewer's Trip T1
const DAN   = "e4000000-0000-4000-a000-000000000004"; // no edge; owns T2; followed by FRANK
const EVE   = "e5000000-0000-4000-a000-000000000005"; // member of T2 (the viewer is not)
const FRANK = "e6000000-0000-4000-a000-000000000006"; // a third party
const INVITED = "e7000000-0000-4000-a000-000000000007"; // invited to T1, never accepted
const PEOPLE = [ALICE, BOB, CAROL, DAN, EVE, FRANK, INVITED];
const KEY: Record<string, string> = {
  [ALICE]: "alice", [BOB]: "bob", [CAROL]: "carol", [DAN]: "dan", [EVE]: "eve", [FRANK]: "frank", [INVITED]: "invited",
};
const T1 = "f1000000-0000-4000-a000-000000000001";
const T2 = "f2000000-0000-4000-a000-000000000002";

// Buddies (buddy_service).
const FOODIE = "b1000000-0000-4000-a000-000000000001"; // approved food only
const NIGHT  = "b2000000-0000-4000-a000-000000000002"; // approved nightlife (verified, signed off)
const BUSY   = "b3000000-0000-4000-a000-000000000003"; // approved city; closed every day of "tomorrow"
const BUDDIES = [FOODIE, NIGHT, BUSY];
Object.assign(KEY, { [FOODIE]: "foodie", [NIGHT]: "night", [BUSY]: "busy" });

const FUTURE = new Date(Date.now() + 6 * 3600_000).toISOString();

function profile(id: string, buddy: boolean) {
  const k = KEY[id]!;
  return {
    id, handle: `zork_${k}`, username: `zork_${k}`, name: `Zork ${k}`, display_name: null, avatar_url: null,
    is_private: false, home_city: "Lisbon", home_country: "Portugal", account_status: "active", verified: false,
    is_official: false, show_profile_picture_publicly: true, buddy_verified_at: buddy ? "2026-01-01T00:00:00Z" : null,
  };
}

function rbp(userId: string, over: Record<string, unknown>) {
  return {
    id: `rbp-${KEY[userId]}`, user_id: userId, categories: ["city"], category_approvals: {},
    nightlife_admin_approved: false, status: "active", admin_status: "active", risk_hold: false,
    risk_review_status: "normal", verification_status: "unverified", id_verified: false, phone_verified: false,
    ...over,
  };
}

/** The UTC days the gateway's own temporal parse resolves `text` to. */
function askedDays(text: string): string[] {
  const t = extractTemporal(text, null).intent;
  return [...(buddyAskFrom(t ? { startsAfter: t.startsAfter, startsBefore: t.startsBefore } : null).dates ?? [])];
}

function world(): Partial<KitState> {
  return {
    rows: {
      profiles: [
        { ...profile(VIEWER, false), handle: "viewer", username: "viewer", name: "Viewer" },
        ...PEOPLE.map((id) => profile(id, false)),
        ...BUDDIES.map((id) => profile(id, true)),
      ],
      blocks: [{ blocker_id: VIEWER, blocked_id: BOB }],
      user_follows: [
        { follower_id: VIEWER, following_id: ALICE, created_at: "2026-02-01T00:00:00Z" },
        { follower_id: VIEWER, following_id: BOB, created_at: "2026-02-02T00:00:00Z" },
        { follower_id: FRANK, following_id: DAN, created_at: "2026-02-03T00:00:00Z" },
      ],
      user_privacy_settings: [], profile_privacy_settings: [], friend_requests: [], user_friendships: [],
      trips: [
        { id: T1, title: "Trip one", owner_id: VIEWER, destination_city: "Porto", destination_country: "PT",
          status: "upcoming", visibility: "private", show_in_discovery: false, start_date: "2026-12-01", created_at: "2026-01-01T00:00:00Z", cover_url: null },
        { id: T2, title: "Trip two", owner_id: DAN, destination_city: "Faro", destination_country: "PT",
          status: "upcoming", visibility: "private", show_in_discovery: false, start_date: "2026-12-01", created_at: "2026-01-01T00:00:00Z", cover_url: null },
      ],
      trip_members: [
        { trip_id: T1, user_id: CAROL, role: "member", status: "accepted" },
        { trip_id: T1, user_id: INVITED, role: "member", status: "invited" },
        { trip_id: T2, user_id: EVE, role: "member", status: "accepted" },
      ],
      trip_plan_items: [
        { id: "mp-1", trip_id: T1, title: "Meet here", category: "meeting_point", status: "planned", source_type: null,
          source_id: null, starts_at: FUTURE, ends_at: null, location_name: "Ribeira", lat: 41.14, lng: -8.61,
          location_is_private: false, lock_type: null, removed_at: null, creator_id: VIEWER, created_at: "2026-01-01T00:00:00Z" },
      ],
      discovery_places: [
        { id: "place-lisbon", name: "zork place lisbon", city: "Lisbon", blurb: null, image_url: null, header_image_source: null,
          image_source_type: null, image_accuracy_status: null, category: "food", primary_category: "food", lat: 38.72, lng: -9.13,
          canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 1 },
        { id: "place-porto", name: "zork place porto", city: "Porto", blurb: null, image_url: null, header_image_source: null,
          image_source_type: null, image_accuracy_status: null, category: "food", primary_category: "food", lat: 41.141, lng: -8.611,
          canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 1 },
      ],
      rent_buddy_profiles: [
        rbp(FOODIE, { categories: ["food"] }),
        rbp(NIGHT, { categories: ["nightlife"], category_approvals: { nightlife: true }, nightlife_admin_approved: true, verification_status: "verified" }),
        rbp(BUSY, {}),
      ],
      rent_buddy_user_limits: [],
      rent_buddy_availability: askedDays("tomorrow").map((d) => ({ buddy_id: "rbp-busy", date: d, is_available: false })),
      buddy_availability_exceptions: [],
      events: [], hidden_gems: [], posts: [], circles: [], hashtags: [], stamp_definitions: [], canonical_locations: [],
      meetups: [], event_rsvps: [], location_preferences: [],
    },
  };
}

/** Every filter call a read made, so a test can prove WHOSE graph was read. */
interface FilterLog { table: string; op: string; col: string; val: unknown }

function client(over?: (w: Partial<KitState>) => Partial<KitState>) {
  const w = world();
  const state = emptyState(over ? over(w) : w);
  const calls = emptyCalls();
  const base = makeKitClient(state, calls);
  const filters: FilterLog[] = [];
  const wrap = (table: string, b: any): any =>
    new Proxy(b, {
      get(target, prop) {
        const v = target[prop];
        if (typeof v !== "function" || prop === "then") return v;
        return (...args: unknown[]) => {
          if (["eq", "in", "neq"].includes(String(prop))) filters.push({ table, op: String(prop), col: String(args[0]), val: args[1] });
          const out = v.apply(target, args);
          return out === target ? wrap(table, out) : out; // keep logging down the whole chain
        };
      },
    });
  const sc = { ...base, from: (t: string) => wrap(t, base.from(t)) };
  return { sc, state, calls, filters };
}

async function serve(
  sc: any,
  context: InputContext,
  text: string,
  sessionContext?: SuggestSessionContext,
) {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  const policy = resolvePolicy(context)!;
  const out = await generateSuggestionsWithCoverage(sc, {
    context, policy, text, userId: VIEWER, limit: 50, lat: 38.72, lng: -9.13, city: "Lisbon", sessionContext,
  });
  const ids = (type: string) => out.suggestions.filter((s) => s.entityType === type).map((s) => String(s.entityId));
  return { ...out, people: [...ids("user"), ...ids("buddy")], users: ids("user"), buddies: ids("buddy"), places: ids("place") };
}

const names = (ids: string[]) => ids.map((i) => KEY[i] ?? i).sort();

// ── Pure pieces ──────────────────────────────────────────────────────────────

describe("G116 — the pure pieces", () => {
  it("P1 the three operators are read off the parse; nothing else is a relationship ask", () => {
    assert.equal(relationshipAskFrom(parseSemanticIntent("zork people i follow")), "followed");
    assert.equal(relationshipAskFrom(parseSemanticIntent("dinner with my crew")), "with_crew");
    assert.equal(relationshipAskFrom(parseSemanticIntent("bars near our meeting point")), "meeting_point");
    assert.equal(relationshipAskFrom(parseSemanticIntent("bars near my hotel")), null);
    assert.equal(relationshipAskFrom(parseSemanticIntent("zork")), null);
  });

  it("P2 a follow scope admits people only; a crew or meeting-point scope admits every type", () => {
    const f = { kind: "followed" as const, personIds: [] };
    assert.equal(relationshipAdmitsType(f, "travelers"), true);
    assert.equal(relationshipAdmitsType(f, "buddies"), true);
    for (const t of ["places", "events", "cities", "hashtags", "trips"]) assert.equal(relationshipAdmitsType(f, t), false, t);
    assert.equal(relationshipAdmitsType({ kind: "with_crew", personIds: [] }, "places"), true);
    assert.equal(relationshipAdmitsType({ kind: "meeting_point", lat: 0, lng: 0 }, "events"), true);
  });

  it("P4 a blocked person is not even in the scope (the person search's own block gate is the second wall)", async () => {
    const { sc } = client();
    const r = await readFollowScope(sc, VIEWER, new Set([BOB]));
    assert.deepEqual(r, { ids: [ALICE], truncated: false });
  });

  it("P3 only unambiguous parse categories become a buddy service; the rest constrain nothing", () => {
    assert.equal(buddyServiceCategoryFor("bar"), "nightlife");
    assert.equal(buddyServiceCategoryFor("nightclub"), "nightlife");
    assert.equal(buddyServiceCategoryFor("restaurant"), "food");
    assert.equal(buddyServiceCategoryFor("museum"), "culture");
    assert.equal(buddyServiceCategoryFor("beach"), null);
    assert.equal(buddyServiceCategoryFor("park"), null);
    assert.equal(buddyServiceCategoryFor(undefined), null);
  });
});

// ── The follow scope ─────────────────────────────────────────────────────────

describe("G116/G98 — people I follow (global_search)", () => {
  it("S1 only the viewer's follows; a followed-but-blocked person never appears; no non-person row", async () => {
    const { sc } = client();
    const r = await serve(sc, "global_search", "zork people i follow");
    assert.deepEqual(names(r.people), ["alice"], `served: ${names(r.people)}`);
    assert.deepEqual(r.places, [], "a place has no follow edge — 'people I follow' cannot be about it");
    assert.equal(r.refusal, null);
    // Control: the same subject without the operator serves strangers and places.
    const plain = await serve(client().sc, "global_search", "zork");
    assert.ok(plain.users.some((id) => id !== ALICE), `control: plain search reaches people with no follow edge (${names(plain.users)})`);
    assert.ok(plain.places.length > 0, "control: plain search serves places");
    assert.ok(!plain.users.includes(BOB), "control: a blocked person is never served");
  });

  it("S2 an empty subject lists the follows (and still never a blocked one)", async () => {
    const r = await serve(client().sc, "global_search", "people i follow");
    assert.deepEqual(names(r.users), ["alice"]);
  });

  it("S3 a viewer who follows nobody gets nobody — not everybody", async () => {
    const { sc, filters } = client((w) => ({ ...w, rows: { ...w.rows!, user_follows: [{ follower_id: FRANK, following_id: DAN }] } }));
    const r = await serve(sc, "global_search", "zork people i follow");
    assert.deepEqual(r.people, []);
    assert.ok(!filters.some((f) => f.table === "profiles" && f.op === "in" && f.col === "id"), "an empty scope still searched people (nothing to search: no read)");
    assert.equal(r.refusal, null, "an empty graph is a true answer, not a failure");
  });
});

// ── The crew scope ───────────────────────────────────────────────────────────

describe("G116/G98 — with my crew (global_search)", () => {
  it("S4 accepted co-members of the viewer's own Trips only; an invitee is not crew; places keep the company reading", async () => {
    const r = await serve(client().sc, "global_search", "zork with my crew");
    assert.deepEqual(names(r.users), ["carol"], `served: ${names(r.users)}`);
    assert.ok(r.places.length > 0, "'with my crew' names who you go with, not what you look for");
  });

  it("S5 a Trip the viewer is NOT in: nobody, and that Trip's member list is never read", async () => {
    const { sc, filters } = client();
    const r = await serve(sc, "global_search", "zork with my crew", { tripId: T2 });
    assert.deepEqual(r.users, [], "a non-member was handed someone else's crew");
    const readT2 = filters.some((f) => f.table === "trip_members" && f.col === "trip_id" && (Array.isArray(f.val) ? f.val.includes(T2) : f.val === T2));
    assert.equal(readT2, false, "the gateway read the member list of a Trip the viewer does not belong to");
    // Control: inside the viewer's own Trip, the crew is served.
    const own = await serve(client().sc, "global_search", "zork with my crew", { tripId: T1 });
    assert.deepEqual(names(own.users), ["carol"]);
  });

  it("S6 only the viewer's own edges are read — no third party's follows, no foreign Trip's members", async () => {
    for (const text of ["zork people i follow", "zork with my crew"]) {
      const { sc, filters } = client();
      await serve(sc, "global_search", text);
      for (const f of filters.filter((x) => x.table === "user_follows" && x.op === "eq")) {
        assert.ok(f.col !== "following_id", `${text}: user_follows read by followee (someone else's followers)`);
        if (f.col === "follower_id") assert.equal(f.val, VIEWER, `${text}: another person's follows were read`);
      }
      for (const f of filters.filter((x) => x.table === "trip_members")) {
        if (f.col === "user_id") assert.equal(f.val, VIEWER, `${text}: another person's memberships were read`);
        if (f.col === "trip_id") assert.deepEqual(f.val, [T1], `${text}: a foreign Trip's members were read`);
      }
    }
  });
});

// ── Fail closed ──────────────────────────────────────────────────────────────

describe("G116 — an unreadable graph is not an empty one", () => {
  const FAIL = { code: "57014", message: "canceling statement due to statement timeout" };

  it("S7 follows unreadable: nobody, nothing else, and the envelope says nothing was read", async () => {
    for (const how of ["error", "throw"] as const) {
      const { sc } = client((w) => (how === "error" ? { ...w, errorTables: { user_follows: FAIL } } : { ...w, throwTables: new Set(["user_follows"]) }));
      const r = await serve(sc, "global_search", "zork people i follow");
      assert.deepEqual(r.people, [], `${how}: people served with the graph unreadable`);
      assert.deepEqual(r.places, []);
      assert.equal(r.refusal?.coverage, "nothing", `${how}: the empty list does not say it is a failure`);
      assert.ok(r.refusal?.failedSources?.includes("relationship_graph"));
    }
  });

  it("S8 crew unreadable: no people, the places still served, and the envelope says partial", async () => {
    const { sc } = client((w) => ({ ...w, errorTables: { trip_members: FAIL } }));
    const r = await serve(sc, "global_search", "zork with my crew");
    assert.deepEqual(r.people, []);
    assert.ok(r.places.length > 0);
    assert.equal(r.refusal?.coverage, "partial");
    for (const s of ["relationship_graph", "travelers", "buddies"]) assert.ok(r.refusal?.failedSources?.includes(s), s);
  });

  it("S8b a graph larger than one request carries is truncated AND said to be partial", async () => {
    const many = Array.from({ length: RELATIONSHIP_SCOPE_MAX_IDS + 5 }, (_, i) => ({
      follower_id: VIEWER, following_id: `ff${String(i).padStart(6, "0")}-0000-4000-a000-000000000000`, created_at: "2026-01-01T00:00:00Z",
    }));
    const { sc } = client((w) => ({ ...w, rows: { ...w.rows!, user_follows: many } }));
    const r = await serve(sc, "global_search", "zork people i follow");
    assert.equal(r.refusal?.coverage, "partial");
    assert.ok(r.refusal?.failedSources?.includes("relationship_graph"));
  });
});

// ── The meeting point ────────────────────────────────────────────────────────

describe("G116 — near our meeting point (global_search)", () => {
  it("S9 the viewer's own meeting point becomes the proximity origin", async () => {
    const r = await serve(client().sc, "global_search", "zork near our meeting point");
    assert.equal(r.places[0], "place-porto", `order: ${r.places}`);
    // Control: from the viewer's own position the Lisbon place leads.
    const plain = await serve(client().sc, "global_search", "zork");
    assert.equal(plain.places[0], "place-lisbon", `control order: ${plain.places}`);
  });

  it("S10 no meeting point (or one in a Trip the viewer is not in): nothing — never the viewer's own position", async () => {
    const none = await serve(client((w) => ({ ...w, rows: { ...w.rows!, trip_plan_items: [] } })).sc, "global_search", "zork near our meeting point");
    assert.deepEqual([...none.places, ...none.people], []);
    const foreign = await serve(
      client((w) => ({ ...w, rows: { ...w.rows!, trip_plan_items: w.rows!.trip_plan_items!.map((p: any) => ({ ...p, trip_id: T2 })) } })).sc,
      "global_search", "zork near our meeting point",
    );
    assert.deepEqual(foreign.places, [], "another Trip's meeting point was used");
  });

  it("S11 meeting point unreadable: nothing, and a refusal naming it", async () => {
    const { sc } = client((w) => ({ ...w, errorTables: { trip_plan_items: { code: "08006", message: "connection failure" } } }));
    const r = await serve(sc, "global_search", "zork near our meeting point");
    assert.deepEqual([...r.places, ...r.people], []);
    assert.equal(r.refusal?.coverage, "nothing");
    assert.ok(r.refusal?.failedSources?.includes("meeting_point"));
  });
});

// ── The buddy ask (G283 / G71) ──────────────────────────────────────────────

describe("G283 — the buddy arm reads the asked category and window", () => {
  it("B1 buddy_service: a buddy approved only for food is not suggested for a nightlife ask (and vice versa)", async () => {
    const night = await serve(client().sc, "buddy_service", "zork nightlife");
    assert.deepEqual(names(night.buddies), ["night"], `served: ${names(night.buddies)}`);
    const bars = await serve(client().sc, "buddy_service", "zork bars");
    assert.deepEqual(names(bars.buddies), ["night"], "a bar ask is a nightlife ask");
    const food = await serve(client().sc, "buddy_service", "zork food");
    assert.deepEqual(names(food.buddies), ["foodie"]);
    // Control: no ask, every eligible buddy.
    const plain = await serve(client().sc, "buddy_service", "zork");
    assert.deepEqual(names(plain.buddies), ["busy", "foodie", "night"]);
  });

  it("B2 a buddy who closed every day of the asked window is withheld; one with no window set stays", async () => {
    assert.ok(askedDays("tomorrow").length > 0, "precondition");
    const r = await serve(client().sc, "buddy_service", "zork tomorrow");
    assert.ok(!r.buddies.includes(BUSY), "a buddy unavailable in the asked window resolved");
    assert.ok(r.buddies.includes(FOODIE) && r.buddies.includes(NIGHT));
  });

  it("B3 unreadable eligibility withholds every buddy and marks the serve partial", async () => {
    const { sc } = client((w) => ({ ...w, errorTables: { rent_buddy_profiles: { code: "57014", message: "timeout" } } }));
    const r = await serve(sc, "buddy_service", "zork nightlife");
    assert.deepEqual(r.buddies, []);
    assert.ok(r.refusal?.failedSources?.includes("buddies"));
    const w2 = client((w) => ({ ...w, errorTables: { rent_buddy_availability: { code: "57014", message: "timeout" } } }));
    const r2 = await serve(w2.sc, "buddy_service", "zork tomorrow");
    assert.deepEqual(r2.buddies, [], "the window read failing must withhold, not ignore the window");
    assert.ok(r2.refusal?.failedSources?.includes("buddies"));
  });

  it("B4 the buddy field with only an ask lists the buddies that ask admits; global_search lists none", async () => {
    const field = await serve(client().sc, "buddy_service", "nightlife tonight");
    assert.deepEqual(names(field.buddies), ["night"]);
    const global = await serve(client().sc, "global_search", "nightlife tonight");
    assert.deepEqual(global.buddies, [], "an operator-only global query must not list every buddy");
  });

  it("B5 global_search's buddy rows obey the same ask", async () => {
    const r = await serve(client().sc, "global_search", "zork nightlife");
    assert.deepEqual(names(r.buddies), ["night"]);
  });
});

// ── Untouched when nothing is asked ──────────────────────────────────────────

describe("no phrase, no change", () => {
  it("N1 a query without a relationship operator or ask reads no graph, no meeting point and no buddy window", async () => {
    for (const [ctx, text] of [["global_search", "zork"], ["buddy_service", "zork"]] as const) {
      const { sc, calls, filters } = client();
      await serve(sc, ctx, text);
      assert.ok(!filters.some((f) => f.table === "user_follows" && f.col === "follower_id" && f.op === "eq" && !filters.some((g) => g.table === "user_follows" && g.op === "in")),
        `${ctx} "${text}" read the whole follow graph`);
      assert.ok(!filters.some((f) => f.table === "trip_members" && f.col === "user_id"), `${ctx} "${text}" read the viewer's memberships`);
      assert.ok(!filters.some((f) => f.table === "trip_plan_items" && f.col === "category" && f.val === "meeting_point"), `${ctx} "${text}" read meeting points`);
      assert.ok(!calls.tables.includes("rent_buddy_availability"), `${ctx} "${text}" read a buddy window`);
    }
  });
});
