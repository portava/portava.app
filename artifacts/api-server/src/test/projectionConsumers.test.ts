/**
 * The producer-without-consumer ratchet must fire — `check:projection-consumers`.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * DECORATIVE ARCHITECTURE. A producer that runs, a table that fills, and nothing
 * that reads it. Every piece is individually correct — the worker has tests, the
 * table has a migration, the scheduler is registered — and the feature does not
 * exist, because the last hop was never built. Nothing fails, so nothing says so.
 *
 * It is the mirror of `checkWriterlessReads` (a read whose table nothing writes).
 * Together they assert data can flow BOTH ways along every declared pipe.
 *
 * ── WHY THE CONTROL AND THE FALSE-POSITIVE CASES CARRY THE WEIGHT ────────────
 * The first version of this checker reported three failures and all three were
 * its own bugs:
 *
 *   * it captured a 500-character window after `.from(...)`, which CONSUMED it,
 *     so every later `.from(...)` in the same file was skipped — reporting "no
 *     consumer" for routes/placeLiving.ts and routes/intelReadModels.ts, both of
 *     which read the table a few lines further down;
 *   * it matched its own filename against the projection-shaped pattern and
 *     reported ITSELF as an unregistered projection.
 *
 * A guard that fails on correct code gets deleted, so the control case below —
 * the real tree and the real registry must pass — is not a formality.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/projectionConsumers.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { callsFunction } from "../scripts/lib/callsFunction.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const CHECKER = join(API_ROOT, "src", "scripts", "checkProjectionConsumers.ts");

let tmp = "";
before(() => { tmp = mkdtempSync(join(tmpdir(), "projcons-")); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function withRegistry(name: string, entries: unknown[]) {
  const p = join(tmp, `${name}.json`);
  writeFileSync(p, JSON.stringify(entries, null, 1));
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, PROJECTION_REGISTRY: p },
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("projection consumer ratchet", () => {
  it("CONTROL — the real tree and the real registry pass", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
      cwd: API_ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    // The inventory must actually be printed — a silent pass proves nothing.
    assert.match(r.stdout, /TRIP_MAP_PROJECTION/);
  });

  it("FAILS a projection whose only consumer is its own producer", () => {
    const { code, out } = withRegistry("stranded", [{
      key: "STRANDED",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: ["lib/mapTripProjectionWorker.ts"],
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /NO CONSUMER outside its own producer/);
  });

  it("FAILS a declared consumer that does not actually read the storage", () => {
    const { code, out } = withRegistry("deadconsumer", [{
      key: "DEAD_CONSUMER",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      // A real file that has nothing to do with this table.
      consumers: ["lib/mapProjectionTripRead.ts", "lib/http.ts"],
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /does not read trip_map_projections/);
  });

  it("FAILS a producer that no longer writes its storage", () => {
    const { code, out } = withRegistry("deadproducer", [{
      key: "DEAD_PRODUCER",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/http.ts"],
      consumers: ["lib/mapProjectionTripRead.ts"],
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /writes neither trip_map_projections directly nor any declared producer function/);
  });

  it("FAILS a scheduler that is never started", () => {
    const { code, out } = withRegistry("unstarted", [{
      key: "UNSTARTED",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: ["lib/mapProjectionTripRead.ts"],
      scheduler: { starts: "startAProducerNobodyEverCalls", from: "index.ts" },
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /is never CALLED from index\.ts/);
  });

  it("FAILS a queue/backfill/sink with no substantive reason", () => {
    const { code, out } = withRegistry("noreason", [{
      key: "NO_REASON",
      kind: "sink",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: [],
      reason: "because",
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /requires a substantive reason/);
  });

  it("FAILS when a projection-shaped writer is missing from the registry", () => {
    // The discovery rule: the registry must not be usable to hide a projection.
    const { code, out } = withRegistry("hidden", [{
      key: "ONLY_ONE",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: ["lib/mapProjectionTripRead.ts"],
    }]);
    assert.notEqual(code, 0);
    assert.match(out, /UNREGISTERED PROJECTION/);
    // …and it must NOT accuse the checker itself, which matches the
    // projection-shaped filename pattern.
    assert.doesNotMatch(out, /checkProjectionConsumers\.ts is not in the projection registry/);
  });

  it("FAILS VACUOUSLY-EMPTY rather than reporting success", () => {
    const { code, out } = withRegistry("empty", []);
    assert.notEqual(code, 0);
    assert.match(out, /VACUOUS/);
  });

  it("FAILS a scheduler whose start call has been COMMENTED OUT", () => {
    // The false negative this rule shipped with. `new RegExp(name + "\\s*\\(")`
    // against the raw file matches inside a comment, so commenting out
    // `startTripMapProjectionScheduler();` in index.ts left the check GREEN at
    // exit 0 — on precisely the regression rule 5 exists to catch, and on the
    // single most likely way a scheduler ever stops running (someone disables it
    // while debugging and does not put it back). Measured first in the sibling
    // checkStateMachineWriters.ts, then found here.
    //
    // The entry point is a crafted file rather than a mutated src/index.ts so the
    // proof does not depend on editing the running tree; `from` is resolved
    // against SRC, so a relative path out of it reaches the temp dir.
    const entry = join(tmp, "commentedEntry.ts");
    writeFileSync(
      entry,
      [
        "// startTripMapProjectionScheduler();",
        "/* startTripMapProjectionScheduler(); */",
        "/*",
        " * startTripMapProjectionScheduler();",
        " */",
        "export const nothingHere = true;",
      ].join("\n"),
    );
    const { code, out } = withRegistry("commented", [{
      key: "COMMENTED_OUT",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: ["lib/mapProjectionTripRead.ts"],
      scheduler: { starts: "startTripMapProjectionScheduler", from: relative(join(API_ROOT, "src"), entry) },
    }]);
    assert.notEqual(code, 0, "a commented-out start call is not a start call");
    assert.match(out, /is never CALLED from/);
  });

  it("PASSES the same entry point once the call is real (the control)", () => {
    // Without this, the case above would also pass against a checker that had
    // simply stopped detecting calls at all.
    const entry = join(tmp, "realEntry.ts");
    writeFileSync(
      entry,
      ["// startTripMapProjectionScheduler();", "startTripMapProjectionScheduler();"].join("\n"),
    );
    const { code } = withRegistry("realcall", [{
      key: "REAL_CALL",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: ["lib/mapProjectionTripRead.ts"],
      scheduler: { starts: "startTripMapProjectionScheduler", from: relative(join(API_ROOT, "src"), entry) },
    }]);
    // Only the UNREGISTERED-PROJECTION discovery rule should still fire here
    // (this crafted registry names one projection while the tree has more), so
    // assert on the scheduler verdict specifically rather than on exit 0.
    assert.equal(code === 0 || code === 1, true);
    const { out } = withRegistry("realcall", [{
      key: "REAL_CALL",
      kind: "projection",
      storage: ["trip_map_projections"],
      producers: ["lib/mapTripProjectionWorker.ts"],
      producerFunctions: ["trip_map_projection_drain"],
      consumers: ["lib/mapProjectionTripRead.ts"],
      scheduler: { starts: "startTripMapProjectionScheduler", from: relative(join(API_ROOT, "src"), entry) },
    }]);
    assert.doesNotMatch(out, /REAL_CALL: startTripMapProjectionScheduler is never CALLED/);
  });
});

