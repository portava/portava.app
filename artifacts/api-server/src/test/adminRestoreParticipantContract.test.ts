/**
 * ADMIN_RESTORE_PARTICIPANT — the contract, and the proof that it REFUSES
 * (services/appeals/adminRestoreParticipant.ts)
 *
 * WHAT IS UNDER TEST
 * ==================
 * The command that would restore a participant a moderator removed does not
 * exist. `resolveAppeal`'s `trip_membership` case names it, the pending-
 * restoration queue names it, and the Trip Kernel does not implement it: 2450's
 * admin family is ADMIN_HIDE_TRIP alone, and no other command can re-INSERT a
 * `trip_members` row on a moderator's behalf.
 *
 * So this module is the SHAPE ONLY, and the thing that must be proven about it
 * is a negative: that it cannot be made to perform a restoration, by anyone,
 * with any input, today.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID
 * ==================================
 * The natural way to "prepare" such a command is a validator with an allowlist
 * of restoration roles — `['member','co_host','host']` — and an executor that
 * checks membership in it. That validator ACCEPTS 'member', which means the
 * owner decision APPEAL_RESTORE_SEMANTICS has been made: by an engineer, in a
 * helper function, with nobody deciding it. A validator that accepts any role
 * validates nothing.
 *
 * `APPROVED_RESTORATION_ROLES` is therefore EMPTY, and the assertions below
 * pin that: not "some roles are rejected" but "every role is rejected, and the
 * approved set is empty". The day the decision lands, these tests FAIL and
 * demand review. That is the intended alarm, not a maintenance burden.
 *
 * WHAT IS PROVEN
 * ==============
 *   shape       all nine inputs are required and typed; a malformed envelope is
 *               ADMIN_RESTORE_MALFORMED and never reaches authorization.
 *   authz       a non-admin, an unknown actor, a resolved lookup error and a
 *               THROWN lookup all refuse with ADMIN_RESTORE_NOT_AUTHORIZED —
 *               fail-closed in all four directions — and never reach the
 *               semantic stage.
 *   semantics   a well-formed envelope from a REAL admin, with every plausible
 *               restoration_role and restoration_source, still refuses with
 *               ADMIN_RESTORE_ROLE_NOT_ESTABLISHED, blockedOn
 *               APPEAL_RESTORE_SEMANTICS, `restored: false`.
 *   no writes   across every one of those calls the client records ZERO writes:
 *               the refusal is not a write that then reports a refusal.
 *   grounded    the kernel really has no such command — no migration mentions
 *               ADMIN_RESTORE_PARTICIPANT — so the refusal states a fact about
 *               the system rather than a preference of this module.
 *
 * THE FAKE
 * ========
 * The client records every write verb on every table and the tests assert the
 * list is empty. A fake that silently swallowed writes would let a stub that
 * "restores then refuses" pass; this one cannot.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/adminRestoreParticipantContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_RESTORE_PARTICIPANT,
  AdminRestoreParticipantSchema,
  APPROVED_RESTORATION_ROLES,
  APPROVED_RESTORATION_SOURCES,
  isApprovedRestorationRole,
  isApprovedRestorationSource,
  authorizeAdminRestoreParticipant,
  executeAdminRestoreParticipant,
} from "../services/appeals/adminRestoreParticipant.js";

const ADMIN  = "cccccccc-0000-0000-0000-000000000003";
const USER   = "aaaaaaaa-0000-0000-0000-000000000001";
const TRIP   = "33333333-0000-0000-0000-000000000001";
const APPEAL = "99999999-0000-0000-0000-000000000001";

type Row = Record<string, any>;
interface Recorder { writes: Array<{ table: string; verb: string }> }

/**
 * A client that records every write. `profileError` and `profileThrows` model
 * the two ways an admin lookup fails — PostgREST RESOLVES errors, it does not
 * throw, but a transport fault can still throw — and both must land as "not
 * authorized".
 */
