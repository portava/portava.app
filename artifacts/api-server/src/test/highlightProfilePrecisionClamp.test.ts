/**
 * §10's location-precision clamp, on every Highlight read that publishes a
 * location — not on the two somebody happened to wire it to.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §10  "Publishing location must never exceed the owner's selected precision."
 *   §25  hard invariant: "Public location precision cannot exceed owner policy."
 *   §28.7 "Never allow public location precision above the owner's publication
 *        policy."
 *
 * WHAT WAS WRONG, AND WHAT KIND OF WRONG IT IS
 * -------------------------------------------
 * `routes/highlights.ts` carries ONE section header over TWO independent passes:
 *
 *     applyResurfacingControls   §11 / §21 — suppress PROACTIVE resurfacing
 *     applyLocationPrecision     §10      — clamp a published location
 *
 * and one rationale, which reads "WHY THIS RUNS ON THE FEEDS AND NOT ON THE
 * PROFILE READ … §21: 'Do not resurface — retain and search privately; suppress
 * PROACTIVE resurfacing.' GET /users/:id/highlights is an explicit retrieval".
 *
 * That is exactly right about the FIRST pass and has nothing to do with the
 * second. §10 does not distinguish proactive from explicit: a profile read
 * publishes the Highlight's `location_name` to a viewer just as a feed does, and
 * the owner's selected rung binds either way. One rationale was written for two
 * passes and is true of one of them, so the clamp ran on
 * `GET /highlights/active` and `GET /highlights/following-feed` and not on
 * `GET /users/:userId/highlights`.
 *
 * HOW LIVE THIS IS, STATED PLAINLY RATHER THAN IMPLIED. `highlight_projection_
 * policies` is migration 2721 and is NOT in the production schema snapshot, so
 * on today's database `readProjectionPolicies` answers `absent`, the clamp is a
 * documented no-op on all three routes, and nothing is being disclosed right now
 * that would not be. This is the surface that would violate the invariant the
 * DAY that migration lands, and it is fixed before then rather than after —
 * which is the same posture `assertLifecycleTransition` took toward
 * `state='removed'`.
 *
 * The `ready`-with-a-stored-rung fixture below is therefore not a hypothetical
 * about code: it is the deployment the migration produces, driven through the
 * real route.
 *
 * NO OWNER BYPASS IS INTRODUCED HERE, and that is deliberate. Neither existing
 * call site has one — `GET /highlights/active` clamps the viewer's own
 * Highlights too — while the Memory sibling `protectMemoryRow` does bypass for
 * the owner. Matching the two call sites that already exist can only narrow
 * disclosure; inventing a bypass on one of three routes would widen it, and
 * which of the two readings §10 wants is an owner decision this suite names and
 * does not take.
 *
 * Run: node --import tsx/esm --test src/test/highlightProfilePrecisionClamp.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readProjectionPolicies } from "../services/highlights/highlightProjectionPolicy.js";
import { startApp, call, fixtureTables, OWNER, VIEWER, H_PUB, H_MINE } from "./highlightsSpecHarness.js";

/** A deployed 2721 row: this Highlight may be published no finer than CITY. */
function cityPolicy(highlightId: string, ownerId: string) {
  return {
    id: `p-${highlightId}`,
    highlight_id: highlightId,
    owner_id: ownerId,
    location_precision: "CITY",
    person_visibility: null,
    consent_store: true,
    consent_resurface: true,
    consent_personalize: true,
    consent_share: true,
    consent_contribute_to_aggregate_intel: true,
  };
}

const byId = (body: any, id: string): any =>
  ((body?.highlights ?? []) as any[]).find((h) => h.id === id) ?? null;

