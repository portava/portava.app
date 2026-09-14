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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveContributorToken, deriveEpochSecret, deriveGroupToken, revocationCommitment } from "../lib/sensingAnonStore.js";
import { buildExperienceState } from "../lib/mapExperienceState.js";
import { SENSING_AUTH_POSTURE, sensingEligibility } from "../lib/sensingAuthPosture.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// census-sensing §9.1's enumeration, made EXECUTABLE (§9.5's named open gap).
//
// §9.1 settled "what SENSING_AUTH_POSTURE actually blocks" by opening every
// reference to the sensing contribution stack by hand, and §9.5 then recorded
// the weakness in its own method: "there is still nothing in this repository
// that can check whether a stated absence was actually searched for." Thirteen
// W rows (S18, S20, S24, S25, S30, S33, S35, S39, S42, S51, S52, S111, S112) —
// half this census's correctness gap — rest on that hand-run enumeration.
//
// This is that enumeration as a test. It is deliberately NOT the tripwire in
// sensingAnonStore.test.ts: that one is about MENTIONS of two modules and the
// table, and it is the reason a route cannot appear. This one is about real
// IMPORTS of the whole ten-module stack, which is the fact the thirteen rows
// actually turn on — "built, and unaddressed".
//
// WHEN THIS GOES RED IT IS NOT A REGRESSION. A new importer means the ingest
// those thirteen rows wait on has started to exist, and the right response is to
// re-derive them in census-sensing, not to add an entry here to keep it green.
// ─────────────────────────────────────────────────────────────────────────────
describe("§9.1 — the sensing contribution stack is imported by its own siblings and nothing else", () => {
  const STACK = [
    "sensingAnonStore", "sensingAnonService", "sensingContributionSession",
    "sensingContributionPolicy", "sensingPresenceState", "sensingCoverageAggregate",
    "sensingDifferencingGate", "sensingRevocationLineage", "sensingAuthPosture",
    "sensingSubjectReconciliation",
  ] as const;

  /**
   * Every non-test, non-migration module under src/ that IMPORTS one of the ten,
   * mapped to what it imports. Self-imports are not reachability.
   */
  function importers(): Map<string, string[]> {
    const re = new RegExp(String.raw`from\s+"[^"]*(${STACK.join("|")})\.js"`, "g");
    const out = new Map<string, string[]>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry)) continue;
        const rel = full.slice(SRC.length + 1);
        if (rel.startsWith("test" + sep) || rel.startsWith("migrations" + sep)) continue;
        const self = entry.replace(/\.tsx?$/, "");
        const hits = [...readFileSync(full, "utf8").matchAll(re)].map((m) => m[1] as string);
        const named = [...new Set(hits)].filter((h) => h !== self).sort();
        if (named.length > 0) out.set(rel, named);
      }
    };
    walk(SRC);
    return out;
  }

  /** The allowlist §9.1 arrived at by hand, with the reason each entry is not an ingest. */
  const PERMITTED = new Map<string, string>([
    [join("lib", "sensingAnonService.ts"), "the store's own read/write service — a sibling, not a caller of one"],
    [join("lib", "sensingContributionPolicy.ts"), "composes the admission policy from the store's constants; pure, no I/O"],
    [join("lib", "sensingContributionSession.ts"), "the issuance half; pure, and refuses while the posture is undecided"],
    [join("lib", "sensingCoverageAggregate.ts"), "the aggregate over the store's rows; pure"],
    [join("lib", "sensingDifferencingGate.ts"), "a type import of the aggregate; pure, keeps no token"],
    [join("lib", "sensingPresenceState.ts"), "a type import of the aggregate's decision; reads no store"],
    [join("lib", "sensingRevocationLineage.ts"), "models a revocation against the store's predicate; pure"],
    [join("lib", "sensingRetentionScheduler.ts"), "the TTL sweep — it DELETES; src/index.ts starts it and imports nothing else from the stack"],
  ]);

  it("the importer set is EXACTLY the allowlist — no route, no service, no producer", () => {
    const found = importers();
    assert.ok(found.size > 0, "premise: the walk found the stack at all");
    assert.deepEqual(
      [...found.keys()].sort(),
      [...PERMITTED.keys()].sort(),
      "a module outside the sensing stack now imports it — the ingest the thirteen posture-blocked rows wait on may have started to exist; re-derive them in census-sensing rather than allowlisting here",
    );
    for (const [, reason] of PERMITTED) assert.ok(reason.length > 20, "every entry gives a reason");
  });

  it("no route and no service under services/ imports any of the ten", () => {
    const found = importers();
    const offenders = [...found.keys()].filter((f) => f.startsWith("routes" + sep) || f.startsWith("services" + sep));
    assert.deepEqual(offenders, [], "an HTTP or service surface for the anonymous sensing path is an owner decision, not an implementation detail");
  });

  it("S111 — the §18.3 subject resolver still has no caller at all", () => {
    // The row's stated blocker. It is not that the resolver is wrong: all four
    // outcomes are representable and proximity never resolves ownership. It is
    // that intel_observations.subject_id is NOT NULL REFERENCES places(id), so
    // `unknown` and `temporary_world_object` cannot be STORED — and giving the
    // resolver a caller would not change that.
    const found = importers();
    const callers = [...found.entries()].filter(([, mods]) => mods.includes("sensingSubjectReconciliation"));
    assert.deepEqual(callers.map(([f]) => f), [], "sensingSubjectReconciliation acquired a caller; re-derive S111");
  });

  it("the posture that blocks the thirteen still reads `undecided`, and refuses every context", () => {
    assert.equal(SENSING_AUTH_POSTURE, "undecided", "the owner decided the posture — re-derive S18, S20, S24, S25, S30, S33, S35, S39, S42, S51, S52, S111, S112");
    for (const ctx of [
      { profileId: null, deviceAttested: false },
      { profileId: "11111111-1111-4111-8111-111111111111", deviceAttested: false },
      { profileId: null, deviceAttested: true },
    ]) {
      const e = sensingEligibility(ctx);
      assert.equal(e.eligible, false);
      assert.equal((e as { reason: string }).reason, "posture_undecided");
    }
  });
});
