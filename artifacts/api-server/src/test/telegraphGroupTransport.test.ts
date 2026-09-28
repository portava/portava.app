/**
 * Telegraph §12 / §14.3 — group membership types, and the group-formation rule
 * written before the operation exists.
 *
 * Spec:
 *   §12    `conversation_members` — "Membership intervals, role, visible
 *          sequence bounds, delivered/seen sequences."
 *   §14.3  "New members do not automatically receive pre-membership history.
 *          Adding a third person to a DM creates a new group; it does not
 *          expose the old DM history. Explicitly selected Plans/Places may be
 *          carried forward as new share objects."
 *
 * TWO STRUCTURAL PINS, AND THEY ARE THE REASON THIS FILE EXISTS
 * ============================================================
 * census T212 grades "adding a third person to a DM" as an UNGUARDED ABSENCE —
 * the rule is unviolated only because no add-participant operation exists — and
 * T213 is N for the same reason. Any work that assumes that premise has to
 * re-check it, and a re-check performed once by a person is a claim that ages.
 * So both halves of the premise are asserted here and re-run on every test run:
 *
 *   1. NO ROUTE REGISTERS AN ADD-PARTICIPANT OPERATION on a thread.
 *   2. `thread_type` ADMITS NO VALUE A FORMED GROUP COULD USE — direct, trip,
 *      circle, and nothing else. The operation is not merely unrouted; its
 *      result has no type.
 *
 * When either fails, the premise has changed and
 * `domain/telegraph/invariants/groupFormationInvariants.ts` is the rule the new
 * operation must go through — that is what the failure message says.
 *
 * SHOWN RED before commit (23 pass green), each mutation reverted:
 *   • `planGroupFormation` accepting a source whose type is not `direct`
 *       -> pass 22 / fail 1 ("refuses to form a group out of a trip thread")
 *   • the plan listing only the ADDED members, dropping the DM's two
 *       -> pass 22 / fail 1 ("every member's window opens at the formation —
 *          including the two who were in the DM")
 *   • `memberFromRow` trusting an unrecognised role
 *       -> pass 22 / fail 1 ("an unrecognised role reads as the LOWER privilege")
 *
 * Run: node --import tsx/esm --test src/test/telegraphGroupTransport.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONVERSATION_TYPES,
  DIRECT_CONVERSATION_MEMBER_COUNT,
  MEMBERSHIP_ROLES,
  UNIMPLEMENTED_MEMBER_BOUNDS,
  checkMembershipInvariants,
  isActiveMember,
  isConversationType,
  memberCanReadMessageAt,
  memberFromRow,
} from "../domain/telegraph/contracts/conversationMembership.js";
import {
  CARRY_FORWARD_KINDS,
  GROUP_FORMATION_BLOCKERS,
  assertNoSourceHistory,
  planGroupFormation,
} from "../domain/telegraph/invariants/groupFormationInvariants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL = "cccccccc-0000-4000-8000-000000000003";
const DM = "dddddddd-0000-4000-8000-00000000000d";

const NOW = "2026-03-10T12:00:00.000Z";

// ── Pin 1: the operation does not exist ──────────────────────────────────────

/**
 * A mutating route whose path adds people to a conversation. Deliberately
 * narrow: it matches the OPERATION's shape, not incidental membership writes,
 * so refactoring a thread handler cannot trip it and adding the operation
 * cannot avoid it.
 */
const ADD_PARTICIPANT_PATH =
  /\/(threads?|conversations?|groups?|chats?)\/:[A-Za-z_]+\/(members|participants|people|invite|add)/i;