describe("GET /users/:userId/highlights — §10 precision clamp", () => {
  it("does not publish the venue name of a Highlight the owner clamped to CITY", async () => {
    const tables = fixtureTables();
    tables.highlight_projection_policies = [cityPolicy(H_PUB, OWNER)];
    const app = await startApp({ tables });
    try {
      const { status, body } = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(status, 200);
      const h = byId(body, H_PUB);
      assert.ok(h, "the public Highlight is visible to this viewer — the ladder is not what is under test");
      assert.equal(
        h.location_name, null,
        "the profile read published the venue NAME of a Highlight whose owner selected CITY",
      );
      // CITY keeps city and country. A clamp that stripped those would be a
      // different bug, and this assertion is what would catch it.
      assert.equal(h.location_city, "Da Nang");
      assert.equal(h.location_country, "Vietnam");
    } finally { await app.close(); }
  });

  it("CONTROL: the active feed already clamps the same fixture", async () => {
    // Without this the subject above could pass for the wrong reason — a fixture
    // whose policy row never resolved would clamp nothing anywhere.
    const tables = fixtureTables();
    tables.highlight_projection_policies = [cityPolicy(H_PUB, OWNER)];
    const app = await startApp({ tables });
    try {
      const { status, body } = await call(app, "GET", `/api/highlights/active?userId=${OWNER}`, VIEWER);
      assert.equal(status, 200);
      const h = byId(body, H_PUB);
      assert.ok(h, "CONTROL: the fixture must reach the active feed");
      assert.equal(h.location_name, null, "CONTROL: the feed clamp must be firing on this fixture");
    } finally { await app.close(); }
  });

  it("leaves a Highlight with no policy row untouched", async () => {
    // `stored == null` on a READY table is not a failed read and must not
    // become a default rung — LOCATION_PRECISION_DEFAULT is an unmade owner
    // decision. The fix must not quietly take it.
    const tables = fixtureTables();
    tables.highlight_projection_policies = [];
    const app = await startApp({ tables });
    try {
      const { body } = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      const h = byId(body, H_PUB);
      assert.ok(h);
      assert.equal(h.location_name, "The Quiet Bar", "no stored rung ⇒ no clamp");
      assert.equal(h.location_city, "Da Nang");
    } finally { await app.close(); }
  });

  it("leaves the profile read untouched when 2721 is ABSENT — today's production", async () => {
    const app = await startApp({ absentTables: new Set(["highlight_projection_policies"]) });
    try {
      const { status, body } = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(status, 200);
      const h = byId(body, H_PUB);
      assert.ok(h, "an undeployed policy table must not empty the profile");
      assert.equal(h.location_name, "The Quiet Bar", "absent ⇒ unenforced, and reported rather than guessed");
    } finally { await app.close(); }
  });

  it("clamps to HIDDEN when the policy table is deployed and UNREADABLE", async () => {
    // Fail closed: the control exists and we cannot show we are inside it.
    const app = await startApp({ failTables: new Set(["highlight_projection_policies"]) });
    try {
      const { status, body } = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(status, 200);
      const h = byId(body, H_PUB);
      assert.ok(h, "an unreadable policy table withholds the LOCATION, not the Highlight");
      assert.equal(h.location_name, null, "unreadable ⇒ HIDDEN");
      assert.equal(h.location_city, null, "unreadable ⇒ HIDDEN");
      assert.equal(h.location_country, null, "unreadable ⇒ HIDDEN");
    } finally { await app.close(); }
  });

  it("applies the same rung to the viewer's OWN Highlight, exactly as the feeds do", async () => {
    // Pinned so the asymmetry with protectMemoryRow cannot be introduced by
    // accident later: if somebody adds an owner bypass here, they must also
    // decide what the feeds do, and this assertion is where that conversation
    // starts.
    const tables = fixtureTables();
    tables.highlight_projection_policies = [cityPolicy(H_MINE, VIEWER)];
    const app = await startApp({ tables });
    try {
      const { body } = await call(app, "GET", `/api/users/${VIEWER}/highlights`, VIEWER);
      const h = byId(body, H_MINE);
      assert.ok(h);
      assert.equal(h.location_name, null, "no owner bypass on this surface — same as GET /highlights/active");
    } finally { await app.close(); }
  });
});

describe("readProjectionPolicies — no service client", () => {
  it("answers `unreadable`, not `absent`, when there is no client to read with", async () => {
    // The route's §10 read runs on the SERVICE client, because a policy row for
    // somebody else's Highlight is not visible under the caller's RLS — a read
    // that silently returned no rows would be `ready`-with-nothing, which is
    // fail-OPEN. `getServiceClient()` can return null, and the answer for that
    // must be the one an unreadable table gets, not the one an UNDEPLOYED table
    // gets: `absent` leaves every location unclamped.
    //
    // ASSERTED ON THE FUNCTION, NOT THROUGH THE ROUTE, and deliberately. In this
    // suite's harness `getServiceClient()` never returns null — `SUPABASE_URL`
    // and `SUPABASE_SERVICE_ROLE_KEY` are set for the runner, so it builds a real
    // client pointed at a dead port, which reaches `unreadable` by a DIFFERENT
    // path (the probe throws). A route-level case would therefore have gone
    // green whichever way this branch was written, which is exactly the false
    // green this file is documenting on another surface.
    const r = await readProjectionPolicies(null, ["30000000-0000-4000-8000-000000000001"]);
    assert.equal(r.state, "unreadable");
  });

  it("still answers `ready` with an empty map for an empty id list", async () => {
    // Preserved behaviour: nothing to clamp is not a failure to read.
    const r = await readProjectionPolicies(null, []);
    assert.equal(r.state, "ready");
  });
});
