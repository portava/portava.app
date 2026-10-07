/**
 * census-trust TRV2-08 / OD-TRUST-5 / lead rulings D-24 and D-24a — a Trust
 * restriction reaches the Compass actions it covers, and no others, through
 * the SAME shared decision the Trips doors use (lib/tripTrustGate.ts).
 *
 * WHAT THIS PINS (rewritten 2026-10-06 for D-24/D-24a)
 * ==============
 *  1. The mapping is D-24's confirmed table: create_proposal = hosting OR
 *     messaging; add_to_trip and both confirms = hosting (change a group
 *     trip's shared plan). private_plan_access and location_plan_join stop no
 *     Compass action.
 *  2. A SOLO trip is never refused, and its restriction state is not read
 *     (D-24a). A GROUP trip is one with any other accepted member — the
 *     actor need not own it.
 *  3. Unreadable trip shape → "try again", never "restricted" (D-24a); on a
 *     group trip, an unreadable restriction state (either degraded shape, or a
 *     throw) → the same.
 *  4. Through the REAL tools: a refused create_proposal issues NO kernel
 *     command (the recorded rpc list is the state assertion); add_to_trip
 *     returns no proposal; replan_day stops pointing at create_proposal.
 *  5. Compass and the Trips doors decide identically (the shared helper).
 *
 * The two route call sites (plan-proposal confirm, autopilot confirm) are
 * driven through their real routers in compass-tools.test.ts §H2 and
 * compassAutopilotKernelPath.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/compassRestrictionGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE,
  COMPASS_TRIP_ACTION,
  checkCompassActionRestriction,
  compassRestrictionToolInfo,
  sendCompassRestrictionRefusal,
  type CompassRestrictedAction,
} from "../compass/CompassRestrictionGate.js";
import { executeCompassTool, toolCreateProposal } from "../compass/CompassTools.js";
import { decideTripActionRestriction, RETAINED_RECORD_ONLY_MESSAGE, TRIP_ACTION_RESTRICTIONS } from "../lib/tripTrustGate.js";
import { getSafeTrustSummary } from "../services/trust/TrustPrivacyGuard.js";
import { RESTRICTION_SENTENCES } from "../lib/discoveryTrustGate.js";
import { readTripProposal } from "../domain/trips/contracts/TripProposalContract.js";

const USER = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const OTHER = "c3c3c3c3-cccc-4ccc-8ccc-000000000003";
const TRIP = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";

const ACTIONS: CompassRestrictedAction[] = ["create_proposal", "add_to_trip", "confirm_plan_proposal", "confirm_autopilot_proposal"];

// ── 3. Through the real create_proposal tool ─────────────────────────────────

type Row = Record<string, any>;

/** PostgREST-shaped fake: the reads toolCreateProposal makes, plus the kernel rpc, recorded. */
function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const rpcs: Array<{ fn: string; args: any }> = [];
  const reads: string[] = [];
  const client: any = {
    rpcs,
    reads,
    from(table: string) {
      reads.push(table);
      if (errorOn.includes(table)) {
        const f: any = {
          select: () => f, eq: () => f, in: () => f, is: () => f, or: () => f, gt: () => f, order: () => f, limit: () => f,
          maybeSingle: async () => ({ data: null, error: { message: `${table} unavailable`, code: "XX000" } }),
          then: (onF: any, onR: any) => Promise.resolve({ data: null, error: { message: `${table} unavailable`, code: "XX000" } }).then(onF, onR),
        };
        return f;
      }
      const filters: Array<(r: Row) => boolean> = [];
      const settle = (single: boolean) => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return chain; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return chain; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
        or: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: async () => settle(true),
        then: (onF: any, onR: any) => Promise.resolve(settle(false)).then(onF, onR),
      };
      return chain;
    },
    async rpc(fn: string, args: any) {
      rpcs.push({ fn, args });
      if (fn !== "trip_kernel_execute") return { data: null, error: null };
      return { data: { ok: true, duplicate: false, version: 2, event_id: 1, sequence: 1, result: { id: "prop-1" }, contract_version: 2 }, error: null };
    },
  };
  return client;
}

