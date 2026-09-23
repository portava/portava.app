/**
 * check:flag-schema-prerequisites — the ratchet for flag-TRUE / schema-ABSENT.
 *
 * A rule that cannot be shown to fail is indistinguishable from no rule, so
 * most of this file is RED-PROOFING against fixtures small enough to reason
 * about, and then the real tree:
 *
 *   • a fixture with a flag ON over a missing column → `unguarded`, naming
 *     the column and the file:line that selects it; flag OFF → `latent`;
 *     registered → `guarded`;
 *   • a pure gate helper (`isFxOn()`) charges its CALLER's schema to the flag
 *     it reads; a callee that reads its own flag is a boundary the outer
 *     closure does not enter; a relative import is followed;
 *   • the select-list parser drops embedded resources whole (the first run
 *     of this scan charged `profiles` to five flags as a column of `posts`);
 *   • THE REAL TREE against THE REAL SNAPSHOT reproduces the founding case:
 *     `media_canonical_enabled` ON, `media_assets.captured_at` absent,
 *     registered → `guarded`. And the whole scan is non-vacuous.
 *   • the SCRIPT exits 0 on the committed state, and exits 1 the moment the
 *     snapshot says a latent flag was turned on — the exact event the ratchet
 *     exists to catch.
 *
 * Run: node --import tsx/esm --test src/test/flagSchemaPrerequisites.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { KNOWN } from "../scripts/checkFlagSchemaPrerequisites.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripComments } from "../scripts/lib/stripComments.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateFlags,
  evaluateRegistry,
  loadProductionSnapshot,
  scanFlagReads,
  selectListColumns,
} from "../lib/capability/prerequisitesCore.js";
import { CAPABILITIES } from "../lib/capability/registry.js";
import type { CapabilityDefinition } from "../lib/capability/schemaRequirement.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG_ROOT, "src");
const SCRIPT = join(SRC, "scripts", "checkFlagSchemaPrerequisites.ts");
const SNAPSHOT = join(SRC, "lib", "capability", "snapshots", "20260907-production-schema.json");

// ── Fixture tree ─────────────────────────────────────────────────────────────

let fixture: string;
before(() => {
  fixture = mkdtempSync(join(tmpdir(), "flag-schema-"));
  mkdirSync(join(fixture, "lib"), { recursive: true });
  mkdirSync(join(fixture, "routes"), { recursive: true });
  mkdirSync(join(fixture, "test"), { recursive: true });

  // A shared reader and a pure gate helper over a const-named flag.
  writeFileSync(join(fixture, "lib", "featureFlags.ts"), `
export async function isFlagEnabled(sc: any, flag: string): Promise<boolean> {
  const { data } = await sc.from("feature_flags").select("enabled").eq("flag", flag).maybeSingle();
  return Boolean(data?.enabled);
}
`);
  writeFileSync(join(fixture, "lib", "fxGate.ts"), `
import { isFlagEnabled } from "./featureFlags.js";
export const FX_FLAG = "fx_enabled";
export async function isFxOn(sc: any): Promise<boolean> { return isFlagEnabled(sc, FX_FLAG); }
`);
  // A writer module reached by import; one function is gated on its OWN flag.
  writeFileSync(join(fixture, "lib", "fxStore.ts"), `
import { isFlagEnabled } from "./featureFlags.js";
export async function writeFx(sc: any, row: { alpha: number }) {
  return sc.from("fx_table").insert({ alpha: row.alpha, beta: 1 });
}
export async function writeOther(sc: any) {
  if (!(await isFlagEnabled(sc, "other_enabled"))) return null;
  return sc.from("other_table").insert({ zeta: 1 });
}
`);
  // The route: direct literal read; gate-helper read; a nested gate.
  writeFileSync(join(fixture, "routes", "fx.ts"), `
import { isFlagEnabled } from "../lib/featureFlags.js";
import { isFxOn } from "../lib/fxGate.js";
import { writeFx, writeOther } from "../lib/fxStore.js";

export async function direct(sc: any) {
  if (!(await isFlagEnabled(sc, "fx_enabled"))) return null;
  const { data } = await sc.from("fx_table").select("id, alpha, beta, author:profiles(id, name)").eq("gamma", 1);
  await writeOther(sc);
  return data;
}
export async function viaHelper(sc: any) {
  if (!(await isFxOn(sc))) return null;
  return writeFx(sc, { alpha: 1 });
}
export async function neverGated(sc: any) {
  return sc.from("ungated_table").select("x");
}
`);
  writeFileSync(join(fixture, "test", "fx.test.ts"), `import { isFlagEnabled } from "../lib/featureFlags.js"; isFlagEnabled(null, "fx_enabled"); `);
});
after(() => rmSync(fixture, { recursive: true, force: true }));

function snapshotJson(over: { fxOn?: boolean; otherOn?: boolean; columns?: Record<string, string[]> } = {}) {
  return {
    projectRef: "fixture",
    capturedAt: "2026-09-07",
    tables: {
      feature_flags: ["flag", "enabled"],
      fx_table: ["id", "alpha", "gamma"], // no beta
      other_table: ["id"], // no zeta
      ungated_table: ["x"],
      profiles: ["id", "name"],
      ...(over.columns ?? {}),
    },
    functions: [],
    enums: [],
    flags: { fx_enabled: over.fxOn ?? true, other_enabled: over.otherOn ?? false },
  };
}

function loadFixtureSnapshot(over: Parameters<typeof snapshotJson>[0] = {}) {
  const p = join(fixture, `snap-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(snapshotJson(over)));
  return loadProductionSnapshot(p);
}

const NO_REGISTRY: Readonly<Record<string, CapabilityDefinition>> = {};

describe("selectListColumns (pure)", () => {
  it("drops embedded resources whole, resolves aliases, strips casts and modifiers", () => {
    assert.deepEqual(selectListColumns("id, alpha, author:profiles(id, name), beta::text, rel!inner(x), count:beta"), ["id", "alpha", "beta", "beta"]);
    assert.deepEqual(selectListColumns("*, profiles(*)"), []);
    assert.deepEqual(selectListColumns("a, b->>c, d.e"), ["a"]);
  });
});

describe("the scan on a fixture tree", () => {
  it("finds every read, resolves a const flag through an import, and skips test files", () => {
    const scan = scanFlagReads(fixture, []);
    const reads = scan.reads.map((r) => `${r.file}:${r.line} ${r.flag} (${r.reader})`).sort();
    assert.deepEqual(reads, [
      "lib/fxGate.ts:4 fx_enabled (isFlagEnabled)",
      "lib/fxStore.ts:7 other_enabled (isFlagEnabled)",
      // These two are in STRING sort order, which is what .sort() above produces:
      // "…fx.ts:13…" precedes "…fx.ts:7…" because '1' < '7'. Line 13, not 14 —
      // the fixture template literal opens with a newline, so its first content
      // line is blank and every line below shifts by one.
      "routes/fx.ts:13 fx_enabled (via isFxOn())",
      "routes/fx.ts:7 fx_enabled (isFlagEnabled)",
    ]);
    // The shared reader's own `.eq("flag", flag)` is unresolvable, as it should be.
    assert.deepEqual(scan.unresolvedReads.map((u) => u.file), ["lib/featureFlags.ts"]);
  });

  it("charges the closure's schema to the flag, across a relative import, and STOPS at a nested gate", () => {
    const scan = scanFlagReads(fixture, []);
    const viaHelper = scan.reads.find((r) => r.reader === "via isFxOn()")!;
    assert.deepEqual(viaHelper.refs.map((x) => x.key).sort(), ["fx_table", "fx_table.alpha", "fx_table.beta"]);
    assert.equal(viaHelper.refs.find((x) => x.key === "fx_table.beta")!.file, "lib/fxStore.ts", "the ref is attributed to the file that names it");

    const direct = scan.reads.find((r) => r.file === "routes/fx.ts" && r.reader === "isFlagEnabled")!;
    const keys = direct.refs.map((x) => x.key);
    assert.ok(keys.includes("fx_table.gamma"), "filter columns count");
    assert.ok(!keys.includes("fx_table.profiles") && !keys.includes("fx_table.author"), "an embedded resource is not a column");
    assert.ok(!keys.includes("other_table") && !keys.includes("other_table.zeta"), "writeOther reads its own flag: a boundary, not charged to fx_enabled");
    assert.ok(!keys.includes("ungated_table"), "neverGated is not in any closure");
  });

  it("RED: flag ON + column absent + unregistered → unguarded, naming the object and its file:line", () => {
    const findings = evaluateFlags(scanFlagReads(fixture, []), loadFixtureSnapshot(), NO_REGISTRY);
    const fx = findings.find((f) => f.flag === "fx_enabled")!;
    assert.equal(fx.classification, "unguarded");
    assert.equal(fx.production, "on");
    // fx_table.beta is referenced TWICE in the fixture and both are real: the
    // direct read's select at routes/fx.ts:8, and writeFx's insert at
    // lib/fxStore.ts:4 (reached through the isFxOn gate). A missing key is
    // reported once, at the first reference in scan order, which is the direct
    // read. Per-READ attribution is asserted separately above and correctly
    // names lib/fxStore.ts for the viaHelper read.
    // Worth improving later: listing every referencing site would be strictly
    // more useful than naming one, since a human fixing this wants both.
    assert.deepEqual(fx.missing.map((m) => `${m.key} @ ${m.file}:${m.line}`), ["fx_table.beta @ routes/fx.ts:8"]);
    const other = findings.find((f) => f.flag === "other_enabled")!;
    assert.equal(other.classification, "latent", "off in production: one UPDATE away");
    assert.deepEqual(other.missing.map((m) => m.key), ["other_table.zeta"]);
  });

  it("GREEN when the column exists in production; LATENT when the flag is off; GUARDED when registered", () => {
    const scan = scanFlagReads(fixture, []);
    const present = evaluateFlags(scan, loadFixtureSnapshot({ columns: { fx_table: ["id", "alpha", "beta", "gamma"] } }), NO_REGISTRY);
    assert.equal(present.find((f) => f.flag === "fx_enabled")!.classification, "ok");

    const off = evaluateFlags(scan, loadFixtureSnapshot({ fxOn: false }), NO_REGISTRY);
    assert.equal(off.find((f) => f.flag === "fx_enabled")!.classification, "latent");

    const registered: Record<string, CapabilityDefinition> = {
      fx_enabled: { flag: "fx_enabled", providedBy: ["9999_fx.sql"], requires: { tables: { fx_table: { columns: ["beta"] } } }, consumers: ["lib/fxStore.ts"], note: "fixture" },
    };
    const guarded = evaluateFlags(scan, loadFixtureSnapshot(), registered);
    assert.equal(guarded.find((f) => f.flag === "fx_enabled")!.classification, "guarded");
  });

  it("evaluateRegistry: a consumer that does not reach lib/capability, or a requirement no migration declares, is reported", () => {
    const scan = scanFlagReads(fixture, []);
    const registry: Record<string, CapabilityDefinition> = {
      fx_enabled: { flag: "fx_enabled", providedBy: ["9999_fx.sql"], requires: { tables: { fx_table: { columns: ["beta", "typo"] } } }, consumers: ["lib/fxStore.ts", "lib/missing.ts"], note: "fixture" },
    };
    const [r] = evaluateRegistry(
      registry,
      loadFixtureSnapshot(),
      scan,
      { table: () => true, column: (_t, c) => c !== "typo", fn: () => true },
      (rel) => { try { return readFileSync(join(fixture, rel), "utf8"); } catch { return null; } },
    );
    assert.deepEqual(r!.missingInProduction, ["fx_table.beta", "fx_table.typo"]);
    assert.deepEqual(r!.undeclared, ["fx_table.typo"]);
    assert.deepEqual(r!.badConsumers, ["lib/fxStore.ts (does not reach lib/capability)", "lib/missing.ts (not found)"]);
    assert.equal(r!.readSites, 3);
  });
});

describe("the real tree against the real snapshot", () => {
  it("is non-vacuous and reproduces the founding case as GUARDED", () => {
    const snap = loadProductionSnapshot(SNAPSHOT);
    assert.equal(snap.projectRef, "ajrurzioarfkagpuxfnb");
    assert.ok(snap.tables.size > 400 && snap.flags.size > 150);
    assert.equal(snap.tables.get("media_assets")!.has("captured_at"), false, "production has never had 2250");
    assert.equal(snap.flags.get("media_canonical_enabled"), true);

    const scan = scanFlagReads(SRC);
    assert.ok(scan.reads.length > 100, `only ${scan.reads.length} reads`);
    const findings = evaluateFlags(scan, snap, CAPABILITIES);
    const media = findings.find((f) => f.flag === "media_canonical_enabled")!;
    assert.equal(media.classification, "guarded");
    assert.ok(media.missing.some((m) => m.key === "media_assets.captured_at" && m.file === "lib/mediaAssets.ts"));

    // And at least one unguarded instance exists today — the enumeration is
    // what the coordinator asked for, and a scan that found none would be
    // suspect, not clean.
    assert.ok(findings.some((f) => f.classification === "unguarded"), "expected at least one unguarded flag (intel_claim_projection_crowd et al.)");
  });
});

describe("the script", () => {
  const run = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], { cwd: PKG_ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 });

  it("exits 0 on the committed snapshot, and reports every KNOWN entry it carries", () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^OK — /m);
    // DERIVED, not hardcoded. This used to require `GUARDED … (1)` naming
    // media_canonical_enabled; 2470 landed on 2026-09-16, that entry was struck as
    // STALE, and the assertion started describing a section that no longer exists.
    // Every KNOWN entry must still be NAMED in the output — an exemption the report
    // does not print is an exemption nobody re-reads — but which bucket it falls in
    // is the script's to decide and changes as migrations land.
    const known = Object.keys(KNOWN);
    // KNOWN REACHED ZERO ON 2026-09-17 and that is the ratchet SUCCEEDING, not a
    // hole in this case. The script's own header says entries classified
    // `unguarded` "MUST reach zero", and the last two — safe_return_enabled and
    // safe_return_trusted_circle_alerts_enabled — were struck because 2780/2794
    // landed on production, which is the one sanctioned way this list shrinks.
    //
    // So the assertion forks instead of demanding a non-empty list. Empty is a
    // state with something to prove too: that the script still exits 0 and still
    // REPORTS the empty ratchet rather than printing nothing and leaving a reader
    // to guess whether it ran. And the moment an entry is added back, the loop
    // below re-arms itself with no edit here.
    if (known.length === 0) {
      assert.match(r.stdout, /^OK — 0 unguarded \(all known\)/m,
        "KNOWN is empty and the script does not say so — an empty ratchet that prints nothing is indistinguishable from a ratchet that did not run");
    }
    for (const flag of known) {
      assert.ok(r.stdout.includes(flag), `KNOWN.${flag} is carried but never printed`);
    }
  });

  it("exits 1 the moment the snapshot says a latent flag was turned on (wall_enabled)", () => {
    const edited = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    assert.equal(edited.flags.wall_enabled, false, "premise: wall_enabled is off in production");
    edited.flags.wall_enabled = true;
    const p = join(fixture, "edited-snapshot.json");
    writeFileSync(p, JSON.stringify(edited));
    const r = run({ FLAG_SCHEMA_SNAPSHOT: p });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /NEW INSTANCE OF THE CLASS: wall_enabled is ON in production/);
  });

  it("does not call process.exit, because that drops the FAIL block it just wrote", () => {
    // THE CASE ABOVE WAS "FLAKY" AND WAS NOT. It went red on CI while passing in
    // isolation, and the reason is in this script's exit path rather than in
    // anything it measures.
    //
    // Node's stdout is ASYNCHRONOUS when it is a pipe, which it is whenever the
    // script is spawned rather than run by a human — `run()` above spawns it
    // with pipes, and so does every CI step that captures output.
    // `process.exit()` does not wait for a queued write. The FAIL block is the
    // LAST thing the script writes, so it is the thing that goes missing, and
    // the exit code stays 1 either way: a failure arrives with no reason
    // attached, and whether it does depends on machine load.
    //
    // Measured before the fix, six spawns under CPU load: four carried 27,662
    // bytes and the FAIL block, two carried 20,695 and 21,546 with the block
    // gone, all six exited 1. After it: six of six complete.
    //
    // This case pins the fix rather than the symptom, because the symptom is
    // load-dependent and a test that reproduces it only sometimes is a test
    // that fails sometimes. `process.exitCode` plus a return is the spelling
    // that lets the writes land; `process.exit` is the one that does not.
    // stripComments, not the raw text: the docblock this fix added SAYS
    // "process.exit()", and a guard that reads its own explanation as the thing
    // it forbids is the exact bug src/scripts/lib/stripComments.ts exists to
    // stop. Its conservative direction is the right one here too — it can only
    // remove text, so this can report a false clean, never a false call.
    const src = stripComments(readFileSync(SCRIPT, "utf8"));
    const calls = [...src.matchAll(/process\.exit\s*\(/g)];
    assert.equal(
      calls.length,
      0,
      `checkFlagSchemaPrerequisites.ts calls process.exit ${calls.length} time(s); ` +
        "set process.exitCode and return instead, so stdout is flushed before Node exits",
    );
    // And the exit code still has to be real, not merely un-truncated.
    assert.equal(run({ FLAG_SCHEMA_SNAPSHOT: join(fixture, "does-not-exist.json") }).status, 2);
  });

  it("exits 1 when a KNOWN entry goes stale (the migration lands in production)", () => {
    // THE SUBJECT IS DERIVED FROM `KNOWN`, and that is the point of this rewrite.
    // This case has now outlived its subject TWICE: it first pushed
    // trust_profiles.evidence_weight until 2371 landed, was repointed at
    // media_canonical_enabled, and 2470 landed on 2026-09-16. Each repoint named
    // another real entry, so the case was guaranteed to break again the next time
    // the ratchet did its job. Naming no entry at all fixes that.
    //
    // It is still not deleted, for the reason the previous author gave and which
    // still holds: deleting it would retire the proof that the ratchet notices when
    // a migration lands — the ONLY way this list is allowed to shrink.
    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

    // Find any KNOWN entry naming a `table.column` the snapshot really lacks, and
    // make that column present — i.e. simulate the migration landing.
    // An entry's objects are either `table` or `table.column`, and the snapshot may
    // be missing the column OR the whole table — the safe_return entries are the
    // latter (trip_subgroups does not exist in production at all). Both shapes are
    // "the migration has not landed", so both are usable, and creating the table is
    // what landing it would do.
    let subject: { flag: string; table: string; column: string } | null = null;
    for (const [flag, entry] of Object.entries(KNOWN)) {
      for (const obj of entry.objects ?? []) {
        const [table, column] = String(obj).split(".");
        if (!table) continue;
        const cols = snap.tables?.[table];
        if (column) {
          if (!Array.isArray(cols) || !cols.includes(column)) {
            subject = { flag, table, column };
            break;
          }
        } else if (!Array.isArray(cols)) {
          // A bare table name: landing it means the table exists with an id.
          subject = { flag, table, column: "id" };
          break;
        }
      }
      if (subject) break;
    }
    // RETIRED DELIBERATELY WHILE KNOWN IS EMPTY, which is what the message below
    // asked the next author to do rather than leave this passing vacuously.
    //
    // The STALE rule needs a real KNOWN entry naming an object production lacks,
    // and as of 2026-09-17 there are no KNOWN entries at all. There is no honest
    // way to exercise the rule without one: a synthetic entry would prove that a
    // fixture works, not that the shipped list is watched.
    //
    // It is SKIPPED, not deleted, and the distinction is the whole point. The
    // search above still runs on every invocation, so the day an entry is added
    // back this case re-arms itself and proves the rule again with no edit here.
    // Deleting it would retire the proof that the ratchet notices when a
    // migration lands — the ONLY way this list is allowed to shrink — and that
    // proof is exactly what makes an empty KNOWN trustworthy rather than merely
    // convenient.
    if (!subject) {
      assert.equal(Object.keys(KNOWN).length, 0,
        "no KNOWN entry names an object absent from the snapshot, yet KNOWN is NOT empty — " +
        "that means every remaining entry is already stale and the ratchet should have failed. " +
        "This case is only allowed to stand down when there is nothing left to guard.");
      return;
    }

    if (!Array.isArray(snap.tables[subject!.table])) snap.tables[subject!.table] = [];
    if (!snap.tables[subject!.table].includes(subject!.column)) {
      snap.tables[subject!.table].push(subject!.column);
    }
    const p = join(fixture, "applied-snapshot.json");
    writeFileSync(p, JSON.stringify(snap));
    const r = run({ FLAG_SCHEMA_SNAPSHOT: p });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, new RegExp(`STALE: KNOWN\\.${subject!.flag}`));
    assert.ok(r.stdout.includes(subject!.column), `the report must name ${subject!.column}`);
  });
});
