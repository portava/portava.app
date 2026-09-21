/**
 * §25 canonical certification fixtures — the twelve, and the report they make.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 (:641), "Canonical certification fixtures" (:643-655).
 * CENSUS: H224-H235, all NOT-BUILT before this suite
 *         (docs/architecture/census-highlights-memories.md §B).
 *
 * WHAT THIS SUITE IS DEFENDING AGAINST
 * ====================================
 *  * A fixture list that drifts from the spec. §25's twelve sentences are read
 *    OUT OF THE SPEC FILE at test time and compared against the fixtures'
 *    `spec_text`, so renaming, dropping or inventing a fixture fails here
 *    rather than being noticed by a reader who happens to have both open.
 *  * A fixture that is data nobody runs. Every fixture must be exercised by the
 *    runner and must produce a verdict.
 *  * Expectations fitted to output. Each fixture's numbers were derived from
 *    §6's gate order and §7's thresholds before the runner was executed; the
 *    refusal fixtures each carry a PAIRED CONTROL that must flip, so a gate
 *    that refuses everything fails the pairs.
 *  * A report that is not replayable. Two runs must be byte-identical; §25's
 *    whole premise is that behaviour can be replayed and diffed.
 *
 * ── RED-FIRST: MUTATIONS OF PRODUCTION CODE, MEASURED ────────────────────────
 * Each was applied to the production file, the suite was run, and the mutation
 * was reverted. None of them is a change to a test or to a constant an
 * assertion reads back.
 *
 *  1. src/services/memoryProjections/projectionRegistry.ts, PublicMemoryProjection
 *     `build`: dropped `&& m.visibility === "public"` from the filter.
 *     MEASURED: 4 fixtures DIVERGED — H224 and H225 leaked an only_me row into
 *     the public derivative, H232 leaked the imported private one and H233 the
 *     voice-note one — invariant H236 went VIOLATED, and
 *     check:memory-certification exited 1 with 5 findings. This suite failed on
 *     "certifies all twelve". Reverted; green.
 *  2. src/services/memoryProjections/evidence.ts, the MEDIA_NOT_CAPTURED check:
 *     removed `prov === "screenshot"` from the not-captured set.
 *     MEASURED: H235 SCREENSHOT_NOT_EXPERIENCED DIVERGED — "eligibility passed
 *     but the spec-derived expectation was refuse (MEDIA_NOT_CAPTURED)" — and
 *     H235's paired control stopped controlling for anything, which this
 *     suite's "flips every paired control" test also caught. Reverted; green.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCertificationFixtures.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CERTIFICATION_FIXTURE_IDS,
  FIXTURE_EXPECTATIONS,
  listFixtures,
} from "../services/memoryCertification/fixtures.js";
import {
  formatCertificationReport,
  runCertification,
  type CertificationReport,
} from "../services/memoryCertification/runCertification.js";

const SPEC_PATH = new URL(
  "../../../../docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt",
  import.meta.url,
).pathname;

/** §25's fixture list, read out of the spec rather than restated here. */
function specFixtureSentences(): string[] {
  const lines = readFileSync(SPEC_PATH, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === "Canonical certification fixtures");
  const end = lines.findIndex((l) => l.trim() === "Hard invariant tests");
  assert.ok(start > 0 && end > start, "could not locate §25's fixture list in the spec");
  return lines.slice(start + 1, end).map((l) => l.trim()).filter((l) => l.length > 0);
}

let report: CertificationReport;

before(async () => {
  report = await runCertification();
});

