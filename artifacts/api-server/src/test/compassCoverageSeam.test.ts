/**
 * census-compass CPV2-12 — "use shared city/time confidence WITHOUT
 * duplicating truth".
 *
 * The census finding: Compass derived its OWN city confidence from its OWN
 * edges (the `compass_city_confidence` upsert, scored over
 * `compass_graph_edges`) while the PLATFORM coverage store already existed
 * under another owner — `lib/intelCoverageScheduler.ts`, writing
 * `intel_coverage_snapshots`. "grep ... returns nothing: the only
 * shared-intelligence seam Compass imports at all is lib/liveClaimRead." Two
 * independent answers to the same question is the duplication of truth.
 *
 * The fix CONSUMES the platform store rather than reproducing it:
 *   - `readPlatformCityCoverage` reads `intel_coverage_snapshots` through a
 *     literal `.from("intel_coverage_snapshots").select("<literal columns>")`
 *     chain — unexpired rows for the city only;
 *   - where the platform has coverage for a city it GOVERNS the confidence
 *     Compass serves (`platformCoverageDepthScore` folds coverage_state and
 *     current_confidence into the same 0–100 depth scale);
 *   - where it has no row, or the read fails, Compass falls back to its own
 *     graph-derived score and SAYS SO: every answer names `source`
 *     ("platform_coverage" | "compass_graph") and `sourceReason`, and the
 *     prose line names it too, so nothing claims platform truth it does not
 *     have.
 *
 * Nothing here writes `intel_coverage_snapshots` — the producer stays the
 * scheduler's, untouched and unimported.
 *
 * TEST-FIRST: this file was written before the implementation and run against
 * the unchanged engine. It failed at import — `readPlatformCityCoverage` and
 * `platformCoverageDepthScore` did not exist — which is the right first red:
 * the census finding is precisely that Compass never read the platform store.
 *
 * Mutation log (each applied ALONE, the suite run, the source restored;
 * every line below was actually run, and the suite is 13 tests green):
 *   M1 the platform read deleted from getCityConfidence — compass-local
 *      always governs, which is the census defect itself       8/5 → red
 *   M2 the platform read kept but no longer governing (the
 *      compass-local depthScore returned from the platform
 *      branch)                                                12/1 → red
 *   M3 the unreadable case collapsed into "platform_no_rows", so an
 *      outage reads as "the shared store has nothing here"    12/1 → red
 *   M4 the freshness filter dropped from the read
 *      (`.gt("expires_at", now)`), so pruned-but-present cells
 *      pass as live coverage                                  12/1 → red
 *   M5 the client-side canonical re-verify dropped
 *      (`canonicalCityKey(r.city) !== key`), so a merely
 *      prefix-matching city's cells fold into this city       12/1 → red
 *   M6 coverage_state ignored in platformCoverageDepthScore
 *      (coveredShare hard-wired to 1)                         12/1 → red
 *   M7 cityConfidenceNote stops naming the provenance
 *      (the clause returns "" for every record)               12/1 → red
 *   M8 "no rows" reported as unreadable (`readable: false` when
 *      cells === 0), collapsing absence into failure          11/2 → red
 *
 *   M9 the SERVER-SIDE narrowing dropped (`.ilike("city", "<key>%")`)
 *                                                            13/0 → GREEN
 *      Reported honestly rather than dressed up. It is green because
 *      the narrowing is not independently observable: the canonical
 *      re-verify (M5) is STRICTLY stricter, so removing the `ilike`
 *      cannot admit a row the fold would then miscount — it can only
 *      make the read page more rows before PLATFORM_COVERAGE_READ_LIMIT,
 *      which is a scale property no in-memory fixture can express. The
 *      two halves are tested per class, not per site: M5 pins the half
 *      that decides correctness, and this line records that the other
 *      half is an optimisation. Asserting on the `.ilike` literal here
 *      would pin the query's spelling, not its behaviour.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassCoverageSeam.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDestinationContextLines,
  cityConfidenceNote,
  getCityConfidence,
  platformCoverageDepthScore,
  readPlatformCityCoverage,
  tierForScore,
} from "../compass/CompassGraphEngine.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = new Date("2026-09-20T12:00:00Z");
const FRESH = "2026-09-20T12:30:00Z";
const STALE = "2026-09-20T11:30:00Z";

interface TableSpec { rows?: any[]; error?: { message: string } }

/**
 * Supabase-shaped fake honouring exactly the filters the read uses: eq, gt
 * (ISO string compare), ilike (prefix), limit — plus maybeSingle, and a
 * per-table error injection so "unreadable" is a real state and not an
 * absence.
 */
