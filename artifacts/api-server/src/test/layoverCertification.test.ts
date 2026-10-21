/**
 * census-layover L218 — check:layover-certification (spec §21: "Certification
 * must prove hard invariants across deterministic scenarios, synthetic
 * disruption, replay, database authorization, and end-to-end lifecycle
 * behavior").
 *
 * Two halves:
 *   - the REAL-TREE CONTROL: the checker is spawned on this repository with no
 *     seam and must exit 0, having inspected every entry (this is the reach the
 *     guard registry records for it);
 *   - each rule, planted: a world or manifest with one defect, and the rule that
 *     must name it — and nothing else.
 *
 * Run: node --import tsx/esm --test src/test/layoverCertification.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LAYOVER_CERTIFICATION, type CertificationEntry } from "../services/airport/layoverCertification.js";
import {
  CERTIFICATION_DOC,
  DOC_BEGIN,
  DOC_END,
  evaluateCertification,
  renderCertificationTable,
  type CertificationWorld,
} from "../scripts/checkLayoverCertification.js";

const PKG = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");

describe("L218 — the real tree", () => {
  it("check:layover-certification exits 0 on this repository and says how much it inspected", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx/esm", "src/scripts/checkLayoverCertification.ts"], { cwd: PKG, encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const m = /(\d+) entries inspected across 5 proof classes/.exec(run.stdout);
    assert.ok(m, run.stdout);
    assert.equal(Number(m[1]), LAYOVER_CERTIFICATION.length);
  });

  it("6. THE DOCUMENT IS THE DATA: a copy with one cell edited by hand fails; an untouched copy passes", () => {
    const doc = readFileSync(resolve(REPO, CERTIFICATION_DOC), "utf8");
    const dir = mkdtempSync(join(tmpdir(), "layover-cert-"));
    const same = join(dir, "same.md"), drifted = join(dir, "drifted.md");
    writeFileSync(same, doc);
    writeFileSync(drifted, doc.replace("| HI-1 | L47 |", "| HI-1 | L47, L48 |"));
    const run = (p: string) => spawnSync(process.execPath, ["--import", "tsx/esm", "src/scripts/checkLayoverCertification.ts"], { cwd: PKG, encoding: "utf8", env: { ...process.env, LAYOVER_CERTIFICATION_DOC: p } });
    const ok = run(same);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = run(drifted);
    assert.equal(bad.status, 1, bad.stdout);
    assert.match(bad.stderr, /does not carry the current certification table/);
  });

  it("the committed document carries the table rendered from the data", () => {
    const doc = readFileSync(resolve(REPO, CERTIFICATION_DOC), "utf8");
    assert.ok(doc.includes(DOC_BEGIN) && doc.includes(DOC_END), "markers present");
    const between = doc.slice(doc.indexOf(DOC_BEGIN) + DOC_BEGIN.length, doc.indexOf(DOC_END)).trim();
    assert.match(between, /^### deterministic scenarios — /);
    for (const e of LAYOVER_CERTIFICATION) assert.ok(between.includes(`| ${e.id} |`), `${e.id} is in the document`);
  });
});

// ── planted worlds ───────────────────────────────────────────────────────────

const FILE = "artifacts/api-server/src/test/layoverPlanted.test.ts";
const DBFILE = "artifacts/api-server/src/test/db/layoverPlanted.db.test.ts";
const APPFILE = "travel-buddy-standalone/src/components/layover/__tests__/Planted.component.test.tsx";
const TITLE = "the planted claim holds";

function world(over: Partial<CertificationWorld> = {}, files: Record<string, string> = {}): CertificationWorld {
  const all: Record<string, string> = { [FILE]: `it("${TITLE}")`, [DBFILE]: `it("${TITLE}")`, [APPFILE]: `it('${TITLE}')`, ...files };
  return {
    readRepoFile: (p) => (p in all ? all[p]! : null),
    apiTestScript: "node --test src/test/layoverPlanted.test.ts",
    localDbRunner: 'FILES=$(ls src/test/db/*.db.test.ts)',
    clientComponentScript: "jest --testPathPattern='\\.component\\.test\\.'",
    migrationFiles: ["2992_layover_tables.sql", "3640_flags.sql"],
    migrationSql: "INSERT INTO feature_flags VALUES ('layover_constraints_enabled', false);",
    baselineUnproved: [],
    productionLedgerNames: ["2992_layover_tables"],
    productionFlags: { layover_constraints_enabled: true },
    productionRecords: "planted records",
    ...over,
  };
}

/** A complete, valid manifest over the planted files: 5 classes, HI-1..7, S-L219..233. */
function manifest(): CertificationEntry[] {
  const proof = [{ file: FILE, test: TITLE, tier: "node" as const }];
  const out: CertificationEntry[] = [];
  ["L47", "L48", "L49", "L50", "L51", "L52", "L53"].forEach((c, i) => out.push({ id: `HI-${i + 1}`, class: "deterministic_scenarios", census: [c], claim: "c", proof, production: {} }));
  for (let n = 219; n <= 233; n++) out.push({ id: `S-L${n}`, class: "deterministic_scenarios", census: [`L${n}`], claim: "c", proof, production: {} });
  out.push({ id: "D-1", class: "synthetic_disruption", census: ["L238"], claim: "c", proof, production: {} });
  out.push({ id: "R-1", class: "replay", census: ["L240"], claim: "c", proof, production: {} });
  out.push({ id: "A-1", class: "database_authorization", census: ["L236"], claim: "c", proof: [{ file: DBFILE, test: TITLE, tier: "local_db" }], production: {} });
  out.push({ id: "E-1", class: "e2e_lifecycle", census: ["L239"], claim: "c", proof: [{ file: APPFILE, test: TITLE, tier: "client" }], production: {} });
  return out;
}

