/**
 * Migration-ledger gate  (`check:migration-ledger`)
 *
 * Compares the migration files in src/migrations/ against
 * public.schema_migration_ledger on the target database, and fails when the
 * database has not seen what this branch contains.
 *
 *
 * THE FAILURE THIS IS WRITTEN AGAINST (2026-08-31)
 * ================================================
 * Five migrations — 2220, 2223, 2224, 2250, 2252 — were merged to main and
 * never applied to the CI database. Nothing in the merge path applies
 * migrations, so `CI (live DB)` went red ON MAIN ITSELF and stayed red until an
 * unrelated PR tripped over it. It surfaced as check:missing-live-columns
 * naming individual columns: true, and several steps removed from the cause.
 * Nobody reads "media_assets.canonical_key is missing" and concludes "main has
 * five migrations this database has never seen".
 *
 * This gate says that sentence. It names FILES, in apply order, and it says
 * plainly that the database does not represent the branch.
 *
 *
 * WHAT IT REPORTS
 * ===============
 *   1. Files on disk with no ledger row  — the unapplied migrations. The point.
 *   2. Ledger rows with no file on disk  — a renumber, rename or deletion after
 *      apply. Renaming is real here: 2220 was renumbered to 2253 this week.
 *   3. Checksum mismatches               — a file EDITED after it was applied.
 *      Its own finding, with its own wording, because it is its own hazard: the
 *      database ran the old content and nothing will ever run the difference.
 *
 * Ledger rows whose checksum is not a sha256 — the 'backfill' sentinel that
 * 2254 seeded for every pre-ledger file — are counted and reported as NOT
 * COMPARED rather than as mismatches. Comparing them would report the entire
 * pre-ledger corpus as drifted on the first run, which is how a gate teaches
 * people to ignore it.
 *
 *
 * WHAT IT CANNOT TELL YOU
 * =======================
 * Anything from before the ledger existed. 2254 seeded every file that was on
 * disk when it ran, including the five named above, and a 'backfill' row asserts
 * only "this filename existed", never "this file was applied". The ledger is
 * authoritative from 2254 forwards and says nothing about what came before.
 * check:missing-live-columns remains the instrument for pre-ledger drift.
 *
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:migration-ledger
 *
 * Exit code 0 → every migration file on disk has a ledger row, and every
 *               comparable checksum matches
 * Exit code 1 → a finding: unapplied file(s), orphaned ledger row(s), an edited
 *               applied migration, or the ledger table itself is absent
 * Exit code 2 → environment / API error — CANNOT establish a result. Missing
 *               credentials land here, never on 0.
 *
 * The 0/1/2 contract is the one checkMissingLiveColumns.ts and
 * auditLiveVsCanonical.ts print in their own headers; it is not invented here.
 */

// ── THE TARGET ASSERTION, IN THE EXECUTION PATH ──────────────────────────────
//
// FIRST import, deliberately: ES modules evaluate imports in source order,
// before the importing module's body, so this runs before anything else in this
// file — before any credential is read and before any request is built. It
// refuses with exit 2 (this script's "cannot establish a result" code) if it
// cannot establish that the target is the sanctioned CI project.
//
// THE STRICT DOOR, NOT THE READ-ONLY ONE, AND WHY. Everything this script sends
// is a SELECT, so on statement content alone it would qualify for
// src/lib/ciProdReadOnlyAuditGuard.mjs — the door checkMissingLiveColumns.ts
// uses, which additionally permits an operator-requested read-only audit of
// declared production from a terminal. That capability is granted only to files
// listed in READ_ONLY_AUDIT_ENTRY_POINTS in scripts/check-guard-coverage.mjs,
// and taking it without adding the entry is exactly the "import nobody notices"
// that list exists to prevent. So this gate takes the strict door, which needs
// no grant: the sanctioned CI project, or exit 2.
//
// The cost is real and named: `pnpm run check:migration-ledger` cannot be
// pointed at production to ask what production is missing. If that is wanted,
// it is a deliberate two-part change — swap this import for
// "../lib/ciProdReadOnlyAuditGuard.mjs" AND add an entry to
// READ_ONLY_AUDIT_ENTRY_POINTS saying what this file sends (two SELECTs: one
// to_regclass() existence probe, and one `select filename, checksum, applied_by
// from public.schema_migration_ledger`). Not one without the other.
import "../lib/ciSupabaseGuard.mjs";

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEDGER_TABLE,
  computeLedgerDrift,
  decideExitCode,
  formatLedgerReport,
  readDiskFiles,
  requireCredentials,
  type LedgerRow,
} from "./lib/migrationLedgerCore.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dir, "../migrations");
const PKG_ROOT = resolve(__dir, "../..");

