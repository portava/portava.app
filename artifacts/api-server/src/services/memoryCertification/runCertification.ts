/**
 * The certification run: fixtures, invariants and chaos scenarios, once, into
 * one structured report.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 (:641) — "Memory behavior must be replayable from structured
 *       evidence, commands, and engine versions."
 *
 * CENSUS: H224-H253 (docs/architecture/census-highlights-memories.md §B).
 *
 * THE REPORT IS THE ARTIFACT. Two runs at the same commit produce the same
 * report, so `git diff` over two runs is a behavioural diff of the memory
 * engines — which is what §25 asks for and what a suite of assertions scattered
 * across test files cannot give. `src/scripts/checkMemoryCertification.ts`
 * prints it; `src/test/memoryCertification*.test.ts` assert on it.
 *
 * THE ENGINE VERSIONS TRAVEL WITH THE REPORT. §25 names them as part of what
 * makes a replay meaningful: a fixture that produced two episodes under
 * detector v1 and three under v2 is a changed engine, not a changed fixture,
 * and the report has to be able to say which.
 */

import {
  ELIGIBILITY_POLICY_VERSION,
  EVIDENCE_NORMALIZER_VERSION,
  evaluateEligibility,
  normalizeEvidence,
  type NormalizedEvidence,
} from "../memoryProjections/evidence.js";
import {
  EPISODE_DETECTOR_VERSION,
  detectEpisodes,
  featureFromEvidence,
} from "../memoryProjections/episodeDetection.js";
import { SIGNIFICANCE_POLICY_VERSION } from "../memoryProjections/significance.js";
import { COMPRESSION_ENGINE_VERSION } from "../memoryProjections/memoryGraph.js";
import { RETRIEVAL_ENGINE_VERSION } from "../memoryRetrieval/searchMemories.js";
import { rebuildProjection } from "../memoryProjections/derivativeRegistry.js";
import {
  CERTIFICATION_FIXTURE_IDS,
  FIXTURE_EXPECTATIONS,
  getFixture,
  type CertificationFixtureId,
} from "./fixtures.js";
import { certificationClient, tablesFor } from "./world.js";
import {
  runAllInvariants,
  type InvariantOutcome,
} from "./invariants.js";
import {
  runAllChaosScenarios,
  type ChaosOutcome,
} from "./chaos.js";

export const CERTIFICATION_SUITE_VERSION = "memory-certification@1";

export type FixtureStatus = "CERTIFIED" | "DIVERGED";

export interface FixtureOutcome {
  readonly id: CertificationFixtureId;
  readonly census_id: string;
  readonly spec_line: number;
  readonly spec_text: string;
  readonly status: FixtureStatus;
  /** Everything the engines produced, so the report is a replay and not a tick. */
  readonly observed: {
    readonly normalized: number;
    readonly normalization_rejections: readonly string[];
    readonly eligible: boolean | null;
    readonly eligibility_reason: string | null;
    readonly episodes: number;
    readonly public_projection_memory_ids: readonly string[];
    readonly paired_control_eligible: boolean | null;
  };
  /** Empty when CERTIFIED. One entry per expectation that did not hold. */
  readonly divergences: readonly string[];
}

export interface CertificationReport {
  readonly suite_version: string;
  readonly engine_versions: Readonly<Record<string, string>>;
  readonly fixtures: readonly FixtureOutcome[];
  readonly invariants: readonly InvariantOutcome[];
  readonly chaos: readonly ChaosOutcome[];
  readonly totals: {
    readonly fixtures_certified: number;
    readonly fixtures_diverged: number;
    readonly invariants_held: number;
    readonly invariants_violated: number;
    readonly invariants_no_surface: number;
    readonly chaos_tolerated: number;
    readonly chaos_broken: number;
    readonly chaos_partial: number;
    readonly chaos_no_surface: number;
  };
  /**
   * True only when nothing DIVERGED, nothing was VIOLATED and nothing was
   * BROKEN. NO_SURFACE and PARTIAL deliberately do NOT fail the run: they are
   * findings about what is missing, and turning them into failures would make
   * the only way to a green run "delete the scenario".
   */
  readonly passed: boolean;
}

