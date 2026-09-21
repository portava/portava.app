/**
 * The NINTH age gate: group travel.
 *
 * `compass/CompassTools.ts#prefsFromRow` used to derive each group member's age
 * straight from `profiles.date_of_birth`, and `CompassSocialEngine` kept its own
 * private copy of the date-of-birth arithmetic to do it with. So a traveler
 * whose government document came back `is_over_18: false` kept the adult
 * birthday they typed, contributed that number to the group's `youngestAge`,
 * and the whole group walked into an `age_min: 18` event. Seven other gate
 * families had exactly this defect; this one was found, ledgered in
 * `ageGateSeamCoverage.test.ts#KNOWN_UNROUTED`, and left for this change.
 *
 * ── WHY THIS SUITE DRIVES THE TOOL AND NOT THE HELPER ───────────────────────
 * `aggregateGroupPreferences` can be handed a `GateAge` directly and asserted on
 * in three lines, and such a test passes whether or not anything ever CALLS it
 * with a resolved gate. The defect was never in the arithmetic — it was in the
 * wiring: the raw column reaching a number without the contradiction rule. So
 * every case here goes through `executeCompassTool("get_group_recommendation")`
 * with rows in `profiles` and `identity_verifications`, which is the path
 * production takes. Reverting the wiring and leaving the helper intact must turn
 * this file red.
 *
 * ── THE CONTROL CASES MATTER AS MUCH AS THE REFUSAL ─────────────────────────
 * A gate that refuses EVERYTHING passes the headline assertion and is useless.
 * So: the same group with the same adult birthdays passes the same 18+ event
 * when the provider CONFIRMS the adult (`is_over_18: true`), and again when
 * there is no verification row at all — which is production's actual state
 * today (0 `identity_verifications` rows, no configured provider). An
 * unrestricted event is asserted alongside in every case, so "no candidates"
 * can never be mistaken for "the age gate did its job".
 *
 * Run: node --import tsx --test src/test/ageGateGroupTravel.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.ts";
import { executeCompassTool } from "../compass/CompassTools.js";
import {
  aggregateGroupPreferences,
  buildGroupRankingProfile,
  type GroupMemberPrefs,
} from "../compass/CompassSocialEngine.js";
import type { CompassProfile } from "../compass/types.js";

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001"; // circle owner, the asker
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002"; // the member under test
const HOST_ID  = "c3c3c3c3-cccc-cccc-cccc-000000000003";

const SOON = new Date(Date.now() + 86_400_000).toISOString();

/** Both members typed an ADULT date of birth. That is the whole point. */
const ADULT_DOB_ALICE = "1990-04-11";
const ADULT_DOB_BOB   = "1995-06-01";

function profileFor(): CompassProfile {
  return {
    userId: ALICE_ID,
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    currentCity: null,
  } as unknown as CompassProfile;
}

/**
 * `verifications` are rows exactly as `identity_verifications` stores them —
 * `is_over_18` null until a session is decided, newest decided row wins.
 */
function rows(verifications: Record<string, any>[]) {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    circles: [{ id: "circ-1", name: "Dive Crew", owner_id: ALICE_ID }],
    circle_memberships: [{ user_id: ALICE_ID, other_id: BOB_ID, status: "accepted" }],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice", interests: ["food"], travel_styles: [], budget_style: "budget", travel_pace: "balanced", spoken_languages: ["en"], verified: true, date_of_birth: ADULT_DOB_ALICE },
      { id: BOB_ID,   handle: "bob",   name: "Bob",   interests: ["food"], travel_styles: [], budget_style: "budget", travel_pace: "balanced", spoken_languages: ["en"], verified: true, date_of_birth: ADULT_DOB_BOB },
    ],
    identity_verifications: verifications,
    events: [
      { id: "ev-open",   title: "Food Market Night", description: null, city: "Cebu", country: "PH", starts_at: SOON, category: "food",      host_id: HOST_ID, state: "published", visibility: "public", max_attendees: 50, going_count: 0, age_min: null, verified_only: false },
      { id: "ev-18plus", title: "Casino Night",      description: null, city: "Cebu", country: "PH", starts_at: SOON, category: "nightlife", host_id: HOST_ID, state: "published", visibility: "public", max_attendees: 50, going_count: 0, age_min: 18,   verified_only: false },
    ],
    blocks: [],
    user_mutes: [],
  } as Record<string, Record<string, any>[]>;
}

