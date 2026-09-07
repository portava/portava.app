/**
 * sensingAuthPosture — the owner's undecided switch, fail-closed until decided.
 *
 * OWNER DECISION REQUIRED: SENSING_AUTH_POSTURE (docs/architecture/
 * sensing-auth-posture-decision.md). While it reads `undecided`, no caller is
 * eligible for a credential under any context.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_ALLOW_UNATTESTED_DEVICES,
  SENSING_AUTH_POSTURE,
  SENSING_AUTH_POSTURES,
  SENSING_ISSUANCE_CLASSES,
  postureAdmitsAnonymous,
  sensingEligibility,
} from "../lib/sensingAuthPosture.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TS = readFileSync(join(SRC, "lib", "sensingAuthPosture.ts"), "utf8");

const PROFILE = { profileId: "11111111-1111-1111-1111-111111111111", deviceAttested: false };
const ATTESTED = { profileId: null, deviceAttested: true };
const NOBODY = { profileId: null, deviceAttested: false };

describe("undecided is fail-closed", () => {
  it("the shipped posture is `undecided`, and it is a constant — no env var, no flag", () => {
    assert.equal(SENSING_AUTH_POSTURE, "undecided");
    assert.match(MODULE_TS, /export const SENSING_AUTH_POSTURE: SensingAuthPosture = "undecided";/);
    assert.doesNotMatch(MODULE_TS, /process\.env|isFlagEnabled|feature_flags/);
  });
  it("nobody is eligible while undecided — a profile, an attested device, or neither", () => {
    for (const ctx of [PROFILE, ATTESTED, NOBODY]) {
      assert.deepEqual(sensingEligibility(ctx), { eligible: false, reason: "posture_undecided" });
    }
  });
  it("an unrecognised posture value is treated as undecided", () => {
    assert.deepEqual(sensingEligibility(PROFILE, "open" as never), { eligible: false, reason: "posture_undecided" });
  });
  it("unattested devices are refused by default under every posture", () => {
    assert.equal(SENSING_ALLOW_UNATTESTED_DEVICES, false);
  });
});

describe("Option A — authenticated_only", () => {
  it("a profile is eligible; the budget key is the profile; the issuance class says so", () => {
    assert.deepEqual(sensingEligibility(PROFILE, "authenticated_only"), {
      eligible: true,
      issuanceClass: "authenticated_profile",
      budgetKey: `profile:${PROFILE.profileId}`,
    });
  });
  it("an attested device without a profile is NOT eligible — attestation is not an account", () => {
    assert.deepEqual(sensingEligibility(ATTESTED, "authenticated_only"), { eligible: false, reason: "profile_required" });
    assert.deepEqual(sensingEligibility(NOBODY, "authenticated_only"), { eligible: false, reason: "profile_required" });
  });
  it("cannot admit an anonymous caller", () => {
    assert.equal(postureAdmitsAnonymous("authenticated_only"), false);
  });
});

describe("Option B — anonymous_capable", () => {
  it("an attested device is eligible with a credential-keyed budget", () => {
    assert.deepEqual(sensingEligibility(ATTESTED, "anonymous_capable"), {
      eligible: true,
      issuanceClass: "attested_device",
      budgetKey: "credential",
    });
  });
  it("a profile is still eligible (capable, not anonymous-only)", () => {
    assert.equal(sensingEligibility(PROFILE, "anonymous_capable").eligible, true);
  });
  it("an unattested device is refused unless the owner accepts it, and then gets the tightest class", () => {
    assert.deepEqual(sensingEligibility(NOBODY, "anonymous_capable"), { eligible: false, reason: "device_attestation_required" });
    assert.deepEqual(sensingEligibility(NOBODY, "anonymous_capable", true), {
      eligible: true,
      issuanceClass: "unattested_device",
      budgetKey: "credential",
    });
  });
  it("is the only posture that admits an anonymous caller", () => {
    assert.equal(postureAdmitsAnonymous("anonymous_capable"), true);
    assert.equal(postureAdmitsAnonymous("undecided"), false);
  });
});

describe("vocabulary and purity", () => {
  it("postures and issuance classes are closed vocabularies matching 2480's CHECK", () => {
    assert.deepEqual([...SENSING_AUTH_POSTURES], ["undecided", "authenticated_only", "anonymous_capable"]);
    assert.deepEqual([...SENSING_ISSUANCE_CLASSES], ["attested_device", "unattested_device", "authenticated_profile"]);
  });
  it("an empty profile id is not a profile", () => {
    assert.deepEqual(sensingEligibility({ profileId: "", deviceAttested: false }, "authenticated_only"), { eligible: false, reason: "profile_required" });
  });
  it("reads no clock and no database; no route imports it", () => {
    assert.doesNotMatch(MODULE_TS, /Date\.now|supabase|getServiceClient|\.from\(/);
  });
});
