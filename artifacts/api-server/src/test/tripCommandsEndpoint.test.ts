/**
 * §11 `POST /trips/:tripId/commands` — the reachability the vertical-slice rule
 * asks for.
 *
 * THE GAP THIS CLOSES, STATED PLAINLY
 * ===================================
 * Migrations 2764-2777 added ten command families to trip_kernel_execute, and
 * before this route NOT ONE of them was reachable from the product. Every
 * existing caller of executeTripCommand sends plan-item or participant commands
 * only, because those are the legacy writes the kernel was retrofitted under. A
 * command family nothing can issue is a stored procedure, not a capability.
 *
 * So the most important assertion in this file is the coverage one: every
 * command type the kernel dispatches is either issuable HERE or has a named
 * legacy route and a cutover of its own. Nothing may fall between.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMMANDS_ENDPOINT_TYPES, CUTOVER_GATED_TYPES,
} from "../server/trips/commandRoute.js";

const route = readFileSync(new URL("../server/trips/commandRoute.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
const kernelTs = readFileSync(new URL("../domain/trips/commands/tripKernel.ts", import.meta.url), "utf8");
/**
 * The CLIENT's copy of the issuable list. Read across the package boundary on
 * purpose: two hand-maintained lists that must agree, in two packages that are
 * type-checked separately, is exactly the drift a contract test is for. A type
 * added on the server and forgotten here is a command the app cannot send; one
 * added here and not there is a 400 at runtime.
 */
const clientService = readFileSync(
  new URL("../../../../travel-buddy-standalone/src/services/tripCommands.ts", import.meta.url),
  "utf8",
);

/** Every command type declared in TripCommandType, read from the source. */
function declaredCommandTypes(): string[] {
  const start = kernelTs.indexOf("export type TripPlanCommandType");
  const end = kernelTs.indexOf("export interface TripCommand {");
  const region = kernelTs.slice(start > 0 ? start : 0, end > 0 ? end : kernelTs.length);
  return [...new Set([...region.matchAll(/^\s*\|\s*"([A-Z_]+)"/gm)].map((m) => m[1]))];
}

describe("every kernel command is reachable somewhere, and nothing falls between", () => {
  it("each declared command type is either issuable here or named as cutover-gated", () => {
    const declared = declaredCommandTypes();
    assert.ok(declared.length > 25, `only ${declared.length} command types found; the parser has stopped working`);
    const issuable = new Set<string>(COMMANDS_ENDPOINT_TYPES);
    const orphans = declared.filter((t) => !issuable.has(t) && !CUTOVER_GATED_TYPES.has(t));
    assert.deepEqual(orphans, [],
      `these commands are declared and unreachable from anywhere: ${orphans.join(", ")}`);
  });

  it("the CLIENT issues exactly the types this endpoint accepts", () => {
    // Reachability, not shape. Before travel-buddy-standalone/src/services/
    // tripCommands.ts existed, every one of these families was unreachable
    // from the product: the endpoint was mounted and no client file named it.
    const start = clientService.indexOf("export const TRIP_COMMAND_TYPES = [");
    assert.ok(start > 0, "the client no longer declares TRIP_COMMAND_TYPES — the app cannot issue commands");
    const end = clientService.indexOf("] as const;", start);
    const declared = [...clientService.slice(start, end).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);

    const server = [...COMMANDS_ENDPOINT_TYPES].sort();
    assert.deepEqual([...declared].sort(), server,
      "the client's issuable list and the server's have drifted apart");
  });

  it("the client never sends the fields the server refuses", () => {
    // The endpoint REFUSES a body naming actor_user_id rather than ignoring it,
    // so a client that sends one is broken, not merely redundant.
    for (const forbidden of ["actor_user_id", "actorUserId", "actor_role"]) {
      assert.ok(!clientService.includes(`${forbidden}:`),
        `the client sends ${forbidden}, which this endpoint refuses`);
    }
  });

  it("the client does not GENERATE an idempotency key", () => {
    // A key minted per call makes every retry a new command and defeats the
    // receipt table. The client requires the caller to supply one.
    assert.ok(!/randomUUID|uuidv4|Math\.random/.test(clientService),
      "the client mints an idempotency key, which turns every retry into a new command");
    assert.match(clientService, /idempotencyKey is required/);
  });

  it("the two sets do not overlap", () => {
    const both = COMMANDS_ENDPOINT_TYPES.filter((t) => CUTOVER_GATED_TYPES.has(t));
    assert.deepEqual(both, [],
      `these are both issuable and cutover-gated, so the flag can be routed around: ${both.join(", ")}`);
  });

  it("every family added in 2764-2777 is issuable", () => {
    for (const t of ["ADD_STAGE", "ADD_LEG", "ADD_COMMITMENT", "ADD_GOAL",
                     "ADD_DECISION_TASK", "ADD_RISK", "SET_PRESENCE",
                     "CREATE_PROPOSAL", "VOTE_ON_PROPOSAL", "RECORD_OUTCOME",
                     "JOIN_PLAN", "SET_PLAN_ATTENDANCE"]) {
      assert.ok((COMMANDS_ENDPOINT_TYPES as readonly string[]).includes(t),
        `${t} was built and is still unreachable`);
    }
  });

  it("is an allowlist, so a new kernel command is unreachable until someone decides", () => {
    assert.match(route, /An allowlist and not a denylist/);
    assert.match(route, /const ISSUABLE = new Set<string>\(COMMANDS_ENDPOINT_TYPES\);/);
  });
});

