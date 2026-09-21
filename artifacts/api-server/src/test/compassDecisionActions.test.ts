/**
 * census-compass CCL-09 — the decision vocabulary reaches Compass's ACTION
 * MODEL with compatibility handling, and no enum value is blindly added.
 *
 * Before this suite: the seven decisions existed (`lib/compassDecision`), the
 * twelve quick-action types existed (a private Set in routes/compass.ts), a
 * mapping existed onto the OPPORTUNITY vocabulary (lib/opportunityEngine), and
 * NO decision reached `/compass/ask` — the surface where a person asks
 * "should I go now?". §18: *"No decision reaches /compass/ask"*.
 *
 * Three things are pinned:
 *   A. the mapping is total (a key per decision), its range is a SUBSET of the
 *      twelve existing action types (no enum was added), and refusals map to
 *      NO action rather than an invented one;
 *   B. the route and the mapping read ONE list — the Set in routes/compass.ts
 *      is built from `COMPASS_QUICK_ACTION_TYPES`, not retyped beside it;
 *   C. `get_decision` is a tool the model can call inside `/compass/ask`: gated
 *      on `compass_decision_enabled` exactly as GET /compass/decision is (off ⇒
 *      `unavailable`, and the place is NOT read), and on ⇒ the decision, its
 *      reasons, the CCL-08 confirmation and the compatible action.
 *
 * Mutation log (2026-09-20; each applied alone, suite run, source restored):
 *   M1 WAIT maps to "viewPlace" (a refusal gets an action)      → 2 red (A3, C5)
 *   M2 GO_NOW maps to an invented "goNow" value                  → 2 red (A2, C4)
 *   M3 get_decision drops the compass_decision_enabled check     → 2 red (C2, C3)
 *   M4 the action omits confirmationRequired (always false)      → 1 red (A4)
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassDecisionActions.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPASS_DECISIONS } from "../lib/compassDecision.js";
import {
  COMPASS_QUICK_ACTION_TYPES,
  DECISION_ACTION_COMPATIBILITY,
  compatibleActionFor,
  isCompassQuickActionType,
} from "../lib/compassDecisionActions.js";
import { KIND_OF_DECISION } from "../lib/opportunityEngine.js";
import { COMPASS_TOOL_DEFINITIONS, COMPASS_TOOL_NAMES, executeCompassTool } from "../compass/CompassTools.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const VIEWER = "77777777-aaaa-4aaa-8aaa-777777777777";
const TOKEN = "compass-decision-token";
const PLACE_ID = "88888888-bbbb-4bbb-8bbb-888888888888";
const UNKNOWN_ID = "99999999-cccc-4ccc-8ccc-999999999999";
const NOW = Date.now();
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];
const ON = { flag: "compass_decision_enabled", enabled: true };
const OFF = { flag: "compass_decision_enabled", enabled: false };

function snapshot(subject: string, over: Record<string, unknown> = {}) {
  return {
    id: `snap-${subject.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
    subject_id: subject, zone_id: null, claim_type: "crowd.level", value: { level: "busy" },
    confidence: 0.85, source_count: 30, observed_at: iso(-3), expires_at: iso(27),
    privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified", computed_at: iso(-3),
    ...over,
  };
}

function world(flags: { flag: string; enabled: boolean }[] = [], over: FakeState = {}): FakeState {
  return {
    feature_flags: [...LIVE_GATES_OPEN, ...flags],
    places: [{ id: PLACE_ID, name: "Han Market", latitude: 16.0678, longitude: 108.2208, status: "active" }],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }, { scope_key: "|crowd.trajectory" }],
    intel_state_snapshots: [snapshot(PLACE_ID)],
    ...over,
  };
}
const client = (state: FakeState) => makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });

describe("A. the mapping — total, range-bounded, refusals map to nothing", () => {
  it("has a key for every one of the seven decisions, and only those", () => {
    assert.deepEqual(Object.keys(DECISION_ACTION_COMPATIBILITY).sort(), [...COMPASS_DECISIONS].sort());
  });

  it("its range is a subset of the twelve existing action types — no enum value was added", () => {
    for (const [decision, action] of Object.entries(DECISION_ACTION_COMPATIBILITY)) {
      if (action === null) continue;
      assert.ok(isCompassQuickActionType(action), `${decision} maps to "${action}", which is not one of the twelve`);
    }
    assert.equal(COMPASS_QUICK_ACTION_TYPES.length, 12);
  });

  it("the four opportunity decisions get an action; the three refusals get NONE — the same four lib/opportunityEngine names", () => {
    const withAction = Object.entries(DECISION_ACTION_COMPATIBILITY).filter(([, a]) => a !== null).map(([d]) => d).sort();
    assert.deepEqual(withAction, Object.keys(KIND_OF_DECISION).sort());
    for (const refusal of ["WAIT", "STAY", "SKIP"] as const) {
      assert.equal(compatibleActionFor(refusal, { id: PLACE_ID, name: "Han Market" }, ["no_live_evidence"], false), null);
    }
  });

  it("an action carries the place, the decision, its reasons and the confirmation requirement; the label names the place", () => {
    const a = compatibleActionFor("SWITCH", { id: PLACE_ID, name: "Han Market" }, ["better_by_more_than_switching_cost"], true);
    assert.ok(a);
    assert.equal(a.actionType, "viewPlace");
    assert.equal(a.label, "Switch to Han Market");
    assert.deepEqual(a.params, { placeId: PLACE_ID, decision: "SWITCH", reasons: ["better_by_more_than_switching_cost"], confirmationRequired: true });
    assert.equal(compatibleActionFor("GO_NOW", { id: PLACE_ID, name: null }, [], false)?.label, "Go now this place");
  });
});

describe("B. one list — the route's allowed set is built from the shared vocabulary", () => {
  it("routes/compass.ts imports COMPASS_QUICK_ACTION_TYPES and no longer spells the twelve itself", () => {
    const route = strip(readFileSync(join(SRC, "routes", "compass.ts"), "utf8"));
    assert.match(route, /COMPASS_QUICK_ACTION_TYPES/);
    assert.match(route, /new Set(?:<string>)?\(COMPASS_QUICK_ACTION_TYPES\)/);
    assert.doesNotMatch(route, /"addTrip",\s*"buildItinerary"/, "a second copy of the action list survives in the route");
  });
});

describe("C. get_decision — the decision reaches /compass/ask as a tool", () => {
  beforeEach(() => _clearPromotedScopeCache());

  it("is declared to the model and dispatchable", () => {
    assert.ok(COMPASS_TOOL_NAMES.has("get_decision"), "get_decision is not a tool the model can call");
    const def = COMPASS_TOOL_DEFINITIONS.find((t) => t.function.name === "get_decision");
    assert.ok(def);
    assert.match(def!.function.description, /GO NOW|go now/i);
  });

  it("flag ABSENT (production's state): unavailable, and the place is NOT read", async () => {
    const sc = client(world([], { places: { error: { message: "must not be read" } } as any }));
    const r: any = await executeCompassTool(sc, VIEWER, null, "get_decision", { subjectId: PLACE_ID });
    assert.equal(r.unavailable, true, JSON.stringify(r));
    assert.equal(r.reason, "feature_disabled");
    assert.equal(r.decision, undefined, "a decision was served while the capability is off");
  });

  it("flag OFF: the same refusal", async () => {
    const r: any = await executeCompassTool(client(world([OFF])), VIEWER, null, "get_decision", { subjectId: PLACE_ID });
    assert.equal(r.unavailable, true);
    assert.equal(r.reason, "feature_disabled");
  });

  it("ON: a live, reachable, compatible place is GO NOW with its reasons, grounding, confirmation and a viewPlace action", async () => {
    const r: any = await executeCompassTool(client(world([ON])), VIEWER, null, "get_decision", { subjectId: PLACE_ID, etaMinutes: 5, intent: "social" });
    assert.equal(r.decision, "GO_NOW", JSON.stringify(r));
    assert.deepEqual(r.reasons, ["live_reachable_compatible"]);
    assert.equal(r.grounding?.truthClass, "corroborated");
    assert.deepEqual(r.confirmation, { required: false, reason: "no_committed_plan_changes" });
    assert.equal(r.compatibleAction?.actionType, "viewPlace");
    assert.equal(r.compatibleAction?.label, "Go now Han Market");
    assert.equal(r.compatibleAction?.params?.placeId, PLACE_ID);
    assert.equal(r.compatibleAction?.params?.decision, "GO_NOW");
  });

  it("ON, live gates CLOSED: WAIT with no_live_evidence — and a refusal carries NO action", async () => {
    const state = world([ON]);
    state.intel_state_snapshots = [];
    const r: any = await executeCompassTool(client(state), VIEWER, null, "get_decision", { subjectId: PLACE_ID, etaMinutes: 5 });
    assert.equal(r.decision, "WAIT", JSON.stringify(r));
    assert.equal(r.compatibleAction, null);
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
  });

  it("an unknown place is an error the model can say honestly, not a decision", async () => {
    const r: any = await executeCompassTool(client(world([ON])), VIEWER, null, "get_decision", { subjectId: UNKNOWN_ID });
    assert.match(String(r.error ?? ""), /not found|unknown/i);
  });

  it("a malformed subjectId is refused before anything is read", async () => {
    const sc = client(world([ON], { places: { error: { message: "must not be read" } } as any }));
    const r: any = await executeCompassTool(sc, VIEWER, null, "get_decision", { subjectId: "not-a-uuid" });
    assert.match(String(r.error ?? ""), /subjectId/);
  });
});
