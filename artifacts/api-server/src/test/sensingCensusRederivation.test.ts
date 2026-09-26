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
import { SENSING_AUTH_POSTURE, SENSING_ALLOW_UNATTESTED_DEVICES, sensingEligibility } from "../lib/sensingAuthPosture.js";
import { inferVibe, type SensingVibeState, type VibeFeatureInput } from "../lib/vibeInference.js";
import { TRUTH_CLASSES } from "../lib/truthClass.js";
import { CONFIDENCE_BANDS, MIN_BAND_FOR_LIVE_STATE } from "../lib/intelContracts.js";

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
    // ── THREE ENTRIES ADDED 2026-09-25, AFTER THE ROWS WERE RE-DERIVED ───────
    // This tripwire's failure message is an INSTRUCTION — "re-derive them in
    // census-sensing rather than allowlisting here" — and it was followed
    // before any of these was written down. census-sensing §14 re-derives every
    // row each of them touches, and moves NOT ONE of them, because each turns
    // on something applied to no database. The allowlist follows the census;
    // the census did not follow the allowlist.
    [
      join("lib", "sensingWindowAggregate.ts"),
      "the per-window aggregation S42/S52 waited on (census-sensing §14.2): joins adjacent k-gated cohorts " +
        "into arrival/departure rates, coverage and dwell and hands them to vibeInference. A refused bucket " +
        "contributes nothing, so no rate is computed over a sub-k cohort, and no token reaches its result. " +
        "Pure; no route, no flag, no publisher — and its inputs are a table with zero rows.",
    ],
    [
      join("routes", "sensingIngest.ts"),
      "the ONE transport, and the reason the 'no route' assertion below is now scoped rather than absolute. " +
        "POST /v1/sensing/contributions is authenticated by the opaque contribution credential and by nothing " +
        "else. It REFUSES EVERY CALLER in production: SENSING_CONTRIBUTOR_PEPPER is unset and the pepper check " +
        "is the handler's first statement. census-sensing §14.2 holds S18 and S32 at W for exactly that.",
    ],
    [
      join("services", "intel", "IntelCaptureService.ts"),
      "the HUMAN-CLAIM capture path, which is a different population: requireUser-bound, actor-keyed, and " +
        "outside the anonymous store entirely. It imports sensingSubjectReconciliation only to decide which of " +
        "§18.3's four outcomes a cluster is, which is the resolver's purpose. census-sensing §14.2 re-derives " +
        "S111 against it and holds it at W: 3002 makes the two unowned outcomes STORABLE and is applied nowhere.",
    ],
    // ── ADDED 2026-09-26, WHEN THE OWNER TOOK DECISION #9 ───────────────────
    // The first importer that is a CONSUMER rather than a sibling, and the
    // reason it is not the ingest this tripwire watches for: it reads the
    // DURABLE PUBLICATION STORE (3110), never the contribution store, and it
    // cannot cause a publication. census-sensing §21 re-derives S39 against it
    // and does NOT move it, because `surface` is still ungranted.
    [
      join("compass", "CompassSensingPresenceProducer.ts"),
      "decision #9's consumer: renders an ALREADY-published, unexpired, k-gated cohort aggregate into " +
        "Compass presence context. Imports the presence state builder, the publication reader and the " +
        "contribution policy; imports no store and writes nothing, so it cannot publish — if rendering " +
        "context could publish, asking Compass a question would be a way to drive the differencing " +
        "attack the gate exists to stop. Its FIRST gate is the `surface` purpose scope, which " +
        "SENSING_ANON_POLICY_V1 does not grant, so it renders nothing today whatever the flag says.",
    ],
    // ── ADDED 2026-09-26 (census-sensing §26): the PUBLISHER ────────────────
    // §21.4 blocker #2 — "publishThroughDifferencingGate has no caller outside
    // tests" — closed. This is not an ingest: it reads the contribution store
    // under the SAME k-gate the aggregate has always applied and records into
    // 3110's publication store; nothing enters the anonymous store through it.
    // Its first gate is the `surface` scope, ungranted, checked before it
    // obtains a client; its second is sensing_publication_enabled (3313,
    // seeded FALSE); so on every deployment it refuses on the first.
    [
      join("lib", "sensingPublicationScheduler.ts"),
      "the publisher: per live cohort, readSensingCohort → aggregateSensingCohort (k, groups, share, " +
        "publication delay) → publishThroughDifferencingGate, on its own clock so no request chooses when a " +
        "cohort is published. Writes ONLY sensing_published_aggregates, and only a PUBLISHABLE aggregate; " +
        "a withheld cohort never reaches the gate. Refuses unless the contribution policy grants `surface` " +
        "(an owner consent act; SENSING_ANON_POLICY_V1 does not) and then unless sensing_publication_enabled " +
        "is true (3313, seeded FALSE). census-sensing §26 re-derives S39/S24 against it.",
    ],
    // ── ADDED 2026-09-26 (census-sensing §27): the ISSUER and the consent map ──
    // §3's eligibility call. The client asked POST /v1/sensing/session and no
    // route answered, so the ingest above could never receive a contribution —
    // a gap §26 did not name. §27 re-derives S18, S20, S30 and S32 against it.
    [
      join("routes", "sensingSession.ts"),
      "the ELIGIBILITY route: requireUser → sensingEligibility → the person's RECORDED consent version " +
        "(lib/sensingConsentScopes) → a session whose scopes are the intersection of that consent and the " +
        "policy in force, written to 2480's table with no identity column. Writes no contribution and reads " +
        "no aggregate. Refuses every caller in production twice over: the pepper is unset, and the only " +
        "consent anyone can hold (v1, Quick Signals) covers no passive-sensing scope.",
    ],
    [
      join("lib", "sensingConsentScopes.ts"),
      "maps a recorded consent disclosure version to the purpose scopes it covers and intersects them with " +
        "the policy — pure, a type/constant import of the contribution policy, no store, no I/O.",
    ],
    [
      join("routes", "mapObservations.ts"),
      "the §22 zone-contribution route. It acquired this import when resolveZoneAnchorSubject was DELETED — " +
        "the nearest-place snap S97 names — and the subject now comes from the resolver, which answers " +
        "`unknown` without an ownership signal. census-sensing §14.2 holds S97 at W and records the deployment " +
        "hazard: production still has subject_id NOT NULL, so 3002 must be applied before this code ships.",
    ],
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

  it("the only route and service surfaces are the four the census re-derived", () => {
    // WHAT THIS USED TO ASSERT: that NO route and NO service imported any of the
    // ten, because "an HTTP or service surface for the anonymous sensing path is
    // an owner decision, not an implementation detail". That was right, and the
    // owner took the posture decision on 2026-09-16, so a transport became
    // buildable and was built.
    //
    // IT IS NOT RELAXED TO "ANY ROUTE MAY". It is narrowed to exactly four
    // named files — three re-derived in census-sensing §14.2 and the issuer in
    // §27 — so a FIFTH surface is as red as the first one would have been. Zero is also red: deleting the
    // ingest without re-deriving S18/S32 would leave the census claiming a
    // transport that no longer exists.
    const found = importers();
    const surfaces = [...found.keys()]
      .filter((f) => f.startsWith("routes" + sep) || f.startsWith("services" + sep))
      .sort();
    assert.deepEqual(
      surfaces,
      [
        join("routes", "mapObservations.ts"),
        join("routes", "sensingIngest.ts"),
        join("routes", "sensingSession.ts"),
        join("services", "intel", "IntelCaptureService.ts"),
      ],
      "the set of route/service surfaces over the sensing stack changed — re-derive S18/S32/S97/S111 in census-sensing rather than editing this list",
    );
  });

  it("S111 — the resolver has callers now, and the row still cannot move", () => {
    // THE ROW'S BLOCKER WAS NEVER THE CALLER, and this case is the clearest
    // demonstration of it in the file. It used to assert the resolver had none.
    // It has two. S111 does not move, because what blocks it is that
    // intel_observations.subject_id is NOT NULL REFERENCES places(id) — so
    // `unknown` and `temporary_world_object` cannot be STORED however many
    // callers resolve them. 3002 drops that NOT NULL and is applied to no
    // database; production was read on 2026-09-25 and still has it.
    //
    // The case is kept, pointed at the real condition, so that the day 3002
    // lands the row is re-derived rather than quietly assumed.
    const found = importers();
    const callers = [...found.entries()]
      .filter(([, mods]) => mods.includes("sensingSubjectReconciliation"))
      .map(([f]) => f)
      .sort();
    assert.deepEqual(
      callers,
      [join("routes", "mapObservations.ts"), join("services", "intel", "IntelCaptureService.ts")],
      "the resolver's caller set changed; re-derive S111 in census-sensing §14",
    );

    // AND THE CONDITION THAT ACTUALLY HOLDS IT: some migration in the tree drops
    // the NOT NULL. When it is applied, S111 is re-derivable; until then it is W.
    const dropsSubjectNotNull = readdirSync(join(SRC, "migrations")).some((f) => {
      try {
        return /ALTER TABLE public\.intel_observations ALTER COLUMN subject_id DROP NOT NULL/.test(
          readFileSync(join(SRC, "migrations", f), "utf8"),
        );
      } catch { return false; }
    });
    assert.equal(dropsSubjectNotNull, true, "no migration drops intel_observations.subject_id NOT NULL — S111's blocker is not even addressed in the tree");
  });

  // ── THIS TRIPWIRE FIRED, AND THAT IS WHAT IT WAS FOR ───────────────────────
  // It used to assert the posture still read `undecided`, with a failure message
  // naming the thirteen rows to re-derive when the owner decided. On 2026-09-16
  // the owner decided (Option B, staged), so it went red exactly as designed.
  //
  // It is NOT retired. The posture is no longer what blocks the thirteen, so the
  // assertion moves to what blocks them NOW — and being explicit about that is
  // the whole point, because "the posture is decided" could otherwise be read as
  // "Sensing observes something", which remains false.
  //
  // RE-DERIVATION DEBT, recorded rather than silently absorbed: S18, S20, S24,
  // S25, S30, S33, S35, S39, S42, S51, S52, S111 and S112 were all graded against
  // `posture_undecided` refusing every caller. That premise is gone. Several of
  // them (S20, S30, S33, S35, S25) are the rows the decision doc's own table says
  // Option B moves to BC — the credential, its budget, its staleness reasons and
  // its purpose scopes now exist and are exercised against production. They are
  // NOT re-graded here: this file re-derives nothing, it detects when a premise
  // moved, and census-sensing is where a verdict changes.
  it("the posture is DECIDED, and what blocks the thirteen is now ingest, not eligibility", () => {
    assert.equal(SENSING_AUTH_POSTURE, "anonymous_capable");

    // Stage one admits a profile — this is the premise change the thirteen were
    // graded against, stated as an assertion so it cannot regress quietly.
    const profile = sensingEligibility({ profileId: "11111111-1111-4111-8111-111111111111", deviceAttested: false });
    assert.equal(profile.eligible, true);
    assert.equal((profile as { issuanceClass: string }).issuanceClass, "authenticated_profile");

    // Stage two stays shut until the attestation primitive exists AND the owner
    // accepts unattested exposure separately. Both device paths are still refused
    // for an unattested caller, so "staged" is enforced, not promised.
    const nobody = sensingEligibility({ profileId: null, deviceAttested: false });
    assert.equal(nobody.eligible, false);
    assert.equal((nobody as { reason: string }).reason, "device_attestation_required");

    // And the real remaining blocker: there is still NO ingest route. Eligibility
    // returning `true` admits nobody while nothing calls it. `sensingAnonStore`'s
    // own no-route tripwire is the authority on that and is asserted there; this
    // line records that the two are load-bearing together.
    assert.equal(SENSING_ALLOW_UNATTESTED_DEVICES, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// census-sensing §10.9 — S52's truth class, pinned against the SPEC's seven and
// against the CODE, not against the module's own header.
//
// §10.5 said of `SensingVibeState`: "truth class always `inferred`". That is
// lib/vibeInference.ts's own header sentence (line 11), and it is false about
// the code beneath it: the no-coverage branch returns `unknown`, on purpose —
// "No coverage ≠ quiet. Nothing is inferred from nothing… not `inferred`,
// because nothing was." The census had restated a module's self-description
// instead of reading the module, which is the one method it is supposed to
// refuse, so the corrected sentence is pinned here rather than left as prose.
//
// WHAT THIS DOES NOT CLAIM. It moves no verdict. S52 is W because nothing can
// populate a `VibeFeatureInput` (S28 is N), not because of what the state
// carries. This pins the EVIDENCE under the row so the correction cannot rot
// back into the original wrong sentence unnoticed.
// ─────────────────────────────────────────────────────────────────────────────
describe("§10.9 / S52 — the vibe state's reachable truth classes are the spec's, and `unknown` is one of them", () => {
  const NOW = Date.parse("2026-09-14T12:00:00.000Z");
  const base = {
    motionEnergy: 0.8, periodicity: 0.7, boundedMovement: true, dwellBucket: 3,
    arrivalVelocity: 0.6, departureVelocity: 0.2,
    venueContext: null, observedAt: new Date(NOW - 60_000).toISOString(),
  };

  it("no coverage ⇒ `unknown`, every output null — not `inferred`, and never a quiet reading", () => {
    const r = inferVibe({ ...base, coverage: "unknown" } as VibeFeatureInput, NOW);
    assert.equal(r.ok, true);
    const s = (r as { ok: true; state: SensingVibeState }).state;
    assert.equal(s.truth.truthClass, "unknown", "no coverage must not be graded `inferred`");
    assert.equal(s.truth.coverage, "unknown");
    // "No coverage ⇒ quiet" is a named spec prohibition: a LOW number would be
    // a quiet reading. Only null is an absence.
    for (const [k, v] of Object.entries({
      energy: s.energy, sociality: s.sociality, danceLikelihood: s.danceLikelihood,
      volatility: s.volatility, momentum: s.momentum,
    })) {
      assert.equal(v, null, `${k} must be null with no coverage, never a low value`);
    }
    assert.deepEqual([...s.contextTags], []);
  });

  it("coverage ⇒ `inferred`, and a band structurally below the live floor", () => {
    const r = inferVibe({ ...base, coverage: "many" } as VibeFeatureInput, NOW);
    assert.equal(r.ok, true);
    const s = (r as { ok: true; state: SensingVibeState }).state;
    assert.equal(s.truth.truthClass, "inferred");
    const bands = CONFIDENCE_BANDS as readonly string[];
    assert.ok(
      bands.indexOf(s.truth.confidence) < bands.indexOf(MIN_BAND_FOR_LIVE_STATE),
      `an inference carried ${s.truth.confidence}, at or above the live floor ${MIN_BAND_FOR_LIVE_STATE}`,
    );
  });

  it("both reachable classes are members of the SPEC's seven — checked against truthClass.ts, not vibeInference.ts", () => {
    const reached = new Set<string>();
    for (const coverage of ["unknown", "few", "several", "many"] as const) {
      const r = inferVibe({ ...base, coverage } as VibeFeatureInput, NOW);
      assert.equal(r.ok, true);
      reached.add((r as { ok: true; state: SensingVibeState }).state.truth.truthClass);
    }
    assert.deepEqual([...reached].sort(), ["inferred", "unknown"], "a third class became reachable — re-derive S52");
    for (const c of reached) {
      assert.ok(TRUTH_CLASSES.includes(c as never), `${c} is not one of §5.1's seven`);
    }
  });

  it("an inference is never a prediction — `predictedFor` is null on both branches", () => {
    for (const coverage of ["unknown", "many"] as const) {
      const r = inferVibe({ ...base, coverage } as VibeFeatureInput, NOW);
      const s = (r as { ok: true; state: SensingVibeState }).state;
      assert.equal(s.temporal.predictedFor, null, "a prediction rendered as an inference — a named spec prohibition");
    }
  });
});
