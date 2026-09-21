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

  it("hosting is gated on trip creation (the pattern the other three follow)", () => {
    assert.match(read("../routes/trips.ts"), /if \(!trustState\.canHost\)/);
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

describe("the two new gates do not invent a degraded branch the service does not have", () => {
  it("the fail-CLOSED branch closes hosting and messaging while LEAVING the two low-risk types open", () => {
    const svc = read("../services/trust/TrustRestrictionService.ts");
    // Asserted in CODE, not in prose. The first version of this test matched the
    // comment that says "Low-risk actions … stay open" — and since `read` now
    // blanks comments, that assertion was checking nothing but its own
    // documentation. The claim the two gates depend on is a set of literal
    // return values, so those are what is read.
    const closed = svc.slice(svc.indexOf("failing closed on hosting/messaging") - 400);
    const branch = closed.slice(closed.indexOf("return {"), closed.indexOf("degradedReason:") + 60);
    assert.match(branch, /canHost:\s*false/, "hosting must fail CLOSED");
    assert.match(branch, /canMessage:\s*false/, "messaging must fail CLOSED");
    assert.match(
      branch, /canJoinPrivatePlans:\s*true/,
      "private_plan_access stays OPEN on a degraded read — which is why its gate carries no fail_closed branch",
    );
    assert.match(branch, /canJoinLocationPlans:\s*true/, "location_plan_join likewise");
  });
});