/** A group trip hosted by USER, with OTHER as an accepted member. */
function world(restrictions: Row[] = [], opts: { solo?: boolean; ownerIsOther?: boolean; readOnly?: boolean } = {}): Record<string, Row[]> {
  const members: Row[] = [{
    trip_id: TRIP, user_id: USER, role: opts.ownerIsOther ? "member" : "owner", status: "accepted",
    // Lane C's R5: membership restored by an upheld appeal after the trip ended (3974).
    ...(opts.readOnly ? { permissions: { access: "retained_record_only" } } : {}),
  }];
  if (!opts.solo) members.push({ trip_id: TRIP, user_id: OTHER, role: opts.ownerIsOther ? "owner" : "member", status: "accepted" });
  return {
    trips: [{ id: TRIP, owner_id: opts.ownerIsOther ? OTHER : USER, status: "active", title: "Cebu trip", plan_edit_permission: "all_members" }],
    trip_members: members,
    feature_flags: [{ flag: "trip_kernel_enabled", enabled: true }],
    trust_restrictions: restrictions,
    discovery_places: [{ id: PLACE, name: "Lantaw Cafe", category: "cafe" }],
  };
}
const PLACE = "d4d4d4d4-dddd-4ddd-8ddd-000000000004";

const PROPOSE = { tripId: TRIP, proposalType: "cancel_plan", change: { targetId: "walk" }, rationale: "rain", affectedObjects: ["walk"] };
const kernelCalls = (c: any) => c.rpcs.filter((r: any) => r.fn === "trip_kernel_execute").length;
const R = (t: string, extra: Row = {}) => ({ user_id: USER, restriction_type: t, lifted_at: null, expires_at: null, ...extra });

const isRestricted = (v: any, types: string[]) =>
  !v.allowed && v.kind === "restricted" && JSON.stringify(v.restrictionTypes) === JSON.stringify(types);
const isUnverifiable = (v: any) => !v.allowed && v.kind === "unverifiable";

// ── 1. The mapping (lead ruling D-24's confirmed table) ──────────────────────

describe("TRV2-08 §1 — each Compass door is one of the shared Trips decisions", () => {
  it("create_proposal is the helper's create_proposal; add_to_trip and both confirms are change_shared_plan (a change here is a policy change)", () => {
    assert.deepEqual({ ...COMPASS_TRIP_ACTION }, {
      create_proposal: "create_proposal",
      add_to_trip: "change_shared_plan",
      confirm_plan_proposal: "change_shared_plan",
      confirm_autopilot_proposal: "change_shared_plan",
    });
    assert.deepEqual([...TRIP_ACTION_RESTRICTIONS.create_proposal], ["hosting", "messaging"]);
    assert.deepEqual([...TRIP_ACTION_RESTRICTIONS.change_shared_plan], ["hosting"]);
  });

  it("hosting refuses every Compass door on a GROUP trip — host or member — in the restriction's own sentence", async () => {
    for (const ownerIsOther of [false, true]) {
      for (const a of ACTIONS) {
        const v = await checkCompassActionRestriction(makeClient(world([R("hosting")], { ownerIsOther })), USER, TRIP, a);
        assert.ok(isRestricted(v, ["hosting"]), `${a} ownerIsOther=${ownerIsOther}: ${JSON.stringify(v)}`);
        if (!v.allowed && v.kind === "restricted") assert.equal(v.message, RESTRICTION_SENTENCES.hosting);
      }
    }
  });

  it("messaging refuses create_proposal only (a proposal counts as hosting OR messaging); add_to_trip and the confirms go through", async () => {
    for (const a of ACTIONS) {
      const v = await checkCompassActionRestriction(makeClient(world([R("messaging")])), USER, TRIP, a);
      if (a === "create_proposal") assert.ok(isRestricted(v, ["messaging"]), JSON.stringify(v));
      else assert.deepEqual(v, { allowed: true, shape: "group" }, a);
    }
  });

  it("private_plan_access and location_plan_join refuse no Compass action", async () => {
    for (const a of ACTIONS) {
      const v = await checkCompassActionRestriction(makeClient(world([R("private_plan_access"), R("location_plan_join")])), USER, TRIP, a);
      assert.deepEqual(v, { allowed: true, shape: "group" }, a);
    }
  });

  it("Compass and the Trips doors decide IDENTICALLY — the gate is the shared helper, not a copy of it", async () => {
    const cases: Array<[Row[], { solo?: boolean; ownerIsOther?: boolean }]> = [
      [[], {}], [[R("hosting")], {}], [[R("messaging")], {}], [[R("hosting")], { solo: true }],
      [[R("hosting")], { ownerIsOther: true }], [[R("hosting"), R("messaging")], {}],
    ];
    for (const [rs, opts] of cases) {
      for (const a of ACTIONS) {
        const compass: any = await checkCompassActionRestriction(makeClient(world(rs, opts)), USER, TRIP, a);
        const trips: any = await decideTripActionRestriction(makeClient(world(rs, opts)), TRIP, USER, COMPASS_TRIP_ACTION[a]);
        assert.equal(compass.allowed, trips.allowed, `${a} ${JSON.stringify(rs)} ${JSON.stringify(opts)}`);
        if (!compass.allowed) assert.deepEqual([compass.kind, compass.restrictionTypes, compass.message], [trips.kind, trips.restrictionTypes, trips.message]);
      }
    }
  });
});

