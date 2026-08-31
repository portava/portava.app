/**
 * Migration-ledger drift core — PURE, and deliberately guard-free.
 *
 * Everything here is a function of its arguments: no database, no environment,
 * no Supabase credential variable named anywhere in this file. That is not
 * tidiness, it is what makes the gate testable at all. Its I/O shell,
 * src/scripts/checkMigrationLedger.ts, imports src/lib/ciSupabaseGuard.mjs as
 * its first import, and that guard exits the PROCESS when it does not like the
 * target — so a unit test that imported the shell would die at import time
 * under the pinned loopback target `pnpm run test` uses. The same split, for
 * the same reason, is why src/scripts/lib/liveVsCanonicalCore.ts exists beside
 * src/scripts/auditLiveVsCanonical.ts.
 *
 * KEEP IT CREDENTIAL-FREE. scripts/check-guard-coverage.mjs classifies any file
 * under src/ that NAMES a Supabase credential environment variable as "can reach
 * Supabase", and then requires it to import a guard front door or hold a written
 * exemption. requireCredentials() below therefore takes the two values as plain
 * strings and never learns where they came from; the shell knows the variable
 * names, and the shell is guarded.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Fully-qualified name of the ledger table (2254_schema_migration_ledger.sql). */
export const LEDGER_TABLE = "public.schema_migration_ledger";

/**
 * The checksum stored for rows seeded by 2254's backfill.
 *
 * It is a word, not a hash, and that is the point: no ledger ever existed in
 * this repo, so which of the ~380 pre-2254 files actually ran cannot be
 * reconstructed. A real sha256 of today's bytes would be a true hash of the
 * wrong thing — it would read as "this is what was applied" when nothing
 * established that the file was applied at all.
 */
export const BACKFILL_CHECKSUM = "backfill";

/** A well-formed sha256 as this repo writes it: 64 lowercase hex characters. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** One row of public.schema_migration_ledger, as the gate needs it. */
export interface LedgerRow {
  filename: string;
  checksum: string;
  /** 'ci' | 'manual' | 'backfill' — pinned by a CHECK constraint in 2254. */
  applied_by: string;
}

/** One migration file on disk, with the sha256 of its current bytes. */
export interface DiskFile {
  filename: string;
  checksum: string;
}

/** A file whose content changed after it was applied. */
export interface ChecksumMismatch {
  filename: string;
  /** sha256 of the file as it is on disk now. */
  onDisk: string;
  /** What the ledger recorded at apply time. */
  inLedger: string;
  appliedBy: string;
}

/** A ledger row whose checksum cannot be compared to anything. */
export interface UnverifiableChecksum {
  filename: string;
  checksum: string;
  appliedBy: string;
}

export interface LedgerDrift {
  /**
   * On disk, absent from the ledger — THE finding this gate exists for. Sorted
   * lexicographically, which is the order a runner applies them in.
   */
  missingFromLedger: string[];
  /** In the ledger, absent from disk: a renumber, a rename, or a deletion. */
  missingFromDisk: LedgerRow[];
  /** Applied, then edited. Its own hazard, reported as its own finding. */
  checksumMismatches: ChecksumMismatch[];
  /**
   * Rows whose recorded checksum is the backfill sentinel or is otherwise not a
   * sha256. NOT a finding: comparing them would report the entire pre-ledger
   * corpus as mismatched on the gate's first run. Counted and printed so the
   * silence is visible.
   */
  unverifiable: UnverifiableChecksum[];
  /** How many files had a real hash on both sides and were actually compared. */
  comparedChecksums: number;
}

/** Sorted list of .sql filenames in a migrations directory. */
export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** sha256 of a file's bytes, lowercase hex. */
export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Every migration file in `dir`, hashed. Sorted by filename. */
export function readDiskFiles(dir: string): DiskFile[] {
  return listMigrationFiles(dir).map((filename) => ({
    filename,
    checksum: sha256OfFile(join(dir, filename)),
  }));
}

/** True when a ledger checksum can be meaningfully compared with a file hash. */
export function isComparableChecksum(checksum: string): boolean {
  return SHA256_HEX_RE.test(checksum);
}

