/**
 * Which of a migration's `DO` blocks certify:migrations re-runs against a live
 * database — and which it holds back.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * On 2026-09-21, main run 35581577283 applied
 * 2965_memory_projector_canon_saves_delete_guard.sql to portava-ci cleanly and
 * then failed `migrations — certify the apply landed` seconds later, on 2965's
 * own precondition:
 *
 *     2965: the installed definition already qualifies the _canon_saves delete;
 *     this migration is not idempotent by design.
 *
 * That guard is correct and it fired correctly. Stage 4 re-runs a migration's
 * assertion blocks AFTER the commit, and an "I have already run" guard is false
 * before the apply and true after it, so feeding it to stage 4 fails the
 * migrations that worked — the better the guard, the louder the false failure.
 *
 * 23 of the 580 files carry a guard of that shape, and 16 of them were applied
 * by CI, in scope, on run 34972255308. That run survived only because certify
 * stops at the first failed stage and failed at stage 1, twelve files short of
 * a complete ledger, so stage 4 never ran. Run 35581577283 is the first to
 * reach stage 4 with one in scope.
 *
 * The classification rule lived inside certifyMigrations.ts, whose first import
 * is the strict CI front door and whose last line is `await main()` — so it
 * could not be imported, and had never been asserted on. It now lives in
 * scripts/lib/migrationSqlBlocks.ts and this file tests it there. These are the
 * REAL predicates over the REAL migration files, not a restatement of them.
 *
 * Run: node --import tsx/esm --test src/test/migrationAssertionBlockClassification.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  topLevelStatements,
} from "../scripts/lib/migrationSqlBlocks.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const THE_REGRESSION = "2965_memory_projector_canon_saves_delete_guard.sql";

const sqlFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");

/** The two buckets, exactly as declarationsOf() fills them. */
function classify(sql: string) {
  const preconditions: string[] = [];
  const postconditions: string[] = [];
  for (const stmt of topLevelStatements(sql)) {
    if (!isAssertionOnlyDoBlock(stmt)) continue;
    if (isPreconditionDoBlock(stmt)) preconditions.push(stmt);
    else postconditions.push(stmt);
  }
  return { preconditions, postconditions };
}

describe("2965 — the file that failed certification after applying cleanly", () => {
  const { preconditions, postconditions } = classify(read(THE_REGRESSION));

  it("its $pre$ guard is a precondition, so stage 4 does not re-run it", () => {
    assert.equal(preconditions.length, 1);
    assert.match(
      preconditions[0],
      /already qualifies the _canon_saves delete/,
      "the block held back must be the already-applied guard that failed run 35581577283",
    );
  });

  it("its $post$ block IS re-run — the end state is still asserted after the commit", () => {
    assert.equal(postconditions.length, 1);
    // What stage 4 actually proved on portava-ci once the surgery landed.
    assert.match(postconditions[0], /POSTCONDITION FAILED/);
    assert.match(postconditions[0], /p_user_id uuid, p_enforce_flag boolean/);
    assert.match(postconditions[0], /DELETE FROM _canon_saves WHERE true;/);
  });

  it("its $mig$ block is neither: it runs EXECUTE, so it is not assertion-only", () => {
    const mig = topLevelStatements(read(THE_REGRESSION)).filter((s) => /^\s*DO\s+\$mig\$/i.test(s));
    assert.equal(mig.length, 1, "2965 has exactly one $mig$ block");
    assert.equal(
      isAssertionOnlyDoBlock(mig[0]),
      false,
      "a block that EXECUTEs a built string can never be sent by certification",
    );
  });
});

