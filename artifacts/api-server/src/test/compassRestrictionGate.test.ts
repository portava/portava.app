/**
 * census-trust TRV2-08 / OD-TRUST-5 — a Trust restriction reaches the Compass
 * actions it covers, and no others.
 *
 * WHAT THIS PINS (narrowed 2026-10-06 after independent verification)
 * ==============
 *  1. The mapping is what the person's own restriction summary says
 *     (TrustPrivacyGuard: hosting = "You cannot host group trips"): only
 *     `hosting`, only for the HOST of a GROUP trip. A member who does not host,
 *     the host of a solo trip, and every other restriction type are untouched.
 *  2. An unreadable trip or restriction state refuses — in BOTH degraded
 *     shapes, including `fail_open`, whose can-flags all read true — and the
 *     words never say the person is restricted.
 *  3. Through the REAL tool, `create_proposal`: a refused proposal issues NO
 *     kernel command (the recorded rpc list is the state assertion).
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
  COMPASS_ACTION_RESTRICTIONS,
  COMPASS_HOSTING_RESTRICTED_MESSAGE,
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
const OTHER = "c3c3c3c3-cccc-4ccc-8ccc-000000000003";
const TRIP = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";

const ACTIONS: CompassRestrictedAction[] = ["create_proposal", "confirm_plan_proposal", "confirm_autopilot_proposal"];
const ALL_TYPES: RestrictionType[] = ["hosting", "private_plan_access", "messaging", "location_plan_join"];
const HOST = { hostsGroupTrip: true };
const NOT_HOST = { hostsGroupTrip: false };

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

describe("TRV2-08 §1 — a restriction refuses only what the person is told it restricts", () => {
  it("every mapped action maps to hosting and nothing else (a change here is a policy change)", () => {
    assert.deepEqual(
      Object.fromEntries(ACTIONS.map((a) => [a, [...COMPASS_ACTION_RESTRICTIONS[a]]])),
      { create_proposal: ["hosting"], confirm_plan_proposal: ["hosting"], confirm_autopilot_proposal: ["hosting"] },
    );
  });

  it("hosting refuses the HOST of a group trip, in the summary's own words", () => {
    for (const a of ACTIONS) {
      const v = decideCompassAction(a, HOST, clean(["hosting"]));
      assert.ok(!v.allowed && v.kind === "restricted", a);
      if (!v.allowed && v.kind === "restricted") {
        assert.deepEqual(v.restrictionTypes, ["hosting"]);
        assert.equal(v.message, COMPASS_HOSTING_RESTRICTED_MESSAGE);
        assert.match(v.message, /hosting group trips/);
      }
    }
  });

  it("hosting does NOT refuse someone who is not hosting a group trip (a member, or a solo trip)", () => {
    for (const a of ACTIONS) assert.deepEqual(decideCompassAction(a, NOT_HOST, clean(["hosting"])), { allowed: true }, a);
  });

  it("messaging, private_plan_access and location_plan_join refuse no Compass action, even for a host", () => {
    for (const a of ACTIONS) {
      assert.deepEqual(decideCompassAction(a, HOST, clean(ALL_TYPES.filter((t) => t !== "hosting"))), { allowed: true }, a);
    }
  });
});

// ── 2. Unreadable state ───────────────────────────────────────────────────────

describe("TRV2-08 §2 — 'could not read' is neither 'not restricted' nor 'restricted'", () => {
  it("fail_closed refuses a host as unverifiable", () => {
    const st: RestrictionState = { ...clean(), canHost: false, canMessage: false, canJoinPrivatePlans: false, canJoinLocationPlans: false, degraded: true, degradedReason: "fail_closed" };
    for (const a of ACTIONS) {
      const v = decideCompassAction(a, HOST, st);
      assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "fail_closed", a);
    }
  });

  it("fail_open refuses a host too, although every can-flag reads TRUE — the table could not be read", () => {
    const st: RestrictionState = { ...clean(), degraded: true, degradedReason: "fail_open" };
    for (const a of ACTIONS) {
      const v = decideCompassAction(a, HOST, st);
      assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "fail_open", a);
    }
  });

  it("the unverifiable words never call the person restricted", () => {
    assert.doesNotMatch(COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE, /restrict/i);
    const info = compassRestrictionToolInfo({ allowed: false, kind: "unverifiable", reason: "fail_closed", message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE });
    assert.match(info, /NOT a restriction/);
  });

  it("a client that THROWS on the trip read is caught by the gate and refuses as unverifiable ('threw')", async () => {
    // getRestrictionState catches its own errors; this throw happens in the
    // gate's own trip read, which is the path its try/catch exists for.
    const throwing: any = { from: () => { throw new Error("boom"); } };
    const v = await checkCompassActionRestriction(throwing, USER, TRIP, "create_proposal");
    assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "threw");
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

/** A group trip hosted by USER, with OTHER as an accepted member. */
function world(restrictions: Row[] = [], opts: { solo?: boolean; ownerIsOther?: boolean } = {}): Record<string, Row[]> {
  const members: Row[] = [{ trip_id: TRIP, user_id: USER, role: opts.ownerIsOther ? "member" : "owner", status: "accepted" }];
  if (!opts.solo) members.push({ trip_id: TRIP, user_id: OTHER, role: opts.ownerIsOther ? "owner" : "member", status: "accepted" });
  return {
    trips: [{ id: TRIP, owner_id: opts.ownerIsOther ? OTHER : USER, status: "active" }],
    trip_members: members,
    feature_flags: [{ flag: "trip_kernel_enabled", enabled: true }],
    trust_restrictions: restrictions,
  };
}

