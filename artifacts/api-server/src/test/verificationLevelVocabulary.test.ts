/**
 * THE LEVEL THE VERIFICATION SERVICE WRITES MUST BE A LEVEL THE DATABASE ACCEPTS.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `toVerificationLevel()` returns `'id_verified'` or `'id_selfie_verified'`
 * (services/identityVerification/types.ts). The live CHECK constraint
 * `profiles_verification_level_check` permits neither. Measured read-only
 * against production (`ajrurzioarfkagpuxfnb`) on 2026-09-13:
 *
 *   CHECK ((verification_level = ANY (ARRAY['none'::text,'basic_verified'::text,
 *           'trusted_traveler'::text,'host_verified'::text,'buddy_verified'::text])))
 *
 * So the success path of identity verification writes a value the database
 * rejects with 23514. `applyVerifiedProfile` binds that error and throws,
 * `webhookHandler` turns the throw into a 5xx so the provider retries — and the
 * retry writes the same rejected value again, forever. No user can ever reach a
 * non-`none` verification level through the verification flow, which is the
 * column `routes/rentABuddyRollout.ts` gates bookings on and
 * `lib/travelerVerification.ts` reads as the ID signal.
 *
 * This was recorded as open audit item **H5** on 2026-08-30
 * (docs/handoff/2026-08-30-session-handoff.md:117) and proved on CI there:
 * `basic_verified` UPDATE succeeds, `id_verified` → 23514. It is still open at
 * this commit, and it is invisible to every existing verification test because
 * they all run against an injected fake client that has no schema knowledge —
 * `src/test/verification.test.ts:280` asserts `id_verified` round-trips through
 * a double that would accept any string at all.
 *
 * ── WHY THIS TEST READS THE MIGRATION HISTORY ───────────────────────────────
 * A test that asserts a hard-coded list would only restate whichever list its
 * author happened to believe. This one reconstructs the vocabulary the way the
 * DATABASE got it — the baseline structure dump, then every forward migration
 * in numeric order, last declaration wins — and asserts the service's codomain
 * is a subset of it. It therefore fails for BOTH drift directions: a new level
 * added to the TypeScript union with no migration, and a migration that narrows
 * the constraint out from under a level the service still writes.
 *
 * It does NOT prove the constraint is what production holds; only a live query
 * does that, and the measurement above is the record of one. What it does prove
 * is that the repository's own account of the constraint and the repository's
 * own writer agree — which is precisely what was not true.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationLevelVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toVerificationLevel } from "../services/identityVerification/types.js";
import type { VerificationResult } from "../services/identityVerification/types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(__dir, "../../baseline/20260819_baseline_structure.sql");
const MIGRATIONS = resolve(__dir, "../migrations");

const CONSTRAINT = "profiles_verification_level_check";

/** Drop `--` line comments. See `declaredVocabulary` for why this is required. */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Every quoted literal inside the ARRAY[...] of the LAST DEFINITION of
 * `profiles_verification_level_check` in `sql`, or null if it defines none.
 *
 * Matches both spellings the two sources use: the pg_dump form
 * `CONSTRAINT x CHECK ((col = ANY (ARRAY['none'::text, …])))` and the
 * hand-written `ADD CONSTRAINT x\n CHECK (col = ANY (ARRAY['none', …]))`.
 *
 * ── WHY THIS IS FUSSIER THAN IT LOOKS ───────────────────────────────────────
 * The first version of this matched the constraint NAME followed by the next
 * `ARRAY[...]`. It was written that way, mutation-tested by deleting
 * `'buddy_verified'` from 2870's real ADD CONSTRAINT — and it STAYED GREEN.
 * The name occurs four more times in that file after the definition: twice in a
 * `-- REVERSIBLE BY` comment that quotes the NARROWED five-value array verbatim,
 * and once in the postcondition's `c.conname = '…'` lookup, which is followed by
 * a `FOREACH v IN ARRAY ARRAY[…]` listing all seven. "Last match" therefore read
 * the postcondition's checklist and reported it as the constraint — a parser
 * that agreed with the file's own assertion about itself instead of with the
 * DDL. Anchoring on `CONSTRAINT <name> … CHECK` and stripping comments first is
 * what makes the mutation bite (see the mutation log in census-trust.md §12.9).
 */
