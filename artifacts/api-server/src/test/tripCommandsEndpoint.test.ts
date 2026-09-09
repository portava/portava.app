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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMMANDS_ENDPOINT_TYPES, CUTOVER_GATED_TYPES,
} from "../routes/tripCommands.js";

const route = readFileSync(new URL("../routes/tripCommands.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");
const kernelTs = readFileSync(new URL("../lib/tripKernel.ts", import.meta.url), "utf8");

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
    assert.match(index, /import tripCommandsRouter from "\.\/tripCommands"/);
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
