/**
 * census-discovery §53 — B03 (census-input-intelligence G71 / G283): Buddy
 * eligibility on Discovery's buddy resolver.
 *
 * GII §11: *"Buddy — Service category, availability, launch/safety/payment
 * eligibility."* §20: *"remove or demote options that are infeasible … Unavailable
 * Buddy category or required safety/payment gate."* G283's own test criterion:
 * *"a verified buddy who offers a different service or is unavailable in the
 * asked window does NOT resolve."*
 *
 * The rule is the owning domain's (lib/discoveryPeopleBuddy.ts names where each
 * predicate comes from). This suite pins:
 *   1. the rule as a pure function, leg by leg, with the control for each;
 *   2. the ask the route derives (intent category, time-intent window);
 *   3. the route, for type=buddies / all / suggest, including every read failing;
 *   4. revocation both ways and retries;
 *   5. a DRIFT GUARD: the domain source lines this module mirrors still say what
 *      the mirror assumes.
 *
 * Payment eligibility is NOT built: no processor exists (09_Payment_Architecture
 * §1). Nothing here pretends it is.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryPeopleBuddy.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { parseTimeIntent } from "../routes/discoverySearchHelpers.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { CATEGORY_RISK_LEVELS } from "../lib/rentaBuddyScanner.js";
import {
  BUDDY_SERVICE_CATEGORIES,
  NO_BUDDY_ASK,
  approvedBuddyCategories,
  buddyAskFrom,
  buddyEligibility,
  readBuddyEligibility,
  type BuddyMarketplaceRow,
} from "../lib/discoveryPeopleBuddy.js";
import {
  VIEWER,
  emptyState,
  installKit,
  kitGet,
  startKitServer,
  type KitState,
} from "./discoverySearchTestKit.js";

// ── Pure rule ────────────────────────────────────────────────────────────────

function row(over: Partial<BuddyMarketplaceRow> = {}): BuddyMarketplaceRow {
  return {
    id: "rbp-1", user_id: "u-1", categories: ["city"], category_approvals: {},
    nightlife_admin_approved: false, status: "active", admin_status: "active", risk_hold: false,
    risk_review_status: "normal", verification_status: "unverified", id_verified: false, phone_verified: false,
    ...over,
  };
}
const noWindows = { unavailableDates: new Set<string>(), exceptions: [] };

describe("B03 — the rule, leg by leg", () => {
  it("E1 SAFETY: every restriction the marketplace applies withholds the buddy, each with its reason; the unrestricted row is eligible", () => {
    const cases: Array<[Partial<BuddyMarketplaceRow>, string]> = [
      [{ status: "pending" }, "not_listed"],
      [{ status: "paused" }, "not_listed"],
      [{ status: "rejected" }, "not_listed"],
      [{ status: "suspended" }, "not_listed"],
      [{ admin_status: "restricted" }, "admin_restricted"],
      [{ admin_status: "disabled" }, "admin_restricted"],
      [{ risk_hold: true }, "risk_hold"],
      [{ risk_review_status: "suspended" }, "risk_review"],
      [{ risk_review_status: "under_review" }, "risk_review"],
    ];
    for (const [over, reason] of cases) {
      assert.deepEqual(buddyEligibility(row(over), null, null, NO_BUDDY_ASK), { eligible: false, reason }, JSON.stringify(over));
    }
    for (const rr of ["normal", "watch", "limited"]) {
      assert.equal(buddyEligibility(row({ risk_review_status: rr }), null, null, NO_BUDDY_ASK).eligible, true, `${rr} is not a refusal`);
    }
    assert.deepEqual(buddyEligibility(null, null, null, NO_BUDDY_ASK), { eligible: false, reason: "no_marketplace_profile" });
    for (const lim of [{ rent_buddy_disabled: true }, { buddy_disabled: true }]) {
      assert.deepEqual(buddyEligibility(row(), { user_id: "u-1", ...lim }, null, NO_BUDDY_ASK), { eligible: false, reason: "buddy_disabled" });
    }
  });

  it("E2 CATEGORY: only APPROVED categories count — the booking gate's own approvals, admin sign-off and high-risk verification", () => {
    const verified = { verification_status: "verified" };
    assert.deepEqual(approvedBuddyCategories(row({ categories: [] }), null), []);
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["nightlife"] }), null), [], "nightlife with no approval");
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["nightlife"], category_approvals: { nightlife: true }, ...verified }), null), [],
      "nightlife approved but without admin sign-off");
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["nightlife"], category_approvals: { nightlife: true }, nightlife_admin_approved: true }), null), [],
      "nightlife approved and signed off, but an unverified buddy on a HIGH-risk category");
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["nightlife"], category_approvals: { nightlife: true }, nightlife_admin_approved: true, ...verified }), null), ["nightlife"]);
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["nightlife"], category_approvals: { nightlife: true }, nightlife_admin_approved: true, ...verified }), { user_id: "u-1", nightlife_disabled: true }), [],
      "nightlife_disabled removes nightlife");
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["group"] }), null), []);
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["group"], category_approvals: { group: true } }), null), ["group"]);
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["arrival"] }), null), [], "arrival is high-risk");
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["arrival"], id_verified: true, phone_verified: true }), null), ["arrival"],
      "the gate's other verification disjunct: id AND phone");
    assert.deepEqual(approvedBuddyCategories(row({ categories: ["arrival"], id_verified: true }), null), []);
    assert.deepEqual(approvedBuddyCategories(row({ categories: [" City ", "city", "FOOD"] }), null), ["city", "food"]);

    assert.deepEqual(buddyEligibility(row({ categories: ["nightlife"] }), null, null, NO_BUDDY_ASK), { eligible: false, reason: "no_approved_category" });
    assert.deepEqual(buddyEligibility(row(), null, null, { category: "nightlife", dates: null }), { eligible: false, reason: "category_not_approved" },
      "a verified buddy who offers a DIFFERENT service does not resolve (G283)");
    assert.equal(buddyEligibility(row(), null, null, { category: "city", dates: null }).eligible, true);
  });

  it("E3 AVAILABILITY: against the asked window, using the windows the buddy SET — a free date keeps them; every date closed withholds them", () => {
    const ask = { category: null, dates: ["2026-10-03", "2026-10-04"] };
    const closedBoth = { unavailableDates: new Set(["2026-10-03"]), exceptions: [{ exception_date: "2026-10-04", end_date: null }] };
    assert.deepEqual(buddyEligibility(row(), null, closedBoth, ask), { eligible: false, reason: "unavailable_in_window" },
      "a buddy unavailable in the asked window does not resolve (G283)");
    const rangeCovers = { unavailableDates: new Set<string>(), exceptions: [{ exception_date: "2026-10-01", end_date: "2026-10-10" }] };
    assert.equal(buddyEligibility(row(), null, rangeCovers, ask).eligible, false, "an exception range covers both days");
    const oneFree = { unavailableDates: new Set(["2026-10-03"]), exceptions: [] };
    assert.equal(buddyEligibility(row(), null, oneFree, ask).eligible, true, "one free day in the window is availability");
    const singleDayElsewhere = { unavailableDates: new Set<string>(), exceptions: [{ exception_date: "2026-10-02", end_date: null }] };
    assert.equal(buddyEligibility(row(), null, singleDayElsewhere, ask).eligible, true, "a single-day exception covers only its own day");
    assert.equal(buddyEligibility(row(), null, noWindows, ask).eligible, true, "an UNSET date is bookable (the booking path's own reading)");
    assert.equal(buddyEligibility(row(), null, closedBoth, NO_BUDDY_ASK).eligible, true, "with no asked window there is no availability question");
  });

  it("E4 the ask: a buddy SERVICE category counts, any other intent does not; the time intent's half-open window maps to UTC days", () => {
    assert.equal(buddyAskFrom({ intentCategory: "nightlife" }).category, "nightlife");
    assert.equal(buddyAskFrom({ intentCategory: " Food " }).category, "food");
    assert.equal(buddyAskFrom({ intentCategory: "beach" }).category, null, "no buddy offers 'beach': it constrains nothing");
    assert.equal(buddyAskFrom(null).category, null);
    assert.deepEqual(buddyAskFrom({ startsAfter: "2026-10-03T18:00:00.000Z", startsBefore: "2026-10-04T00:00:00.000Z" }).dates, ["2026-10-03"],
      "an instant AT midnight ends the previous day");
    assert.deepEqual(buddyAskFrom({ startsAfter: "2026-10-03T00:00:00.000Z", startsBefore: "2026-10-05T00:00:00.000Z" }).dates, ["2026-10-03", "2026-10-04"]);
    assert.equal(buddyAskFrom({ startsAfter: "2026-10-03T00:00:00.000Z" }).dates, null, "a one-sided window is not enumerated");
    assert.equal(buddyAskFrom({ startsAfter: "2026-01-01T00:00:00.000Z", startsBefore: "2026-06-01T00:00:00.000Z" }).dates, null, "an oversized window is not enumerated");
    for (const k of Object.keys(CATEGORY_RISK_LEVELS)) assert.ok(BUDDY_SERVICE_CATEGORIES.has(k), `${k} missing from the service vocabulary`);
  });

  it("E5 the reads fail CLOSED and say which relation failed; a rejected read is a failed read", async () => {
    const failing = (bad: string, mode: "resolve" | "reject") => ({
      from: (t: string) => {
        const b: any = {
          select: () => b, in: () => b, lte: () => b,
          then: (f: any, r: any) => (t === bad
            ? (mode === "reject" ? Promise.reject(new Error("reset")) : Promise.resolve({ data: null, error: { message: "boom" } }))
            : Promise.resolve({ data: t === "rent_buddy_profiles" ? [row({ user_id: "u-1" })] : [], error: null })).then(f, r),
        };
        return b;
      },
    });
    const ask = { category: null, dates: ["2026-10-03"] };
    for (const t of ["rent_buddy_profiles", "rent_buddy_user_limits", "rent_buddy_availability", "buddy_availability_exceptions"]) {
      for (const mode of ["resolve", "reject"] as const) {
        const r = await readBuddyEligibility(failing(t, mode), ["u-1"], ask);
        assert.equal(r.ok, false, `${t} (${mode}) read as success`);
        assert.equal(!r.ok && r.relation, t);
      }
    }
    const healthy = await readBuddyEligibility(failing("none", "resolve"), ["u-1"], ask);
    assert.deepEqual(healthy, { ok: true, ineligible: new Map() }, "control");
  });
});

// ── The route ────────────────────────────────────────────────────────────────

const OK = "d1000000-0000-4000-a000-000000000001";    // eligible, offers city
const NIGHT = "d2000000-0000-4000-a000-000000000002"; // eligible, approved nightlife (verified)
const SUSP = "d3000000-0000-4000-a000-000000000003";  // marketplace-suspended
const HOLD = "d4000000-0000-4000-a000-000000000004";  // risk hold
const NONE = "d5000000-0000-4000-a000-000000000005";  // declares only unapproved nightlife
const BARE = "d6000000-0000-4000-a000-000000000006";  // buddy-verified, no marketplace row
const BUSY = "d7000000-0000-4000-a000-000000000007";  // eligible, but closed tomorrow
const ALL_BUDDIES = [OK, NIGHT, SUSP, HOLD, NONE, BARE, BUSY];
const NAME: Record<string, string> = { [OK]: "ok", [NIGHT]: "night", [SUSP]: "susp", [HOLD]: "hold", [NONE]: "none", [BARE]: "bare", [BUSY]: "busy" };

function profile(id: string, handle: string) {
  return {
    id, handle, username: handle, name: `Zork ${handle}`, display_name: null, avatar_url: null, is_private: false,
    home_city: null, home_country: null, account_status: "active", verified: false, is_official: false,
    show_profile_picture_publicly: true, buddy_verified_at: "2026-01-01T00:00:00Z",
  };
}
function mrow(userId: string, over: Record<string, unknown> = {}) {
  return { ...row({ id: `rbp-${NAME[userId]}`, user_id: userId }), ...over };
}

/** The UTC days the route's own time intent resolves "tomorrow" to. */
function tomorrowDays(): string[] {
  return [...(buddyAskFrom(parseTimeIntent("zork tomorrow", null).intent).dates ?? [])];
}

