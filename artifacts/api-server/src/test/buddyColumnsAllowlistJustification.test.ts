/**
 * The BUDDY_PUBLIC_COLUMNS allowlist exception is only valid while its
 * justification holds — so this test IS the justification, executable.
 *
 * BACKGROUND
 * ==========
 * Seven buddy endpoints call `.select(BUDDY_PUBLIC_COLUMNS)` rather than a
 * string literal. checkWritePathColumns' resolveSelectString follows an
 * identifier only to a SAME-FILE initializer, and those sites import the
 * constant, so it cannot see through the import and reports them as
 * unresolvable. They are allowlisted in UNRESOLVED_ALLOWLIST.
 *
 * That allowlist entry rests on ONE argument: the risk the check exists to
 * catch is a select list naming a column that does not exist, because
 * PostgREST then fails the WHOLE read with PGRST100 — the MediaProjection
 * bug, where a single wrong column silently emptied place identity. And that
 * risk is already covered for this particular string, because
 * lib/buddyMapRead.ts BOTH defines BUDDY_PUBLIC_COLUMNS AND calls
 * `.select(BUDDY_PUBLIC_COLUMNS)` in the same file — so there the identifier
 * DOES resolve, and the columns ARE checked against the live schema on every
 * CI run.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * That argument is load-bearing and invisible. If someone moves the constant
 * to a shared types module, or refactors buddyMapRead so it no longer selects
 * through the constant in the same file, the live column check silently stops
 * covering it — and seven allowlisted blind spots become genuinely blind, with
 * nothing failing. The allowlist entry would still sit there looking
 * considered.
 *
 * So the justification is pinned here rather than left in a comment. If the
 * verification disappears, this fails and names what to do: either restore the
 * same-file select, or remove the allowlist entries and resolve those seven
 * sites another way.
 *
 * This does NOT verify the columns exist live — that is check:write-path-columns'
 * job, and it needs credentials. This verifies only that the arrangement which
 * makes that check reach this constant is still in place.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");

const READER = join(SRC, "lib", "buddyMapRead.ts");
const GUARD = join(SRC, "scripts", "checkWritePathColumns.ts");
/**
 * The AST extraction — including `resolveSelectString`, whose inability to
 * follow an import is the entire reason the allowlist exception below exists —
 * MOVED out of checkWritePathColumns.ts into this shared module, so the static
 * `check:schema-references` could reuse it without the live-credential guard.
 * The invariant is unchanged; only its address is. Asserting against the old
 * file would silently stop checking anything.
 */
const EXTRACTOR = join(SRC, "scripts", "lib", "schemaReferenceExtract.ts");

/** The allowlist keys whose justification this file pins. */
const DEPENDENT_ALLOWLIST_KEYS = [
  "src/routes/rentABuddy.ts|select|select list not statically resolvable",
  "src/routes/rentABuddyMarketplace.ts|select|select list not statically resolvable",
];

describe("the allowlist exception's justification still holds", () => {
  test("buddyMapRead.ts DEFINES BUDDY_PUBLIC_COLUMNS", () => {
    const src = readFileSync(READER, "utf8");
    assert.match(
      src,
      /export const BUDDY_PUBLIC_COLUMNS\s*=/,
      "the constant no longer lives here. If it moved, the same-file resolution that " +
        "column-checks it moved too — re-point this test at its new home and confirm " +
        "that home also selects through it, or drop the allowlist entries.",
    );
  });

  test("its initializer is a STRING LITERAL, not another identifier", () => {
    // resolveSelectString resolves literals and `+` chains of them. If this
    // became a computed value — an array .join(), a spread, a call — it would
    // stop resolving even in its own file, and the coverage would vanish
    // without the constant moving anywhere.
    const src = readFileSync(READER, "utf8");
    const m = src.match(/export const BUDDY_PUBLIC_COLUMNS\s*=\s*([\s\S]{0,1200}?);\s*\n/);
    assert.ok(m, "could not read the initializer");
    const init = m[1];
    assert.ok(
      /^\s*"/.test(init),
      "the initializer must start as a string literal so resolveSelectString can read it",
    );
    assert.ok(
      !/\.join\(|\.map\(|\[|\bfunction\b|=>/.test(init),
      "the initializer became a computed expression — it no longer statically resolves, " +
        "so the live column check no longer covers this constant anywhere",
    );
  });

  test("buddyMapRead.ts SELECTS through it in the same file", () => {
    // This is the actual verification site. Same file as the definition, so
    // the identifier resolves and the columns are checked live.
    const src = readFileSync(READER, "utf8");
    assert.match(
      src,
      /\.select\(\s*BUDDY_PUBLIC_COLUMNS\s*[,)]/,
      "nothing in this file selects through the constant any more, so " +
        "checkWritePathColumns never resolves it and the seven allowlisted sites " +
        "are now genuinely unverified. Restore a same-file select, or remove the " +
        "UNRESOLVED_ALLOWLIST entries and make those sites resolvable.",
    );
  });

  test("the allowlist entries this justifies are actually present", () => {
    // The inverse failure: if the entries were removed because the sites were
    // fixed, this file is stale and should go with them.
    const guard = readFileSync(GUARD, "utf8");
    const missing = DEPENDENT_ALLOWLIST_KEYS.filter((k) => !guard.includes(k));
    assert.deepEqual(
      missing,
      [],
      "these allowlist entries are gone, so this justification pins nothing. " +
        "If the sites were made resolvable, delete this test with them.",
    );
  });

  test("the guard still resolves identifiers only within one file", () => {
    // The whole exception exists because resolveSelectString cannot follow an
    // import. If it ever learns to, the seven sites resolve on their own and
    // the allowlist entries should be dropped rather than left standing.
    //
    // Reads the EXTRACTOR, not the guard: the resolution logic moved there when
    // the static check began sharing it. The property is the same one.
    const guard = readFileSync(EXTRACTOR, "utf8");
    assert.match(
      guard,
      /findInitializer\(\s*expr\.text\s*,\s*sf\s*,/,
      "resolveSelectString's identifier lookup changed shape. If it can now follow " +
        "imports, these sites resolve by themselves — drop the allowlist entries " +
        "instead of keeping a blind spot that is no longer necessary.",
    );
  });
});