async function runFixture(id: CertificationFixtureId): Promise<FixtureOutcome> {
  const fixture = getFixture(id);
  const expectation = FIXTURE_EXPECTATIONS[id];
  const now = new Date(fixture.world.now);
  const divergences: string[] = [];

  // 1. Normalize every signal. A fixture whose signals do not normalize is a
  //    broken fixture, and saying so is more useful than silently testing three
  //    records where twelve were written.
  const normalized: NormalizedEvidence[] = [];
  const rejections: string[] = [];
  for (const raw of fixture.world.signals) {
    const r = normalizeEvidence(raw, now);
    if (r.ok) normalized.push(r.evidence);
    else rejections.push(`${String(raw.source_id)}: ${r.reason}`);
  }
  if (rejections.length > 0) {
    divergences.push(`signals failed to normalize: ${rejections.join("; ")}`);
  }

  // 2. §6 eligibility over the whole fixture.
  let eligible: boolean | null = null;
  let reason: string | null = null;
  if (expectation.eligibility === null) {
    if (fixture.world.signals.length !== 0) {
      divergences.push("expectation says this fixture carries no evidence, but it has signals");
    }
  } else {
    const verdict = evaluateEligibility(normalized, { mode: "AUTOMATIC" });
    eligible = verdict.eligible;
    reason = verdict.reason;
    if (verdict.eligible !== expectation.eligibility.eligible) {
      divergences.push(
        `eligibility ${verdict.eligible ? "passed" : `refused (${verdict.reason})`} but the spec-derived expectation was ` +
          `${expectation.eligibility.eligible ? "pass" : `refuse (${expectation.eligibility.reason})`}`,
      );
    } else if (verdict.reason !== expectation.eligibility.reason) {
      divergences.push(`eligibility reason ${String(verdict.reason)} but expected ${String(expectation.eligibility.reason)}`);
    }
  }

  // 3. The paired control, where the fixture has one. This is what keeps a
  //    refusal fixture from being satisfied by a gate that refuses everything.
  let controlEligible: boolean | null = null;
  if (expectation.paired_control) {
    const controlEvidence: NormalizedEvidence[] = [];
    for (const raw of expectation.paired_control.signals) {
      const r = normalizeEvidence(raw, now);
      if (r.ok) controlEvidence.push(r.evidence);
      else divergences.push(`paired control signal ${String(raw.source_id)} failed to normalize: ${r.reason}`);
    }
    const control = evaluateEligibility(controlEvidence, { mode: "AUTOMATIC" });
    controlEligible = control.eligible;
    if (control.eligible !== expectation.paired_control.expect_eligible) {
      divergences.push(
        `paired control (${expectation.paired_control.description}) was ` +
          `${control.eligible ? "eligible" : `refused (${control.reason})`}, expected ` +
          `${expectation.paired_control.expect_eligible ? "eligible" : "refused"} — the fixture's own verdict is therefore not attributable to the rule under test`,
      );
    }
  }

  // 4. §7 episode detection.
  const detected = detectEpisodes(normalized.map(featureFromEvidence));
  if (detected.episodes.length !== expectation.episodes) {
    divergences.push(`§7 found ${detected.episodes.length} episode(s), expected ${expectation.episodes}`);
  }
  if (detected.detector_version !== EPISODE_DETECTOR_VERSION) {
    divergences.push(`detector reported version ${detected.detector_version}`);
  }

  // 5. §18 PublicMemoryProjection — the derivative every privacy claim rests on.
  const client = certificationClient(tablesFor(fixture.world));
  const built = await rebuildProjection(
    client,
    "PublicMemoryProjection",
    { owner_id: fixture.world.owner_id, viewer_id: null },
    now,
  );
  let publicIds: string[] = [];
  if (!built.ok) {
    divergences.push(`PublicMemoryProjection would not build: ${built.detail}`);
  } else {
    publicIds = built.value.rows.map((r) => String(r.memory_id)).sort();
    const expected = [...expectation.public_projection_memory_ids].sort();
    if (JSON.stringify(publicIds) !== JSON.stringify(expected)) {
      divergences.push(
        `PublicMemoryProjection carried [${publicIds.join(", ")}], expected [${expected.join(", ")}]`,
      );
    }
  }

  return {
    id: fixture.id,
    census_id: fixture.census_id,
    spec_line: fixture.spec_line,
    spec_text: fixture.spec_text,
    status: divergences.length === 0 ? "CERTIFIED" : "DIVERGED",
    observed: {
      normalized: normalized.length,
      normalization_rejections: rejections,
      eligible,
      eligibility_reason: reason,
      episodes: detected.episodes.length,
      public_projection_memory_ids: publicIds,
      paired_control_eligible: controlEligible,
    },
    divergences,
  };
}

