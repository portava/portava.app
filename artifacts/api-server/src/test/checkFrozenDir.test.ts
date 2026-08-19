/**
 * Bare-filename rogue-file detection — as used by auditMigrationsVsLive.ts's
 * OWN embedded checkFrozenDirGuard() (a separate, still-bare-filename-only
 * copy of frozen-dir checking that predates and is untouched by the
 * checkFrozenDir.ts/frozenDirCheck.ts rewrite — see checkFrozenDirCheck.test.ts
 * for that one, which tests content-hash-aware checking, missing-root
 * detection, deletion detection, and the unlisted-root sweep).
 *
 * NOTE: this is the OLD, narrower logic. It cannot detect a file whose
 * content was modified in place (same bare filename → still "known"), and it
 * only ever checks two hardcoded roots. Kept here because it's still an
 * accurate test of what auditMigrationsVsLive.ts's inline guard does today.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FROZEN_LEGACY_FILES } from "../scripts/frozenLegacyFiles.js";

/** Mirrors the exact filter used in checkFrozenDir.ts. */
function findRogueFiles(entries: string[]): string[] {
  return entries.filter((f) => !FROZEN_LEGACY_FILES.has(f));
}

describe("Frozen-dir guard — rogue .sql file detection", () => {
  test("a brand-new .sql file added to the legacy dir is flagged as rogue", () => {
    const entries = [...FROZEN_LEGACY_FILES, "9999_sneaky_new_migration.sql"];
    const rogue = findRogueFiles(entries);
    assert.deepEqual(rogue, ["9999_sneaky_new_migration.sql"]);
  });

  test("every currently allowlisted file passes with zero rogue entries", () => {
    const entries = [...FROZEN_LEGACY_FILES];
    assert.deepEqual(findRogueFiles(entries), []);
  });

  test("a nested path (subdirectory) is flagged as rogue even if the bare name is allowlisted", () => {
    const [anyKnownFile] = FROZEN_LEGACY_FILES;
    const nested = `subdir/${anyKnownFile}`;
    const rogue = findRogueFiles([nested]);
    assert.deepEqual(rogue, [nested]);
  });

  test("an empty directory listing produces no rogue files", () => {
    assert.deepEqual(findRogueFiles([]), []);
  });
});
