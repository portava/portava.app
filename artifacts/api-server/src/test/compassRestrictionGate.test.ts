/**
 * census-trust TRV2-08 / OD-TRUST-5 — Trust restrictions reach the Compass
 * actions that act for a person.
 *
 * WHAT THIS PINS
 * ==============
 *  1. The mapping (lane L's reading, compass/CompassRestrictionGate.ts) —
 *     exactly which restriction types refuse which Compass action, and that a
 *     type NOT needed for an action does not refuse it ("limit each restriction
 *     to the actions … needed").
 *  2. An unreadable restriction state refuses — in BOTH degraded shapes,
 *     including `fail_open`, whose can-flags all read true — and the words never
 *     say the person is restricted.
 *  3. Through the REAL tool, `create_proposal`: a hosting or messaging
 *     restriction, or an unreadable `trust_restrictions`, means NO kernel
 *     command is issued (the state assertion: the recorded rpc list is empty),
 *     while a clean record, a lifted restriction or an unrelated one still
 *     proposes.
 *
 * The three route call sites (plan-proposal confirm, autopilot confirm,
 * boost-visibility) are driven through their real routers in
 * compass-tools.test.ts §H2 and compassAutopilotKernelPath.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/compassRestrictionGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  COMPASS_ACTION_RESTRICTIONS,
  COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE,
  checkCompassActionRestriction,
  compassRestrictionToolInfo,
  decideCompassAction,
  type CompassRestrictedAction,
} from "../compass/CompassRestrictionGate.js";
import { toolCreateProposal } from "../compass/CompassTools.js";
import { readTripProposal } from "../domain/trips/contracts/TripProposalContract.js";
import type { RestrictionState, RestrictionType } from "../services/trust/TrustRestrictionService.js";

const USER = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const TRIP = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";

const ACTIONS: CompassRestrictedAction[] = [
  "create_proposal",
  "confirm_plan_proposal",
  "confirm_autopilot_proposal",
  "boost_visibility_on",
];
const ALL_TYPES: RestrictionType[] = ["hosting", "private_plan_access", "messaging", "location_plan_join"];

function clean(active: RestrictionType[] = []): RestrictionState {
  return {
    canHost: !active.includes("hosting"),
    canJoinPrivatePlans: !active.includes("private_plan_access"),
    canMessage: !active.includes("messaging"),
    canJoinLocationPlans: !active.includes("location_plan_join"),
    activeRestrictions: active,
  };
}

// ── 1. The mapping ────────────────────────────────────────────────────────────

describe("TRV2-08 §1 — which restriction refuses which Compass action", () => {
  it("is exactly lane L's stated reading (a change here is a policy change, not a refactor)", () => {
    assert.deepEqual(
      Object.fromEntries(ACTIONS.map((a) => [a, [...COMPASS_ACTION_RESTRICTIONS[a]]])),
      {
        create_proposal: ["hosting", "messaging"],
        confirm_plan_proposal: ["hosting"],
        confirm_autopilot_proposal: ["hosting"],
        boost_visibility_on: ["messaging"],
      },
    );
  });

  it("a clean record allows every action", () => {
    for (const a of ACTIONS) assert.deepEqual(decideCompassAction(a, clean()), { allowed: true }, a);
  });

  it("each mapped type refuses its action, names only that type, and says so in words", () => {
    for (const a of ACTIONS) {
      for (const t of COMPASS_ACTION_RESTRICTIONS[a]) {
        const v = decideCompassAction(a, clean([t]));
        assert.equal(v.allowed, false, `${a} under ${t}`);
        assert.ok(!v.allowed && v.kind === "restricted");
        if (!v.allowed && v.kind === "restricted") {
          assert.deepEqual(v.restrictionTypes, [t]);
          assert.match(v.message, /currently restricted from/);
        }
      }
    }
  });

  it("a type the action does not need does NOT refuse it (OD-TRUST-5: limit to the actions needed)", () => {
    for (const a of ACTIONS) {
      const unneeded = ALL_TYPES.filter((t) => !COMPASS_ACTION_RESTRICTIONS[a].includes(t));
      assert.ok(unneeded.length > 0);
      assert.deepEqual(decideCompassAction(a, clean(unneeded)), { allowed: true }, `${a} under ${unneeded.join(",")}`);
    }
  });
});

// ── 2. An unreadable state ────────────────────────────────────────────────────

describe("TRV2-08 §2 — 'could not read' is neither 'not restricted' nor 'restricted'", () => {
  it("fail_closed refuses as unverifiable", () => {
    const st: RestrictionState = { ...clean(), canHost: false, canMessage: false, canJoinPrivatePlans: false, canJoinLocationPlans: false, degraded: true, degradedReason: "fail_closed" };
    for (const a of ACTIONS) {
      const v = decideCompassAction(a, st);
      assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "fail_closed", a);
    }
  });

  it("fail_open refuses too, although every can-flag reads TRUE — the table could not be read", () => {
    const st: RestrictionState = { ...clean(), degraded: true, degradedReason: "fail_open" };
    for (const a of ACTIONS) {
      const v = decideCompassAction(a, st);
      assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "fail_open", a);
    }
  });

  it("the unverifiable words never call the person restricted", () => {
    assert.doesNotMatch(COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE, /restrict/i);
    const info = compassRestrictionToolInfo({ allowed: false, kind: "unverifiable", reason: "fail_closed", message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE });
    assert.match(info, /NOT a restriction/);
  });

  it("a read that THROWS refuses as unverifiable rather than escaping", async () => {
    const throwing: any = { from: () => { throw new Error("boom"); } };
    // getRestrictionState catches its own errors; this is the belt for a client
    // that fails before the service can.
    const v = await checkCompassActionRestriction(throwing, USER, "create_proposal");
    assert.equal(v.allowed, false);
    assert.ok(!v.allowed && v.kind === "unverifiable");
  });
});

// ── 3. Through the real create_proposal tool ─────────────────────────────────

type Row = Record<string, any>;

/** PostgREST-shaped fake: the reads toolCreateProposal makes, plus the kernel rpc, recorded. */
function makeClient(tables: Record<string, Row[]>, errorOn: string[] = []) {
  const rpcs: Array<{ fn: string; args: any }> = [];
  const client: any = {
    rpcs,
    from(table: string) {
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

function world(restrictions: Row[] = []): Record<string, Row[]> {
  return {
    trips: [{ id: TRIP, owner_id: USER, status: "active" }],
    trip_members: [{ trip_id: TRIP, user_id: USER, role: "owner", status: "accepted" }],
    feature_flags: [{ flag: "trip_kernel_enabled", enabled: true }],
    trust_restrictions: restrictions,
  };
}

const PROPOSE = { tripId: TRIP, proposalType: "cancel_plan", change: { targetId: "walk" }, rationale: "rain", affectedObjects: ["walk"] };
const kernelCalls = (c: any) => c.rpcs.filter((r: any) => r.fn === "trip_kernel_execute").length;

describe("TRV2-08 §3 — create_proposal, through the real tool", () => {
  it("a clean record proposes (control: the kernel IS reached on this fixture)", async () => {
    const c = makeClient(world());
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
    assert.equal(kernelCalls(c), 1);
  });

  for (const t of ["messaging", "hosting"] as const) {
    it(`an active ${t} restriction proposes NOTHING and says why`, async () => {
      const c = makeClient(world([{ user_id: USER, restriction_type: t, lifted_at: null, expires_at: null }]));
      const r: any = await toolCreateProposal(c, USER, PROPOSE);
      assert.equal(r.proposal, null);
      assert.match(r.info, /currently restricted from proposing changes to your trip crew/);
      assert.equal(kernelCalls(c), 0, "no kernel command may be issued for a restricted proposer");
    });
  }

  it("a LIFTED restriction no longer refuses", async () => {
    const c = makeClient(world([{ user_id: USER, restriction_type: "messaging", lifted_at: "2026-10-01T00:00:00Z", expires_at: null }]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
    assert.equal(kernelCalls(c), 1);
  });

  it("a restriction on ANOTHER person does not refuse this one", async () => {
    const c = makeClient(world([{ user_id: "someone-else", restriction_type: "hosting", lifted_at: null, expires_at: null }]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
  });

  it("an unrelated restriction type (location_plan_join) does not refuse a proposal", async () => {
    const c = makeClient(world([{ user_id: USER, restriction_type: "location_plan_join", lifted_at: null, expires_at: null }]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
    assert.equal(kernelCalls(c), 1);
  });

  it("an UNREADABLE trust_restrictions proposes nothing, and tells the model it is NOT a restriction", async () => {
    const c = makeClient(world(), ["trust_restrictions"]);
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal, null);
    assert.match(r.info, /NOT a restriction/);
    assert.doesNotMatch(r.info, /currently restricted/);
    assert.equal(kernelCalls(c), 0);
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