/**
 * Diff migration files on disk against ledger rows.
 *
 * Both directions, because both are real: a file with no row is an unapplied
 * migration, and a row with no file is something the database ran that this
 * branch can no longer show you.
 */
export function computeLedgerDrift(
  diskFiles: readonly DiskFile[],
  ledgerRows: readonly LedgerRow[],
): LedgerDrift {
  const byFilename = new Map<string, LedgerRow>();
  for (const row of ledgerRows) byFilename.set(row.filename, row);

  const onDisk = new Set(diskFiles.map((f) => f.filename));

  const missingFromLedger: string[] = [];
  const checksumMismatches: ChecksumMismatch[] = [];
  const unverifiable: UnverifiableChecksum[] = [];
  let comparedChecksums = 0;

  for (const file of [...diskFiles].sort((a, b) =>
    a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0,
  )) {
    const row = byFilename.get(file.filename);
    if (!row) {
      missingFromLedger.push(file.filename);
      continue;
    }
    if (!isComparableChecksum(row.checksum)) {
      unverifiable.push({
        filename: file.filename,
        checksum: row.checksum,
        appliedBy: row.applied_by,
      });
      continue;
    }
    comparedChecksums++;
    if (row.checksum !== file.checksum) {
      checksumMismatches.push({
        filename: file.filename,
        onDisk: file.checksum,
        inLedger: row.checksum,
        appliedBy: row.applied_by,
      });
    }
  }

  const missingFromDisk = ledgerRows
    .filter((row) => !onDisk.has(row.filename))
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  return {
    missingFromLedger,
    missingFromDisk,
    checksumMismatches,
    unverifiable,
    comparedChecksums,
  };
}

/** True when the drift contains anything the gate must fail on. */
export function hasFindings(drift: LedgerDrift): boolean {
  return (
    drift.missingFromLedger.length > 0 ||
    drift.missingFromDisk.length > 0 ||
    drift.checksumMismatches.length > 0
  );
}

/**
 * 0 = the database represents this branch, 1 = it does not.
 *
 * 2 is reserved for "cannot establish a result" and is decided by the shell —
 * the same 0/1/2 contract checkMissingLiveColumns.ts and auditLiveVsCanonical.ts
 * print in their headers.
 */
export function decideExitCode(drift: LedgerDrift): 0 | 1 {
  return hasFindings(drift) ? 1 : 0;
}

export interface ReportContext {
  /** The Supabase project ref the ledger was read from. */
  projectRef: string;
  /** Repo-relative label for the migrations directory, for the message. */
  migrationsDirLabel: string;
  diskCount: number;
  ledgerCount: number;
}

/**
 * The message a person reads once and knows what to do.
 *
 * It names FILES, never columns. The failure that produced this gate surfaced
 * as check:missing-live-columns listing individual columns — true, and several
 * steps removed from "main has five migrations this database has never seen".
 */
