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
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("exits 0 on the committed snapshot and reports the guarded media case", () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^OK — /m);
    assert.match(r.stdout, /GUARDED[^\n]*\(1\)\n  media_canonical_enabled/);
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

  it("exits 1 when a KNOWN entry goes stale (the migration lands in production)", () => {
    // This case used to push trust_profiles.evidence_weight/_count, because
    // KNOWN.trust_engine_enabled listed them as absent. Migration 2371 then
    // landed in production, the ratchet reported that entry STALE, the entry was
    // struck — and this case started asserting a message that can no longer be
    // produced, so it has been red ever since. The rule it exists to prove is
    // fine; the fixture had outlived its subject.
    //
    // It is repointed at the one KNOWN entry that remains rather than deleted,
    // because deleting it would retire the proof that the ratchet notices when a
    // migration lands — which is the ONLY way this list is allowed to shrink.
    const edited = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    assert.ok(
      !edited.tables.media_assets.includes("captured_at"),
      "premise: media_assets.captured_at is still absent in production (owner decision MEDIA_CANONICAL_FLAG)",
    );
    edited.tables.media_assets.push("captured_at");
    const p = join(fixture, "applied-snapshot.json");
    writeFileSync(p, JSON.stringify(edited));
    const r = run({ FLAG_SCHEMA_SNAPSHOT: p });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /STALE: KNOWN\.media_canonical_enabled/);
    assert.match(r.stdout, /captured_at/);
  });
});