describe("the route is registered and authorized", () => {
  it("is mounted", () => {
    assert.match(index, /import tripCommandsRouter from "\.\.\/server\/trips\/commandRoute"/);
    assert.match(index, /router\.use\(tripCommandsRouter\)/);
  });

  it("is the path §11 names", () => {
    assert.match(route, /router\.post\("\/trips\/:tripId\/commands"/);
  });

  it("requires a user, then membership, before issuing anything", () => {
    const user = route.indexOf("await requireUser(req, res)");
    const member = route.indexOf("await requireTripMember(sc, tripId, user.id)");
    const exec = route.indexOf("await executeTripCommand(");
    assert.ok(user > 0 && member > user && exec > member,
      "a command can be issued before membership is established");
  });

  it("takes the actor from the token and REFUSES a body that names one", () => {
    // Silently overriding it would let a caller believe they had acted as
    // someone else, and believe it right up until they checked.
    assert.match(route, /"actor_user_id" in body \|\| "actorUserId" in body \|\| "actor_role" in body/);
    assert.match(route, /actorUserId: user\.id/);
    assert.ok(!/actorUserId: body\./.test(route));
  });

  it("never issues an admin or system command", () => {
    assert.match(route, /actorRole: "user"/);
    assert.ok(!(COMMANDS_ENDPOINT_TYPES as readonly string[]).includes("ADMIN_HIDE_TRIP" as never));
    assert.ok(!(COMMANDS_ENDPOINT_TYPES as readonly string[]).includes("SET_TRIP_COVER" as never));
  });
});

describe("the flag is respected by exclusion, not bypassed", () => {
  it("plan and participant commands are refused with a reason that says why", () => {
    for (const t of ["ADD_PLAN", "UPDATE_TRIP", "INVITE_PARTICIPANT", "JOIN_VIA_LINK"]) {
      assert.ok(CUTOVER_GATED_TYPES.has(t), `${t} could be issued here, routing around the flag`);
    }
    assert.match(route, /has a legacy writer and a flag-gated cutover/);
  });

  it("explains why the flag does not gate the new families", () => {
    // They have no legacy path. Gating them off would not fall back to
    // anything; it would just refuse.
    assert.match(route, /The families below have NO legacy path/);
  });
});

describe("failures stay distinguishable", () => {
  it("an unreachable kernel is 503, not 400", () => {
    // Telling a caller their input was wrong when the database was unreachable
    // sends them to fix the wrong thing.
    assert.match(route, /if \(reason === "TRIP_KERNEL_UNAVAILABLE"\)[\s\S]*?res\.status\(503\)/);
    assert.match(route, /503 and NOT a 400/);
  });

  it("authorization, absence, conflict and malformed map to four statuses", () => {
    assert.match(route, /FORBIDDEN_REASONS\.has\(reason\) \? 403/);
    assert.match(route, /NOT_FOUND_REASONS\.has\(reason\) \? 404/);
    assert.match(route, /TRIP_VERSION_CONFLICT/);
    assert.match(route, /: 400;/);
  });

  it("carries the kernel's reason code through rather than flattening it", () => {
    assert.match(route, /reason,\s*\n\s*detail: result\.detail/);
  });

  it("requires an idempotency key rather than generating one", () => {
    // A generated key makes every retry a NEW command and defeats the receipt
    // the kernel keeps for exactly this.
    assert.match(route, /idempotency_key is required/);
    assert.ok(!/idempotencyKey: randomUUID\(\)/.test(route));
  });
});

// ── Behaviour over the REAL router, with both Trips flags explicitly FALSE ────
//
// Everything above reads the route's source. These drive it: a fake database
// whose `feature_flags` rows say trip_kernel_enabled and
// trip_operational_projections_enabled are FALSE — production's state — and a
// fake `trip_kernel_execute` that records what it was handed.
describe("POST /trips/:tripId/commands over HTTP, both Trips flags FALSE", () => {
  const OWNER = "11111111-0000-4000-8000-0000000000a1";
  const TRIP = "aaaaaaaa-0000-4000-8000-0000000000a2";
  type Harness = { base: string; close(): Promise<void> };
  let h: Harness;
  let call: (base: string, m: "POST", p: string, u: string, b?: unknown) => Promise<{ status: number; body: any }>;
  let kernelCalls: Array<{ name: string; args: any }> = [];

  async function setup() {
    const harness = await import("./telegraphCertificationHarness.js");
    const { _setTestClient } = await import("../lib/http.js");
    const { _setTestServiceClient } = await import("../lib/supabase.js");
    const router = (await import("../server/trips/commandRoute.js")).default;
    const c = harness.makeFakeClient({
      trips: [{ id: TRIP, owner_id: OWNER }],
      trip_members: [{ trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted", permissions: null }],
      feature_flags: [
        { flag: "trip_kernel_enabled", enabled: false },
        { flag: "trip_operational_projections_enabled", enabled: false },
      ],
    });
    (c as any).rpc = async (name: string, args: any) => {
      kernelCalls.push({ name, args });
      return { data: { ok: true, duplicate: false, version: kernelCalls.length, event_id: `e${kernelCalls.length}`, sequence: kernelCalls.length, result: { id: "r1" }, contract_version: 2 }, error: null };
    };
    _setTestClient(c as never, true);
    _setTestServiceClient(c as never);
    if (!h) h = await harness.startRouter(router);
    call = harness.call as typeof call;
  }
  const post = async (body: unknown) => { await setup(); kernelCalls = []; return call(h.base, "POST", `/trips/${TRIP}/commands`, OWNER, body); };
  after(async () => { if (h) await h.close(); });

  // census-trips TR78, TR79, TR81, TR84, TR85, TR86, TR22: the stage, leg,
  // commitment, goal, decision-task and risk families are issued with BOTH flags FALSE. The flag is a cutover
  // switch for families with a legacy writer; these have none.
  for (const [type, payload] of [
    ["ADD_STAGE", { stage_type: "city", city_id: "c1", timezone: "Europe/Paris", sequence: 1 }],
    ["ADD_LEG", { from_stage_id: "s1", to_stage_id: "s2", leg_type: "train" }],
    ["ADD_COMMITMENT", { stage_id: "s2", type: "event", starts_at: "2026-10-20T19:00:00Z", required_arrival_at: "2026-10-20T18:45:00Z" }],
    ["ADD_GOAL", { type: "food", priority: 0.5 }],
    ["ADD_DECISION_TASK", { type: "pick_dinner", deadline_at: "2026-10-20T18:00:00Z" }],
    ["ADD_RISK", { likelihood: "medium", impact: "high" }],
  ] as const) {
    it(`${type} reaches trip_kernel_execute while trip_kernel_enabled is FALSE`, async () => {
      const r = await post({ type, idempotency_key: `k-${type}`, payload });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(kernelCalls.length, 1);
      assert.equal(kernelCalls[0]!.name, "trip_kernel_execute");
      assert.equal(kernelCalls[0]!.args.p_command.type, type);
      assert.deepEqual(kernelCalls[0]!.args.p_command.payload, payload);
      assert.equal(kernelCalls[0]!.args.p_command.actor_user_id, OWNER);
    });
  }

  // census-trips TR153: §9.3's three payload fields are written under ONE key
  // each at this door too — it is the one proposal writer that runs with the
  // kernel flag off — and a malformed one is refused before the kernel.
  describe("CREATE_PROPOSAL: §9.3's contract fields, canonical at the door (TR153)", () => {
    it("camelCase spellings are written under the canonical keys, once, and the change body is untouched", async () => {
      const r = await post({
        type: "CREATE_PROPOSAL", idempotency_key: "p-1",
        payload: {
          proposal_type: "move_plan", decision_rule: "majority",
          payload_json: { planId: "pl1", to: "20:00", affectedObjects: ["pl1", "c2"], impactSummary: "dinner moves 1h", rationale: "the museum runs late" },
        },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      const sent = kernelCalls[0]!.args.p_command.payload;
      assert.equal(sent.proposal_type, "move_plan");
      assert.equal(sent.decision_rule, "majority");
      assert.deepEqual(sent.payload_json, {
        planId: "pl1", to: "20:00",
        affected_objects: ["pl1", "c2"], rationale: "the museum runs late", impact_summary: "dinner moves 1h",
      });
    });

    it("a payload with no contract fields reaches the kernel exactly as sent", async () => {
      const payload = { proposal_type: "other", payload_json: { note: "x" } };
      const r = await post({ type: "CREATE_PROPOSAL", idempotency_key: "p-2", payload });
      assert.equal(r.status, 200);
      assert.deepEqual(kernelCalls[0]!.args.p_command.payload, payload);
    });

    it("a null payload_json, and a null contract field, are \"not recorded\": passed / omitted, never refused", async () => {
      const r1 = await post({ type: "CREATE_PROPOSAL", idempotency_key: "p-n1", payload: { proposal_type: "other", payload_json: null } });
      assert.equal(r1.status, 200);
      assert.equal(kernelCalls[0]!.args.p_command.payload.payload_json, null);
      const r2 = await post({ type: "CREATE_PROPOSAL", idempotency_key: "p-n2", payload: { proposal_type: "other", payload_json: { note: "x", rationale: null, impactSummary: "costs 10" } } });
      assert.equal(r2.status, 200);
      assert.deepEqual(kernelCalls[0]!.args.p_command.payload.payload_json, { note: "x", impact_summary: "costs 10" });
    });

    for (const [label, payload_json] of [
      ["affected objects that are not an array", { affected_objects: "pl1" }],
      ["an affected object that is not an id", { affected_objects: ["pl1", 7] }],
      ["a rationale that is not text", { rationale: 42 }],
      ["an impact summary that is not text", { impactSummary: { cost: 3 } }],
      ["two spellings of one field that disagree", { affected_objects: ["a"], affectedObjects: ["b"] }],
      ["a payload_json that is not an object", ["not", "an", "object"]],
    ] as const) {
      it(`refused before the kernel: ${label}`, async () => {
        const r = await post({ type: "CREATE_PROPOSAL", idempotency_key: `bad-${label}`, payload: { proposal_type: "other", payload_json } });
        assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 300));
        assert.equal(r.body.error, "invalid_payload");
        assert.equal(kernelCalls.length, 0, "a malformed contract field never reaches trip_kernel_execute");
      });
    }

    it("other families are not rewritten: a `rationale` key on ADD_GOAL passes through verbatim", async () => {
      const payload = { type: "food", priority: 0.5, rationale: 7 };
      const r = await post({ type: "ADD_GOAL", idempotency_key: "g-r", payload });
      assert.equal(r.status, 200);
      assert.deepEqual(kernelCalls[0]!.args.p_command.payload, payload);
    });
  });
});