// ── 2. Solo trips and unreadable state (lead ruling D-24a) ───────────────────

describe("TRV2-08 §2 — a solo trip is never refused; 'could not read' is neither 'not restricted' nor 'restricted'", () => {
  it("a SOLO trip under hosting AND messaging is allowed at every door, and the restriction state is not even read", async () => {
    for (const a of ACTIONS) {
      const c = makeClient(world([R("hosting"), R("messaging")], { solo: true }));
      assert.deepEqual(await checkCompassActionRestriction(c, USER, TRIP, a), { allowed: true, shape: "solo" }, a);
      assert.ok(!c.reads.includes("trust_restrictions"), `${a}: a solo trip's restriction state was read`);
    }
  });

  it("an invited-but-not-accepted person does not make a trip a group trip", async () => {
    const t = world([R("hosting")], { solo: true });
    t.trip_members.push({ trip_id: TRIP, user_id: OTHER, role: "member", status: "invited" });
    assert.deepEqual(await checkCompassActionRestriction(makeClient(t), USER, TRIP, "confirm_plan_proposal"), { allowed: true, shape: "solo" });
  });

  it("an UNREADABLE trip_members — solo or group cannot be told — is 'try again' at every door, never allowed and never 'restricted'", async () => {
    for (const a of ACTIONS) {
      const v = await checkCompassActionRestriction(makeClient(world([], { solo: true }), ["trip_members"]), USER, TRIP, a);
      assert.ok(isUnverifiable(v), `${a}: ${JSON.stringify(v)}`);
      if (!v.allowed) { assert.equal(v.message, COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE); assert.doesNotMatch(v.message, /restrict/i); }
    }
  });

  it("an UNREADABLE trips row is 'try again' too", async () => {
    const v = await checkCompassActionRestriction(makeClient(world([R("hosting")]), ["trips"]), USER, TRIP, "confirm_plan_proposal");
    assert.ok(isUnverifiable(v), JSON.stringify(v));
  });

  it("on a GROUP trip an unreadable trust_restrictions is 'try again'; on a SOLO trip it is never consulted", async () => {
    const group = await checkCompassActionRestriction(makeClient(world(), ["trust_restrictions"]), USER, TRIP, "confirm_autopilot_proposal");
    assert.ok(isUnverifiable(group), JSON.stringify(group));
    const solo = await checkCompassActionRestriction(makeClient(world([], { solo: true }), ["trust_restrictions"]), USER, TRIP, "confirm_autopilot_proposal");
    assert.deepEqual(solo, { allowed: true, shape: "solo" });
  });

  it("a client that THROWS is caught (by the shared helper's own reads) and refuses as unverifiable", async () => {
    const throwing: any = { from: () => { throw new Error("boom"); } };
    const v = await checkCompassActionRestriction(throwing, USER, TRIP, "create_proposal");
    assert.ok(isUnverifiable(v), JSON.stringify(v));
  });

  it("the unverifiable words never call the person restricted; the tool info says it is NOT a restriction", () => {
    assert.doesNotMatch(COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE, /restrict/i);
    const info = compassRestrictionToolInfo({ allowed: false, kind: "unverifiable", reason: "x", message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE });
    assert.match(info, /NOT a restriction/);
  });
});

