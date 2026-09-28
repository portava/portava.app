/**
 * census-discovery §81 (lane W10-S2) — A11: §57.10 Q4, decided (register
 * D-W10S2-7). The dead free-time arms of `portavaRank.availabilityFitScore`
 * (`ViewerContext.availableMinutes` / `availableNow`) are an independent
 * "free time" calculation — exactly what Trips `:185` forbids a consumer to
 * keep — with no caller. The decision is to DELETE them; `lib/portavaRank.ts`
 * is the ranker lane's file, so the deletion is a routed hunk (census §81), and
 * until it lands this suite is the ratchet that keeps the arms dead:
 *
 *   F1  no module that imports the ranker names either field — so nothing can
 *       feed the duplicate while it waits for deletion. A Temporal Freedom
 *       consumer reads the Trips windows (`TripFreedomConsumers.fitInstantToWindows`),
 *       never a scalar handed to the ranker.
 *   F2  the arms still exist in `portavaRank.ts` — this case goes RED the day
 *       the routed hunk lands, so A11 is re-graded rather than left describing
 *       a duplicate that is gone (the §57 inventory's two-direction pattern).
 *
 * Run: node --import tsx/esm --test src/test/discoveryFreeTimeRetirement.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "__tests__" || name === "node_modules") continue;
      out.push(...tsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const strip = (src: string) => src.split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "")).join("\n");

describe("A11 — the dead free-time arms stay dead until the routed deletion lands", () => {
  it("F1 no importer of the ranker names availableMinutes or availableNow", () => {
    const offenders: string[] = [];
    let importers = 0;
    for (const f of tsFiles(SRC)) {
      const rel = path.relative(SRC, f).split(path.sep).join("/");
      if (rel === "lib/portavaRank.ts" || rel.startsWith("scripts/")) continue;
      const text = strip(readFileSync(f, "utf8"));
      if (!/from\s+["'][^"']*portavaRank(\.js)?["']/.test(text)) continue;
      importers++;
      if (/\bavailableMinutes\b|\bavailableNow\b/.test(text)) offenders.push(rel);
    }
    assert.ok(importers >= 6, `only ${importers} importer(s) of the ranker found — this test is reading the wrong tree`);
    assert.deepEqual(offenders, [], `a ranker consumer feeds the dead free-time arms: ${offenders.join(", ")}`);
  });

  it("F2 the arms are still in portavaRank.ts — RED when the routed deletion lands (re-grade A11 then)", () => {
    const rank = strip(readFileSync(path.join(SRC, "lib", "portavaRank.ts"), "utf8"));
    assert.match(rank, /availableMinutes\?: number \| null;/);
    assert.match(rank, /if \(ctx\.availableMinutes != null\) \{/);
    assert.match(rank, /if \(ctx\.availableNow\) \{/);
  });
});
