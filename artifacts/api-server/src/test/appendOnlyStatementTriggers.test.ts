/**
 * appendOnlyStatementTriggers — the statement-level append-only trigger may not
 * come back a third time.
 *
 * NO DATABASE. This reads src/migrations/*.sql as text, so it runs in the plain
 * `pnpm test` tier and names no Supabase credential env var (which is what keeps
 * scripts/check-guard-coverage.mjs from demanding a guard import here).
 *
 * ── WHAT IT IS GUARDING ─────────────────────────────────────────────────────
 * A `BEFORE DELETE ... FOR EACH STATEMENT` trigger fires when the statement
 * starts. It cannot know the statement will match zero rows, so it refuses
 * cascades that would delete nothing. The intel tables hang off profiles, which
 * hangs off auth.users, so ONE such trigger makes EVERY account deletion in the
 * product fail — and fail in a place that looks unrelated to intel.
 *
 * This has now happened twice:
 *
 *   2130  attached it to intel_observations / _evidence / _confirmations
 *   2137  removed it, and wrote down why, at length
 *   2276  attached it to intel_presence_verifications, commented
 *         "Append-only, exactly as 2130 attached to the intel_* family"
 *   2277  attached it to intel_attributions
 *   2279  attached it to intel_historical_patterns
 *   2291  removed it again
 *
 * The second occurrence cost eight RLS write-boundary assertions that silently
 * stopped executing (`tests=8 pass=0 fail=0 exit=1`) and 56 fixture auth users
 * stranded in the shared CI project, because every teardown delete in every
 * live-DB suite had been refused since 2276 was applied.
 *
 * A comment saying "do not re-add this" was already present, twice, in 2137.
 * Prose did not stop the copy-paste. This does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Files that attach the statement-level trigger and are ALREADY superseded by a
 * later removal. This list is a RATCHET: it may shrink, never grow. A new entry
 * means somebody re-attached the trigger, which is the thing being forbidden.
 */
const SUPERSEDED_ATTACHERS: ReadonlySet<string> = new Set([
  "2130_intel_storage.sql", // removed by 2137
  "2276_intel_presence_verification.sql", // removed by 2291
  "2277_intel_outcomes_attribution.sql", // removed by 2291
  "2279_intel_historical_patterns.sql", // removed by 2291
]);

/** The migration that performs the second removal. */
const REMOVAL = "2291_intel_stmt_trigger_removal_round2.sql";

/** Tables 2291 must un-guard. */
const REMOVED_FROM = [
  "intel_presence_verifications",
  "intel_attributions",
  "intel_historical_patterns",
] as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function read(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * True when the file ATTACHES the statement-level append-only trigger.
 *
 * Matched on `CREATE TRIGGER ... intel_append_only_stmt()` rather than on the
 * trigger name, because both 2130 and 2276 build the name with format() from a
 * loop variable and the literal name never appears in the CREATE. Dropping the
 * trigger also names the function in a comment in some files, so the CREATE
 * keyword is what distinguishes an attach from a removal.
 */
function attachesStatementTrigger(sql: string): boolean {
  return /CREATE TRIGGER[\s\S]{0,400}?intel_append_only_stmt\s*\(\s*\)/i.test(sql);
}

describe("the statement-level append-only trigger stays off", () => {
  it("no migration attaches intel_append_only_stmt() beyond the superseded ones", () => {
    const attachers = migrationFiles().filter((f) => attachesStatementTrigger(read(f)));
    const unexpected = attachers.filter((f) => !SUPERSEDED_ATTACHERS.has(f));

    assert.deepEqual(
      unexpected,
      [],
      `These migrations attach a BEFORE DELETE ... FOR EACH STATEMENT append-only trigger:\n` +
        `  ${unexpected.join("\n  ")}\n\n` +
        `A statement-level BEFORE trigger fires even when the statement matches zero rows, so it ` +
        `refuses the auth.users -> profiles -> intel_* delete cascade for every user, whether or not ` +
        `that user has any intel rows. It breaks account deletion product-wide and every fixture ` +
        `teardown in the live-DB suites, and supabase-js reports the refusal in { error } rather than ` +
        `throwing — so the callers see a delete that succeeded.\n\n` +
        `The row-level *_no_update_delete trigger already enforces append-only on every real row. ` +
        `Attach that one; do not attach the _stmt variant. See 2137 and 2291.`,
    );
  });

  it("the superseded list is a shrink-only ratchet — every entry still attaches", () => {
    // Prevents the list rotting into permission to add: an entry that no longer
    // attaches must be deleted from it, not left as a free slot.
    for (const file of SUPERSEDED_ATTACHERS) {
      assert.ok(
        attachesStatementTrigger(read(file)),
        `${file} is listed as a superseded attacher but no longer attaches the trigger. ` +
          `Remove it from SUPERSEDED_ATTACHERS rather than leaving a stale allowance behind.`,
      );
    }
  });

  it("2291 drops the trigger from all three tables 2276/2277/2279 guarded", () => {
    const sql = read(REMOVAL);
    for (const table of REMOVED_FROM) {
      assert.ok(
        sql.includes(table),
        `${REMOVAL} must drop ${table}_no_update_delete_stmt; ${table} is not named in it.`,
      );
    }
    assert.match(
      sql,
      /DROP TRIGGER IF EXISTS/,
      `${REMOVAL} must drop the statement-level triggers, not merely describe them.`,
    );
  });

  it("2291 leaves the row-level and TRUNCATE guards alone", () => {
    const sql = read(REMOVAL);
    // The removal targets exactly one trigger suffix. If it ever drops the
    // row-level guard, append-only stops being enforced at all — which would be
    // a security regression wearing a CI fix's clothes.
    const drops = [...sql.matchAll(/DROP TRIGGER IF EXISTS[^;]*/gi)].map((m) => m[0]);
    for (const drop of drops) {
      assert.ok(
        /_no_update_delete_stmt/.test(drop),
        `${REMOVAL} drops something other than the statement-level trigger: ${drop.trim()}`,
      );
    }
    assert.ok(drops.length > 0, `${REMOVAL} contains no DROP TRIGGER at all.`);
  });
});
