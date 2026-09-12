/**
 * census-sensing §1 — the invariants behind rows re-derived against the code,
 * pinned where no existing suite held them.
 *
 * Each `it` names the row it pins and was watched go red under a mutation of
 * the code it reads (the mutation is recorded beside the row in the census).
 * A pin here adds evidence for a verdict; it moves none on its own.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveContributorToken, deriveEpochSecret, deriveGroupToken, revocationCommitment } from "../lib/sensingAnonStore.js";
import { buildExperienceState } from "../lib/mapExperienceState.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

process.env["SENSING_CONTRIBUTOR_PEPPER"] ??= "census-rederivation-pepper-" + "q".repeat(24);

describe("S18 — a contribution identifier rotates at BOTH layers, each on its own", () => {
  const secret = "device-secret-that-never-leaves-the-device";
  const e1 = 490_000;
  const e2 = e1 + 1;

  it("the device folds the epoch: one device secret yields a different epoch secret per epoch", () => {
    assert.notEqual(deriveEpochSecret(secret, e1), deriveEpochSecret(secret, e2));
  });

  it("the server folds the epoch too: ONE commitment presented under two epochs is two unrelated tokens", () => {
    const commitment = revocationCommitment(deriveEpochSecret(secret, e1));
    assert.notEqual(deriveContributorToken(e1, commitment), deriveContributorToken(e2, commitment));
    assert.notEqual(deriveGroupToken(e1, "party-a"), deriveGroupToken(e2, "party-a"));
  });

  it("and the two layers compose: the stored token for one device differs across epochs", () => {
    const t1 = deriveContributorToken(e1, revocationCommitment(deriveEpochSecret(secret, e1)));
    const t2 = deriveContributorToken(e2, revocationCommitment(deriveEpochSecret(secret, e2)));
    assert.notEqual(t1, t2);
    // and is stable within one
    assert.equal(t1, deriveContributorToken(e1, revocationCommitment(deriveEpochSecret(secret, e1))));
  });
});

describe("S43 — the Experience engine folds claims and reads no personal preference", () => {
  const code = stripComments(readFileSync(join(SRC, "lib", "mapExperienceState.ts"), "utf8"));

  it("the fold's source names no viewer, user, profile, preference or taste input", () => {
    assert.doesNotMatch(code, /\b(viewer|viewerId|userId|user_id|profile|preference|preferences|taste|affinity|dislike)\b/);
  });

  it("an extra, preference-shaped field on the input changes nothing in the state", () => {
    const base = {
      claims: [{ id: "c1", claimType: "crowd.level", value: { level: "busy" }, band: "live" as const, sourceClass: "firsthand_unverified" as const, sourceCountBucket: "few" as const }],
      activity: "busy" as const,
      trend: undefined,
      confidence: "live" as const,
      freshness: "live" as const,
      sourceClass: "firsthand_unverified" as const,
    };
    const plain = buildExperienceState(base);
    const withPreference = buildExperienceState({ ...base, viewerPreference: { dislikes: ["busy"] } } as typeof base);
    assert.deepEqual(withPreference, plain);
    assert.equal(plain.crowd.density, "busy");
  });
});