const PROPOSE = { tripId: TRIP, proposalType: "cancel_plan", change: { targetId: "walk" }, rationale: "rain", affectedObjects: ["walk"] };
const kernelCalls = (c: any) => c.rpcs.filter((r: any) => r.fn === "trip_kernel_execute").length;
const R = (t: string, extra: Row = {}) => ({ user_id: USER, restriction_type: t, lifted_at: null, expires_at: null, ...extra });

describe("TRV2-08 §3 — create_proposal, through the real tool", () => {
  it("a clean record proposes (control: the kernel IS reached on this fixture)", async () => {
    const c = makeClient(world());
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
    assert.equal(kernelCalls(c), 1);
  });

  it("the HOST of a group trip under a hosting restriction proposes NOTHING and is told why", async () => {
    const c = makeClient(world([R("hosting")]));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal, null);
    assert.match(r.info, /restricted from hosting group trips/);
    assert.equal(kernelCalls(c), 0, "no kernel command may be issued for a restricted host");
  });

  it("a hosting restriction does not stop a MEMBER who does not host the trip", async () => {
    const c = makeClient(world([R("hosting")], { ownerIsOther: true }));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
  });

  it("a hosting restriction does not stop the host of a SOLO trip (not a group trip)", async () => {
    const c = makeClient(world([R("hosting")], { solo: true }));
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal?.status, "pending");
  });

  it("a messaging restriction does not stop a proposal — it does not start a conversation", async () => {
    const c = makeClient(world([R("messaging")]));
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

  it("an UNREADABLE trust_restrictions (for a host) proposes nothing, and tells the model it is NOT a restriction", async () => {
    const c = makeClient(world(), ["trust_restrictions"]);
    const r: any = await toolCreateProposal(c, USER, PROPOSE);
    assert.equal(r.proposal, null);
    assert.match(r.info, /NOT a restriction/);
    assert.doesNotMatch(r.info, /currently restricted/);
    assert.equal(kernelCalls(c), 0);
  });

  it("an UNREADABLE trip_members (can't tell whether it is a group trip) is unverifiable, never 'allowed'", async () => {
    // Through the gate directly: on the tool path the membership check above
    // the gate already throws TripAccessUnavailableError for this table.
    const c = makeClient(world([R("hosting")]), ["trip_members"]);
    const v = await checkCompassActionRestriction(c, USER, TRIP, "create_proposal");
    assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "trip_unreadable");
  });

  it("an UNREADABLE trips row is unverifiable too", async () => {
    const c = makeClient(world([R("hosting")]), ["trips"]);
    const v = await checkCompassActionRestriction(c, USER, TRIP, "confirm_plan_proposal");
    assert.ok(!v.allowed && v.kind === "unverifiable" && v.reason === "trip_unreadable");
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