export function formatLedgerReport(
  drift: LedgerDrift,
  ctx: ReportContext,
): string {
  const out: string[] = [];

  if (!hasFindings(drift)) {
    out.push(
      `✔ check:migration-ledger PASSED — project ${ctx.projectRef} has a ledger row for ` +
        `every one of the ${ctx.diskCount} migration file(s) in ${ctx.migrationsDirLabel}.`,
    );
    out.push(
      `  ${drift.comparedChecksums} file(s) had a recorded sha256 and matched it.`,
    );
    if (drift.unverifiable.length > 0) {
      out.push(
        `  ${drift.unverifiable.length} row(s) carry no comparable checksum and were NOT ` +
          `checked for content drift — ${drift.unverifiable.length === 1 ? "it is" : "they are"} ` +
          `pre-ledger backfill row(s) seeded by 2254, which assert only that the file existed, ` +
          `never that it was applied.`,
      );
    }
    return out.join("\n");
  }

  out.push("");
  out.push(
    "✖  check:migration-ledger FAILED — this database does not represent this branch.",
  );

  if (drift.missingFromLedger.length > 0) {
    const n = drift.missingFromLedger.length;
    out.push("");
    out.push(
      `   ${n} migration file(s) exist in ${ctx.migrationsDirLabel} on this branch and have no ` +
        `row in\n   ${LEDGER_TABLE} on project ${ctx.projectRef}. This database has never ` +
        `seen them.\n   Apply them, in this order:`,
    );
    out.push("");
    const width = String(n).length;
    drift.missingFromLedger.forEach((f, i) => {
      out.push(`     ${String(i + 1).padStart(width, " ")}. ${f}`);
    });
    out.push("");
    out.push(
      "   Until they are applied, every check that reads this database is measuring an\n" +
        "   OLDER schema than the one this branch was written against. If\n" +
        "   check:missing-live-columns is red too, the columns it names are a SYMPTOM of the\n" +
        "   files above — apply these, do not chase the column list.",
    );
  }

  if (drift.missingFromDisk.length > 0) {
    out.push("");
    out.push(
      `   ${drift.missingFromDisk.length} ledger row(s) name a migration file that is not in ` +
        `${ctx.migrationsDirLabel}.\n   The database ran something this branch cannot show you — a migration was\n` +
        "   renumbered, renamed or deleted after it was applied, or the row was written\n" +
        "   from a different branch:",
    );
    out.push("");
    for (const row of drift.missingFromDisk) {
      out.push(`     • ${row.filename}   (applied_by=${row.applied_by})`);
    }
    out.push("");
    out.push(
      "   Renaming is not hypothetical here: 2220_canonical_locations_search_key.sql was\n" +
        "   renumbered to 2253_map_contribution_claim_types.sql on 2026-08-31. If that is\n" +
        "   what happened, UPDATE the row's filename — deleting it makes this gate ask for a\n" +
        "   re-apply of something that already ran.",
    );
  }

  if (drift.checksumMismatches.length > 0) {
    out.push("");
    out.push(
      `   ${drift.checksumMismatches.length} migration file(s) CHANGED after being applied.\n` +
        "   The bytes on disk no longer hash to what was recorded at apply time. The database\n" +
        "   ran the OLD content; the file now says something else, and nothing will ever run\n" +
        "   the difference. This is not a pending migration — re-applying an edited file may\n" +
        "   not be safe:",
    );
    out.push("");
    for (const m of drift.checksumMismatches) {
      out.push(`     • ${m.filename}   (applied_by=${m.appliedBy})`);
      out.push(`         ledger  ${m.inLedger}`);
      out.push(`         disk    ${m.onDisk}`);
    }
    out.push("");
    out.push(
      "   Either restore the file's content, or write a NEW migration for the change and\n" +
        "   update this row's checksum deliberately. Editing an applied migration in place\n" +
        "   makes the file stop describing the database.",
    );
  }

  out.push("");
  out.push(
    `   ${ctx.diskCount} file(s) on disk, ${ctx.ledgerCount} ledger row(s) on ${ctx.projectRef}; ` +
      `${drift.comparedChecksums} checksum(s) compared, ` +
      `${drift.unverifiable.length} not comparable (pre-ledger backfill).`,
  );
  out.push("");

  return out.join("\n");
}

/** Why a credential check refused. Rendered by the shell, which knows the names. */
export type MissingCredential = "url" | "token";

export type CredentialCheck =
  | { ok: true; url: string; token: string }
  | { ok: false; exitCode: 2; missing: MissingCredential[] };

/**
 * Fail closed on absent credentials. Never "skip", never pass.
 *
 * A gate that reports success when it could not reach the database is worse than
 * no gate: the whole failure this was written against was a red signal that
 * nobody could act on, and a green signal nobody can trust is the same defect
 * with the sign flipped. The empty string counts as absent — an unset secret in
 * a workflow expands to "" rather than disappearing.
 */
export function requireCredentials(
  url: string | undefined,
  token: string | undefined,
): CredentialCheck {
  const missing: MissingCredential[] = [];
  if (typeof url !== "string" || url.trim() === "") missing.push("url");
  if (typeof token !== "string" || token.trim() === "") missing.push("token");
  if (missing.length > 0) return { ok: false, exitCode: 2, missing };
  return { ok: true, url: (url as string).trim(), token: (token as string).trim() };
}
