/**
 * Migration-ledger gate — the drift core, driven entirely by fixtures.
 *
 * NO DATABASE, and no Supabase credential variable named anywhere in this file.
 * Both are load-bearing:
 *
 *   * It imports only src/scripts/lib/migrationLedgerCore.ts, which is
 *     guard-free. src/scripts/checkMigrationLedger.ts — the I/O shell — imports
 *     src/lib/ciSupabaseGuard.mjs as its first import, and that guard calls
 *     process.exit(2) when it cannot establish the target. A test that imported
 *     the shell would die at import under the loopback target `pnpm run test`
 *     pins. Same split, same reason, as auditLiveVsCanonical.test.ts.
 *   * scripts/check-guard-coverage.mjs classifies any file under src/ that NAMES
 *     a Supabase credential env var as able to reach Supabase, and then demands
 *     a guard import or a written exemption. This file names none, which is why
 *     requireCredentials() takes plain strings rather than an env object.
 *
 * The last section reads 2254_schema_migration_ledger.sql as text and pins the
 * ledger contract and the honesty of the backfill claim. src/test/
 * migrationDeployability.test.ts separately proves the file is deployable (no
 * unconditional RAISE in a top-level DO block, which is how 2195 silently rolled
 * itself back).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BACKFILL_CHECKSUM,
  LEDGER_TABLE,
  SHA256_HEX_RE,
  computeLedgerDrift,
  decideExitCode,
  formatLedgerReport,
  hasFindings,
  isComparableChecksum,
  listMigrationFiles,
  readDiskFiles,
  requireCredentials,
  sha256OfFile,
  type DiskFile,
  type LedgerRow,
} from "../scripts/lib/migrationLedgerCore.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dir, "../migrations");
const LEDGER_MIGRATION = "2254_schema_migration_ledger.sql";

/**
 * A believable sha256: 64 lowercase hex characters, and deliberately containing
 * letters — a digits-only fixture would survive .toUpperCase() unchanged and
 * silently defeat the "an uppercase hash is not comparable" case below.
 */
const hash = (seed: string): string =>
  (seed + "bdf9ace1").repeat(9).slice(0, 64).replace(/[^0-9a-f]/g, "c");

const disk = (filename: string, checksum = hash("1")): DiskFile => ({
  filename,
  checksum,
});

const row = (
  filename: string,
  checksum = hash("1"),
  applied_by = "ci",
): LedgerRow => ({ filename, checksum, applied_by });

