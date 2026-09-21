/**
 * OPTION B STAGED — the posture decision, and the sweep it required.
 *
 * ── WHAT THIS PINS ───────────────────────────────────────────────────────────
 * On 2026-09-16 the owner took the decision `sensing-auth-posture-decision.md`
 * had been holding open since 2026-09-07: Option B, staged. Three things became
 * true in one diff, and each is asserted here rather than left to prose.
 *
 *   1. `SENSING_AUTH_POSTURE` is `anonymous_capable` and no longer refuses
 *      everyone. `undecided` was not a placeholder anybody could leave in place.
 *   2. STAGED means `SENSING_ALLOW_UNATTESTED_DEVICES` stays FALSE. With it
 *      false, an unattested device is REFUSED — so "profiles first, while the
 *      attestation primitive is built" is a property of the code, not a plan.
 *   3. `purge_expired_sensing_sessions` has a registered sweep. The decision doc
 *      called this out as the one piece with no code written.
 *
 * ── WHY IT IS WORTH A FILE ───────────────────────────────────────────────────
 * The posture is a bare constant with deliberately no env var and no flag, which
 * makes it exactly the kind of value that gets edited back by a careless merge
 * with nothing failing. And the budget/refusal ladder below is the abuse control
 * for an anonymous ingest path — a regression that silently admitted unattested
 * devices would not announce itself.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/sensingPostureOptionB.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SENSING_AUTH_POSTURE,
  SENSING_ALLOW_UNATTESTED_DEVICES,
  sensingEligibility,
} from "../lib/sensingAuthPosture.js";
import { RETENTION_PASSES, runSensingSessionCleanup } from "../lib/intelRetentionScheduler.js";

describe("Sensing Option B, staged", () => {
  it("the posture is decided, and it is anonymous_capable", () => {
    assert.equal(SENSING_AUTH_POSTURE, "anonymous_capable");
    assert.notEqual(SENSING_AUTH_POSTURE, "undecided", "undecided refuses every caller");
  });

  it("STAGED: unattested devices stay refused until the owner accepts that exposure separately", () => {
    assert.equal(SENSING_ALLOW_UNATTESTED_DEVICES, false);
    const r = sensingEligibility({ profileId: null, deviceAttested: false });
    assert.equal(r.eligible, false);
    assert.equal((r as any).reason, "device_attestation_required");
  });

  it("stage one: an authenticated profile is eligible, budget keyed on the profile", () => {
    const r = sensingEligibility({ profileId: "p-1", deviceAttested: false });
    assert.equal(r.eligible, true);
    assert.equal((r as any).issuanceClass, "authenticated_profile");
    assert.equal((r as any).budgetKey, "profile:p-1");
  });

  it("stage two is reachable the moment attestation exists — and is keyed on the credential, never an identity", () => {
    const r = sensingEligibility({ profileId: null, deviceAttested: true });
    assert.equal(r.eligible, true);
    assert.equal((r as any).issuanceClass, "attested_device");
    assert.equal((r as any).budgetKey, "credential", "a device budget must not be keyed on a person");
  });

  it("the session purge sweep is REGISTERED, not merely exported", () => {
    const names = RETENTION_PASSES.map((p) => p.name);
    assert.ok(names.includes("sensing_session_cleanup"), `registered passes: ${names.join(", ")}`);
    const pass = RETENTION_PASSES.find((p) => p.name === "sensing_session_cleanup")!;
    assert.equal(pass.flag, null, "retention hygiene is not behind a flag an operator could switch off");
    assert.equal(typeof pass.run, "function");
  });

  it("the sweep passes the instant IN and coerces a string bigint", async () => {
    const calls: any[] = [];
    const client = {
      rpc: async (fn: string, args: any) => {
        calls.push([fn, args]);
        return { data: "7", error: null }; // int8 over PostgREST arrives as a STRING
      },
    };
    const now = new Date("2026-09-16T18:00:00.000Z");
    const r = await runSensingSessionCleanup({ client, now });
    assert.deepEqual(calls[0], ["purge_expired_sensing_sessions", { p_now: now.toISOString() }]);
    assert.equal(r.purged, 7, "a string bigint must not be reported as 0");
    assert.equal(r.skipped, false);
  });

  it("an absent relation is REPORTED, never counted as a successful erasure of zero", async () => {
    const client = { rpc: async () => ({ data: null, error: { message: "relation does not exist" } }) };
    const r = await runSensingSessionCleanup({ client });
    assert.equal(r.purged, 0);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "error");
  });

  it("no client is skipped, not an error", async () => {
    const r = await runSensingSessionCleanup({ client: null });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "no_client");
  });
});