describe("callsFunction — the shared comment-aware detector", () => {
  it("finds a real call", () => {
    assert.equal(callsFunction("startX();", "startX"), true);
    assert.equal(callsFunction("  await startX( a, b );", "startX"), true);
  });

  it("does NOT find a line-commented call", () => {
    assert.equal(callsFunction("// startX();", "startX"), false);
    assert.equal(callsFunction("const y = 1; // startX();", "startX"), false);
  });

  it("does NOT find a block-commented call, single or multi line", () => {
    assert.equal(callsFunction("/* startX(); */", "startX"), false);
    assert.equal(callsFunction("/*\n startX();\n*/", "startX"), false);
    assert.equal(callsFunction("a();\n/*\nstartX();\n*/\nb();", "startX"), false);
  });

  it("finds a real call on a line that also carries a comment", () => {
    assert.equal(callsFunction("startX(); // kicks the drain", "startX"), true);
  });

  it("does not match a longer identifier that merely ends with the name", () => {
    assert.equal(callsFunction("dontStartX();", "startX"), false);
  });

  it("errs toward NOT finding rather than toward finding", () => {
    // A `//` inside a string truncates the rest of that line. That is the
    // deliberate direction: ambiguity must fail the guard loudly, never pass it
    // quietly. Pinned so a future \"improvement\" that flips the direction has to
    // argue with this case.
    assert.equal(callsFunction('const u = "https://x"; startX();', "startX"), false);
  });
});
