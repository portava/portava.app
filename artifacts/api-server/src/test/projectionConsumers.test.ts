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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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

/**
 * Run the checker against a CRAFTED src tree.
 *
 * The writer/reader attribution rules read whole source files, so proving they
 * are comment-aware needs a tree whose only `.from(...)` occurrences are the
 * ones under test — mutating the real tree could not isolate that. The checker
 * refuses a tree of fewer than 100 files (MIN_FILES_SCANNED), which is itself
 * the right behaviour, so the tree is padded with inert filler; a case that
 * passed by scanning almost nothing would prove nothing.
 */
function withTree(name: string, files: Record<string, string>, entries: unknown[]) {
  const root = join(tmp, `tree-${name}`);
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 110; i++) {
    writeFileSync(join(src, `filler${i}.ts`), `export const filler${i} = ${i};\n`);
  }
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(src, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const reg = join(tmp, `${name}.json`);
  writeFileSync(reg, JSON.stringify(entries, null, 1));
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, PROJECTION_REGISTRY: reg, PROJECTION_SRC: src },
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

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

// ─────────────────────────────────────────────────────────────────────────────
// WRITER AND READER ATTRIBUTION ARE ANSWERED FROM CODE, NOT FROM PROSE.
//
// Until 2026-09-08 both scans ran over the RAW file text, so a commented-out
// `.from("t").insert(...)` counted as a producer and a commented-out
// `.from("t").select(...)` counted as a consumer. That is the sixth guard in
// this tree to ship this bug and the fifth to ship it in the direction that
// reports a GAP AS CLOSED: the projection looks wired, and nothing says
// otherwise.
//
// Measured over 1,725 real files at the time of the fix: 24 phantom writer
// attributions and 24 phantom reader attributions, at least one of them
// (`posts`, from scripts/lib/tableAccessExtract.ts) naming a table this registry
// actually tracks. No projection's verdict changed on the day — the defect was
// latent, not live — which is the right time to close it, and the reason this
// suite exists rather than a commit message saying it was fine.
// ─────────────────────────────────────────────────────────────────────────────

const CRAFTED = [{
  key: "CRAFTED",
  kind: "projection",
  storage: ["crafted_projection"],
  producers: ["worker.ts"],
  consumers: ["reader.ts"],
}];

describe("writer/reader attribution is comment-aware", () => {
  it("CONTROL — a real write and a real read PASS", () => {
    const { code, out } = withTree("real", {
      "worker.ts": 'export async function run(sc: any) { await sc.from("crafted_projection").insert({ a: 1 }); }\n',
      "reader.ts": 'export async function read(sc: any) { return sc.from("crafted_projection").select("*"); }\n',
    }, CRAFTED);
    assert.equal(code, 0, `the control tree must pass, otherwise the two cases below prove nothing:\n${out}`);
  });

  it("FAILS when the only write is inside a COMMENT", () => {
    const { code, out } = withTree("commented-write", {
      "worker.ts": [
        "// await sc.from(\"crafted_projection\").insert({ a: 1 });",
        "/* await sc.from(\"crafted_projection\").insert({ a: 1 }); */",
        "/**",
        " * Historical shape:",
        " *   await sc.from(\"crafted_projection\").insert({ a: 1 });",
        " */",
        "export const nothingHere = true;",
      ].join("\n") + "\n",
      "reader.ts": 'export async function read(sc: any) { return sc.from("crafted_projection").select("*"); }\n',
    }, CRAFTED);
    assert.notEqual(code, 0, "a commented-out insert is not a producer");
    assert.match(out, /producer worker\.ts writes neither crafted_projection/);
  });

  it("FAILS when the only read is inside a COMMENT", () => {
    const { code, out } = withTree("commented-read", {
      "worker.ts": 'export async function run(sc: any) { await sc.from("crafted_projection").insert({ a: 1 }); }\n',
      "reader.ts": [
        "// return sc.from(\"crafted_projection\").select(\"*\");",
        "/* return sc.from(\"crafted_projection\").select(\"*\"); */",
        "export const nothingHere = true;",
      ].join("\n") + "\n",
    }, CRAFTED);
    assert.notEqual(code, 0, "a commented-out select is not a consumer");
    assert.match(out, /declared consumer reader\.ts does not read crafted_projection/);
  });

  it("a table-name CONSTANT declared only in a comment does not resolve", () => {
    // `.from(SOME_CONST)` is resolved through a map of `const NAME = "table"`
    // declarations, and that map was built from raw text too. Three constants in
    // the real tree exist only inside comments; resolving a chain through one
    // attributes a real access to a name nothing declares.
    const { code, out } = withTree("commented-const", {
      "worker.ts": [
        '// const CRAFTED_TABLE = "crafted_projection";',
        'export async function run(sc: any) { await sc.from(CRAFTED_TABLE).insert({ a: 1 }); }',
        'declare const CRAFTED_TABLE: string;',
      ].join("\n") + "\n",
      "reader.ts": 'export async function read(sc: any) { return sc.from("crafted_projection").select("*"); }\n',
    }, CRAFTED);
    assert.notEqual(code, 0, "a constant that exists only in a comment must not resolve a table name");
    assert.match(out, /producer worker\.ts writes neither crafted_projection/);
  });

  it("the crafted tree is not passing by being too small to judge", () => {
    // The checker refuses below MIN_FILES_SCANNED, and that refusal must be the
    // thing NOT happening in the cases above — otherwise every "FAILS" result
    // here is a vacuity refusal wearing the right exit code.
    const { out } = withTree("real2", {
      "worker.ts": 'export async function run(sc: any) { await sc.from("crafted_projection").insert({ a: 1 }); }\n',
      "reader.ts": 'export async function read(sc: any) { return sc.from("crafted_projection").select("*"); }\n',
    }, CRAFTED);
    assert.doesNotMatch(out, /VACUOUS/, "the crafted tree is below the file floor");
  });
});