async function groupEvents(spec: Record<string, any>): Promise<any> {
  return (await executeCompassTool(
    makeFailClosedClient(spec),
    ALICE_ID,
    profileFor(),
    "get_group_recommendation",
    { circleName: "Dive Crew", kind: "events" },
  )) as any;
}

const idsOf = (r: any) => (r.candidates ?? []).map((c: any) => String(c.id));

describe("group travel — a provider-verified minor cannot pass the group through an 18+ event", () => {
  it("REFUSES the 18+ event when the newest decided result says a member is NOT over 18", async () => {
    // Bob typed 1995. The provider says otherwise, and it is the NEWEST decided
    // row — an older `true` must not survive a later `false`, and a `created`
    // session with is_over_18 null settles nothing either way.
    const result = await groupEvents({
      rows: rows([
        { user_id: BOB_ID, is_over_18: true,  created_at: "2026-01-02T00:00:00Z" },
        { user_id: BOB_ID, is_over_18: false, created_at: "2026-05-09T00:00:00Z" },
        { user_id: BOB_ID, is_over_18: null,  created_at: "2026-06-01T00:00:00Z" },
      ]),
    });
    assert.ok(!idsOf(result).includes("ev-18plus"),
      `the 18+ event was recommended to a group containing a verified minor (got ${JSON.stringify(idsOf(result))})`);
    // ...and the tool is demonstrably still working: the UNRESTRICTED event is
    // still recommended, so the assertion above is not passing because the tool
    // returned nothing.
    assert.deepEqual(idsOf(result), ["ev-open"]);
    assert.ok((result.groupConstraintsApplied ?? []).includes("age_could_not_be_confirmed_for_every_member"),
      `expected the could-not-confirm reason, got ${JSON.stringify(result.groupConstraintsApplied)}`);
    // The refusal says the check did not produce an answer. It does NOT say a
    // member is a minor, name a member, or mention a date of birth — the group
    // aggregate is shared with everyone in the group.
    const text = JSON.stringify(result).toLowerCase();
    assert.ok(!text.includes("minor"), "a group-facing answer must not announce that somebody is a minor");
    assert.ok(!text.includes("date_of_birth") && !text.includes("birth"), "no date of birth reaches the answer");
    assert.ok(!text.includes(ADULT_DOB_BOB));
  });

  it("CONTROL — the provider confirms the adult, and the same group passes the same event", async () => {
    const result = await groupEvents({
      rows: rows([
        { user_id: BOB_ID, is_over_18: false, created_at: "2026-01-02T00:00:00Z" },
        { user_id: BOB_ID, is_over_18: true,  created_at: "2026-05-09T00:00:00Z" },
      ]),
    });
    assert.ok(idsOf(result).includes("ev-18plus"),
      `a confirmed-adult group must still get the 18+ event (got ${JSON.stringify(idsOf(result))})`);
    assert.equal(idsOf(result).length, 2);
    assert.ok(!(result.groupConstraintsApplied ?? []).some((r: string) => r.startsWith("age_")),
      `no age constraint should fire here, got ${JSON.stringify(result.groupConstraintsApplied)}`);
  });

  it("CONTROL — no verification rows at all (production's actual state) still passes", async () => {
    // Production holds 0 identity_verifications rows and has no configured
    // provider. If this case refused, the change would have closed the gate on
    // every real user rather than on contradicted ones.
    const result = await groupEvents({ rows: rows([]) });
    assert.deepEqual(idsOf(result).sort(), ["ev-18plus", "ev-open"]);
  });

  it("an UNREADABLE identity_verifications read refuses too — and as an outage, not a verdict", async () => {
    // supabase-js RESOLVES on a database error, so this arrives as
    // `{ data: null, error }` — byte-identical to "this user has no rows",
    // which is the permissive answer. It must not be taken as one.
    const result = await groupEvents({
      rows: rows([{ user_id: BOB_ID, is_over_18: true, created_at: "2026-05-09T00:00:00Z" }]),
      failOn: (ctx: any) => (ctx.table === "identity_verifications"
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null),
    });
    assert.ok(!idsOf(result).includes("ev-18plus"), "an unreadable age check is a closed age gate");
    assert.deepEqual(idsOf(result), ["ev-open"]);
    const reasons: string[] = result.groupConstraintsApplied ?? [];
    assert.ok(reasons.includes("age_could_not_be_confirmed_for_every_member"));
    assert.ok(!reasons.includes("age_restriction_not_met_by_all_members"),
      "an outage must not be reported as a finding about the group's ages");
  });

  it("the ages of a SIX-person group cost ONE identity_verifications read, not six", async () => {
    // The seam is batched for a reason: the group tool reads its members in one
    // `.in()` and the verification read must not be the N+1 that undoes it. Six
    // members, and the count is asserted rather than assumed — `failOn` is
    // called exactly once per terminal read, so it doubles as a read counter.
    const extra = ["d4d4d4d4-dddd-dddd-dddd-000000000004", "e5e5e5e5-eeee-eeee-eeee-000000000005",
                   "f6f6f6f6-ffff-ffff-ffff-000000000006", "a7a7a7a7-aaaa-aaaa-aaaa-000000000007"];
    const spec = rows([]);
    for (const id of extra) {
      spec.circle_memberships.push({ user_id: ALICE_ID, other_id: id, status: "accepted" });
      spec.profiles.push({ id, handle: `u${id.slice(0, 2)}`, name: "U", interests: ["food"], travel_styles: [], budget_style: "budget", travel_pace: "balanced", spoken_languages: ["en"], verified: true, date_of_birth: ADULT_DOB_BOB });
    }
    const reads: Record<string, number> = {};
    const result = await groupEvents({
      rows: spec,
      failOn: (ctx: any) => { reads[ctx.table] = (reads[ctx.table] ?? 0) + 1; return null; },
    });
    assert.equal(result.group.size, 6, "six people in the group");
    assert.equal(reads["identity_verifications"], 1,
      `the verified-age signal must be ONE batched read for the whole group, got ${reads["identity_verifications"]}`);
    assert.equal(reads["profiles"], 1, "and the profile read stays the single batched read it already was");
    assert.ok(idsOf(result).includes("ev-18plus"), "six adults, no contradiction: the 18+ event still passes");
  });

  it("a member whose profile row never came back is not silently dropped from the group", async () => {
    // Bob is in the circle but has no `profiles` row in this read. Dropping him
    // would shrink the group AND remove his unknown age from the aggregate —
    // the permissive answer. He joins as an unknown-age member instead.
    const spec = rows([]);
    spec.profiles = spec.profiles.filter((p: any) => p.id !== BOB_ID);
    const result = await groupEvents({ rows: spec });
    assert.equal(result.group.size, 2, "the group is still two people");
    assert.ok(!idsOf(result).includes("ev-18plus"));
    assert.deepEqual(idsOf(result), ["ev-open"]);
  });
});