const problemsOf = (m: CertificationEntry[], w = world()) => evaluateCertification(m, w).problems;

describe("L218 — each rule names its own defect, and only it", () => {
  it("CONTROL: the planted manifest over the planted world is clean", () => {
    assert.deepEqual(problemsOf(manifest()), []);
  });

  it("1. COMPLETE: a proof class with no entry", () => {
    assert.deepEqual(problemsOf(manifest().filter((e) => e.class !== "replay")), ["proof class replay has no entry — §21 names five classes"]);
  });

  it("1. COMPLETE: a hard invariant dropped, or certifying the wrong row", () => {
    assert.deepEqual(problemsOf(manifest().filter((e) => e.id !== "HI-4")), ["§6.1 hard invariant HI-4 is missing"]);
    assert.deepEqual(problemsOf(manifest().map((e) => (e.id === "HI-2" ? { ...e, census: ["L99"] } : e))), ["HI-2 must certify L48"]);
  });

  it("1. COMPLETE: a §21.1 scenario dropped, or listed twice", () => {
    assert.deepEqual(problemsOf(manifest().filter((e) => e.id !== "S-L230")), ["§21.1 scenario S-L230 appears 0 times, not once"]);
    const twice = [...manifest(), { ...manifest().find((e) => e.id === "S-L229")! }];
    assert.deepEqual(problemsOf(twice), ["duplicate id S-L229", "§21.1 scenario S-L229 appears 2 times, not once"]);
  });

  it("2. CITED: a proof file that does not exist", () => {
    const m = manifest().map((e) => (e.id === "D-1" ? { ...e, proof: [{ file: "artifacts/api-server/src/test/gone.test.ts", test: TITLE, tier: "node" as const }] } : e));
    assert.deepEqual(problemsOf(m), ["D-1: artifacts/api-server/src/test/gone.test.ts does not exist"]);
  });

  it("2. CITED: a test title that is not in the file", () => {
    const m = manifest().map((e) => (e.id === "R-1" ? { ...e, proof: [{ file: FILE, test: "a title someone renamed", tier: "node" as const }] } : e));
    assert.deepEqual(problemsOf(m), [`R-1: "a title someone renamed" is not a title in ${FILE}`]);
  });

  it("3. EXECUTED: a node proof nothing runs", () => {
    const problems = problemsOf(manifest(), world({ apiTestScript: "node --test src/test/somethingElse.test.ts" }));
    assert.ok(problems.length > 0 && problems.every((p) => /layoverPlanted\.test\.ts is not in artifacts\/api-server package\.json "test" — nothing runs it$/.test(p)), problems.join("\n"));
  });

  it("3. EXECUTED: the local-db runner stops globbing the db suites", () => {
    assert.deepEqual(problemsOf(manifest(), world({ localDbRunner: "FILES=src/test/db/one.db.test.ts" })), ["A-1: scripts/local-db/run-tests.sh no longer runs src/test/db/*.db.test.ts"]);
  });

  it("3. EXECUTED: a client proof that is not a component test the app's jest selects", () => {
    const m = manifest().map((e) => (e.id === "E-1" ? { ...e, proof: [{ file: "travel-buddy-standalone/src/lib/plain.test.ts", test: TITLE, tier: "client" as const }] } : e));
    const problems = problemsOf(m, world({}, { "travel-buddy-standalone/src/lib/plain.test.ts": `it('${TITLE}')` }));
    assert.deepEqual(problems, ["E-1: travel-buddy-standalone/src/lib/plain.test.ts is not a component test the app's jest run selects"]);
  });

  it("4. REAL DEPENDENCIES: a migration with no file, a flag no migration seeds", () => {
    const m = manifest().map((e) => (e.id === "S-L222" ? { ...e, production: { migrations: ["9999"], flags: ["made_up_flag"] } } : e));
    assert.deepEqual(problemsOf(m), ["S-L222: migration 9999 names 0 files under src/migrations, not one", "S-L222: flag made_up_flag is seeded by no migration"]);
  });

  it("5. MONOTONE: an unproved entry not in the baseline", () => {
    const m = manifest().map((e) => (e.id === "E-1" ? { ...e, proof: null, unprovedBecause: "no lifecycle suite" } : e));
    assert.deepEqual(problemsOf(m), ["E-1 is unproved and not in the baseline — the unproved set may only shrink"]);
    assert.deepEqual(problemsOf(m, world({ baselineUnproved: ["E-1"] })), [], "allowed while the baseline names it");
  });

  it("5. MONOTONE: a baseline that still names an entry that is now proved is stale", () => {
    assert.deepEqual(problemsOf(manifest(), world({ baselineUnproved: ["E-1"] })), ["baseline still names E-1 as unproved, but it is proved now — remove it (the shrink is recorded by that edit)"]);
  });

  it("an unproved entry must say why", () => {
    const m = manifest().map((e) => (e.id === "E-1" ? { ...e, proof: null } : e));
    assert.ok(problemsOf(m, world({ baselineUnproved: ["E-1"] })).includes("E-1 is unproved and does not say why"));
  });
});