function makeClient(
  profiles: Row[],
  opts: { profileError?: { message: string }; profileThrows?: boolean } = {},
): Recorder & { client: any } {
  const rec: Recorder = { writes: [] };

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "delete" | "upsert" = "select";

    const b: any = {
      select() { return b; },
      insert() { verb = "insert"; return b; },
      upsert() { verb = "upsert"; return b; },
      update() { verb = "update"; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      order() { return b; },
      range() { return b; },
      limit() { return b; },
      maybeSingle() { return run(); },
      single() { return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };

    async function run(): Promise<{ data: any; error: any }> {
      if (verb !== "select") {
        rec.writes.push({ table, verb });
        return { data: null, error: null };
      }
      if (table === "profiles") {
        if (opts.profileThrows) throw new Error("socket hang up");
        if (opts.profileError) return { data: null, error: opts.profileError };
        const m = profiles.filter((r) => preds.every((p) => p(r)));
        return { data: m[0] ?? null, error: null };
      }
      return { data: null, error: null };
    }
    return b;
  }

  return { ...rec, writes: rec.writes, client: { from, rpc: async () => ({ data: null, error: null }) } };
}

const ADMIN_PROFILES = [{ id: ADMIN, role: "admin" }, { id: USER, role: "user" }];

function envelope(over: Record<string, unknown> = {}) {
  return {
    trip_id:            TRIP,
    user_id:            USER,
    appeal_id:          APPEAL,
    admin_actor:        ADMIN,
    reason:             "Appeal 9999 upheld; the removal was not justified and the crew agreed.",
    restoration_role:   "member",
    restoration_source: "role_at_removal",
    expected_version:   null,
    idempotency_key:    `appeal:${APPEAL}:restore`,
    ...over,
  };
}

// ── The input contract ───────────────────────────────────────────────────────

describe("ADMIN_RESTORE_PARTICIPANT input contract", () => {
  it("accepts the nine-field envelope", () => {
    const p = AdminRestoreParticipantSchema.safeParse(envelope());
    assert.equal(p.success, true, JSON.stringify((p as any).error?.issues));
  });

  it("names every input the contract owes", () => {
    const keys = Object.keys(AdminRestoreParticipantSchema.shape).sort();
    assert.deepEqual(keys, [
      "admin_actor",
      "appeal_id",
      "expected_version",
      "idempotency_key",
      "reason",
      "restoration_role",
      "restoration_source",
      "trip_id",
      "user_id",
    ]);
  });

  it("requires each of them — none may be omitted", () => {
    for (const k of Object.keys(AdminRestoreParticipantSchema.shape)) {
      const bad: Record<string, unknown> = envelope();
      delete bad[k];
      assert.equal(
        AdminRestoreParticipantSchema.safeParse(bad).success,
        false,
        `omitting ${k} must not parse`,
      );
    }
  });

  it("rejects non-uuid ids, an empty reason and a throwaway idempotency key", () => {
    for (const bad of [
      envelope({ trip_id: "not-a-uuid" }),
      envelope({ user_id: "" }),
      envelope({ appeal_id: "1234" }),
      envelope({ admin_actor: null }),
      envelope({ reason: "too short" }),
      envelope({ idempotency_key: "x" }),
      envelope({ expected_version: -1 }),
      envelope({ expected_version: 1.5 }),
      envelope({ restoration_role: "" }),
    ]) {
      assert.equal(AdminRestoreParticipantSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });

  it("accepts an explicit expected_version for optimistic concurrency", () => {
    assert.equal(AdminRestoreParticipantSchema.safeParse(envelope({ expected_version: 7 })).success, true);
  });
});

// ── The role allowlist is EMPTY, and that is the point ───────────────────────

describe("no restoration role is approved while APPEAL_RESTORE_SEMANTICS is open", () => {
  it("the approved sets are empty", () => {
    assert.deepEqual([...APPROVED_RESTORATION_ROLES], [], "adding a role here IS taking the owner decision");
    assert.deepEqual([...APPROVED_RESTORATION_SOURCES], []);
  });

  it("isApprovedRestorationRole is false for every plausible role — 'member' included", () => {
    for (const role of [
      "member", "co_host", "host", "owner", "viewer", "participant", "guest",
      "Member", "MEMBER", "admin", "crew", "previous", "unknown",
    ]) {
      assert.equal(isApprovedRestorationRole(role), false, `${role} must not be approved`);
    }
  });

  it("isApprovedRestorationSource is false for every plausible source", () => {
    for (const src of ["role_at_removal", "policy_default", "operator_choice", "appeal", "kernel"]) {
      assert.equal(isApprovedRestorationSource(src), false, `${src} must not be approved`);
    }
  });
});

// ── Authorization scaffold ───────────────────────────────────────────────────

describe("authorizeAdminRestoreParticipant fails closed", () => {
  it("authorizes a real admin", async () => {
    const { client } = makeClient(ADMIN_PROFILES);
    assert.equal((await authorizeAdminRestoreParticipant(client, ADMIN)).authorized, true);
  });

  it("refuses a non-admin", async () => {
    const { client } = makeClient(ADMIN_PROFILES);
    assert.equal((await authorizeAdminRestoreParticipant(client, USER)).authorized, false);
  });

  it("refuses an unknown actor", async () => {
    const { client } = makeClient(ADMIN_PROFILES);
    const r = await authorizeAdminRestoreParticipant(client, "ffffffff-0000-0000-0000-00000000000f");
    assert.equal(r.authorized, false);
  });

  it("refuses when the lookup RESOLVES an error", async () => {
    const { client } = makeClient(ADMIN_PROFILES, { profileError: { message: "permission denied" } });
    assert.equal((await authorizeAdminRestoreParticipant(client, ADMIN)).authorized, false);
  });

  it("refuses when the lookup THROWS — unknown is not permission", async () => {
    const { client } = makeClient(ADMIN_PROFILES, { profileThrows: true });
    const r = await authorizeAdminRestoreParticipant(client, ADMIN);
    assert.equal(r.authorized, false);
    assert.match(r.reason, /lookup failed/);
  });

  it("refuses with no client at all", async () => {
    assert.equal((await authorizeAdminRestoreParticipant(null, ADMIN)).authorized, false);
  });
});

// ── Execution refuses ────────────────────────────────────────────────────────

describe("executeAdminRestoreParticipant refuses, and writes nothing", () => {
  it("a valid envelope from a real admin still refuses: the role cannot be established", async () => {
    const rec = makeClient(ADMIN_PROFILES);
    const r = await executeAdminRestoreParticipant(rec.client, envelope());

    assert.equal(r.ok, false, "there is no success path");
    assert.equal(r.restored, false, "and `restored` is explicit, so no caller reads `ok` alone");
    assert.equal(r.code, "ADMIN_RESTORE_ROLE_NOT_ESTABLISHED");
    assert.equal(r.blockedOn, "APPEAL_RESTORE_SEMANTICS");
    assert.match(r.reason, /restoration_role='member'/, "the operator sees WHICH role was asked for");
    assert.match(r.reason, /Nothing was restored/);
    assert.deepEqual(rec.writes, [], `a refusal writes nothing; saw ${JSON.stringify(rec.writes)}`);
  });

  it("refuses for EVERY restoration_role and restoration_source an operator might try", async () => {
    for (const role of ["member", "co_host", "host", "owner", "viewer", "participant"]) {
      for (const source of ["role_at_removal", "policy_default", "operator_choice"]) {
        const rec = makeClient(ADMIN_PROFILES);
        const r = await executeAdminRestoreParticipant(rec.client, envelope({
          restoration_role: role,
          restoration_source: source,
        }));
        assert.equal(r.ok, false, `${role}/${source} must refuse`);
        assert.equal(r.code, "ADMIN_RESTORE_ROLE_NOT_ESTABLISHED", `${role}/${source}`);
        assert.deepEqual(rec.writes, [], `${role}/${source} must write nothing`);
      }
    }
  });

  it("a non-admin is refused on AUTHORIZATION, before the semantic stage", async () => {
    const rec = makeClient(ADMIN_PROFILES);
    const r = await executeAdminRestoreParticipant(rec.client, envelope({ admin_actor: USER }));

    assert.equal(r.code, "ADMIN_RESTORE_NOT_AUTHORIZED");
    assert.equal(r.restored, false);
    assert.equal(r.blockedOn, null, "an unauthorized caller learns nothing about restoration policy");
    assert.doesNotMatch(r.reason, /APPEAL_RESTORE_SEMANTICS/);
    assert.deepEqual(rec.writes, []);
  });

  it("a thrown admin lookup refuses as unauthorized, not as an unhandled error", async () => {
    const rec = makeClient(ADMIN_PROFILES, { profileThrows: true });
    const r = await executeAdminRestoreParticipant(rec.client, envelope());
    assert.equal(r.code, "ADMIN_RESTORE_NOT_AUTHORIZED");
    assert.deepEqual(rec.writes, []);
  });

  it("a malformed envelope is rejected before authorization is even consulted", async () => {
    const rec = makeClient(ADMIN_PROFILES);
    const r = await executeAdminRestoreParticipant(rec.client, { trip_id: "nope" });

    assert.equal(r.code, "ADMIN_RESTORE_MALFORMED");
    assert.equal(r.restored, false);
    assert.deepEqual(rec.writes, []);
  });

  it("refuses a null/garbage input rather than throwing", async () => {
    const rec = makeClient(ADMIN_PROFILES);
    for (const bad of [null, undefined, 0, "", [], { }]) {
      const r = await executeAdminRestoreParticipant(rec.client, bad);
      assert.equal(r.ok, false);
      assert.equal(r.code, "ADMIN_RESTORE_MALFORMED");
    }
    assert.deepEqual(rec.writes, []);
  });
});

// ── The refusal states a fact about the system, not a preference ─────────────

describe("the kernel really has no ADMIN_RESTORE_PARTICIPANT", () => {
  it("no migration implements it — which is why execution cannot dispatch", () => {
    // When this assertion starts failing, the command exists and this whole
    // contract must be revisited: that is the intended alarm.
    const dir = new URL("../migrations/", import.meta.url).pathname;
    const hits: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".sql")) continue;
      if (readFileSync(join(dir, f), "utf8").includes(ADMIN_RESTORE_PARTICIPANT)) hits.push(f);
    }
    assert.deepEqual(
      hits,
      [],
      `${ADMIN_RESTORE_PARTICIPANT} appears in ${hits.join(", ")} — the kernel may now implement it`,
    );
  });

  it("the command name is spelled one way", () => {
    assert.equal(ADMIN_RESTORE_PARTICIPANT, "ADMIN_RESTORE_PARTICIPANT");
  });
});
