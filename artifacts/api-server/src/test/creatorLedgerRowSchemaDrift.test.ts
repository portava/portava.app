/**
 * Every column `CreatorAttributionService` writes exists in the migration that
 * declares the table — the half `check:write-path-columns` cannot see.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `check:write-path-columns` extracts the object-literal payload of every
 * `.insert()` / `.upsert()` and diffs its keys against the LIVE schema. Three
 * sites in `services/creators/CreatorAttributionService.ts` defeat it, because
 * the payload handed to supabase is a NAME:
 *
 *     const row  = toCreatorAttributionRow(model.attribution);          // :230
 *     const rows = built.entries.map((e) => toCreatorEarningEntryRow(…)); // :271
 *     const row  = { ...toCreatorAttributionRow(held.attribution), … };  // :308
 *
 * That construction is deliberate and is not being reversed: inlining the
 * literal at each call site duplicates the schema three times instead of
 * naming it once, and the third site would then have to restate eighteen keys
 * to add one. The sites are allowlisted in `UNRESOLVED_ALLOWLIST`, and the
 * allowlist's own comment says what that costs — *"each of these is a blind
 * spot where a phantom column could reach the database unseen by THIS check"*.
 *
 * THIS FILE IS THE COVER FOR THAT BLIND SPOT, and it is written down rather
 * than assumed: the allowlist entry and this test ship together, so the check
 * loses nothing it had.
 *
 * ── WHAT IT CHECKS, AND WHAT IT CANNOT ──────────────────────────────────────
 * It reads the two mappers' returned object keys statically and the `ADD
 * COLUMN` / `CREATE TABLE` column names out of 2920 and 2921, and requires
 * every written key to be a declared column. It is a MIGRATION check, not a
 * live-schema check: it proves the code agrees with the migration that would
 * create the table, which is strictly weaker than proving it agrees with a
 * database. `check:missing-live-columns` reads the live schema from the other
 * direction and is what closes that half.
 *
 * WHAT IS ASSERTED, and why each is separate:
 *  (1) The extractor is WIRED — it found both mappers and a plausible number
 *      of keys. Without this the whole file passes vacuously the day someone
 *      renames a mapper.
 *  (2) Every `toCreatorAttributionRow` key is a column 2920 declares.
 *  (3) Every `toCreatorEarningEntryRow` key is a column 2921 declares.
 *  (4) `supersedes_id`, spread in at the third call site rather than produced
 *      by the mapper, is a declared column too. It is the one key the mappers
 *      do not carry and would be invisible to (2).
 *
 * Run: node --import tsx/esm --test src/test/creatorLedgerRowSchemaDrift.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROWS = join(__dir, "..", "lib", "creatorLedgerRows.ts");
const MIGRATIONS = join(__dir, "..", "migrations");

/**
 * The keys of the object literal a named function RETURNS.
 *
 * Deliberately narrow: it takes the text from `export function <name>` to the
 * next top-level `}` at column 0, and reads `  key:` at exactly two spaces of
 * indentation. Nested objects are indented further and are not columns, which
 * is the one case that would otherwise produce a phantom name.
 */
function returnedKeys(src: string, fn: string): string[] {
  const start = src.indexOf(`export function ${fn}(`);
  if (start < 0) return [];
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end < 0 ? src.length : end);
  return [...body.matchAll(/^ {4}([a-z_][a-z0-9_]*):/gim)].map((m) => m[1]!);
}

/** Words that open a TABLE CONSTRAINT clause, not a column definition. */
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  "constraint", "primary", "unique", "check", "foreign", "exclude", "like",
]);

/** Column names a migration declares, from CREATE TABLE and ADD COLUMN alike. */
function declaredColumns(file: string): Set<string> {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  const out = new Set<string>();
  // CREATE TABLE ... ( <name> <type> ... )
  const ct = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+public\.[a-z_]+\s*\(([\s\S]*?)\n\);/gi;
  for (const m of sql.matchAll(ct)) {
    for (const line of m[1]!.split("\n")) {
      // The type is matched as ANY identifier rather than an enumerated list.
      // The first version of this line enumerated the types it expected and
      // MISSED `currency char(3)`, then reported `currency` as a column 2920
      // does not declare — a false defect produced by the instrument, on a
      // column that has been there since the migration was written. An
      // allowlist of type names is a second schema to keep in sync, so the
      // exclusion moved to the other side: anything whose first token is a
      // table-constraint keyword is not a column, and everything else is.
      const c = /^\s{2,}([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line);
      if (c && !TABLE_CONSTRAINT_KEYWORDS.has(c[1]!.toLowerCase())) out.add(c[1]!);
    }
  }
  for (const m of sql.matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) out.add(m[1]!);
  return out;
}

const rowsSrc = readFileSync(ROWS, "utf8");
const ATTRIBUTION_KEYS = returnedKeys(rowsSrc, "toCreatorAttributionRow");
const ENTRY_KEYS = returnedKeys(rowsSrc, "toCreatorEarningEntryRow");
const C2920 = declaredColumns("2920_creator_attributions.sql");
const C2921 = declaredColumns("2921_creator_earning_entries.sql");

describe("creator ledger row mappers — the write-path blind spot, covered", () => {
  it("(1) the extractor is WIRED — both mappers found, both migrations read", () => {
    assert.ok(
      ATTRIBUTION_KEYS.length >= 15,
      `toCreatorAttributionRow yielded ${ATTRIBUTION_KEYS.length} key(s) — the mapper was renamed or reshaped and this guard is now vacuous`,
    );
    assert.ok(
      ENTRY_KEYS.length >= 12,
      `toCreatorEarningEntryRow yielded ${ENTRY_KEYS.length} key(s) — same`,
    );
    assert.ok(C2920.size >= 15, `2920 yielded ${C2920.size} column(s)`);
    assert.ok(C2921.size >= 12, `2921 yielded ${C2921.size} column(s)`);
  });

  it("(2) every attribution row key is a column 2920 declares", () => {
    const bad = ATTRIBUTION_KEYS.filter((k) => !C2920.has(k));
    assert.deepEqual(
      bad, [],
      "toCreatorAttributionRow writes column(s) 2920 does not create — PostgREST fails the WHOLE insert (PGRST204) " +
        "and the attribution is never recorded",
    );
  });

  it("(3) every earning-entry row key is a column 2921 declares", () => {
    const bad = ENTRY_KEYS.filter((k) => !C2921.has(k));
    assert.deepEqual(
      bad, [],
      "toCreatorEarningEntryRow writes column(s) 2921 does not create — the whole upsert fails and the ledger pair is lost",
    );
  });

  it("(4) supersedes_id — spread in at the call site, not produced by the mapper — is declared too", () => {
    // `holdAttribution`'s call site writes `{ ...toCreatorAttributionRow(…),
    // supersedes_id: originalRowId }`. Case (2) reads the mapper and would
    // never see it, which is exactly the shape of key this whole file exists
    // to stop reaching a database unchecked.
    assert.ok(
      C2920.has("supersedes_id"),
      "2920 declares no supersedes_id, so the fraud-hold insert would fail entirely and no hold would ever be recorded",
    );
  });
});
