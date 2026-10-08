/**
 * postconditionSupersession — the chain-end half of lead ruling CERT-1 (2026-10-08):
 * for EVERY `-- certify:supersedes-postconditions <file>` declaration on disk,
 * on the database the whole chain built, the superseded file's re-runnable
 * postconditions FAIL (at least one block — otherwise the declaration hides
 * nothing and is refused as gratuitous) and EVERY re-runnable postcondition of
 * the superseder PASSES. Together with certifyPostconditionSupersession.test.ts
 * (subject overlap, never/withheld literals) this is what lets
 * planPostconditionRerun hold a block back without losing an assertion.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postconditionSupersession.db.test.ts
 *      Skips without a database, like every src/test/db suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql } from "./localDb.js";
import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  supersededPostconditionFiles,
  topLevelStatements,
} from "../../scripts/lib/migrationSqlBlocks.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(__dir, "../../migrations");
const sqlOf = (f: string) => readFileSync(join(MIG, f), "utf8");
const postconditions = (f: string) =>
  topLevelStatements(sqlOf(f)).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));

const DECLARATIONS: Array<{ by: string; file: string }> = [];
for (const by of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) {
  for (const file of supersededPostconditionFiles(sqlOf(by))) DECLARATIONS.push({ by, file });
}

describe("certify:migrations stage 4 — every supersession declaration, at the chain end", { skip: !HAVE_DB }, () => {
  it("anti-vacuity: the declarations are found (3801 → 2148, 3362)", () => {
    assert.ok(DECLARATIONS.length >= 2, `found ${DECLARATIONS.length}`);
  });

  for (const { by, file } of DECLARATIONS) {
    it(`${file} ← ${by}: the superseded postcondition FAILS here and the superseder's PASSES`, () => {
      const old = postconditions(file);
      assert.ok(old.length > 0, `${file} has no re-runnable postcondition to supersede`);
      const failed = old.map((b) => psql(b)).filter((r) => r.status !== 0);
      assert.ok(failed.length > 0, `every postcondition of ${file} passes at the chain end, so ${by}'s declaration hides nothing; remove it`);
      for (const r of failed) assert.match(r.stderr, /FAILED/, `${file} failed for a reason other than its own assertion:\n${r.stderr}`);
      const own = postconditions(by);
      assert.ok(own.length > 0, `${by} has no re-runnable postcondition`);
      for (const b of own) {
        const r = psql(b);
        assert.equal(r.status, 0, `${by}'s postcondition must pass at the chain end:\n${r.stderr}`);
      }
    });
  }
});
