/**
 * census-compass CPH-14 — "track the full chain recommended → viewed → saved →
 * went → stayed → liked → invited → made memory → returned, not just clicks".
 *
 * The row's evidence said "seven of the eight recordable stages have no
 * producer anywhere in the tree". That was true when written and is false at
 * this head: every stage is emitted by a route through `linkOutcomeSignal`
 * (or, for `viewed`, also by the client-facing POST). This suite PINS the
 * producers by scanning the route sources, so a stage cannot silently lose
 * its producer again — and it names the two anchor caveats rather than hiding
 * them: `invited` anchors on the recipient's profile id and `stayed` on a
 * trip/postcard id, which only link when Compass served THOSE ids.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassOutcomeProducers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OUTCOME_STAGES, type OutcomeStage } from "../compass/CompassOutcomeEngine.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTES = join(SRC, "routes");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every `linkOutcomeSignal(...)` call in routes/, with the stage literal it passes (or the helper it derives one from). */
function producers(): Array<{ file: string; stage: string }> {
  const out: Array<{ file: string; stage: string }> = [];
  for (const f of readdirSync(ROUTES).filter((n) => n.endsWith(".ts"))) {
    const src = strip(readFileSync(join(ROUTES, f), "utf8"));
    for (const m of src.matchAll(/linkOutcomeSignal\(\s*([\s\S]*?)\)\s*;/g)) {
      const args = m[1]!;
      const lit = /"(viewed|saved|went|stayed|liked|invited|made_memory|returned)"/.exec(args);
      if (lit) out.push({ file: f, stage: lit[1]! });
      else if (/\bstage\b/.test(args)) out.push({ file: f, stage: "<derived>" });
    }
  }
  return out;
}

describe("CPH-14 — every recordable stage has a producer", () => {
  const found = producers();

  it("finds the route producers at all (vacuity guard)", () => {
    assert.ok(found.length >= 8, `only ${found.length} linkOutcomeSignal call(s) under routes/`);
  });

  it("rankEvents derives viewed / saved / went from the rank funnel", () => {
    const src = strip(readFileSync(join(ROUTES, "rankEvents.ts"), "utf8"));
    assert.match(src, /if \(outcome === "tap"\) return "viewed";/);
    assert.match(src, /return "saved";/);
    assert.match(src, /return "went";/);
    assert.ok(found.some((p) => p.file === "rankEvents.ts" && p.stage === "<derived>"));
  });

  for (const stage of OUTCOME_STAGES as readonly OutcomeStage[]) {
    it(`${stage} has a literal producer in routes/ (or the rank funnel derives it)`, () => {
      const derivable = stage === "viewed" || stage === "saved" || stage === "went";
      const has = found.some((p) => p.stage === stage) || (derivable && found.some((p) => p.stage === "<derived>"));
      assert.ok(has, `no producer emits "${stage}"; producers seen: ${JSON.stringify(found)}`);
    });
  }

  it("the client-facing POST /compass/outcomes accepts every stage (the ninth producer is the client)", () => {
    const src = strip(readFileSync(join(ROUTES, "compassOutcomes.ts"), "utf8"));
    assert.match(src, /z\.enum\(OUTCOME_STAGES\)/);
  });

  it("names the two anchor caveats: invited anchors on a recipient id, stayed on a trip/postcard id", () => {
    const friends = strip(readFileSync(join(ROUTES, "friends.ts"), "utf8"));
    assert.match(friends, /linkOutcomeSignal\([^)]*recipientId,\s*"invited"/);
    const location = strip(readFileSync(join(ROUTES, "location.ts"), "utf8"));
    assert.match(location, /relatedTripId \?\? relatedPostcardId,\s*"stayed"/);
  });
});