export async function runCertification(): Promise<CertificationReport> {
  const fixtures: FixtureOutcome[] = [];
  for (const id of CERTIFICATION_FIXTURE_IDS) fixtures.push(await runFixture(id));
  const invariants = await runAllInvariants();
  const chaos = await runAllChaosScenarios();

  const totals = {
    fixtures_certified: fixtures.filter((f) => f.status === "CERTIFIED").length,
    fixtures_diverged: fixtures.filter((f) => f.status === "DIVERGED").length,
    invariants_held: invariants.filter((i) => i.status === "HELD").length,
    invariants_violated: invariants.filter((i) => i.status === "VIOLATED").length,
    invariants_no_surface: invariants.filter((i) => i.status === "NO_SURFACE").length,
    chaos_tolerated: chaos.filter((c) => c.status === "TOLERATED").length,
    chaos_broken: chaos.filter((c) => c.status === "BROKEN").length,
    chaos_partial: chaos.filter((c) => c.status === "PARTIAL").length,
    chaos_no_surface: chaos.filter((c) => c.status === "NO_SURFACE").length,
  };

  return {
    suite_version: CERTIFICATION_SUITE_VERSION,
    engine_versions: Object.freeze({
      normalizer: EVIDENCE_NORMALIZER_VERSION,
      eligibility: ELIGIBILITY_POLICY_VERSION,
      episode_detector: EPISODE_DETECTOR_VERSION,
      significance: SIGNIFICANCE_POLICY_VERSION,
      compression: COMPRESSION_ENGINE_VERSION,
      retrieval: RETRIEVAL_ENGINE_VERSION,
    }),
    fixtures,
    invariants,
    chaos,
    totals,
    passed:
      totals.fixtures_diverged === 0 &&
      totals.invariants_violated === 0 &&
      totals.chaos_broken === 0,
  };
}

/** A stable, diffable rendering. No timestamps, no durations, no host details. */
export function formatCertificationReport(report: CertificationReport): string {
  const out: string[] = [];
  out.push(`memory certification — ${report.suite_version}`);
  out.push("");
  out.push("engine versions");
  for (const [k, v] of Object.entries(report.engine_versions)) out.push(`  ${k.padEnd(18)} ${v}`);
  out.push("");
  out.push("§25 canonical certification fixtures");
  for (const f of report.fixtures) {
    out.push(`  ${f.census_id.padEnd(5)} ${f.status.padEnd(9)} ${f.id}`);
    out.push(
      `        evidence ${f.observed.normalized}` +
        `  eligible ${String(f.observed.eligible)}${f.observed.eligibility_reason ? ` (${f.observed.eligibility_reason})` : ""}` +
        `  episodes ${f.observed.episodes}` +
        `  public rows ${f.observed.public_projection_memory_ids.length}` +
        (f.observed.paired_control_eligible === null ? "" : `  control eligible ${String(f.observed.paired_control_eligible)}`),
    );
    for (const d of f.divergences) out.push(`        DIVERGED: ${d}`);
  }
  out.push("");
  out.push("§25 hard invariant tests");
  for (const i of report.invariants) {
    out.push(`  ${i.census_id.padEnd(5)} ${i.status.padEnd(10)} ${i.id}`);
    out.push(`        surface: ${i.surface}${i.reachable_from_a_route ? " [reachable from a route]" : " [NOT reachable from any route]"}`);
    out.push(`        ${i.detail}`);
  }
  out.push("");
  out.push("§25 property / chaos scenarios");
  for (const c of report.chaos) {
    out.push(`  ${c.census_id.padEnd(5)} ${c.status.padEnd(10)} ${c.id}`);
    out.push(`        ${c.detail}`);
  }
  out.push("");
  out.push(
    `TOTALS  fixtures ${report.totals.fixtures_certified} certified / ${report.totals.fixtures_diverged} diverged` +
      `  ·  invariants ${report.totals.invariants_held} held / ${report.totals.invariants_violated} violated / ${report.totals.invariants_no_surface} no-surface` +
      `  ·  chaos ${report.totals.chaos_tolerated} tolerated / ${report.totals.chaos_broken} broken / ${report.totals.chaos_partial} partial / ${report.totals.chaos_no_surface} no-surface`,
  );
  out.push(
    "NO_SURFACE and PARTIAL are findings, not passes: they mean this repository has nothing for that half of the requirement to be true of.",
  );
  return out.join("\n");
}
