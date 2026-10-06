/**
 * census-trips §83 — ADMIN_RESTORE_PARTICIPANT, the Trip Kernel command an
 * upheld trip-membership appeal needs (lane B's request; owner ruling
 * 2026-10-04, "Appeal restoration"). Migration 3974 adds it to
 * trip_kernel_execute by TRANSFORM (2764 / 2798's method); this suite proves
 * the transform against the corpus it will be applied over, and the TS call.
 *
 * WHAT CANNOT BE PROVEN HERE. There is no Postgres on this machine, so 3974's
 * plpgsql was not executed: the branch's behaviour is asserted by its text, and
 * CI (or db/harness/run.sh) is its first execution. Said in 3974's header too.
 *
 * WHAT IS ASSERTED
 *   A. the transform's anchors exist exactly once in the kernel it transforms
 *      (2590's full definition + 2798's declarations) and nothing between 2590
 *      and 3974 rewrote them; every variable the branch uses is declared; the
 *      branch refuses before its first write; it emits an event type the
 *      vocabulary and the snapshot fold already carry; the rollback removes
 *      exactly what the migration adds;
 *   B. the one call lane B makes: kernel off is a refusal with no RPC; kernel on
 *      sends ADMIN_RESTORE_PARTICIPANT as actor_role 'admin' with the plan's
 *      role, access, appeal and removal event;
 *   C. the TS vocabulary: the admin family, not issuable at the generic door.
 *
 * Run: node --import tsx/esm --test src/test/tripKernelAdminRestore.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { adminRestoreTripParticipant } from "../domain/trips/commands/adminRestoreTripParticipant.js";
import { tripCommandFamily, TRIP_EVENT_TYPES } from "../domain/trips/commands/tripKernel.js";
import { COMMANDS_ENDPOINT_TYPES } from "../server/trips/commandRoute.js";

const MIG = new URL("../migrations/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, MIG), "utf8");
const files = readdirSync(MIG).filter((f) => /^\d+_.*\.sql$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
const m3974 = read("3974_trip_kernel_admin_restore_participant.sql");
const k2590 = read("2590_trip_kernel_add_plan_attachment_columns.sql");
const kbody = k2590.slice(k2590.indexOf("CREATE OR REPLACE FUNCTION public.trip_kernel_execute"), k2590.indexOf("$fn$;", k2590.indexOf("CREATE OR REPLACE FUNCTION public.trip_kernel_execute")));
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const branch = m3974.slice(m3974.indexOf("$branches$      WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN"), m3974.lastIndexOf("$branches$"));

describe("A. 3974 transforms the kernel it says it transforms", () => {
  it("A1. its two dispatch anchors occur exactly once in 2590's definition, the last full CREATE of trip_kernel_execute", () => {
    assert.equal(count(kbody, "    WHEN 'ADMIN_HIDE_TRIP' THEN 'admin'"), 1);
    assert.equal(count(kbody, "      WHEN 'ADMIN_HIDE_TRIP' THEN\n"), 1);
    const laterFull = files.filter((f) => parseInt(f, 10) > 2590 && /CREATE OR REPLACE FUNCTION public\.trip_kernel_execute/.test(read(f)));
    assert.deepEqual(laterFull, [], "a later full rewrite would make 2590 the wrong base");
  });

  it("A2. nothing between 2590 and 3974 touches the ADMIN_HIDE_TRIP anchors; 2798 declares v_rec_day exactly once", () => {
    const touching = files.filter((f) => { const n = parseInt(f, 10); return n > 2590 && n < 3974 && read(f).includes("ADMIN_HIDE_TRIP"); });
    assert.deepEqual(touching, []);
    assert.equal(count(read("2798_trip_kernel_recurrence_family.sql"), "'  v_rec_day    date;'"), 1);
    assert.match(m3974, /IF position\('ADD_RECURRING_COMMITMENT' in d\) = 0 THEN/, "3974 refuses a kernel without 2798");
  });

  it("A3. every variable the branch uses is declared — by 2590 or by 3974 itself", () => {
    const used = new Set([...branch.matchAll(/\bv_[a-z_]+\b/g)].map((m) => m[0]));
    const declared = new Set([...kbody.matchAll(/^\s{2}(v_[a-z_]+)\s+[a-z]/gm)].map((m) => m[1]!));
    // 3974's own declarations, read from the text it inserts after 2798's v_rec_day — not assumed.
    const decl = m3974.slice(m3974.indexOf("d := replace(d, '  v_rec_day    date;',"), m3974.indexOf("-- 2. capability dispatch"));
    for (const m of decl.matchAll(/'  (v_[a-z_]+)\s+[a-z]+;'/g)) declared.add(m[1]!);
    assert.ok(declared.has("v_rst_event"), "vacuity guard: 3974's declarations were read");
    assert.deepEqual([...used].filter((v) => !declared.has(v)).sort(), []);
  });

  it("A4. every refusal comes before the branch's first write", () => {
    const firstWrite = Math.min(...["INSERT INTO public.trip_members", "UPDATE public.trip_crew_location_sessions"].map((w) => branch.indexOf(w)));
    for (const r of ["TRIP_COMMAND_MALFORMED", "TRIP_RESTORE_ACCESS_MISMATCH", "TRIP_RESTORE_TRIP_STATUS_UNKNOWN",
      "TRIP_RESTORE_REMOVAL_NOT_RECORDED", "TRIP_RESTORE_NOT_LATEST_REMOVAL", "TRIP_PARTICIPANT_ALREADY_EXISTS"]) {
      const at = branch.lastIndexOf(r);
      assert.ok(at > 0 && at < firstWrite, `${r} at ${at} is not before the first write at ${firstWrite}`);
    }
  });

  it("A5. the removal is matched on trip, type, person AND role, and must be the latest", () => {
    assert.match(branch, /e\.event_id = v_rst_event\s+AND e\.trip_id = v_trip_id\s+AND e\.type = 'trip\.participant_removed'\s+AND e\.payload_json->'result'->>'user_id' = v_subject::text\s+AND e\.payload_json->'payload'->>'role_at_removal' = v_new_role;/);
    assert.match(branch, /e2\.sequence > v_rst_seq/);
    assert.match(branch, /IF v_new_role NOT IN \('member', 'co_host', 'viewer', 'invited'\)/, "never owner");
    assert.match(branch, /IF v_subject = v_actor THEN/, "an admin cannot restore themselves");
  });

  it("A6. live sharing is off after it: a surviving session is stopped, and the event says so", () => {
    assert.match(branch, /UPDATE public\.trip_crew_location_sessions SET status = 'stopped', stopped_at = now\(\)\s+WHERE trip_id = v_trip_id AND user_id = v_subject AND status = 'active';/);
    assert.match(branch, /'live_sharing_restored', false/);
    const m3972 = read("3972_trip_private_anchor_rls_and_grant_lifecycle.sql");
    assert.match(m3972, /IF TG_OP = 'INSERT' THEN\s+DELETE FROM public\.trip_private_anchor_shares/, "a membership that begins holds no grant");
  });

  it("A7. the event is one the vocabulary and the snapshot fold already carry — no new type", () => {
    assert.match(branch, /v_event_type := 'trip\.participant_added';/);
    assert.ok((TRIP_EVENT_TYPES as readonly string[]).includes("trip.participant_added"));
    assert.match(read("2773_trip_snapshot_fold_and_replay.sql"), /WHEN t IN \('trip\.participant_invited','trip\.participant_added',/);
  });

  it("A8. exactly one branch and one dispatch entry are added, and checked as such; the rollback removes the same three edits", () => {
    assert.match(m3974, /IF n <> branches_before \+ 1 THEN/);
    assert.match(m3974, /IF n <> admin_before \+ 1 THEN/);
    const rb = readFileSync(new URL("../../../../db/rollback/2026-10-05-3974-trip-kernel-admin-restore-participant-rollback.sql", import.meta.url), "utf8");
    assert.match(rb, /WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN\.\*\?      WHEN 'ADMIN_HIDE_TRIP' THEN/);
    assert.ok(rb.includes("$a$ WHEN 'ADMIN_RESTORE_PARTICIPANT' THEN 'admin'$a$"));
    assert.ok(rb.includes("'  v_rst_event  uuid;'") && m3974.includes("'  v_rst_event  uuid;'"));
    assert.match(rb, /IF n <> branches_before - 1 THEN/);
  });
});

describe("B. the one call lane B makes", () => {
  const input = {
    tripId: "aaaaaaaa-0000-4000-8000-00000000000a", userId: "22222222-0000-4000-8000-000000000002", role: "co_host",
    access: "membership" as const, appealId: "cccccccc-0000-4000-8000-00000000000c", removalEventId: "eeeeeeee-0000-4000-8000-00000000000e",
    adminActor: "11111111-0000-4000-8000-000000000001", reason: "appeal upheld by moderation review", idempotencyKey: "appeal-restore-1", expectedVersion: 7,
  };
  const client = (kernelOn: boolean) => {
    const rpcs: Array<{ name: string; args: any }> = [];
    return {
      rpcs,
      from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { enabled: kernelOn }, error: null }) }; return q; },
      rpc: async (name: string, args: any) => { rpcs.push({ name, args }); return { data: { ok: true, duplicate: false, version: 8, event_id: "ev-1", sequence: 9, result: { user_id: input.userId, role: "co_host", access: "membership" }, contract_version: 2 }, error: null }; },
    };
  };

  it("B1. kernel off: refused, named, and no RPC — there is no legacy twin for a restoration", async () => {
    const sc = client(false);
    const r = await adminRestoreTripParticipant(sc as never, input);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "TRIP_KERNEL_DISABLED");
    assert.equal(sc.rpcs.length, 0);
  });

  it("B2. kernel on: ADMIN_RESTORE_PARTICIPANT as actor_role admin, carrying the plan exactly", async () => {
    const sc = client(true);
    const r = await adminRestoreTripParticipant(sc as never, input);
    assert.equal(r.ok, true);
    assert.equal(sc.rpcs.length, 1);
    const c = sc.rpcs[0]!.args.p_command;
    assert.equal(sc.rpcs[0]!.name, "trip_kernel_execute");
    assert.equal(c.type, "ADMIN_RESTORE_PARTICIPANT");
    assert.equal(c.actor_role, "admin");
    assert.equal(c.actor_user_id, input.adminActor);
    assert.equal(c.expected_trip_version, 7);
    assert.equal(c.idempotency_key, "appeal-restore-1");
    assert.deepEqual(c.payload, { user_id: input.userId, role: "co_host", access: "membership", appeal_id: input.appealId, removal_event_id: input.removalEventId, reason: input.reason });
  });
});

describe("C. the TS vocabulary", () => {
  it("C1. ADMIN_RESTORE_PARTICIPANT is the admin family, and the generic /commands door does not issue it", () => {
    assert.equal(tripCommandFamily("ADMIN_RESTORE_PARTICIPANT"), "admin");
    assert.ok(!(COMMANDS_ENDPOINT_TYPES as readonly string[]).includes("ADMIN_RESTORE_PARTICIPANT"));
  });
});