function world(): Partial<KitState> {
  return {
    rows: {
      profiles: [
        { ...profile(VIEWER, "viewer"), buddy_verified_at: null },
        ...ALL_BUDDIES.map((id) => profile(id, `zork_${NAME[id]}`)),
      ],
      rent_buddy_profiles: [
        mrow(OK),
        mrow(NIGHT, { categories: ["nightlife"], category_approvals: { nightlife: true }, nightlife_admin_approved: true, verification_status: "verified" }),
        mrow(SUSP, { status: "suspended" }),
        mrow(HOLD, { risk_hold: true }),
        mrow(NONE, { categories: ["nightlife"] }),
        mrow(BUSY),
      ],
      rent_buddy_user_limits: [],
      rent_buddy_availability: tomorrowDays().map((d) => ({ buddy_id: "rbp-busy", date: d, is_available: false })),
      buddy_availability_exceptions: [],
      location_preferences: [],
      blocks: [], user_privacy_settings: [], profile_privacy_settings: [],
      user_follows: [], friend_requests: [], user_friendships: [], event_rsvps: [],
      canonical_locations: [], hashtags: [], stamp_definitions: [],
    },
  };
}

let base = "";
let server: Server;
let state: KitState;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => { invalidateBuddyLaunchGateCache(); server.close(); });