describe("L218 — the report: proved in full or in part, and production dependencies", () => {
  it("gaps make an entry 'part'; a missing proof 'none'", () => {
    const m = manifest().map((e) => (e.id === "S-L223" ? { ...e, gaps: "expanded options" } : e.id === "E-1" ? { ...e, proof: null, unprovedBecause: "x" } : e));
    const r = evaluateCertification(m, world({ baselineUnproved: ["E-1"] }));
    assert.equal(r.entries.find((x) => x.id === "S-L223")?.proved, "part");
    assert.equal(r.entries.find((x) => x.id === "E-1")?.proved, "none");
    assert.equal(r.entries.find((x) => x.id === "HI-1")?.proved, "full");
  });

  it("dependencies are met only when every migration is in the ledger, every flag is ON, and nothing else waits", () => {
    const needs = (production: CertificationEntry["production"]) => {
      const m = manifest().map((e) => (e.id === "S-L222" ? { ...e, production } : e));
      return evaluateCertification(m, world()).entries.find((x) => x.id === "S-L222")!;
    };
    assert.deepEqual(needs({ migrations: ["2992"], flags: ["layover_constraints_enabled"] }), { id: "S-L222", proved: "full", dependenciesMet: true, blockers: [] });
    assert.deepEqual(needs({ migrations: ["3640"] }).blockers, ["migration 3640 not applied"]);
    assert.deepEqual(needs({ flags: ["layover_constraints_enabled"] }).dependenciesMet, true);
    const off = evaluateCertification(manifest().map((e) => (e.id === "S-L222" ? { ...e, production: { flags: ["layover_constraints_enabled"] } } : e)), world({ productionFlags: {} })).entries.find((x) => x.id === "S-L222")!;
    assert.deepEqual(off.blockers, ["flag layover_constraints_enabled not ON"]);
    assert.deepEqual(needs({ ownerRuling: "#9", external: "a feed", data: "curation" }).blockers, ["owner ruling #9", "external: a feed", "data: curation"]);
  });

  it("the rendered table is deterministic and carries every entry, its gaps and its needs", () => {
    const m = manifest().map((e) => (e.id === "S-L223" ? { ...e, gaps: "expanded options are not proved" } : e));
    const r = evaluateCertification(m, world());
    const a = renderCertificationTable(m, r, "planted records");
    assert.equal(a, renderCertificationTable(m, r, "planted records"));
    assert.match(a, /\| S-L223 \| L223 \| c \| .* \| expanded options are not proved \| no dependency this data names \|/);
    for (const e of m) assert.ok(a.includes(`| ${e.id} |`));
  });
});
