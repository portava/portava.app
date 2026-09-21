/**
 * Every background worker in the tree is actually started.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `server/trips/projectionWorkers/index.ts` says, in its own header:
 *
 *     "this module is the one place src/index.ts starts them, so a worker
 *      cannot be added to the tree and forgotten at startup."
 *
 * That was a PROMISE, not a mechanism. Nothing read the directory, so a fourth
 * scheduler dropped in beside the three would compile, typecheck, pass its own
 * unit tests, be imported by nothing, and never run — and the sentence above
 * would still be sitting there claiming otherwise. The barrel was complete when
 * this was written (all three files are listed); this is what keeps it so.
 *
 * A worker that is never started is the quietest failure a background job has:
 * there is no error, no log line and no failing test — the work simply does not
 * happen, and the first evidence is a user noticing something stale.
 *
 * ─── WHAT IS AND IS NOT CHECKED ──────────────────────────────────────────────
 *
 * Checked: that the barrel covers its own directory, that `src/index.ts` calls
 * the barrel, and that `src/index.ts` starts every `start*` it bothered to
 * import. The third is the generic form of the same defect one level up.
 *
 * NOT checked: that a started worker does anything useful, that its flag is on,
 * or that it runs in a deployed process. `startTripProjectionWorkers()` being
 * called says the loop is armed in THIS codebase, never that the deployment is
 * running this build. Those are separate questions and this file does not
 * pretend to answer them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TRIP_PROJECTION_WORKERS } from "../server/trips/projectionWorkers/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const WORKER_DIR = resolve(SRC, "server/trips/projectionWorkers");

/**
 * Comments stripped, because a CALL and a COMMENTED-OUT CALL look identical to a
 * regex. MEASURED: without this, commenting out `startTripProjectionWorkers();`
 * — a one-character edit, and the exact way a starter gets disabled "just for a
 * minute" — left both assertions below green. Line comments only: this file
 * reads source it controls, and a block comment mid-statement would be a
 * stranger thing than the defect being guarded.
 */
function stripComments(src: string): string {
  return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** A file in the worker directory that is a worker, not the barrel. */
function workerFiles(): string[] {
  return readdirSync(WORKER_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts" && !f.endsWith(".test.ts"))
    .sort();
}

describe("Trips projection workers — the barrel covers its own directory", () => {
  it("every scheduler file beside the barrel is listed in TRIP_PROJECTION_WORKERS", () => {
    const files = workerFiles();
    assert.ok(files.length > 0, "the worker directory is empty — this test is measuring nothing");

    // The barrel references each worker by importing its start function, so the
    // honest check is that the barrel's SOURCE names every file. Comparing
    // counts alone would pass a barrel that listed one worker twice.
    const barrel = readFileSync(resolve(WORKER_DIR, "index.ts"), "utf8");
    const unlisted = files.filter((f) => !barrel.includes(`./${f.replace(/\.ts$/, ".js")}`));
    assert.deepEqual(unlisted, [],
      `worker file(s) exist that the barrel does not import, so nothing starts them:\n  ${unlisted.join("\n  ")}`);

    assert.equal(TRIP_PROJECTION_WORKERS.length, files.length,
      `the barrel imports every worker file but registers ${TRIP_PROJECTION_WORKERS.length} of ${files.length} — an import that is not in the array is still never started`);
  });

  it("every registered worker has a distinct id and a callable start", () => {
    const ids = TRIP_PROJECTION_WORKERS.map((w) => w.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate worker id(s): ${ids.join(", ")}`);
    for (const w of TRIP_PROJECTION_WORKERS) {
      assert.equal(typeof w.start, "function", `worker ${w.id} has no start()`);
      assert.ok(w.stop === null || typeof w.stop === "function", `worker ${w.id}'s stop is neither null nor a function`);
    }
  });

  it("src/index.ts actually calls the barrel", () => {
    // The barrel being complete is worth nothing if the entry point stopped
    // calling it, which is a one-line deletion away and would look harmless.
    const index = stripComments(readFileSync(resolve(SRC, "index.ts"), "utf8"));
    assert.match(index, /startTripProjectionWorkers\s*\(/,
      "src/index.ts does not call startTripProjectionWorkers() — the Trips workers are armed nowhere");
  });
});

describe("src/index.ts — an imported starter is a started starter", () => {
  it("every start* imported into the entry point is also called there", () => {
    // The generic form of the same defect: adding the import and forgetting the
    // call compiles, and the only symptom is work that silently never happens.
    const raw = readFileSync(resolve(SRC, "index.ts"), "utf8");
    const index = stripComments(raw);
    const imported = new Set<string>();
    for (const m of index.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of m[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()!.trim();
        if (/^start[A-Z]/.test(name)) imported.add(name);
      }
    }
    assert.ok(imported.size > 10, `only ${imported.size} start* imports found — the scan is broken, not the file`);

    const called = new Set(Array.from(index.matchAll(/\b(start[A-Za-z0-9_]*)\s*\(/g), (m) => m[1]!));
    const never = Array.from(imported).filter((n) => !called.has(n)).sort();
    assert.deepEqual(never, [],
      `imported into src/index.ts and never called — these background jobs do not run:\n  ${never.join("\n  ")}`);
  });
});