// ── 3. Through the real tools ────────────────────────────────────────────────

describe("TRV2-08 §3 — create_proposal and add_to_trip, through the real tools", () => {
  it("a clean record proposes (control: the kernel IS reached on this fixture)", async () => {
    const c = makeClient(world());
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
    assert.equal(kernelCalls(c), 1);
  });

  it("hosting on a GROUP trip: create_proposal proposes NOTHING and the model is told why, in the restriction's words", async () => {
    for (const ownerIsOther of [false, true]) {
      const c = makeClient(world([R("hosting")], { ownerIsOther }));
      const r: any = await toolCreateProposal(c, USER, PROPOSE);
      assert.equal(r.proposal, null);
      assert.ok(String(r.info).startsWith(RESTRICTION_SENTENCES.hosting), r.info);
      assert.equal(kernelCalls(c), 0, "no kernel command may be issued for a restricted person");
    }
  });

  it("messaging on a GROUP trip: create_proposal proposes nothing", async () => {
    const c = makeClient(world([R("messaging")]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal, null);
    assert.ok(String(r.info).startsWith(RESTRICTION_SENTENCES.messaging), r.info);
    assert.equal(kernelCalls(c), 0);
  });

  it("a SOLO trip under hosting and messaging proposes (D-24a)", async () => {
    const c = makeClient(world([R("hosting"), R("messaging")], { solo: true }));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
    assert.equal(kernelCalls(c), 1);
  });

  it("a LIFTED hosting restriction no longer refuses", async () => {
    const c = makeClient(world([R("hosting", { lifted_at: "2026-10-01T00:00:00Z" })]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
  });

  it("a restriction on ANOTHER person does not refuse this one", async () => {
    const c = makeClient(world([R("hosting", { user_id: OTHER })]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
  });

  it("an UNREADABLE trust_restrictions on a group trip proposes nothing, and tells the model it is NOT a restriction", async () => {
    const c = makeClient(world(), ["trust_restrictions"]);
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal, null);
    assert.match(r.info, /NOT a restriction/);
    assert.doesNotMatch(r.info, /cannot host|cannot initiate/);
    assert.equal(kernelCalls(c), 0);
  });

  it("add_to_trip: hosting on a GROUP trip returns no proposal; a SOLO trip and a messaging restriction still get one", async () => {
    const restricted: any = await executeCompassTool(makeClient(world([R("hosting")])), USER, null, "add_to_trip", { tripId: TRIP, placeId: PLACE });
    assert.ok(!restricted.proposal, JSON.stringify(restricted));
    assert.ok(String(restricted.error).startsWith(RESTRICTION_SENTENCES.hosting), JSON.stringify(restricted));
    const solo: any = await executeCompassTool(makeClient(world([R("hosting")], { solo: true })), USER, null, "add_to_trip", { tripId: TRIP, placeId: PLACE });
    assert.equal(solo.proposal?.status, "pending_confirmation", JSON.stringify(solo));
    const messaging: any = await executeCompassTool(makeClient(world([R("messaging")])), USER, null, "add_to_trip", { tripId: TRIP, placeId: PLACE });
    assert.equal(messaging.proposal?.status, "pending_confirmation", JSON.stringify(messaging));
  });

  it("add_to_trip: an unreadable restriction state on a group trip is 'try again', with no proposal", async () => {
    const r: any = await executeCompassTool(makeClient(world(), ["trust_restrictions"]), USER, null, "add_to_trip", { tripId: TRIP, placeId: PLACE });
    assert.ok(!r.proposal);
    assert.match(String(r.error), /NOT a restriction/);
  });

  it("CT-09: a proposal that IS made carries affectedObjects, rationale and impactSummary — read back through the contract's own reader", async () => {
    const c = makeClient(world());
    await toolCreateProposal(c, USER, { ...PROPOSE, decisionRule: "majority", expiresAt: "2026-10-06T12:00:00Z", impactSummary: "no bookings affected" });
    const cmd = c.rpcs.find((r: any) => r.fn === "trip_kernel_execute")?.args?.p_command;
    assert.ok(cmd, "the kernel command was recorded");
    assert.equal(cmd.type, "CREATE_PROPOSAL");
    // What a crew member's reader will make of the stored row — not the keys
    // this test happens to expect.
    const read = readTripProposal({
      id: "prop-1", trip_id: TRIP, proposal_type: cmd.payload.proposal_type, status: "pending",
      expires_at: cmd.payload.expires_at, decision_rule: cmd.payload.decision_rule, proposed_by: USER,
      payload_json: cmd.payload.payload_json,
    });
    assert.deepEqual(read.affectedObjects, ["walk"]);
    assert.match(String(read.rationale), /rain/);
    assert.match(String(read.impactSummary), /no bookings affected/);
    assert.equal(cmd.payload.decision_rule, "majority");
    assert.equal(cmd.payload.expires_at, "2026-10-06T12:00:00Z");
    assert.equal(cmd.payload.payload_json.source, "compass");
  });
});

// ── 4. A retained-record-only member (lane C's read_only verdict) ────────────

describe("TRV2-08 §4 — a member restored to an ended trip's record only may read it, not change it, and is never called restricted", () => {
  it("every Compass door refuses read_only — solo or group, with NO restriction on the person", async () => {
    for (const solo of [false, true]) {
      for (const a of ACTIONS) {
        const v = await checkCompassActionRestriction(makeClient(world([], { solo, readOnly: true })), USER, TRIP, a);
        assert.deepEqual(v, { allowed: false, kind: "read_only", message: RETAINED_RECORD_ONLY_MESSAGE }, `${a} solo=${solo}`);
      }
    }
  });

  it("the tool says the trip can be viewed, not changed — never a restriction — and issues no kernel command", async () => {
    const c = makeClient(world([], { readOnly: true }));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal, null);
    assert.ok(String(r.info).startsWith(RETAINED_RECORD_ONLY_MESSAGE), r.info);
    assert.doesNotMatch(String(r.info), /restrict/i);
    // The read_only wording itself (VL5b N1): the model is told the RECORD can be
    // viewed but not changed — never the restricted fallthrough's "on a group trip
    // for them … do not try another way", which frames an ended trip as a penalty.
    assert.match(String(r.info), /can be viewed but no longer changed/, r.info);
    assert.doesNotMatch(String(r.info), /group trip/i, r.info);
    assert.doesNotMatch(String(r.info), /another way/i, r.info);
    assert.equal(kernelCalls(c), 0);
    const added: any = await executeCompassTool(makeClient(world([], { readOnly: true })), USER, null, "add_to_trip", { tripId: TRIP, placeId: PLACE });
    assert.ok(!added.proposal);
    assert.doesNotMatch(String(added.error), /restrict/i);
  });

  it("the route body is the Trips doors' own: 403 trip_record_read_only, no restrictionTypes", () => {
    let status = 0; let body: any = null;
    const res: any = { status(n: number) { status = n; return res; }, json(b: unknown) { body = b; return res; } };
    sendCompassRestrictionRefusal(res, { allowed: false, kind: "read_only", message: RETAINED_RECORD_ONLY_MESSAGE });
    assert.equal(status, 403);
    assert.deepEqual(body, { error: "trip_record_read_only", message: RETAINED_RECORD_ONLY_MESSAGE });
  });
});

// ── 5. The refusal's words are the person's own restriction summary ──────────

describe("TRV2-08 §5 — a Compass refusal says exactly the sentence the person's restriction summary shows (D-24)", () => {
  it("RESTRICTION_SENTENCES (lane C's copy the gate refuses with) equals TrustPrivacyGuard's summary sentence for hosting and messaging", async () => {
    // Read through the REAL summary builder, so when lane B rewrites the
    // sentences (lead ruling D-24, PR #636) this goes red until the gate's
    // words come from TrustPrivacyGuard too.
    const summary = await getSafeTrustSummary(makeClient(world([R("hosting"), R("messaging")])) as any, USER);
    assert.equal(summary.restrictionsDegraded, undefined, "the fake must read the restrictions, or this proves nothing");
    assert.ok(summary.restrictions.includes(RESTRICTION_SENTENCES.hosting), JSON.stringify(summary.restrictions));
    assert.ok(summary.restrictions.includes(RESTRICTION_SENTENCES.messaging), JSON.stringify(summary.restrictions));
  });
});