function declaredVocabulary(sql: string): string[] | null {
  const re = new RegExp(
    `CONSTRAINT\\s+${CONSTRAINT}\\s+CHECK[\\s\\S]*?ARRAY\\s*\\[([^\\]]*)\\]`,
    "g",
  );
  let last: string | null = null;
  for (const m of stripSqlComments(sql).matchAll(re)) last = m[1] ?? null;
  if (last === null) return null;
  return [...last.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/** The vocabulary the database would hold: baseline, then migrations in numeric order. */
function effectiveVocabulary(): { values: string[]; source: string } {
  let values = declaredVocabulary(readFileSync(BASELINE, "utf8"));
  let source = "baseline/20260819_baseline_structure.sql";
  assert.ok(values, `${CONSTRAINT} not found in the baseline structure dump`);

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));

  for (const f of files) {
    const next = declaredVocabulary(readFileSync(join(MIGRATIONS, f), "utf8"));
    if (next && next.length > 0) {
      values = next;
      source = `src/migrations/${f}`;
    }
  }
  return { values: values!, source };
}

/** Every value `toVerificationLevel` can return, exercised rather than transcribed. */
function serviceCodomain(): string[] {
  const inputs: Array<Pick<VerificationResult, "status" | "selfieMatch">> = [
    { status: "verified", selfieMatch: true },
    { status: "verified", selfieMatch: false },
    { status: "verified", selfieMatch: undefined },
    { status: "failed", selfieMatch: true },
    { status: "pending", selfieMatch: false },
    { status: "created", selfieMatch: undefined },
    { status: "processing", selfieMatch: true },
    { status: "expired", selfieMatch: false },
    { status: "canceled", selfieMatch: undefined },
  ];
  return [...new Set(inputs.map((i) => toVerificationLevel(i)))];
}

describe("profiles.verification_level vocabulary", () => {
  it("PROOF OF INSTRUMENT: the parser reads a vocabulary, and the service has more than one value", () => {
    const { values, source } = effectiveVocabulary();
    assert.ok(
      values.includes("none"),
      `the constraint vocabulary parsed from ${source} should contain 'none'; got ${JSON.stringify(values)}`,
    );
    assert.ok(
      serviceCodomain().length >= 2,
      "toVerificationLevel must be able to return more than 'none', or this test proves nothing",
    );
  });

  it("every level toVerificationLevel can write is permitted by the CHECK constraint", () => {
    const { values, source } = effectiveVocabulary();
    const rejected = serviceCodomain().filter((v) => !values.includes(v));
    assert.deepEqual(
      rejected,
      [],
      `toVerificationLevel() returns ${JSON.stringify(rejected)}, which ${CONSTRAINT} ` +
        `(last declared in ${source} as ${JSON.stringify(values)}) rejects with 23514. ` +
        `routes/verification.ts#applyVerifiedProfile writes this column on every successful ` +
        `verification; a rejected value means no user can ever become verified.`,
    );
  });

  it("widening the constraint did not drop a level the platform already uses", () => {
    const { values, source } = effectiveVocabulary();
    // The five levels that predate identity verification. Other surfaces read
    // them (lib/travelerVerification.ts, the Passport projection, the settings
    // screen's LEVEL_LABEL map), so a migration may ADD to this vocabulary and
    // must never remove from it.
    for (const legacy of ["none", "basic_verified", "trusted_traveler", "host_verified", "buddy_verified"]) {
      assert.ok(
        values.includes(legacy),
        `${source} dropped '${legacy}' from ${CONSTRAINT}; existing rows carry it`,
      );
    }
  });
});
