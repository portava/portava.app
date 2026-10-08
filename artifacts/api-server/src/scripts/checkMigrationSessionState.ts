/**
 * check:migration-session-state — no migration block that runs as its OWN
 * request reads state another request left behind (a temp table, a session
 * setting), and no block certify re-runs after the commit carries an "I have
 * already run" refusal.
 *
 * The incident, the two processes that run a block on its own, and the three
 * rules are in src/scripts/lib/migrationSessionState.ts. In one line: main
 * 2de186f820's live apply stopped at 3974 because its post-COMMIT
 * postcondition read pg_temp._k3974_after, which the applier's separate
 * request could never see; every pre-merge tier (one psql session per file)
 * passed it.
 *
 * Reads only files on disk. No database, no credentials, no network.
 *
 * EXEMPT, BY CONSTRUCTION: a file ORDER_OVERRIDES.json SKIPS. The applier, the
 * local harness and certify never run it, so no block of it is ever a
 * separate request. Each is named in the output with what supersedes it.
 *
 * KNOWN (shrink-only): findings in files that are already applied on
 * portava-ci, so they cannot be edited. Each entry is a REAL defect, not a
 * permission: it fails certify:migrations stage 4 on any database whose
 * certification run applied that file (a fresh one — portava-beta), and it is
 * listed here so that a new instance fails this check while these stay
 * visible. An entry whose finding is gone is STALE and fails the check: delete
 * it in the same change.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:migration-session-state
 *
 * Exit 0 — no finding outside KNOWN, no stale KNOWN entry
 * Exit 1 — a finding, or a stale entry
 * Exit 2 — the migration tree or the applier could not be read
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSessionStateFindings,
  findingKey,
  type MigrationClassifier,
  type SessionStateFinding,
} from "./lib/migrationSessionState.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = process.env.MIGRATION_SESSION_STATE_DIR ?? resolve(__dir, "../migrations");
/** The applier: its classifier decides what runs after the COMMIT, its override reader what is skipped. */
const APPLIER = resolve(__dir, "../../../../scripts/src/apply-migrations.ts");

/**
 * Real findings in applied files (portava-ci), measured 2026-10-08 on the
 * PGlite full-chain replay by re-running each block in a fresh session
 * (DISCARD ALL), as certify stage 4 sends it. Shrink-only.
 */
export const KNOWN: ReadonlyArray<{ file: string; rule: SessionStateFinding["rule"]; name: string; why: string }> = [
  {
    file: "2570_intel_live_scope_admin_surface_flag.sql",
    rule: "temp-table",
    name: "_m2570_before",
    why: 'in-body assertion block reads the ON COMMIT DROP snapshot; correct under the applier (same transaction); a stage-4 re-run raises \'relation "_m2570_before" does not exist\'.',
  },
  {
    file: "2745_layover_recommendation_travel_provenance.sql",
    rule: "session-guc",
    name: "portava.m2745_labelled_before",
    why: "in-body assertion block reads the count an earlier block stored with set_config(..., true); a stage-4 re-run reads NULL and raises 'travel_time_source went from <NULL> to 0 labelled row(s)'.",
  },
  {
    file: "2798_trip_kernel_recurrence_family.sql",
    rule: "temp-table",
    name: "_k2798_before",
    why: 'in-body $post$ block reads the ON COMMIT DROP before-counts (3974 copied this method and moved the read after the COMMIT, which is what broke the live apply); a stage-4 re-run raises \'relation "_k2798_before" does not exist\'.',
  },
];

interface ApplierSurface {
  classifyMigration: MigrationClassifier;
  readOrderOverrides: (dir?: string) => Array<{ skip?: string; superseded_by?: string[] }>;
}