describe("§25: the fixture list is the spec's list", () => {
  it("has exactly twelve fixtures, in the spec's order, with the spec's own words", () => {
    const sentences = specFixtureSentences();
    assert.equal(sentences.length, 12, `the spec lists ${sentences.length} fixtures`);
    const fixtures = listFixtures();
    assert.equal(fixtures.length, 12);
    assert.deepEqual(
      fixtures.map((f) => f.spec_text),
      sentences,
      "a fixture's spec_text drifted from §25",
    );
  });

  it("numbers every fixture with a distinct census id and a real spec line", () => {
    const fixtures = listFixtures();
    const ids = fixtures.map((f) => f.census_id);
    assert.equal(new Set(ids).size, 12, "two fixtures claim the same census id");
    assert.deepEqual(ids, [
      "H224", "H225", "H226", "H227", "H228", "H229",
      "H230", "H231", "H232", "H233", "H234", "H235",
    ]);
    const specLines = readFileSync(SPEC_PATH, "utf8").split("\n");
    for (const f of fixtures) {
      assert.equal(
        specLines[f.spec_line - 1]?.trim(),
        f.spec_text,
        `${f.id} cites spec line ${f.spec_line}, which says something else`,
      );
    }
  });

  it("gives every fixture an expectation", () => {
    for (const id of CERTIFICATION_FIXTURE_IDS) {
      assert.ok(FIXTURE_EXPECTATIONS[id], `${id} has no expectation, so it asserts nothing`);
      assert.ok(FIXTURE_EXPECTATIONS[id].rationale.length > 40, `${id}'s expectation has no argument behind it`);
    }
  });
});

describe("§25: every fixture is exercised and certifies", () => {
  it("produces one outcome per fixture", () => {
    assert.equal(report.fixtures.length, 12);
    assert.deepEqual(report.fixtures.map((f) => f.id), [...CERTIFICATION_FIXTURE_IDS]);
  });

  it("certifies all twelve against expectations derived from the spec", () => {
    const diverged = report.fixtures.filter((f) => f.status === "DIVERGED");
    assert.deepEqual(
      diverged.map((f) => `${f.id}: ${f.divergences.join(" | ")}`),
      [],
      "a fixture no longer behaves the way §6/§7/§18 say it must",
    );
    assert.equal(report.totals.fixtures_certified, 12);
  });

  it("actually ran the engines: no fixture is an empty pass", () => {
    for (const f of report.fixtures) {
      const expectation = FIXTURE_EXPECTATIONS[f.id];
      if (expectation.eligibility === null) {
        // A derivative fixture must still have produced a projection verdict.
        assert.equal(f.observed.normalized, 0, `${f.id} claims no evidence but normalized some`);
        assert.ok(
          f.observed.public_projection_memory_ids.length > 0,
          `${f.id} certifies a derivative and produced no derivative rows`,
        );
      } else {
        assert.ok(f.observed.normalized > 0, `${f.id} normalized no evidence, so the gate was asked nothing`);
        assert.equal(f.observed.eligible, expectation.eligibility.eligible);
      }
      assert.deepEqual(f.observed.normalization_rejections, [], `${f.id} had signals that would not normalize`);
    }
  });

  it("flips every paired control, so no refusal is a blanket deny", () => {
    const withControls = report.fixtures.filter((f) => FIXTURE_EXPECTATIONS[f.id].paired_control);
    assert.ok(withControls.length >= 4, `only ${withControls.length} fixtures carry a paired control`);
    for (const f of withControls) {
      const control = FIXTURE_EXPECTATIONS[f.id].paired_control!;
      assert.equal(
        f.observed.paired_control_eligible,
        control.expect_eligible,
        `${f.id}'s control (${control.description}) did not flip`,
      );
      assert.notEqual(
        f.observed.paired_control_eligible,
        f.observed.eligible,
        `${f.id}'s control produced the same verdict as the fixture, so it controls for nothing`,
      );
    }
  });
});

describe("§25: the run is replayable", () => {
  it("produces a byte-identical report twice", async () => {
    const again = await runCertification();
    assert.equal(
      formatCertificationReport(again),
      formatCertificationReport(report),
      "two runs at one commit differed — §25's replayability does not hold",
    );
  });

  it("carries the engine versions a replay would be compared against", () => {
    assert.deepEqual(Object.keys(report.engine_versions).sort(), [
      "compression", "eligibility", "episode_detector", "normalizer", "retrieval", "significance",
    ]);
    for (const [engine, version] of Object.entries(report.engine_versions)) {
      assert.match(version, /@\d+$/, `${engine} has no version suffix, so a replay cannot be attributed`);
    }
  });

  it("renders without a clock, a duration or a host in the output", () => {
    const text = formatCertificationReport(report);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "the report embeds a wall-clock instant");
    assert.doesNotMatch(text, /\bms\b|\bduration\b/i, "the report embeds a timing, which cannot be diffed");
  });
});