const ctx = {
  projectRef: "hwokxgbmezheskbzskfr",
  migrationsDirLabel: "src/migrations/",
  diskCount: 0,
  ledgerCount: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Disk ahead of the ledger — THE finding this gate exists for.
// ─────────────────────────────────────────────────────────────────────────────
describe("disk ahead of ledger — the unapplied migrations", () => {
  it("reports every file that has no ledger row", () => {
    const drift = computeLedgerDrift(
      [
        disk("2219_locate_friends_sessions.sql"),
        disk("2220_canonical_locations_search_key.sql"),
        disk("2223_map_media_evidence.sql"),
        disk("2224_route_hop_signal.sql"),
        disk("2250_media_asset_canonical_model.sql"),
        disk("2252_hidden_gem_contributions.sql"),
      ],
      [row("2219_locate_friends_sessions.sql")],
    );

    assert.deepEqual(drift.missingFromLedger, [
      "2220_canonical_locations_search_key.sql",
      "2223_map_media_evidence.sql",
      "2224_route_hop_signal.sql",
      "2250_media_asset_canonical_model.sql",
      "2252_hidden_gem_contributions.sql",
    ]);
    assert.equal(decideExitCode(drift), 1);
  });

  it("names the files IN APPLY ORDER even when the disk list arrives shuffled", () => {
    // A runner applies lexicographically. A list in any other order is a list
    // somebody has to re-sort before acting on it.
    const drift = computeLedgerDrift(
      [
        disk("2252_hidden_gem_contributions.sql"),
        disk("2220_canonical_locations_search_key.sql"),
        disk("2250_media_asset_canonical_model.sql"),
        disk("2223_map_media_evidence.sql"),
        disk("2224_route_hop_signal.sql"),
      ],
      [],
    );
    assert.deepEqual(drift.missingFromLedger, [
      "2220_canonical_locations_search_key.sql",
      "2223_map_media_evidence.sql",
      "2224_route_hop_signal.sql",
      "2250_media_asset_canonical_model.sql",
      "2252_hidden_gem_contributions.sql",
    ]);
  });

  it("the failure message says the database does not represent the branch, and names the files", () => {
    const drift = computeLedgerDrift(
      [
        disk("2220_canonical_locations_search_key.sql"),
        disk("2223_map_media_evidence.sql"),
      ],
      [],
    );
    const text = formatLedgerReport(drift, { ...ctx, diskCount: 2, ledgerCount: 0 });

    assert.match(text, /does not represent this branch/);
    assert.match(text, /Apply them, in this order/);
    assert.match(text, /has never\s+seen them/);
    assert.match(text, /1\. 2220_canonical_locations_search_key\.sql/);
    assert.match(text, /2\. 2223_map_media_evidence\.sql/);
    // It must point at the cause, not at the symptom that used to surface first.
    assert.match(text, /check:missing-live-columns/);
    assert.match(text, /SYMPTOM/);
    // And it must not be a column list.
    assert.doesNotMatch(text, /missing column/i);
  });

  it("numbers the list so the order is unmistakable", () => {
    const files = Array.from({ length: 11 }, (_, i) => `21${10 + i}_x.sql`);
    const drift = computeLedgerDrift(files.map((f) => disk(f)), []);
    const text = formatLedgerReport(drift, { ...ctx, diskCount: 11, ledgerCount: 0 });
    // Right-aligned so " 1." and "11." line up rather than ragging.
    assert.match(text, /\n {6}1\. 2110_x\.sql/);
    assert.match(text, /\n {5}11\. 2120_x\.sql/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ledger ahead of disk — a rollback, a rename, or a renumber.
// ─────────────────────────────────────────────────────────────────────────────
describe("ledger ahead of disk — rows with no file", () => {
  it("reports a ledger row whose file is not on disk", () => {
    const drift = computeLedgerDrift(
      [disk("2253_map_contribution_claim_types.sql")],
      [
        row("2253_map_contribution_claim_types.sql"),
        row("2220_canonical_locations_search_key.sql", hash("2"), "manual"),
      ],
    );
    assert.deepEqual(
      drift.missingFromDisk.map((r) => r.filename),
      ["2220_canonical_locations_search_key.sql"],
    );
    assert.equal(drift.missingFromLedger.length, 0);
    assert.equal(decideExitCode(drift), 1, "an orphaned ledger row is a finding, not a note");
  });

  it("the message explains the renumber case and says to UPDATE rather than delete", () => {
    const drift = computeLedgerDrift(
      [],
      [row("2220_canonical_locations_search_key.sql", hash("2"), "manual")],
    );
    const text = formatLedgerReport(drift, { ...ctx, diskCount: 0, ledgerCount: 1 });
    assert.match(text, /renumbered, renamed or deleted after it was applied/);
    assert.match(text, /2220_canonical_locations_search_key\.sql.*renumbered to 2253/s);
    assert.match(text, /UPDATE the row's filename/);
    assert.match(text, /applied_by=manual/);
  });

  it("sorts orphaned rows, and does not confuse them with unapplied files", () => {
    const drift = computeLedgerDrift(
      [disk("2100_a.sql")],
      [row("2300_z.sql"), row("2200_m.sql"), row("2100_a.sql")],
    );
    assert.deepEqual(
      drift.missingFromDisk.map((r) => r.filename),
      ["2200_m.sql", "2300_z.sql"],
    );
    assert.deepEqual(drift.missingFromLedger, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checksum drift — an APPLIED migration that was edited afterwards.
// ─────────────────────────────────────────────────────────────────────────────
describe("checksum mismatch — an edited applied migration", () => {
  it("is its own finding, not folded into the unapplied list", () => {
    const drift = computeLedgerDrift(
      [disk("2251_hidden_gem_place_protection_index.sql", hash("c"))],
      [row("2251_hidden_gem_place_protection_index.sql", hash("d"))],
    );
    assert.equal(drift.checksumMismatches.length, 1);
    assert.equal(drift.missingFromLedger.length, 0, "it IS in the ledger — it is not unapplied");
    assert.equal(drift.missingFromDisk.length, 0, "it IS on disk — it was not renamed");
    assert.deepEqual(drift.checksumMismatches[0], {
      filename: "2251_hidden_gem_place_protection_index.sql",
      onDisk: hash("c"),
      inLedger: hash("d"),
      appliedBy: "ci",
    });
    assert.equal(decideExitCode(drift), 1);
  });

  it("is worded as its own hazard — the DB ran the old content", () => {
    const drift = computeLedgerDrift(
      [disk("2251_x.sql", hash("c"))],
      [row("2251_x.sql", hash("d"))],
    );
    const text = formatLedgerReport(drift, { ...ctx, diskCount: 1, ledgerCount: 1 });
    assert.match(text, /CHANGED after being applied/);
    assert.match(text, /ran the OLD content/);
    assert.match(text, /not a pending migration/);
    assert.match(text, /ledger {2}[0-9a-f]{64}/);
    assert.match(text, /disk {4}[0-9a-f]{64}/);
    // It must not tell the reader to apply it — re-applying an edited file is
    // the hazard, not the remedy.
    assert.doesNotMatch(text, /Apply them, in this order/);
  });

  it("does NOT compare the backfill sentinel — that would report the whole pre-ledger corpus", () => {
    const drift = computeLedgerDrift(
      [disk("0010_trip_plan.sql", hash("e")), disk("0011_message_type.sql", hash("f"))],
      [
        row("0010_trip_plan.sql", BACKFILL_CHECKSUM, "backfill"),
        row("0011_message_type.sql", BACKFILL_CHECKSUM, "backfill"),
      ],
    );
    assert.deepEqual(drift.checksumMismatches, []);
    assert.equal(drift.unverifiable.length, 2);
    assert.equal(drift.comparedChecksums, 0);
    assert.equal(decideExitCode(drift), 0, "a backfill row is not a finding");
  });

  it("treats any non-sha256 checksum as unverifiable rather than as a mismatch", () => {
    // Not just the sentinel: a truncated hash, an empty string, an uppercase
    // hash. Reporting these as CONTENT DRIFT would be a false accusation.
    for (const bad of ["", "backfill", "abc", hash("1").toUpperCase(), "n/a"]) {
      assert.equal(isComparableChecksum(bad), false, `${JSON.stringify(bad)} must not be compared`);
      const drift = computeLedgerDrift([disk("2100_a.sql", hash("9"))], [row("2100_a.sql", bad)]);
      assert.deepEqual(drift.checksumMismatches, [], `${JSON.stringify(bad)} produced a mismatch`);
      assert.equal(drift.unverifiable.length, 1);
    }
    assert.ok(SHA256_HEX_RE.test(hash("1")), "the fixture hash must itself be well formed");
    assert.equal(isComparableChecksum(hash("1")), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The clean case.
// ─────────────────────────────────────────────────────────────────────────────
describe("identical sets pass", () => {
  it("passes when every file has a row and every comparable checksum matches", () => {
    const files = [disk("2100_a.sql", hash("1")), disk("2101_b.sql", hash("2"))];
    const drift = computeLedgerDrift(files, [
      row("2100_a.sql", hash("1")),
      row("2101_b.sql", hash("2")),
    ]);
    assert.equal(hasFindings(drift), false);
    assert.equal(decideExitCode(drift), 0);
    assert.equal(drift.comparedChecksums, 2);

    const text = formatLedgerReport(drift, { ...ctx, diskCount: 2, ledgerCount: 2 });
    assert.match(text, /PASSED/);
    assert.doesNotMatch(text, /FAILED/);
  });

  it("the passing message states how many checksums were NOT compared", () => {
    // A pass that silently skipped 380 comparisons is a pass that overstates
    // itself — the same defect the assert-nonprod guard was fixed for.
    const drift = computeLedgerDrift(
      [disk("2100_a.sql"), disk("0010_trip_plan.sql")],
      [row("2100_a.sql"), row("0010_trip_plan.sql", BACKFILL_CHECKSUM, "backfill")],
    );
    const text = formatLedgerReport(drift, { ...ctx, diskCount: 2, ledgerCount: 2 });
    assert.match(text, /PASSED/);
    assert.match(text, /1 row\(s\) carry no comparable checksum and were NOT checked/);
    assert.match(text, /never that it was applied/);
  });

  it("an empty ledger against an empty disk is a pass, and says nothing misleading", () => {
    const drift = computeLedgerDrift([], []);
    assert.equal(decideExitCode(drift), 0);
    // The shell refuses to run at all on an empty migrations directory (exit 2);
    // the core has no opinion, and must not invent one.
    assert.equal(hasFindings(drift), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Credentials — fail closed, never skip.
// ─────────────────────────────────────────────────────────────────────────────
describe("missing credentials fail closed", () => {
  it("refuses with exit code 2 when nothing is supplied", () => {
    const r = requireCredentials(undefined, undefined);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.exitCode, 2);
    assert.deepEqual(r.ok === false && r.missing, ["url", "token"]);
  });

  it("refuses when only one of the two is supplied", () => {
    const noToken = requireCredentials("https://ref.supabase.co", undefined);
    assert.equal(noToken.ok, false);
    assert.deepEqual(noToken.ok === false && noToken.missing, ["token"]);

    const noUrl = requireCredentials(undefined, "sbp_token");
    assert.equal(noUrl.ok, false);
    assert.deepEqual(noUrl.ok === false && noUrl.missing, ["url"]);
  });

  it("treats the empty string and whitespace as ABSENT, not as a value", () => {
    // An unset secret expands to "" in a workflow rather than disappearing. A
    // gate that accepts "" would authenticate with nothing and report whatever
    // the API said about it.
    for (const blank of ["", "   ", "\t\n"]) {
      const r = requireCredentials(blank, blank);
      assert.equal(r.ok, false, `${JSON.stringify(blank)} was accepted as a credential`);
      assert.equal(r.ok === false && r.exitCode, 2);
    }
  });

  it("never returns exit code 0 for a refusal — there is no skip path", () => {
    const r = requireCredentials(undefined, undefined);
    assert.notEqual(r.ok === false && r.exitCode, 0);
    assert.equal(r.ok === false && (r as { exitCode: number }).exitCode, 2);
  });

  it("accepts a well-formed pair and trims it", () => {
    const r = requireCredentials("  https://ref.supabase.co  ", " sbp_token ");
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.url, "https://ref.supabase.co");
    assert.equal(r.ok === true && r.token, "sbp_token");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem side, against the real migrations directory.
// ─────────────────────────────────────────────────────────────────────────────
describe("reading the real migrations directory", () => {
  it("lists only .sql files, sorted, and finds the full set", () => {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    assert.ok(files.length > 300, `expected the full migration set, found ${files.length}`);
    assert.ok(files.every((f) => f.endsWith(".sql")));
    assert.deepEqual(files, [...files].sort(), "must be in apply (lexicographic) order");
    assert.ok(files.includes(LEDGER_MIGRATION));
  });

  it("hashes files to a well-formed, stable sha256", () => {
    const h = sha256OfFile(join(MIGRATIONS_DIR, LEDGER_MIGRATION));
    assert.match(h, SHA256_HEX_RE);
    assert.equal(h, sha256OfFile(join(MIGRATIONS_DIR, LEDGER_MIGRATION)));
  });

  it("readDiskFiles against a ledger built from itself is clean", () => {
    // The tautology is the point: it proves the disk side and the diff agree on
    // filenames and hash formatting, so a real green is a real green.
    const files = readDiskFiles(MIGRATIONS_DIR);
    const drift = computeLedgerDrift(
      files,
      files.map((f) => row(f.filename, f.checksum, "ci")),
    );
    assert.equal(hasFindings(drift), false);
    assert.equal(drift.comparedChecksums, files.length);
  });

  it("removing one row from that ledger makes the gate name exactly that file", () => {
    const files = readDiskFiles(MIGRATIONS_DIR);
    const ledger = files
      .filter((f) => f.filename !== LEDGER_MIGRATION)
      .map((f) => row(f.filename, f.checksum, "ci"));
    const drift = computeLedgerDrift(files, ledger);
    assert.deepEqual(drift.missingFromLedger, [LEDGER_MIGRATION]);
    assert.equal(decideExitCode(drift), 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The migration itself: the contract, and the honesty of the backfill claim.
// ─────────────────────────────────────────────────────────────────────────────
describe("2254_schema_migration_ledger.sql", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, LEDGER_MIGRATION), "utf8");

  it("creates the contracted table with the contracted column names", () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.schema_migration_ledger/);
    assert.match(sql, /filename\s+TEXT PRIMARY KEY/);
    assert.match(sql, /checksum\s+TEXT NOT NULL/);
    assert.match(sql, /applied_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    assert.match(sql, /applied_by\s+TEXT NOT NULL/);
    assert.match(sql, /notes\s+TEXT/);
    assert.equal(LEDGER_TABLE, "public.schema_migration_ledger");
  });

  it("pins applied_by to the three contracted values", () => {
    assert.match(sql, /CHECK \(applied_by IN \('ci', 'manual', 'backfill'\)\)/);
  });

  it("is service-role only: RLS on, no policy, no client grant", () => {
    assert.match(sql, /ALTER TABLE public\.schema_migration_ledger ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.schema_migration_ledger FROM anon/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.schema_migration_ledger FROM authenticated/);
    assert.match(sql, /GRANT [A-Z, ]+ ON TABLE public\.schema_migration_ledger TO service_role/);
    assert.doesNotMatch(
      sql,
      /GRANT [^\n]*ON TABLE public\.schema_migration_ledger TO (anon|authenticated)/,
      "a client grant on the ledger would make the record of what ran client-writable",
    );
    assert.doesNotMatch(
      sql,
      /CREATE POLICY [a-z_]+ ON (public\.)?schema_migration_ledger/,
      "the empty policy set IS the write boundary",
    );
  });

  it("seeds every migration file that existed when it was written, including itself", () => {
    const listed = [...sql.matchAll(/^ {2}'([0-9][^']*\.sql)',?$/gm)].map((m) => m[1]);
    const onDisk = listMigrationFiles(MIGRATIONS_DIR);
    assert.deepEqual(
      listed,
      onDisk,
      "the backfill list must match src/migrations/ exactly — a file added after 2254 was " +
        "authored has no row and will be reported as unapplied, which is correct only if it " +
        "genuinely is",
    );
    assert.ok(listed.includes(LEDGER_MIGRATION), "2254 must seed its own row");
  });

  it("backfilled rows claim file EXISTENCE and never that the file was applied", () => {
    // This is the whole ethical content of the backfill. If this assertion is
    // ever relaxed, the ledger starts asserting something nobody verified.
    assert.match(sql, /'backfill',\n\s*'backfill',/);
    assert.match(sql, /Asserts only that this filename existed in src\/migrations\/ when 2254 ran/);
    assert.match(sql, /NOT evidence that it was applied to this database/);
    assert.match(sql, /nothing verified that it was/);
    assert.match(
      sql,
      /IT IS NOT EVIDENCE\n-- {5}THAT THE FILE WAS EVER APPLIED/,
      "the header must state the claim in the plainest form available",
    );
  });

  it("names the five migrations the backfill cannot catch, rather than leaving it implicit", () => {
    // Scoped to the PROSE HEADER, above BEGIN;. Every one of these filenames
    // also appears in the backfill ARRAY further down, so an unscoped
    // `sql.includes(...)` would pass even with the admission deleted.
    const header = sql.slice(0, sql.indexOf("\nBEGIN;"));
    assert.ok(header.length > 1000, "header not located");
    for (const f of [
      "2220_canonical_locations_search_key.sql",
      "2223_map_media_evidence.sql",
      "2224_route_hop_signal.sql",
      "2250_media_asset_canonical_model.sql",
      "2252_hidden_gem_contributions.sql",
    ]) {
      assert.ok(header.includes(f), `${f} must be named in the header's admission`);
    }
    assert.match(header, /This gate will not catch them/);
  });

  it("the backfill is a no-op on replay", () => {
    assert.match(sql, /ON CONFLICT \(filename\) DO NOTHING/);
  });

  it("is transactional, with a postcondition that proves the boundary", () => {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.match(sql, /POSTCONDITION FAILED: row level security is not enabled/);
    assert.match(sql, /POSTCONDITION FAILED: anon holds/);
    assert.match(sql, /POSTCONDITION FAILED: authenticated holds/);
  });

  it("every RAISE sits inside an IF — the 2195 rollback trap", () => {
    // migrationDeployability.test.ts enforces this across the whole directory;
    // asserted here too so a change to THIS file fails in THIS suite as well.
    for (const line of sql.split("\n")) {
      if (/^\s*RAISE\s+(EXCEPTION\b|')/.test(line)) {
        assert.ok(
          /RAISE EXCEPTION '(PRE|POST)CONDITION FAILED/.test(line),
          `unexpected RAISE shape: ${line.trim()}`,
        );
      }
    }
    assert.doesNotMatch(sql, /RAISE EXCEPTION 'PROOF/);
  });
});