function fakeDb(tables: Record<string, TableSpec | any[]>): any {
  return {
    from(table: string) {
      const spec = tables[table];
      const s: TableSpec = Array.isArray(spec) ? { rows: spec } : (spec ?? { rows: [] });
      let out = [...(s.rows ?? [])];
      const b: any = {
        select: () => b,
        like: () => b,
        limit: () => b,
        eq: (c: string, v: unknown) => { out = out.filter((r) => r[c] === v); return b; },
        gt: (c: string, v: string) => { out = out.filter((r) => String(r[c] ?? "") > String(v)); return b; },
        ilike: (c: string, pat: string) => {
          const re = new RegExp("^" + pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          out = out.filter((r) => re.test(String(r[c] ?? "")));
          return b;
        },
        maybeSingle: () => Promise.resolve(
          s.error ? { data: null, error: s.error } : { data: out[0] ?? null, error: null },
        ),
        then: (res: (x: unknown) => void) => res(
          s.error ? { data: null, error: s.error } : { data: out, error: null },
        ),
      };
      return b;
    },
  };
}

const cell = (over: Record<string, unknown> = {}) => ({
  city: "Cebu City", zone_id: "z1", claim_family: "crowd.level",
  coverage_state: "covered", current_confidence: 0.9, score: 0.1,
  computed_at: "2026-09-20T11:55:00Z", expires_at: FRESH, ...over,
});

const compassRow = (over: Record<string, unknown> = {}) => ({
  city: "cebu", depth_score: 12, tier: "thin", signals: { visitors: 3 },
  computed_at: "2026-09-19T00:00:00Z", ...over,
});

describe("A. the seam is a literal read of the PLATFORM store, not a second producer", () => {
  const src = readFileSync(join(SRC, "compass", "CompassGraphEngine.ts"), "utf8");

  it("reads intel_coverage_snapshots through a literal .from().select() chain", () => {
    assert.match(
      src,
      /\.from\("intel_coverage_snapshots"\)\s*\n?\s*\.select\("[a-z_, ]+"\)/,
      "the schema scanner attributes refs only from a literal .from(\"t\").select(\"cols\") chain",
    );
    // Literal column list — never a ternary or a variable.
    const sel = /\.from\("intel_coverage_snapshots"\)\s*\n?\s*\.select\((.+?)\)/s.exec(src)?.[1] ?? "";
    assert.ok(/^"[^"]+"$/.test(sel.trim()), `select() must be a literal string, got ${sel}`);
    for (const col of ["city", "coverage_state", "current_confidence", "expires_at"]) {
      assert.ok(sel.includes(col), `the read must name ${col}`);
    }
  });

  it("consumes the platform store without importing or re-running its producer", () => {
    assert.doesNotMatch(src, /(?:import|require)[^\n]*intelCoverage/, "Compass must not pull in the coverage producer");
    assert.doesNotMatch(src, /from\("intel_coverage_snapshots"\)[\s\S]{0,200}\.(insert|upsert|delete)\(/,
      "Compass reads the platform store; writing it would be the duplication again");
  });
});

describe("B. platform coverage folds onto the same 0–100 depth scale", () => {
  it("covered + confident scores high, uncovered scores low, and it is monotone", () => {
    const full = platformCoverageDepthScore({ cells: 4, covered: 4, meanConfidence: 1 });
    const none = platformCoverageDepthScore({ cells: 4, covered: 0, meanConfidence: 0 });
    const half = platformCoverageDepthScore({ cells: 4, covered: 2, meanConfidence: 0.5 });
    assert.equal(full, 100);
    assert.equal(none, 0);
    assert.ok(half > none && half < full, `${none} < ${half} < ${full}`);
    // coverage_state genuinely matters, not only the confidence numbers.
    assert.ok(
      platformCoverageDepthScore({ cells: 4, covered: 4, meanConfidence: 0.5 }) >
      platformCoverageDepthScore({ cells: 4, covered: 0, meanConfidence: 0.5 }),
      "a covered city must outscore an uncovered one at equal confidence",
    );
    assert.equal(platformCoverageDepthScore({ cells: 0, covered: 0, meanConfidence: 0 }), 0);
  });
});

describe("C. the platform read is scoped, fresh, and honest about failure", () => {
  it("reads only this city's UNEXPIRED cells", async () => {
    const db = fakeDb({
      intel_coverage_snapshots: [
        cell(),
        cell({ zone_id: "z2", coverage_state: "no_coverage", current_confidence: 0 }),
        cell({ zone_id: "z3", expires_at: STALE, coverage_state: "covered", current_confidence: 1 }),
        cell({ city: "Manila", zone_id: "z4", coverage_state: "covered", current_confidence: 1 }),
        // Prefix-matches the canonical key server-side but is NOT this city:
        // the client-side canonical re-verify is the half that catches it.
        cell({ city: "Cebuano Heights", zone_id: "z5", coverage_state: "covered", current_confidence: 1 }),
      ],
    });
    const { coverage, readable } = await readPlatformCityCoverage(db, "Cebu", NOW);
    assert.equal(readable, true);
    assert.ok(coverage);
    assert.equal(coverage!.cells, 2, "expired, foreign and merely prefix-matching cells must not count");
    assert.equal(coverage!.covered, 1);
    assert.equal(coverage!.noCoverage, 1);
  });

  it("no rows is not an error, and an error is not an absence", async () => {
    const empty = await readPlatformCityCoverage(fakeDb({ intel_coverage_snapshots: [] }), "Cebu", NOW);
    assert.equal(empty.coverage, null);
    assert.equal(empty.readable, true);

    const broken = await readPlatformCityCoverage(
      fakeDb({ intel_coverage_snapshots: { error: { message: "boom" } } }), "Cebu", NOW,
    );
    assert.equal(broken.coverage, null);
    assert.equal(broken.readable, false, "an unreadable platform store must not read as an empty one");

    const noDb = await readPlatformCityCoverage(null, "Cebu", NOW);
    assert.equal(noDb.coverage, null);
    assert.equal(noDb.readable, false);
  });
});

describe("D. the platform GOVERNS the confidence Compass serves", () => {
  it("platform coverage overrides the graph-derived score and names itself", async () => {
    const db = fakeDb({
      compass_city_confidence: [compassRow({ depth_score: 12, tier: "thin" })],
      intel_coverage_snapshots: [cell(), cell({ zone_id: "z2" }), cell({ zone_id: "z3" })],
    });
    const conf = await getCityConfidence(db, "Cebu", NOW);
    assert.ok(conf);
    const expected = platformCoverageDepthScore({ cells: 3, covered: 3, meanConfidence: 0.9 });
    assert.equal(conf!.depthScore, expected, "the platform score must govern, not the compass-local 12");
    assert.equal(conf!.tier, tierForScore(expected));
    assert.equal(conf!.source, "platform_coverage");
    assert.equal(conf!.sourceReason, "platform_coverage");
    // Signals stay aggregate NUMBERS only — the privacy contract of this file.
    for (const v of Object.values(conf!.signals)) assert.equal(typeof v, "number");
  });

  it("platform coverage answers even when Compass has no graph row of its own", async () => {
    const db = fakeDb({ compass_city_confidence: [], intel_coverage_snapshots: [cell()] });
    const conf = await getCityConfidence(db, "Cebu", NOW);
    assert.ok(conf, "a platform answer must not need a compass row to exist");
    assert.equal(conf!.source, "platform_coverage");
  });

  it("a platform city spelled differently still governs, and a foreign city never does", async () => {
    // The platform keys `places.city` raw ("Cebu City"); Compass keys canonical
    // ("cebu"). The read narrows server-side and re-verifies canonically.
    const db = fakeDb({
      compass_city_confidence: [compassRow()],
      intel_coverage_snapshots: [cell({ city: "cebu" }), cell({ city: "Cebu City", zone_id: "z2" })],
    });
    const conf = await getCityConfidence(db, "Cebu", NOW);
    assert.equal(conf!.source, "platform_coverage");
    assert.equal(conf!.platformCells, 2);
  });
});

describe("E. a missing or unreadable platform row degrades honestly", () => {
  it("no platform row ⇒ the graph-derived score, labelled compass_graph", async () => {
    const db = fakeDb({
      compass_city_confidence: [compassRow({ depth_score: 42, tier: "moderate" })],
      intel_coverage_snapshots: [],
    });
    const conf = await getCityConfidence(db, "Cebu", NOW);
    assert.ok(conf);
    assert.equal(conf!.depthScore, 42);
    assert.equal(conf!.source, "compass_graph");
    assert.equal(conf!.sourceReason, "platform_no_rows");
  });

  it("an unreadable platform store is never presented as a platform answer", async () => {
    const db = fakeDb({
      compass_city_confidence: [compassRow({ depth_score: 42, tier: "moderate" })],
      intel_coverage_snapshots: { error: { message: "boom" } },
    });
    const conf = await getCityConfidence(db, "Cebu", NOW);
    assert.ok(conf);
    assert.equal(conf!.source, "compass_graph");
    assert.equal(conf!.sourceReason, "platform_unreadable");
    assert.notEqual(conf!.source, "platform_coverage");
  });

  it("neither source ⇒ null, not a confident zero", async () => {
    const db = fakeDb({ compass_city_confidence: [], intel_coverage_snapshots: [] });
    assert.equal(await getCityConfidence(db, "Cebu", NOW), null);
    assert.equal(await getCityConfidence(null, "Cebu", NOW), null);
  });
});

describe("F. the prose names the provenance", () => {
  it("cityConfidenceNote says which store answered, and never claims platform when it did not", () => {
    const platform = cityConfidenceNote(
      { city: "cebu", depthScore: 80, tier: "deep", signals: {}, computedAt: "", source: "platform_coverage", sourceReason: "platform_coverage" },
      "Cebu",
    );
    const local = cityConfidenceNote(
      { city: "cebu", depthScore: 80, tier: "deep", signals: {}, computedAt: "", source: "compass_graph", sourceReason: "platform_no_rows" },
      "Cebu",
    );
    // The prose names the shared store as "the shared coverage index" and not
    // by its owning subsystem, because these lines reach a prompt and the
    // read-time privacy assertion over them rejects any "lat" substring —
    // which "pl-at-form" contains. Provenance is still named, unambiguously.
    assert.match(platform, /depth from the shared coverage index/i);
    assert.match(local, /Compass's own graph history/i);
    assert.doesNotMatch(local, /depth from the shared/i, "a compass-local answer must not wear the shared store's name");
    // An unlabelled record predates the seam: it must NOT claim the platform.
    const legacy = cityConfidenceNote({ city: "cebu", depthScore: 80, tier: "deep", signals: {}, computedAt: "" }, "Cebu");
    assert.doesNotMatch(legacy, /shared coverage index/i);
    // And nothing these lines say may trip the read-time coordinate guard.
    for (const note of [platform, local, legacy]) assert.doesNotMatch(note, /lat|lng|latitude|longitude/i);
  });

  it("the destination context line carries the source", async () => {
    const db = fakeDb({
      compass_city_models: [{ city: "cebu", time_slices: {}, monthly: {}, top_categories: ["food"], sample_size: 9, built_at: "" }],
      compass_city_confidence: [compassRow()],
      intel_coverage_snapshots: [cell(), cell({ zone_id: "z2" })],
    });
    const lines = await buildDestinationContextLines(db, "Cebu", NOW);
    const conf = lines.find((l) => l.startsWith("City data confidence"));
    assert.ok(conf, lines.join("\n"));
    assert.match(conf!, /source: shared coverage index/i);
    for (const l of lines) assert.doesNotMatch(l, /lat|lng|latitude|longitude/i, "prompt lines carry no coordinates");
  });
});
