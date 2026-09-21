/**
 * §25 property / chaos scenarios — the nine, plus the defect they found.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §25 "Property / chaos testing" (:666-675).
 * CENSUS: H245-H253 (docs/architecture/census-highlights-memories.md §B).
 *
 * ── A REAL DEFECT THIS SUITE FOUND, AND THE FIX ──────────────────────────────
 *
 * `DUPLICATE_UPLOAD` came up BROKEN the first time it was run, before anything
 * was changed to make it pass:
 *
 *     H245  BROKEN  DUPLICATE_UPLOAD — the survivor depended on delivery order
 *
 * `dedupeEvidence` sorted candidates by (fingerprint, source_id) and kept the
 * first at equal precedence. A re-delivered upload has the SAME source_id and —
 * because `fingerprint` buckets time to the minute on purpose — the SAME
 * fingerprint, differing only in `observed_at`. So the surviving record, and
 * therefore the timestamp §7 draws episode boundaries from, was whichever copy
 * the caller passed first. The existing order-independence test in
 * memoryProjectionEvidence.test.ts could not see it: its two records differ in
 * PRECEDENCE, which is decided before the tie-break ever runs.
 *
 * The fix is in the production module, not here: the pre-sort in
 * `src/services/memoryProjections/evidence.ts` is now a total order over the
 * fields that distinguish two records at equal precedence. The scenario is the
 * regression test, and the direct assertion below is a second, independent one.
 *
 * ── RED-FIRST: MUTATIONS OF PRODUCTION CODE, MEASURED ────────────────────────
 *
 *  1. src/services/memoryProjections/evidence.ts, `dedupeEvidence` pre-sort:
 *     reverted to `(fingerprint, source_id)` — the state of the tree before
 *     this work.
 *     MEASURED: H245 DUPLICATE_UPLOAD -> BROKEN ("the survivor depended on
 *     delivery order"), check:memory-certification exit 1, and this file failed
 *     four subtests including "keeps the SAME record whichever copy arrives
 *     first". Restored; green. This is the ONLY mutation in this batch that was
 *     found rather than staged: the first run was red because the code was
 *     wrong, and the fix came after.
 *  2. src/services/memoryProjections/episodeDetection.ts: made the midnight
 *     crossing act rather than record, by adding
 *     `if (crossesMidnightUtc(prev.at_ms, f.at_ms)) featuresHit.push("TIME_GAP")`
 *     to the boundary loop.
 *     MEASURED: H253 TIMEZONE_AND_DATE_LINE_EDGES -> BROKEN ("midnight forced a
 *     split: 2 episodes from a 30-minute gap"), check:memory-certification
 *     exit 1. Reverted; green.
 *  3. src/services/memoryProjections/derivativeRegistry.ts, `rebuildProjection`:
 *     disabled the REVOKED guard so a rebuild overwrites a revoked registration.
 *     MEASURED: H244 CONSUMERS_TOLERATE_DUPLICATE_AND_OUT_OF_ORDER -> VIOLATED
 *     ("a rebuild arriving after a revocation resurrected the derivative")
 *     while H247 stayed TOLERATED — which is the discrimination the two
 *     scenarios exist to provide. Reverted; green.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCertificationChaos.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAOS_SCENARIO_IDS,
  listChaosScenarios,
  runAllChaosScenarios,
  type ChaosOutcome,
} from "../services/memoryCertification/chaos.js";
import {
  dedupeEvidence,
  normalizeEvidence,
  type RawSignal,
} from "../services/memoryProjections/evidence.js";
import {
  detectEpisodes,
  featureFromEvidence,
} from "../services/memoryProjections/episodeDetection.js";

const SPEC_PATH = new URL(
  "../../../../docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt",
  import.meta.url,
).pathname;

const NOW = new Date("2026-06-01T00:00:00.000Z");

function norm(over: Partial<RawSignal>) {
  const r = normalizeEvidence(
    {
      owner_id: "cert-owner",
      source_type: "CAMERA_CAPTURE",
      source_id: "upload-1",
      assertion_type: "CAPTURED_MEDIA",
      observed_at: "2026-04-02T09:12:00.000Z",
      assertion_json: { place_id: "place-ferry", capture_provenance: "camera" },
      ...over,
    },
    NOW,
  );
  assert.ok(r.ok, `fixture failed to normalize: ${JSON.stringify(r)}`);
  return r.evidence;
}

let outcomes: ChaosOutcome[];
const by = (id: string): ChaosOutcome => {
  const found = outcomes.find((o) => o.id === id);
  assert.ok(found, `no outcome for ${id}`);
  return found;
};

before(async () => {
  outcomes = await runAllChaosScenarios();
});

describe("§25: the scenario list is the spec's list", () => {
  it("has exactly nine scenarios, in the spec's order, with the spec's own words", () => {
    const lines = readFileSync(SPEC_PATH, "utf8").split("\n");
    const start = lines.findIndex((l) => l.trim() === "Property / chaos testing");
    const end = lines.findIndex((l) => /^26\. Delivery Phases/.test(l.trim()));
    assert.ok(start > 0 && end > start);
    const sentences = lines.slice(start + 1, end).map((l) => l.trim()).filter(Boolean);
    assert.equal(sentences.length, 9);
    assert.deepEqual(listChaosScenarios().map((c) => c.spec_text), sentences);
    assert.deepEqual(listChaosScenarios().map((c) => c.census_id), [
      "H245", "H246", "H247", "H248", "H249", "H250", "H251", "H252", "H253",
    ]);
  });
});

describe("§25: every scenario runs and reports the status it earned", () => {
  it("evaluates all nine", () => {
    assert.equal(outcomes.length, 9);
    assert.deepEqual(outcomes.map((o) => o.id), [...CHAOS_SCENARIO_IDS]);
  });

  it("breaks on nothing", () => {
    assert.deepEqual(
      outcomes.filter((o) => o.status === "BROKEN").map((o) => `${o.census_id}: ${o.detail}`),
      [],
    );
  });

  it("tolerates the seven with a whole surface", () => {
    assert.deepEqual(
      outcomes.filter((o) => o.status === "TOLERATED").map((o) => o.census_id),
      ["H245", "H246", "H247", "H248", "H250", "H251", "H253"],
    );
  });

  it("reports the two half-built scenarios as PARTIAL, naming the missing half", () => {
    const partial = outcomes.filter((o) => o.status === "PARTIAL");
    assert.deepEqual(partial.map((o) => o.census_id), ["H249", "H252"]);
    assert.match(by("CONCURRENT_MERGE_AND_EDIT").detail, /MERGE half NO SURFACE/);
    assert.match(by("CONCURRENT_MERGE_AND_EDIT").detail, /no memory_relations table/);
    assert.match(by("ENTITY_MERGE_AFTER_MEMORY_CREATION").detail, /display_name_at_occurrence/);
  });

  it("names the production code each scenario perturbed", () => {
    for (const o of outcomes) {
      assert.ok(o.surface.includes(".ts"), `${o.id} does not name a module`);
      assert.ok(o.detail.length > 60, `${o.id}'s detail is too thin to audit`);
    }
  });
});

describe("§25 H245: a re-delivered upload does not depend on arrival order", () => {
  it("collapses a duplicate to one record", () => {
    const a = norm({});
    const b = norm({ observed_at: "2026-04-02T09:12:20.000Z" });
    assert.equal(a.fingerprint, b.fingerprint, "the fixture is inert: the two deliveries are different claims");
    assert.equal(a.source_id, b.source_id);
    const { kept, dropped } = dedupeEvidence([a, b]);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
  });

  it("keeps the SAME record whichever copy arrives first", () => {
    const a = norm({});
    const b = norm({ observed_at: "2026-04-02T09:12:20.000Z" });
    const forward = dedupeEvidence([a, b]).kept;
    const backward = dedupeEvidence([b, a]).kept;
    assert.deepEqual(
      forward,
      backward,
      "the survivor of a duplicate upload depended on delivery order — §7 draws episode boundaries from its observed_at, so two replays of one history would differ",
    );
    assert.equal(forward[0]!.observed_at, a.observed_at, "the earliest observation of the claim must be the one kept");
  });

  it("still prefers precedence over arrival order and over the earliest timestamp", () => {
    // The fingerprint covers source_type and assertion_type, so two records
    // that genuinely normalize to the same fingerprint cannot differ in
    // precedence. The higher-precedence twin is therefore constructed — the
    // same shape memoryProjectionEvidence.test.ts uses — because the tie-break
    // being tested is reachable only when a caller re-labels a claim.
    const weak = norm({ source_type: "GPS_PROXIMITY", assertion_type: "NEARBY" });
    const strong = {
      ...weak,
      source_type: "USER_CORRECTION" as const,
      truth_level: "USER_ASSERTED" as const,
      is_correction: true,
      confidence: 0.2,
      observed_at: "2026-04-02T09:12:40.000Z",
    };
    assert.equal(weak.fingerprint, strong.fingerprint, "the twins must share a fingerprint or dedupe never compares them");
    assert.ok(strong.confidence < weak.confidence, "the fixture must make precedence, not score, the deciding rule");
    assert.ok(strong.observed_at > weak.observed_at, "the fixture must make precedence, not recency, the deciding rule");
    assert.equal(dedupeEvidence([weak, strong]).kept[0]!.source_type, "USER_CORRECTION");
    assert.equal(dedupeEvidence([strong, weak]).kept[0]!.source_type, "USER_CORRECTION");
  });
});

describe("§25 H253: the calendar does not decide an episode boundary", () => {
  it("groups a 30-minute gap the same way across midnight as at midday", () => {
    const across = detectEpisodes(
      [
        norm({ source_id: "a", observed_at: "2026-04-20T23:45:00.000Z" }),
        norm({ source_id: "b", observed_at: "2026-04-21T00:15:00.000Z" }),
      ].map(featureFromEvidence),
    );
    const within = detectEpisodes(
      [
        norm({ source_id: "c", observed_at: "2026-04-22T11:45:00.000Z" }),
        norm({ source_id: "d", observed_at: "2026-04-22T12:15:00.000Z" }),
      ].map(featureFromEvidence),
    );
    assert.equal(across.episodes.length, 1);
    assert.equal(across.episodes.length, within.episodes.length);
    assert.equal(across.boundaries[0]!.crosses_midnight, true, "the crossing was not even recorded");
    assert.equal(across.boundaries[0]!.split, false, "the crossing was acted on");
    assert.equal(within.boundaries[0]!.crosses_midnight, false);
  });
});