function install(over: Partial<KitState> = world()): KitState {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
  ({ state } = installKit(over));
  return state;
}
const buddiesOnly = (ids: string[]) => ids.filter((id) => ALL_BUDDIES.includes(id));

async function search(type: string, extra = "", q = "zork") {
  const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent(q)}&type=${type}&limit=50${extra}`);
  return { status, body, ids: ((body?.results ?? []) as any[]).map((r) => String(r.id)) };
}
async function suggestBuddies() {
  const { status, body } = await kitGet(base, `/discovery/suggest?q=zork`);
  const g = ((body?.groups ?? []) as any[]).find((x) => x.type === "buddies");
  return { status, body, ids: ((g?.items ?? []) as any[]).map((it) => String(it.id)) };
}

describe("B03 — GET /discovery/search?type=buddies and the suggest Buddies group", () => {
  it("R1 SAFETY + CATEGORY with no ask: suspended, risk-held, no-approved-category and no-marketplace buddies are withheld; eligible ones served", async () => {
    install();
    const r = await search("buddies");
    assert.equal(r.status, 200);
    assert.deepEqual(buddiesOnly(r.ids).sort(), [OK, NIGHT, BUSY].sort(), `served: ${buddiesOnly(r.ids).map((i) => NAME[i])}`);
    assert.equal(r.body.refusal, undefined);
  });

  it("R2 the eligibility is about the BUDDY role: every withheld buddy is still a traveler", async () => {
    install();
    const t = await search("travelers");
    for (const id of ALL_BUDDIES) assert.ok(t.ids.includes(id), `${NAME[id]} vanished from travelers`);
  });

  it("R3 the suggest Buddies group applies the same rule (one resolver, not two)", async () => {
    install();
    const s = await suggestBuddies();
    for (const id of [SUSP, HOLD, NONE, BARE]) assert.ok(!s.ids.includes(id), `suggest leaked ${NAME[id]}`);
    assert.ok(s.ids.length > 0 && s.ids.every((id) => [OK, NIGHT, BUSY].includes(id)), "control");
  });

  it("R4 an ASKED category (intentCategory) keeps only buddies approved for it; a non-service intent constrains nothing", async () => {
    install();
    assert.deepEqual(buddiesOnly((await search("buddies", "&intentCategory=nightlife")).ids), [NIGHT],
      "a buddy who offers a DIFFERENT service resolved for a nightlife ask");
    assert.deepEqual(buddiesOnly((await search("buddies", "&intentCategory=beach")).ids).sort(), [OK, NIGHT, BUSY].sort());
  });

  it("R5 an ASKED window (the time intent) withholds the buddy who closed every day of it; the buddy with no window set stays", async () => {
    install();
    const r = await search("buddies", "", "zork tomorrow");
    assert.ok(tomorrowDays().length > 0, "precondition: 'tomorrow' resolves to a window");
    assert.ok(!r.ids.includes(BUSY), "a buddy unavailable in the asked window resolved");
    assert.ok(r.ids.includes(OK), "an unset date is bookable — the owning domain's reading");
    // Without the ask the same buddy is served: the window, not the buddy, decided.
    assert.ok((await search("buddies")).ids.includes(BUSY));
  });

  it("R6 revocation, both ways, on the next request: a suspension withholds, a reinstatement restores", async () => {
    install();
    assert.ok((await search("buddies")).ids.includes(OK));
    state.rows.rent_buddy_profiles!.find((r) => r.user_id === OK)!.status = "suspended";
    assert.ok(!(await search("buddies")).ids.includes(OK), "a suspended buddy was still suggested");
    state.rows.rent_buddy_profiles!.find((r) => r.user_id === OK)!.status = "active";
    assert.ok((await search("buddies")).ids.includes(OK), "a reinstated buddy stayed hidden");
  });

  it("R7 the same request twice gives the same eligibility result", async () => {
    install();
    const a = buddiesOnly((await search("buddies", "", "zork tomorrow")).ids);
    const b = buddiesOnly((await search("buddies", "", "zork tomorrow")).ids);
    assert.deepEqual(b, a);
  });
});

describe("B03 — a marketplace read failing withholds every buddy AND says so", () => {
  const FAIL = { code: "57014", message: "canceling statement due to statement timeout" };
  const RELATIONS: Array<[string, string]> = [
    ["rent_buddy_profiles", "zork"],
    ["rent_buddy_user_limits", "zork"],
    // The window reads are issued only when a window was asked.
    ["rent_buddy_availability", "zork tomorrow"],
    ["buddy_availability_exceptions", "zork tomorrow"],
  ];

  it("X1 type=buddies: nothing served, and a refusal rather than an empty list — for each of the four reads", async () => {
    for (const [table, q] of RELATIONS) {
      const s = world(); (s as any).errorTables = { [table]: FAIL }; install(s);
      const r = await search("buddies", "", q);
      assert.deepEqual(buddiesOnly(r.ids), [], `${table}: a buddy was served with its eligibility unreadable`);
      assert.equal(r.body.refusal?.coverage, "nothing", `${table}: the empty list does not say it is a failure`);
    }
  });

  it("X2 type=all names `buddies` as failed and still serves travelers; suggest does the same", async () => {
    const s = world(); (s as any).errorTables = { rent_buddy_profiles: FAIL }; install(s);
    const a = await search("all");
    assert.equal(a.body.refusal?.coverage, "partial");
    assert.ok(a.body.refusal.failedSources.includes("buddies"));
    assert.ok(!a.body.refusal.failedSources.includes("travelers"), "the traveler role does not read the marketplace");
    assert.ok(a.ids.includes(OK), "travelers are still served");
    const g = await suggestBuddies();
    assert.deepEqual(g.ids, []);
    assert.ok(g.body.refusal?.failedSources?.includes("buddies"));
  });

  it("X3 CONTROL: with no buddy candidate at all the marketplace is not read, and nothing is refused", async () => {
    const s = world(); (s as any).errorTables = { rent_buddy_profiles: FAIL }; install(s);
    const r = await search("buddies", "", "nobodymatchesthis");
    assert.equal(r.body.refusal, undefined, "an empty candidate set must not read (or fail on) the marketplace");
  });
});

// ── Drift guard ──────────────────────────────────────────────────────────────

describe("B03 — the owning domain still says what the mirror assumes", () => {
  const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("D1 the booking gate's category approvals, admin sign-off and high-risk verification are still spelled as mirrored", () => {
    const rab = src("routes/rentABuddy.ts");
    assert.ok(rab.includes('if (category === "nightlife" || category === "group") {'), "approval-required categories moved");
    assert.ok(rab.includes("if (!approvals[category]) {"), "approval test moved");
    assert.ok(rab.includes('if (category === "nightlife" && !(buddyProfile as any)?.nightlife_admin_approved) {'), "nightlife sign-off moved");
    assert.ok(rab.includes("(buddyProfile as any)?.verification_status === 'verified'") &&
      rab.includes("((buddyProfile as any)?.id_verified && (buddyProfile as any)?.phone_verified)"), "high-risk verification disjunction moved");
    assert.ok(rab.includes('if (riskStatus === "suspended") reasons.push("account_suspended");') &&
      rab.includes('if (riskStatus === "under_review") reasons.push("account_under_review");'), "risk-review refusals moved");
  });

  it("D2 the booking path still treats only an explicit false row or an exception range as unavailable", () => {
    const rab = src("routes/rentABuddy.ts");
    assert.ok(rab.includes("if (avRow && !(avRow as any).is_available) {"), "the availability refusal changed shape");
    assert.ok(rab.includes("if (ex.end_date == null) return ex.exception_date === isoDate;") &&
      rab.includes("return ex.end_date >= isoDate;"), "findBlockingAvailabilityException's coverage rule changed");
  });

  it("D3 the marketplace's own buddy search still requires status AND admin_status active on BOTH of its reads (count and page)", () => {
    const rab = src("routes/rentABuddy.ts");
    const search = rab.slice(rab.indexOf("function applyBuddyFilters("), rab.indexOf("// Apply weighted scoring across the full fetched pool"));
    assert.ok(search.length > 0, "the marketplace search handler moved — re-point this guard");
    const chains = search.match(/\.eq\("status", "active"\)\s*\n\s*\.eq\("admin_status", "active"\)/g) ?? [];
    assert.equal(chains.length, 2, "the marketplace listing rule changed; lib/discoveryPeopleBuddy.ts mirrors it");
  });
});
