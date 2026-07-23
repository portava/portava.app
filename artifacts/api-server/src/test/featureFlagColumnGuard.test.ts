/**
 * Guard: feature_flags reads must use the `flag` column, never `key`.
 *
 * History: the feature_flags table's primary key is `flag`
 * (0037_feature_flags.sql). A long-lived bug had 11 call sites querying
 * `.eq("key", …)` — the column doesn't exist, the query errored, the catch
 * returned false, and the feature silently read as DISABLED regardless of the
 * real flag value (Safe Return was un-enable-able through the API because of
 * this). Fixed 2026-07-23.
 *
 * This test scans the source tree and fails if any file queries
 * feature_flags with an `.eq("key", …)` filter, so the bug cannot recur.
 * Prefer `isFlagEnabled` / `getFlagRow` from lib/featureFlags.ts over local
 * flag-reading helpers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** feature_flags table reference followed (within 300 chars) by .eq("key", …) */
const BAD_PATTERN = /from\(\s*["'`]feature_flags["'`]\s*\)[\s\S]{0,300}?\.eq\(\s*["'`]key["'`]/;

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip tests (this guard included), generated types, and migrations.
      if (entry === "test" || entry === "node_modules" || entry === "migrations") continue;
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("no source file queries feature_flags by the nonexistent `key` column", () => {
  const offenders: string[] = [];
  for (const file of collectTsFiles(SRC_ROOT)) {
    const contents = readFileSync(file, "utf8");
    if (BAD_PATTERN.test(contents)) {
      offenders.push(relative(SRC_ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `feature_flags must be queried by the \`flag\` column (the PK), never \`key\`. ` +
      `Offending files: ${offenders.join(", ")}. Use isFlagEnabled/getFlagRow from lib/featureFlags.ts.`,
  );
});
