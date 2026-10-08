/**
 * planAppealRestoration — the owner's 2026-10-04 appeal-restoration ruling as a
 * pure decision (services/appeals/adminRestoreParticipant.ts):
 *   "If an appeal succeeds, restore the access and permissions removed by that
 *    decision. Don't recreate missed live activity or location sharing; if a
 *    trip has ended, restore access to its retained record only."
 *
 * Run: node --import tsx/esm --test src/test/appealRestorationPlan.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planAppealRestoration } from "../services/appeals/adminRestoreParticipant.js";
import { ROLE_AT_REMOVAL_SOURCE, type RoleAtRemoval } from "../services/appeals/roleAtRemoval.js";

const removed = (role: string): RoleAtRemoval => ({ found: true, role, eventId: "ev-9", occurredAt: "2026-09-01T00:00:00Z", source: ROLE_AT_REMOVAL_SOURCE });

describe("planAppealRestoration", () => {
  it("a live trip restores the MEMBERSHIP in exactly the role at removal — a co_host returns as co_host", () => {
    for (const status of ["planning", "active"]) {
      const p = planAppealRestoration(removed("co_host"), status);
      assert.deepEqual(p, { restore: true, access: "membership", role: "co_host", source: ROLE_AT_REMOVAL_SOURCE, removalEventId: "ev-9", liveSharingRestored: false });
    }
  });

  it("an ENDED trip restores access to its retained record only", () => {
    for (const status of ["completed", "archived", "cancelled"]) {
      const p = planAppealRestoration(removed("member"), status);
      assert.equal(p.restore, true);
      if (p.restore) assert.equal(p.access, "retained_record_only", status);
    }
  });

  it("live activity and location sharing are never recreated (the literal false)", () => {
    const p = planAppealRestoration(removed("member"), "active");
    assert.equal(p.restore && p.liveSharingRestored, false);
  });

  it("an unreadable removal record is a retry, not an answer; no record restores nothing; an unrecorded role needs a person", () => {
    assert.deepEqual(planAppealRestoration({ found: false, reason: "LEDGER_UNREADABLE", detail: "x" }, "active"), { restore: false, reason: "removal_record_unreadable", detail: "x" });
    assert.equal((planAppealRestoration({ found: false, reason: "NO_REMOVAL_EVENT" }, "active") as { reason: string }).reason, "no_removal_recorded");
    assert.equal((planAppealRestoration({ found: false, reason: "ROLE_NOT_RECORDED" }, "active") as { reason: string }).reason, "role_not_recorded");
    assert.equal((planAppealRestoration({ found: false, reason: "LEDGER_MALFORMED" }, "active") as { reason: string }).reason, "role_not_recorded");
  });

  it("owner, or a role outside the member roles, is not restorable; an unknown trip status is not guessed", () => {
    assert.equal((planAppealRestoration(removed("owner"), "active") as { reason: string }).reason, "role_not_restorable");
    assert.equal((planAppealRestoration(removed("admin"), "active") as { reason: string }).reason, "role_not_restorable");
    assert.equal((planAppealRestoration(removed("member"), "paused") as { reason: string }).reason, "trip_status_unknown");
  });
});
