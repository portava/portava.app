#!/usr/bin/env node
/**
 * check-test-registration.mjs
 *
 * The `test` script in this package.json is a manually curated,
 * space-separated list of test file paths (see TEST_RUNNER_TECH_DEBT.md for
 * why: no glob-based runner is wired up). That means a brand-new
 * `*.test.ts` file can be added to the repo, pass code review, and then
 * silently NEVER run in CI or the api-test workflow — nobody remembered to
 * add its path to the curated list.
 *
 * This guard closes that gap without requiring an immediate mass-backfill:
 * every *.test.ts file under src/ must be either
 *   (a) present in the package.json `test` script's file list, or
 *   (b) listed in ./UNREGISTERED_TESTS_ALLOWLIST.json, a dated, documented
 *       allowlist of pre-existing files not yet folded into the curated
 *       list (see docs/test-triage-2026-07.md for history).
 *
 * Any NEW test file that is in neither bucket fails this check immediately,
 * so it can never again go unnoticed. Allowlist entries that no longer
 * exist on disk also fail, keeping the allowlist itself honest over time.
 *
 * Run via the check-test-registration workflow:
 *   pnpm --filter @workspace/api-server run check:test-registration
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const testScript = pkg.scripts?.test ?? "";
const registered = new Set(
  (testScript.match(/src\/[^\s'"]+\.test\.ts/g) ?? []).map((p) => p.trim()),
);

const allowlistPath = path.join(__dirname, "UNREGISTERED_TESTS_ALLOWLIST.json");
let allowlist = [];
try {
  allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
} catch {
  // No allowlist file yet is fine — treated as empty.
}
const allowlistSet = new Set(allowlist);

const found = execSync("find src -name '*.test.ts' -type f", { cwd: pkgRoot })
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();

const unregisteredAndNotAllowed = found.filter(
  (f) => !registered.has(f) && !allowlistSet.has(f),
);
const staleAllowlistEntries = allowlist.filter((f) => !found.includes(f));

let failed = false;

if (unregisteredAndNotAllowed.length > 0) {
  failed = true;
  console.error(
    `\n❌ ${unregisteredAndNotAllowed.length} test file(s) exist but are NOT registered in package.json's ` +
      `"test" script and are NOT in the allowlist — they would silently never run:\n`,
  );
  for (const f of unregisteredAndNotAllowed) console.error(`   - ${f}`);
  console.error(
    `\nFix: add each new file's path to the "test" script in artifacts/api-server/package.json.\n` +
      `(If a file is a deliberate carry-over that isn't ready to join the curated run yet, add it to\n` +
      `scripts/UNREGISTERED_TESTS_ALLOWLIST.json with a comment explaining why — but new files should\n` +
      `almost always be registered directly, not allowlisted.)\n`,
  );
}

if (staleAllowlistEntries.length > 0) {
  failed = true;
  console.error(
    `\n❌ ${staleAllowlistEntries.length} allowlist entr(y/ies) in UNREGISTERED_TESTS_ALLOWLIST.json no longer ` +
      `exist on disk — remove them:\n`,
  );
  for (const f of staleAllowlistEntries) console.error(`   - ${f}`);
}

if (failed) {
  process.exit(1);
}

console.log(
  `✅ check-test-registration: all ${found.length} test files are either registered ` +
    `(${registered.size} in package.json) or explicitly allowlisted (${allowlist.length}).`,
);
