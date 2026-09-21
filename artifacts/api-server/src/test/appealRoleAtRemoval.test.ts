/**
 * APPEAL_RESTORE_SEMANTICS — what this repository can now establish, and what
 * is still the owner's to decide.
 *
 * The decision was recorded as blocked on TWO things: no durable source for a
 * removed member's role, and no policy for what to restore them to. This file
 * pins that the first is now false and that the second is untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { recoverRoleAtRemoval, ROLE_AT_REMOVAL_SOURCE } from "../services/appeals/roleAtRemoval.js";
import {
  APPROVED_RESTORATION_ROLES, APPROVED_RESTORATION_SOURCES,
  isApprovedRestorationRole, isApprovedRestorationSource,
} from "../services/appeals/adminRestoreParticipant.js";

const kernel = readFileSync(
  new URL("../migrations/2590_trip_kernel_add_plan_attachment_columns.sql", import.meta.url), "utf8");
const foundation = readFileSync(
  new URL("../migrations/2420_trip_kernel_foundation.sql", import.meta.url), "utf8");

/** A supabase-js stand-in: only the shape recoverRoleAtRemoval uses. */
function fakeClient(answer: { data?: unknown; error?: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
  chain.limit = async () => answer;
  return { from: () => chain } as never;
}

const removalEvent = (userId: string, role: string | null) => ({
  event_id: "e1",
  occurred_at: "2026-10-01T12:00:00Z",
  payload_json: {
    command_type: "REMOVE_PARTICIPANT",
    family: "participant",
    result: { trip_id: "t", user_id: userId, role },
    payload: role === null ? {} : { role_at_removal: role },
  },
});

describe("the FACTUAL half is settled: the role is durably recorded", () => {
  it("the kernel writes role_at_removal before deleting the row", () => {
    assert.match(kernel, /v_payload := v_payload \|\| jsonb_build_object\('role_at_removal', v_member\.role::text\);/);
  });

  it("and trip_events is append-only, so nothing can rewrite it", () => {
    assert.match(foundation, /CREATE OR REPLACE FUNCTION public\.trip_events_refuse_update\(\)/);
    assert.match(foundation, /CREATE TRIGGER trg_trip_events_append_only/);
  });

  it("recovers the role from the ledger", async () => {
    const r = await recoverRoleAtRemoval(fakeClient({ data: [removalEvent("u1", "co_host")], error: null }), "t", "u1");
    assert.equal(r.found, true);
    if (r.found) {
      assert.equal(r.role, "co_host");
      assert.equal(r.source, ROLE_AT_REMOVAL_SOURCE);
    }
  });

  it("takes the MOST RECENT removal, not the first", async () => {
    // Someone removed, restored and removed again should come back to what
    // they had before the LAST removal — anything else silently reverses a
    // role change they consented to in between. The query orders by sequence
    // descending, so the first match is the latest.
    const rows = [removalEvent("u1", "member"), removalEvent("u1", "co_host")];
    const r = await recoverRoleAtRemoval(fakeClient({ data: rows, error: null }), "t", "u1");
    assert.equal(r.found, true);
    if (r.found) assert.equal(r.role, "member", "the older removal won");
  });

  it("ignores removals of OTHER people on the same trip", async () => {
    const rows = [removalEvent("someone-else", "co_host"), removalEvent("u1", "member")];
    const r = await recoverRoleAtRemoval(fakeClient({ data: rows, error: null }), "t", "u1");
    assert.equal(r.found, true);
    if (r.found) assert.equal(r.role, "member");
  });
});

describe("every failure is NAMED, and none of them is a role", () => {
  it("an unreadable ledger is not 'no removal'", async () => {
    const r = await recoverRoleAtRemoval(fakeClient({ data: null, error: { message: "boom" } }), "t", "u1");
    assert.equal(r.found, false);
    if (!r.found) assert.equal(r.reason, "LEDGER_UNREADABLE");
  });

  it("no removal event is its own answer", async () => {
    const r = await recoverRoleAtRemoval(fakeClient({ data: [], error: null }), "t", "u1");
    assert.equal(r.found, false);
    if (!r.found) assert.equal(r.reason, "NO_REMOVAL_EVENT");
  });

  it("a pre-2450 removal that recorded no role is distinct from both", async () => {
    const r = await recoverRoleAtRemoval(fakeClient({ data: [removalEvent("u1", null)], error: null }), "t", "u1");
    assert.equal(r.found, false);
    if (!r.found) assert.equal(r.reason, "ROLE_NOT_RECORDED");
  });

  it("a malformed ledger read is not an empty one", async () => {
    const r = await recoverRoleAtRemoval(fakeClient({ data: "nonsense" as never, error: null }), "t", "u1");
    assert.equal(r.found, false);
    if (!r.found) assert.equal(r.reason, "LEDGER_MALFORMED");
  });

  it("no failure path ever yields a role", async () => {
    for (const answer of [
      { data: null, error: { message: "x" } },
      { data: [], error: null },
      { data: [removalEvent("u1", null)], error: null },
      { data: "nonsense" as never, error: null },
      { data: [{ payload_json: null }], error: null },
      { data: [{ payload_json: { result: { user_id: "u1" } } }], error: null },
    ]) {
      const r = await recoverRoleAtRemoval(fakeClient(answer), "t", "u1");
      assert.equal(r.found, false, `${JSON.stringify(answer).slice(0, 40)} produced a role`);
    }
  });
});

describe("the POLICY half is untouched — the decision is narrower, not taken", () => {
  it("the approved-role allowlist is still empty", () => {
    // Adding a value here IS taking the owner decision. This file adds none.
    assert.deepEqual([...APPROVED_RESTORATION_ROLES], []);
    for (const r of ["member", "co_host", "viewer", "owner", "invited"]) {
      assert.equal(isApprovedRestorationRole(r), false,
        `${r} became an approved restoration role without the decision being taken`);
    }
  });

  it("the approved-source allowlist is still empty too", () => {
    // Even though the source now EXISTS and is proven above. Whether it may be
    // USED is the policy question, and it is not this file's to answer.
    assert.deepEqual([...APPROVED_RESTORATION_SOURCES], []);
    assert.equal(isApprovedRestorationSource(ROLE_AT_REMOVAL_SOURCE), false);
  });

  it("the module says which half it settles and which it does not", () => {
    const mod = readFileSync(new URL("../services/appeals/roleAtRemoval.ts", import.meta.url), "utf8");
    assert.match(mod, /It settles the FACTUAL half/);
    assert.match(mod, /It settles NOTHING about the POLICY half/);
    assert.match(mod, /may a removed CO_HOST be restored as co_host/);
    assert.match(mod, /does the crew cap/);
  });
});