const MUTATING = /router\.(post|put|patch)\(\s*(["'`])([^"'`]+)\2/g;

describe("§14.3 premise — no add-participant operation exists (census T212)", () => {
  it("no route registers an add-participant operation on a thread", () => {
    const routesDir = join(PKG_ROOT, "src/routes");
    const offenders: string[] = [];
    for (const file of readdirSync(routesDir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(routesDir, file), "utf8");
      for (const m of text.matchAll(MUTATING)) {
        if (ADD_PARTICIPANT_PATH.test(m[3])) offenders.push(`${file}: ${m[1].toUpperCase()} ${m[3]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "An add-participant operation now exists. census T212's premise has changed: route it through " +
        "domain/telegraph/invariants/groupFormationInvariants.ts#planGroupFormation, which refuses to " +
        "expose the source DM's history, and re-grade T212/T213 rather than deleting this assertion.",
    );
  });

  it("thread_type admits no value a group formed from a DM could use", () => {
    const types = readFileSync(join(PKG_ROOT, "src/lib/database.types.ts"), "utf8");
    assert.match(
      types,
      /thread_type_enum:\s*\["direct",\s*"trip",\s*"circle"\]/,
      "thread_type_enum changed. If a group type was added, group formation is now expressible and " +
        "GROUP_FORMATION_BLOCKERS is stale.",
    );
    assert.deepEqual([...CONVERSATION_TYPES], ["direct", "trip", "circle"]);
  });

  it("the blockers are recorded, so the rule does not read as a shipped capability", () => {
    assert.ok(GROUP_FORMATION_BLOCKERS.length >= 2);
    assert.deepEqual(
      GROUP_FORMATION_BLOCKERS.map((b) => b.id).sort(),
      ["no_add_participant_operation", "no_conversation_type_for_a_formed_group"],
    );
    for (const b of GROUP_FORMATION_BLOCKERS) assert.ok(b.evidence.length > 10);
  });
});

// ── §12 the member contract ──────────────────────────────────────────────────

describe("§12 conversation_members — the shape, with the gaps named", () => {
  it("names the two properties §12 asks for that no column supplies", () => {
    assert.deepEqual(
      UNIMPLEMENTED_MEMBER_BOUNDS.map((b) => b.property).sort(),
      ["lastDeliveredSequence", "visibleUntilSequence"],
    );
    assert.deepEqual(UNIMPLEMENTED_MEMBER_BOUNDS.map((b) => b.census).sort(), ["T210", "T72"]);
  });

  it("the contract has no field for either of them", () => {
    const member = memberFromRow({ thread_id: DM, user_id: BOB, joined_at: NOW });
    for (const b of UNIMPLEMENTED_MEMBER_BOUNDS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(member, b.property),
        false,
        `${b.property} must not be a field — a permanently-undefined field is worse than an absent one`,
      );
    }
  });

  it("maps a row: interval, role, bound, seen", () => {
    const member = memberFromRow({
      thread_id: DM,
      user_id: BOB,
      role: "admin",
      joined_at: "2026-03-01T00:00:00.000Z",
      left_at: null,
      visible_from_at: "2026-03-01T00:00:00.000Z",
      last_read_at: "2026-03-02T00:00:00.000Z",
      muted_at: null,
      archived_at: null,
    });
    assert.equal(member.conversationId, DM);
    assert.equal(member.role, "admin");
    assert.equal(member.interval.leftAt, null);
    assert.equal(isActiveMember(member), true);
    assert.equal(member.lastReadAt, "2026-03-02T00:00:00.000Z");
  });

  it("an unrecognised role reads as the LOWER privilege", () => {
    const member = memberFromRow({ thread_id: DM, user_id: BOB, role: "owner", joined_at: NOW });
    assert.equal(member.role, "member");
    assert.deepEqual([...MEMBERSHIP_ROLES], ["member", "admin"]);
  });

  it("a departed member is outside every window, bound on or off", () => {
    const departed = memberFromRow({
      thread_id: DM,
      user_id: BOB,
      joined_at: "2026-03-01T00:00:00.000Z",
      left_at: "2026-03-02T00:00:00.000Z",
      visible_from_at: null,
    });
    assert.equal(memberCanReadMessageAt(departed, "2026-03-01T12:00:00.000Z", false), false);
    assert.equal(memberCanReadMessageAt(departed, "2026-03-01T12:00:00.000Z", true), false);
  });

  it("an active member's window is the §14.3 floor, and only when the bound is on", () => {
    const rejoined = memberFromRow({
      thread_id: DM,
      user_id: BOB,
      joined_at: "2026-03-01T00:00:00.000Z",
      left_at: null,
      visible_from_at: "2026-03-05T00:00:00.000Z",
    });
    assert.equal(memberCanReadMessageAt(rejoined, "2026-03-02T00:00:00.000Z", true), false);
    assert.equal(memberCanReadMessageAt(rejoined, "2026-03-06T00:00:00.000Z", true), true);
    assert.equal(memberCanReadMessageAt(rejoined, "2026-03-02T00:00:00.000Z", false), true);
  });

  it("reports a bound set earlier than the interval start rather than deciding what it means", () => {
    const suspicious = memberFromRow({
      thread_id: DM,
      user_id: BOB,
      joined_at: "2026-03-05T00:00:00.000Z",
      visible_from_at: "2026-03-01T00:00:00.000Z",
    });
    const check = checkMembershipInvariants(suspicious);
    assert.equal(check.ok, false);
    assert.deepEqual(check.violations, ["visible_from_before_joined"]);
  });

  it("catches an interval that ends before it starts, and a missing start", () => {
    const backwards = memberFromRow({
      thread_id: DM,
      user_id: BOB,
      joined_at: "2026-03-05T00:00:00.000Z",
      left_at: "2026-03-01T00:00:00.000Z",
    });
    assert.deepEqual(checkMembershipInvariants(backwards).violations, ["left_before_joined"]);
    assert.deepEqual(
      checkMembershipInvariants(memberFromRow({ thread_id: DM, user_id: BOB })).violations,
      ["missing_joined_at"],
    );
  });

  it("a well-formed membership passes", () => {
    const ok = memberFromRow({
      thread_id: DM,
      user_id: BOB,
      role: "member",
      joined_at: "2026-03-01T00:00:00.000Z",
      visible_from_at: "2026-03-01T00:00:00.000Z",
    });
    assert.deepEqual(checkMembershipInvariants(ok), { ok: true, violations: [] });
    assert.equal(isConversationType("direct"), true);
    assert.equal(isConversationType("group"), false);
  });
});

// ── §14.3 group formation ────────────────────────────────────────────────────

describe("§14.3 — adding a third person creates a new group and carries no history", () => {
  const source = {
    sourceConversationId: DM,
    sourceConversationType: "direct" as const,
    sourceMemberUserIds: [ALICE, BOB],
    addedUserIds: [CAROL],
    nowIso: NOW,
  };

  it("every member's window opens at the formation — including the two who were in the DM", () => {
    const r = planGroupFormation(source);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.memberUserIds, [ALICE, BOB, CAROL]);
    assert.equal(r.plan.visibleFromAt, NOW);
    assert.equal(r.plan.carriesNoSourceHistory, true);
  });

  it("the plan has NO field that could name the DM's messages", () => {
    const r = planGroupFormation(source);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(assertNoSourceHistory(r.plan).ok, true);
    assert.equal(r.plan.sourceConversationId, DM, "provenance is kept; content is not");
  });

  it("REFUSES a hand-built plan that names the source's history", () => {
    for (const field of ["messages", "history", "transcript", "sourceMessageId", "cursor"]) {
      const bad = { sourceConversationId: DM, memberUserIds: [], [field]: ["x"] };
      const r = assertNoSourceHistory(bad);
      assert.equal(r.ok, false, `"${field}" must be refused`);
      assert.equal(r.ok === false && r.field, field);
    }
  });

  it("carries forward explicitly selected Plans and Places as NEW share objects", () => {
    const r = planGroupFormation({
      ...source,
      carryForward: [
        { kind: "PLAN", objectId: "plan-1" },
        { kind: "PLACE", objectId: "place-1" },
      ],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.carriedForward, [
      { kind: "PLAN", objectId: "plan-1", shareProjectionVersion: "1" },
      { kind: "PLACE", objectId: "place-1", shareProjectionVersion: "1" },
    ]);
    assert.deepEqual([...CARRY_FORWARD_KINDS], ["PLAN", "PLACE"]);
  });

  it("carrying nothing forward is valid", () => {
    const r = planGroupFormation({ ...source, carryForward: [] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.plan.carriedForward, []);
  });

  it("REFUSES a carry-forward that points at a message instead of the object", () => {
    const r = planGroupFormation({
      ...source,
      carryForward: [{ kind: "PLACE", objectId: "place-1", messageId: "m-1" } as any],
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "carry_forward_references_a_message");
  });

  it("REFUSES a carry-forward kind §14.3 does not name", () => {
    const r = planGroupFormation({
      ...source,
      carryForward: [{ kind: "MESSAGE", objectId: "m-1" } as any],
    });
    assert.equal(r.ok === false && r.refusal, "carry_forward_kind_unsupported");
  });

  it("refuses to form a group out of a trip thread", () => {
    const r = planGroupFormation({ ...source, sourceConversationType: "trip" });
    assert.equal(r.ok === false && r.refusal, "source_not_direct");
  });

  it("refuses a source that is not a two-party direct conversation", () => {
    const r = planGroupFormation({ ...source, sourceMemberUserIds: [ALICE] });
    assert.equal(r.ok === false && r.refusal, "source_not_two_party");
    assert.equal(DIRECT_CONVERSATION_MEMBER_COUNT, 2);
  });

  it("refuses adding nobody, and refuses re-adding a party already in the DM", () => {
    assert.equal(
      planGroupFormation({ ...source, addedUserIds: [] }).ok === false &&
        (planGroupFormation({ ...source, addedUserIds: [] }) as any).refusal,
      "no_added_members",
    );
    const dup = planGroupFormation({ ...source, addedUserIds: [ALICE] });
    assert.equal(dup.ok === false && dup.refusal, "added_member_already_in_source");
  });

  it("refuses an unparseable formation instant rather than defaulting it", () => {
    const r = planGroupFormation({ ...source, nowIso: "whenever" });
    assert.equal(r.ok === false && r.refusal, "invalid_formation_time");
  });
});
