/**
 * Frozen-dir guard — rogue-file detection logic
 *
 * checkFrozenDir.ts itself is a top-level-executing standalone script (it
 * calls process.exit()), so it can't be imported directly in a test without
 * killing the test process. Instead this test exercises the same detection
 * logic checkFrozenDir.ts uses — filtering a directory listing against
 * FROZEN_LEGACY_FILES — to confirm a brand-new .sql file dropped into the
 * legacy migrations folder is classified as rogue, while every currently
 * allowlisted file is not.
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
