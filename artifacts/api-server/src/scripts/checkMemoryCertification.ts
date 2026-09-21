/**
 * checkMemoryCertification — run §25's certification suite and print the report.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 "Replay, Testing, and Certification" (:641).
 * CENSUS: docs/architecture/census-highlights-memories.md §B — H224-H253.
 *
 * WHY A SCRIPT AND NOT ONLY TESTS
 * ===============================
 * A certification suite that only runs inside `node --test` produces a tick and
 * a duration. §25 asks for something a person can read: which fixture produced
 * which verdict, under which engine versions, and — the part that matters most
 * here — which invariants have NO SURFACE in this repository to be true of.
 * That last number is the honest measure of how much of §25 is real, and it is
 * printed on every run rather than buried in a passing suite.
 *
 * EXIT CODES
 *   0  every fixture certified, no invariant violated, no scenario broken.
 *      NO_SURFACE and PARTIAL do NOT fail: they are findings about missing
 *      product, and failing on them would make "delete the scenario" the
 *      cheapest way to a green build.
 *   1  a fixture diverged from its spec-derived expectation, an invariant was
 *      violated, or a scenario broke.
 *   2  the checker could not run honestly — it produced no fixtures, no
 *      invariants or no scenarios. A checker that exits 0 having measured
 *      nothing is the failure mode this repository keeps finding in its guards,
 *      so it is asserted against rather than trusted.
 *
 * Reads nothing, writes nothing, touches no database. Deterministic: two runs
 * at one commit print byte-identical output.
 *
 * Run: node --import tsx/esm src/scripts/checkMemoryCertification.ts
 */
import { CERTIFICATION_FIXTURE_IDS } from "../services/memoryCertification/fixtures.js";
import { INVARIANT_IDS } from "../services/memoryCertification/invariants.js";
import { CHAOS_SCENARIO_IDS } from "../services/memoryCertification/chaos.js";
import {
  formatCertificationReport,
  runCertification,
} from "../services/memoryCertification/runCertification.js";

async function main(): Promise<void> {
  const report = await runCertification();
  console.log(formatCertificationReport(report));
  console.log("");

  // Vacuity: the suite must have measured everything §25 names.
  const missing: string[] = [];
  if (report.fixtures.length !== CERTIFICATION_FIXTURE_IDS.length) {
    missing.push(`${report.fixtures.length} fixture outcomes for ${CERTIFICATION_FIXTURE_IDS.length} fixtures`);
  }
  if (report.invariants.length !== INVARIANT_IDS.length) {
    missing.push(`${report.invariants.length} invariant outcomes for ${INVARIANT_IDS.length} invariants`);
  }
  if (report.chaos.length !== CHAOS_SCENARIO_IDS.length) {
    missing.push(`${report.chaos.length} chaos outcomes for ${CHAOS_SCENARIO_IDS.length} scenarios`);
  }
  if (missing.length > 0) {
    console.error(`::error::check:memory-certification measured less than §25 names — ${missing.join("; ")}`);
    process.exit(2);
  }

  const failures = [
    ...report.fixtures.filter((f) => f.status === "DIVERGED").map((f) => `${f.census_id} ${f.id}: ${f.divergences.join(" | ")}`),
    ...report.invariants.filter((i) => i.status === "VIOLATED").map((i) => `${i.census_id} ${i.id}: ${i.detail}`),
    ...report.chaos.filter((c) => c.status === "BROKEN").map((c) => `${c.census_id} ${c.id}: ${c.detail}`),
  ];
  if (failures.length > 0) {
    for (const f of failures) console.error(`::error::${f}`);
    console.error(`check:memory-certification FAILED — ${failures.length} finding(s)`);
    process.exit(1);
  }

  const unbuilt = [
    ...report.invariants.filter((i) => i.status === "NO_SURFACE").map((i) => i.census_id),
    ...report.chaos.filter((c) => c.status === "NO_SURFACE" || c.status === "PARTIAL").map((c) => c.census_id),
  ];
  if (unbuilt.length > 0) {
    console.log(
      `NOTE: ${unbuilt.length} requirement(s) have no surface, or only half a surface, in this repository: ${unbuilt.join(", ")}. ` +
        "That is reported, not failed — see the per-entry detail above for what is missing.",
    );
  }
  console.log("check:memory-certification PASSED");
}

main().catch((err) => {
  console.error(`::error::check:memory-certification could not run: ${String((err as Error)?.stack ?? err)}`);
  process.exit(2);
});
