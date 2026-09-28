/**
 * census-discovery §82 (lane W10-O) — DV-78: `04` §4's `immediate_skip`, with
 * its threshold decided (register D-W10-O-7) and derived DOWNSTREAM from the
 * dwell rows `04` §8 says sequence features come from.
 *
 *   S1  the threshold is a named value.
 *   S2  a skip is an exposure whose detail sheet was opened (`tap`, nothing
 *       stronger) with less than the threshold of FOREGROUND dwell (active +
 *       passive_foreground); idle time is not foreground; a save is never a
 *       skip; an exposure with no dwell row is not counted at all.
 *   S3  per arm; with no dwell rows at all the figure is UNOBSERVED and says
 *       why (collection is gated on the owner's consent, 3395, B-1) — never 0.
 *   S4  it collects nothing and feeds no ranker: the module has no I/O, and no
 *       ranking module imports it.
 *   S5  an exposure's dwell is summed across its emissions (a view split by
 *       backgrounding is one view).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryDwellSkip.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IMMEDIATE_SKIP_MAX_FOREGROUND_MS, buildImmediateSkipReport } from "../lib/discoveryDwellSkip.js";
import { DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION } from "../lib/discoveryRankProvenance.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let n = 0;
const rid = () => `row-${++n}`;
/** A well-formed served id: 22 URL-safe characters, the shape exposureIdsOf accepts. */
function servedId(): string {
  n += 1;
  return `sv_${String(n).padStart(19, "0")}`;
}

function exposure(arm: "pde" | "legacy", outcome: string, id: string) {
  return { id: rid(), surface: "discovery", event_type: null, outcome, recommendation_id: id,
    features: { modelVersion: arm === "pde" ? DISCOVERY_PDE_MODEL_VERSION : DISCOVERY_MODEL_VERSION, servePoint: 1, recommendationId: id } };
}
function dwell(id: string, kind: string, ms: number) {
  return { id: rid(), surface: "discovery", event_type: "place_dwell", outcome: "analytics", dwell_kind: kind, dwell_ms: ms, features: { recommendationId: id } };
}

describe("DV-78 — immediate_skip, derived from dwell (census-discovery §82, D-W10-O-7)", () => {
  it("S1. the threshold is a named value", () => {
    assert.equal(IMMEDIATE_SKIP_MAX_FOREGROUND_MS, 2_000);
  });

  it("S2. opened with under 2 s of foreground dwell is a skip; idle is not foreground; a save is never a skip; no dwell is not counted", async () => {
    const { RECOMMENDATION_ID_SHAPE } = await import("../lib/rankEventsProvenance.js");
    const a = servedId(), b = servedId(), c = servedId(), d = servedId(), e = servedId();
    assert.ok(RECOMMENDATION_ID_SHAPE.test(a), `fixture id ${a} must be a served-id shape`);
    const rows = [
      exposure("pde", "tap", a), dwell(a, "active", 1_500),                                // skip
      exposure("pde", "tap", b), dwell(b, "active", 1_500), dwell(b, "passive_foreground", 600), // 2.1 s foreground: not a skip
      exposure("pde", "tap", c), dwell(c, "active", 900), dwell(c, "idle", 3_600_000),     // idle is not foreground: skip
      exposure("pde", "save", d), dwell(d, "active", 300),                                   // a save is never a skip
      exposure("pde", "tap", e),                                                             // no dwell: not counted
    ];
    const r = buildImmediateSkipReport(rows);
    assert.deepEqual(r.arms.pde, { observed: true, exposuresWithDwell: 4, skips: 2, share: 0.5 });
  });

  it("S3. per arm; with no dwell rows at all the figure is UNOBSERVED and says why — never 0", () => {
    const x = servedId();
    const r = buildImmediateSkipReport([exposure("legacy", "tap", x)]);
    assert.equal(r.arms.legacy.observed, false);
    assert.equal(r.arms.pde.observed, false);
    if (!r.arms.legacy.observed) assert.match(r.arms.legacy.reason, /discovery_dwell_telemetry_enabled/);
    assert.equal("share" in r.arms.legacy, false);
  });

  it("S4. it collects nothing and feeds no ranker", () => {
    const src = readFileSync(resolve(SRC, "lib/discoveryDwellSkip.ts"), "utf8");
    assert.doesNotMatch(src, /from "\.\/(supabase|featureFlags|http)\.js"|\.from\(|fetch\(|\.rpc\(/, "no I/O");
    const rankers = [resolve(SRC, "lib/portavaRank.ts"), resolve(SRC, "lib/discoveryPde.ts"),
      ...readdirSync(resolve(SRC, "services/ranking")).filter((f) => f.endsWith(".ts")).map((f) => resolve(SRC, "services/ranking", f))];
    for (const f of rankers) assert.doesNotMatch(readFileSync(f, "utf8"), /discoveryDwellSkip/, `${f} must not read immediate_skip`);
  });

  it("S5. an exposure's dwell is summed across its emissions", () => {
    const x = servedId();
    const r = buildImmediateSkipReport([exposure("legacy", "tap", x), dwell(x, "active", 1_200), dwell(x, "active", 1_200)]);
    assert.deepEqual(r.arms.legacy, { observed: true, exposuresWithDwell: 1, skips: 0, share: 0 }, "2.4 s over two emissions is one view, not two skips");
  });
});