describe("the same refusal one layer later: the group RANKING profile", () => {
  const adult = (age: number, dob: string): GroupMemberPrefs => ({
    userId: ALICE_ID, handle: "alice", interests: [], travelStyles: [],
    budgetStyle: null, travelPace: null, verified: true,
    ageGate: { state: "ok", age, dateOfBirth: dob },
  });

  it("a verified minor does not let the rest of the group vouch for the group's age", () => {
    const agg = aggregateGroupPreferences([
      adult(36, ADULT_DOB_ALICE),
      { ...adult(31, ADULT_DOB_BOB), userId: BOB_ID, ageGate: { state: "verified_minor" } },
    ]);
    // NOT 36. The old code filtered the minor out of `knownAges` and handed the
    // adult's age to the gate as if it were the group's.
    assert.equal(agg.youngestAge, null);
  });

  it("an unresolved group age is REMOVED from the ranking profile, not inherited from the viewer", () => {
    const viewer = { userId: ALICE_ID, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], viewerAge: 36 } as unknown as CompassProfile;
    const closed = aggregateGroupPreferences([
      adult(36, ADULT_DOB_ALICE),
      { ...adult(31, ADULT_DOB_BOB), userId: BOB_ID, ageGate: { state: "unreadable" } },
    ]);
    assert.equal(buildGroupRankingProfile(viewer, closed, []).viewerAge, undefined,
      "the viewer's own 36 must not stand in for a group whose age is unknown");
    const open = aggregateGroupPreferences([adult(36, ADULT_DOB_ALICE), { ...adult(31, ADULT_DOB_BOB), userId: BOB_ID }]);
    assert.equal(buildGroupRankingProfile(viewer, open, []).viewerAge, 31,
      "and a group whose age IS known still drives age-gated ranking");
  });
});