describe("the rule across every migration on disk", () => {
  // A statement arrives from topLevelStatements() with whatever comments sat
  // between it and the previous semicolon, so "is this $pre$-tagged?" has to be
  // asked past them. Asking with a bare /^\s*DO/ is the bug this test caught:
  // it left 12 files — 2779, 2789, 2791, 2793, 2921 among them — in the re-run
  // bucket, every one of them a second-apply guard.
  const TAGGED_PRE = /^(?:\s|--[^\n]*)*DO\s+\$pre\$/i;

  it("every assertion-only $pre$ block is held back, banner comment or not", () => {
    let preFiles = 0;
    let preBlocks = 0;
    for (const f of sqlFiles()) {
      const { preconditions, postconditions } = classify(read(f));
      if (preconditions.length > 0) preFiles++;
      preBlocks += preconditions.length;
      for (const p of preconditions) {
        assert.match(p, TAGGED_PRE, `${f}: held back a block that is not $pre$-tagged`);
      }
      for (const p of postconditions) {
        assert.doesNotMatch(p, TAGGED_PRE, `${f}: a $pre$ block reached the re-run`);
      }
    }
    // Measured 2026-09-21 across 580 files: 32 files, 32 blocks, none missed.
    // The floor is what makes a predicate that quietly stops matching fail here
    // rather than pass vacuously — it read 0, then 20, before it read 32.
    assert.ok(preFiles >= 32, `expected at least 32 files with a $pre$ block, saw ${preFiles}`);
    assert.ok(preBlocks >= preFiles);
  });

  it("$post$ and untagged $$ blocks are still re-run — the default did not move", () => {
    let post = 0;
    let anon = 0;
    for (const f of sqlFiles()) {
      for (const b of classify(read(f)).postconditions) {
        if (/^(?:\s|--[^\n]*)*DO\s+\$post\$/i.test(b)) post++;
        else if (/^(?:\s|--[^\n]*)*DO\s+\$\$/.test(b)) anon++;
      }
    }
    // 474 blocks still re-run at the time of writing: 30 $post$, 179 $$, the
    // rest under other tags. Holding $pre$ back took 32 blocks out of 506.
    assert.ok(post >= 30, `expected $post$ blocks to still be re-run, saw ${post}`);
    assert.ok(anon >= 170, `expected untagged DO $$ blocks to still be re-run, saw ${anon}`);
  });

  it("the already-applied guard family is why this exists, and it is large", () => {
    const refusers = sqlFiles().filter((f) =>
      classify(read(f)).preconditions.some((p) =>
        p
          .split("\n")
          .some(
            (line) =>
              /RAISE\s+EXCEPTION/i.test(line) &&
              /already (exists|ran|has run)|this migration has run|already qualifies|is already SECURITY DEFINER/i.test(
                line,
              ),
          ),
      ),
    );
    // Each of these RAISEs on a second apply, so each would fail stage 4 on the
    // run that applied it — the way 2965 did. 23 at the time of writing.
    assert.ok(
      refusers.length >= 23,
      `expected the second-apply guard to be house style, saw ${refusers.length}`,
    );
    assert.ok(refusers.includes(THE_REGRESSION));
  });
});

describe("the read-only guarantee is unchanged by the tag", () => {
  it("a $pre$ tag cannot smuggle a mutating block past the scan", () => {
    const mutating = `DO $pre$ BEGIN DROP TABLE x; RAISE NOTICE 'gone'; END $pre$;`;
    assert.equal(isAssertionOnlyDoBlock(mutating), false);
    // Never reaches the precondition/postcondition split at all.
    assert.equal(classify(mutating).preconditions.length, 0);
    assert.equal(classify(mutating).postconditions.length, 0);
  });

  it("a $pre$ block with no RAISE is not an assertion block either", () => {
    assert.equal(isAssertionOnlyDoBlock(`DO $pre$ BEGIN PERFORM 1; END $pre$;`), false);
  });

  it("the tag match is anchored: $prelude$ is not $pre$", () => {
    assert.equal(isPreconditionDoBlock(`DO $prelude$ BEGIN RAISE NOTICE 'x'; END $prelude$;`), false);
    assert.equal(isPreconditionDoBlock(`DO $pre$ BEGIN RAISE NOTICE 'x'; END $pre$;`), true);
  });

  it("a banner comment above the block does not hide the tag", () => {
    // The exact shape 12 migration files use, and the one that slipped past the
    // first version of isPreconditionDoBlock().
    const banner =
      "\n\n-- ── Preconditions ──────────────────────────────────────────\n" +
      "DO $pre$ BEGIN RAISE NOTICE 'x'; END $pre$;";
    assert.equal(isPreconditionDoBlock(banner), true);
    assert.equal(isPreconditionDoBlock(`/* block */ DO $pre$ BEGIN RAISE NOTICE 'x'; END $pre$;`), true);
    // And a comment that merely mentions the tag is not the tag.
    assert.equal(
      isPreconditionDoBlock(`-- DO $pre$ is what this is not\nDO $post$ BEGIN RAISE NOTICE 'x'; END $post$;`),
      false,
    );
  });
});
