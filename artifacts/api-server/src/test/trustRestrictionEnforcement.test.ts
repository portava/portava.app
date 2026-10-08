/**
 * All four Trust restrictions are ENFORCED, not just declared.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * TrustRestrictionService declares four types. `hosting` was gated in
 * routes/trips.ts and `messaging` in routes/messaging.ts. The other two —
 * `private_plan_access` ("excluded from private plans") and `location_plan_join`
 * ("cannot join location-based plans") — reached the user as capability chips on
 * their Passport and were enforced NOWHERE (census-trust A13).
 *
 * A user was TOLD they were excluded and then let in. That is worse than either
 * honest outcome: a restriction that is announced and not applied teaches a
 * moderator that the sanction works.
 *
 * This asserts the ENFORCEMENT EXISTS at the two points that mean "joining", by
 * reading the routes — a route test would need the whole Express + Supabase
 * fixture for a one-line predicate, and what regresses here is deletion, not
 * logic. The predicate itself (getRestrictionState) is covered by trust.test.ts.
 *
 * WHAT WOULD TURN THIS RED: delete either gate, or move it off the join path.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/trustRestrictionEnforcement.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Read a source file with its COMMENTS BLANKED.
 *
 * The first version of this file read the raw text, and a mutation test caught
 * it: replacing `if (!locTrust.canJoinLocationPlans)` with `if (false)` left
 * every assertion green, because the paragraph ABOVE the gate explaining what
 * canJoinLocationPlans is still contained the word. A test that a comment can
 * satisfy is a test of the documentation.
 */
const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** The handler body for one route, so a gate elsewhere in the file cannot pass for this one. */
function handler(src: string, marker: string): string {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `route ${marker} not found — it was renamed or removed`);
  const rest = src.slice(i + marker.length);
  const next = rest.search(/\nrouter\.(get|post|put|patch|delete)\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("every declared restriction type has an enforcement point", () => {
  it("all four types are still declared — if one is dropped, its gate is dead code", () => {
    const svc = read("../services/trust/TrustRestrictionService.ts");
    for (const t of ["hosting", "private_plan_access", "messaging", "location_plan_join"]) {
      assert.match(svc, new RegExp(`\\|\\s*"${t}"`), `${t} is no longer a RestrictionType`);
    }
  });

  it("hosting is gated where a trip becomes a GROUP trip — inviting someone — and not on creation (lead ruling D-24a)", () => {
    // A trip being created is its creator's alone, and a hosting restriction
    // does not stop a solo trip (census-trips §85.1). The gate is on the doors
    // that bring someone else in; trustRestrictionDoors.test.ts proves each by
    // behaviour.
    const trips = read("../routes/trips.ts");
    assert.match(handler(trips, 'router.post("/trips/:tripId/invite"'), /refuseIfTrustRestricted\(res,[^;]*"hosting"\)/);
    assert.match(handler(read("../routes/trips-expansion.ts"), 'router.post("/trips/:tripId/invite-link"'), /refuseIfTrustRestricted\(res,[^;]*"hosting"\)/);
    assert.doesNotMatch(handler(trips, 'router.post("/trips", '), /canHost|getRestrictionState|refuseIfTrustRestricted/, "creation reads no restriction state");
  });

  it("messaging is gated where a conversation is initiated", () => {
    assert.match(read("../routes/messaging.ts"), /getRestrictionState/);
  });

  it("private_plan_access is gated on ACCEPTING AN INVITE, and only for a private trip", () => {
    const h = handler(read("../routes/trips.ts"), 'router.post("/trips/:tripId/accept-invite"');
    assert.match(h, /canJoinPrivatePlans/, "the accept-invite handler must consult the restriction");
    assert.match(
      h, /\["private", "invite"\]/,
      "a PUBLIC trip is not a private plan — gating it would refuse a join the restriction does not cover",
    );
    assert.match(h, /trust_restriction/, "and it must answer with the same error code the hosting gate uses");
  });

  it("location_plan_join is gated on STARTING a live share", () => {
    const h = handler(read("../routes/tripCrewLocation.ts"), 'router.post("/trips/:tripId/crew/live-share/start"');
    assert.match(h, /canJoinLocationPlans/, "starting a share is the location-based join this type names");
    assert.match(h, /trust_restriction/);
  });

  it("STOPPING a live share is NOT gated — a restricted user must always be able to stop", () => {
    const h = handler(read("../routes/tripCrewLocation.ts"), 'router.post("/trips/:tripId/crew/live-share/stop"');
    assert.ok(
      !/canJoinLocationPlans/.test(h),
      "gating the stop path would trap a restricted user in a live location broadcast",
    );
  });
});

// ── census-trust §31 — an UNREAD restriction state grants none of the four ──
//
// Until 2026-10-03 the fail-CLOSED branch closed hosting and messaging and LEFT
// private_plan_access and location_plan_join OPEN ("low-risk actions"), and the
// two gates below were written to rely on that: no degraded branch, because the
// flag could not be false on a degraded read. Neither type is low-risk —
// location_plan_join gates the start of a live LOCATION broadcast to a crew —
// and an unread restriction state must never grant access. So the branch now
// closes all four, and each gate must answer that state with the retryable
// refusal, BEFORE its restriction message (which would accuse an unrestricted
// user of being restricted). The behaviour is driven end to end in
// tripCrewRosterUnreadable.test.ts (T1-T5) and tripInviteRespond.test.ts (15-17).
describe("a degraded restriction read refuses every join, and both join gates say so retryably", () => {
  it("the fail-CLOSED branch closes ALL FOUR restriction types", () => {
    const svc = read("../services/trust/TrustRestrictionService.ts");
    // Asserted in CODE, not in prose: `read` blanks comments, and the claim the
    // two gates depend on is a set of literal return values.
    const closed = svc.slice(svc.indexOf("failing closed on every restriction type") - 400);
    const branch = closed.slice(closed.indexOf("return {"), closed.indexOf("degradedReason:") + 60);
    assert.match(branch, /canHost:\s*false/, "hosting must fail CLOSED");
    assert.match(branch, /canMessage:\s*false/, "messaging must fail CLOSED");
    assert.match(branch, /canJoinPrivatePlans:\s*false/, "private_plan_access must fail CLOSED");
    assert.match(branch, /canJoinLocationPlans:\s*false/, "location_plan_join must fail CLOSED");
  });

  for (const [label, file, marker, flag] of [
    ["accept-invite (private_plan_access)", "../routes/trips.ts", 'router.post("/trips/:tripId/accept-invite"', "canJoinPrivatePlans"],
    ["live-share start (location_plan_join)", "../routes/tripCrewLocation.ts", 'router.post("/trips/:tripId/crew/live-share/start"', "canJoinLocationPlans"],
  ] as const) {
    it(`${label}: a fail_closed read is answered degraded_unavailable BEFORE the restriction message`, () => {
      const h = handler(read(file), marker);
      const gate = h.indexOf(flag);
      assert.notEqual(gate, -1, `${label}: the gate is gone`);
      const degraded = h.indexOf('degradedReason === "fail_closed"');
      assert.notEqual(degraded, -1, `${label}: no fail_closed branch — a degraded read would read as a restriction`);
      const restricted = h.indexOf("trust_restriction", gate);
      assert.ok(
        degraded < restricted,
        `${label}: the degraded branch must run before the restriction message, or an outage accuses the user`,
      );
      assert.match(h.slice(degraded, restricted), /degraded_unavailable/, `${label}: the degraded answer is the retryable code`);
    });
  }
});