// ── Environment ───────────────────────────────────────────────────────────────
//
// Same pair, and the same precedence, as checkMissingLiveColumns.ts: the
// project-scoped token first, the personal access token as a fallback. The
// values are handed to requireCredentials() as plain strings — the pure core
// deliberately never learns the variable names (see its header).

const rawUrl = process.env.SUPABASE_URL;
const rawToken =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

const creds = requireCredentials(rawUrl, rawToken);
if (!creds.ok) {
  const wanted = creds.missing
    .map((m) =>
      m === "url"
        ? "SUPABASE_URL"
        : "SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI) or SUPABASE_ACCESS_TOKEN",
    )
    .join(" and ");
  console.error(
    `ERROR: ${wanted} must be set.\n` +
      "       This gate FAILS CLOSED: it cannot read the ledger, so it cannot say\n" +
      "       whether this database represents the branch, and it will not report a\n" +
      "       pass it has no evidence for.\n" +
      "       Run from artifacts/api-server with .env loaded, or export them manually.",
  );
  process.exit(creds.exitCode);
}

const token = creds.token;

let projectRef: string;
try {
  projectRef = new URL(creds.url).hostname.split(".")[0];
} catch {
  console.error(
    "ERROR: SUPABASE_URL is not a URL, so no project ref can be resolved from it.",
  );
  process.exit(2);
}

// ── Transport ─────────────────────────────────────────────────────────────────

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ── Main ──────────────────────────────────────────────────────────────────────

const MIGRATIONS_LABEL = `${relative(PKG_ROOT, MIGRATIONS_DIR)}/`;

console.log(
  `check:migration-ledger — diffing ${MIGRATIONS_LABEL} against ${LEDGER_TABLE} ` +
    `(project ${projectRef}) …`,
);

let diskFiles: ReturnType<typeof readDiskFiles>;
try {
  diskFiles = readDiskFiles(MIGRATIONS_DIR);
} catch (err) {
  console.error(
    `ERROR: could not read the migrations directory ${MIGRATIONS_DIR}: ` +
      `${(err as Error).message}`,
  );
  process.exit(2);
}

if (diskFiles.length === 0) {
  // A gate that scanned nothing has not established that nothing is missing.
  console.error(
    `ERROR: no .sql files found in ${MIGRATIONS_DIR}. A ledger diff over an empty\n` +
      "       file set proves nothing and must not be reported as a pass.",
  );
  process.exit(2);
}

// ── Does the ledger exist at all? ────────────────────────────────────────────
//
// Asked separately, rather than letting the SELECT below fail with 42P01,
// because "the table is missing" and "the query broke" are different answers and
// only one of them is actionable. A missing ledger is NOT an environment error:
// it is an established, actionable fact about the database — 2254 has not been
// applied — so it exits 1, with its own sentence, rather than dumping every file
// on disk into the unapplied list.

let ledgerPresent: boolean;
try {
  const rows = await liveQuery<{ present: boolean }>(
    `select (to_regclass('${LEDGER_TABLE}') is not null) as present`,
  );
  ledgerPresent = rows[0]?.present === true;
} catch (err) {
  console.error(
    `ERROR: could not query project ${projectRef}: ${(err as Error).message}`,
  );
  process.exit(2);
}

if (!ledgerPresent) {
  console.error(
    `\n✖  check:migration-ledger FAILED — ${LEDGER_TABLE} does not exist on project ` +
      `${projectRef}.\n\n` +
      "   The ledger is the record of which migrations this database has run. Without\n" +
      "   it this gate cannot tell you which of the " +
      diskFiles.length +
      " file(s) in " +
      MIGRATIONS_LABEL +
      " are\n   missing here, and it will not guess.\n\n" +
      "   Apply src/migrations/2254_schema_migration_ledger.sql to this database, then\n" +
      "   run this check again.\n",
  );
  process.exit(1);
}

let ledgerRows: LedgerRow[];
try {
  ledgerRows = await liveQuery<LedgerRow>(
    `select filename, checksum, applied_by from ${LEDGER_TABLE}`,
  );
} catch (err) {
  console.error(
    `ERROR: could not read ${LEDGER_TABLE} on project ${projectRef}: ` +
      `${(err as Error).message}`,
  );
  process.exit(2);
}

const drift = computeLedgerDrift(diskFiles, ledgerRows);
const report = formatLedgerReport(drift, {
  projectRef,
  migrationsDirLabel: MIGRATIONS_LABEL,
  diskCount: diskFiles.length,
  ledgerCount: ledgerRows.length,
});
const exitCode = decideExitCode(drift);

if (exitCode === 0) console.log(report);
else console.error(report);

process.exit(exitCode);

// This module exports nothing on purpose. The pure half lives in
// ./lib/migrationLedgerCore.ts, which is what src/test/migrationLedger.test.ts
// imports — importing THIS file runs the guard and then the diff, which is
// exactly what a gate should do and exactly what a unit test must not.