let applier: ApplierSurface;
let files: string[];
try {
  applier = (await import(APPLIER)) as ApplierSurface;
  files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
} catch (err) {
  console.error(`check:migration-session-state: cannot read the migration tree or the applier: ${(err as Error).message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`check:migration-session-state: no migration files in ${MIGRATIONS_DIR} — refusing to report a pass over nothing.`);
  process.exit(2);
}

let skips: Map<string, string[]>;
try {
  skips = new Map(
    applier
      .readOrderOverrides(MIGRATIONS_DIR)
      .filter((o) => typeof o.skip === "string")
      .map((o) => [o.skip as string, o.superseded_by ?? []]),
  );
} catch (err) {
  console.error(`check:migration-session-state: ORDER_OVERRIDES.json could not be read: ${(err as Error).message}`);
  process.exit(2);
}

let blockCount = 0;
let postPhase = 0;
let certifyRuns = 0;
const findings: SessionStateFinding[] = [];
for (const f of files) {
  if (skips.has(f)) continue;
  const { blocks, findings: fs } = findSessionStateFindings(f, readFileSync(join(MIGRATIONS_DIR, f), "utf8"), applier.classifyMigration);
  blockCount += blocks.length;
  postPhase += blocks.filter((b) => b.runBy.includes("applier post-phase")).length;
  certifyRuns += blocks.filter((b) => b.runBy.includes("certify stage 4")).length;
  findings.push(...fs);
}

const knownKeys = new Map(KNOWN.map((k) => [findingKey(k), k]));
const foundKeys = new Set(findings.map(findingKey));
const fresh = findings.filter((f) => !knownKeys.has(findingKey(f)));
const stale = KNOWN.filter((k) => !foundKeys.has(findingKey(k)));

console.log("check:migration-session-state — a block sent as its own request reads no state another request left behind");
console.log(
  `  scanned ${files.length - skips.size} migration file(s): ${blockCount} separately-run block(s) ` +
    `(${postPhase} run by the applier after the COMMIT, ${certifyRuns} re-run by certify stage 4)`,
);
for (const [f, by] of skips) {
  if (files.includes(f)) console.log(`  · ${f}: SKIPPED by ORDER_OVERRIDES.json (never run; superseded by ${by.join(", ")})`);
}
for (const k of KNOWN) {
  if (foundKeys.has(findingKey(k))) console.log(`  · KNOWN ${k.file} [${k.rule}: ${k.name}] — ${k.why}`);
}

const describe = (f: SessionStateFinding) => {
  const where = `${f.file}:${f.line} (${f.runBy.join(" + ")})`;
  switch (f.rule) {
    case "temp-table":
      return (
        `${where} reads temp table "${f.name}", which the block does not create and does not probe for. ` +
        "That request is a NEW session: the table is not there. Recompute the value from the catalog/data " +
        `in this block, or guard the read with to_regclass('pg_temp.${f.name}') as 3390/3460/3504 do.`
      );
    case "session-guc":
      return (
        `${where} reads setting "${f.name}" with current_setting(), and the file sets it OUTSIDE this block. ` +
        "The value lives in the request that set it. Recompute it in this block."
      );
    case "second-apply-guard":
      return (
        `${where} raises "${f.name}" but is not tagged $pre$, so certify stage 4 re-runs it after the commit, ` +
        "where an already-applied guard is false by construction. Tag it DO $pre$."
      );
  }
};

if (fresh.length > 0 || stale.length > 0) {
  for (const f of fresh) console.error(`  ✖ ${describe(f)}`);
  for (const k of stale) {
    console.error(
      `  ✖ STALE KNOWN entry ${k.file} [${k.rule}: ${k.name}]: the finding is gone. Delete the entry in ` +
        "src/scripts/checkMigrationSessionState.ts in the same change (the list only shrinks).",
    );
  }
  console.error(
    `check:migration-session-state FAILED — ${fresh.length} finding(s), ${stale.length} stale KNOWN entr${stale.length === 1 ? "y" : "ies"}.`,
  );
  process.exit(1);
}

console.log(
  `check:migration-session-state PASSED — ${blockCount} separately-run block(s) inspected; ` +
    `${findings.length} KNOWN finding(s) in applied files, no new one.`,
);
process.exit(0);
