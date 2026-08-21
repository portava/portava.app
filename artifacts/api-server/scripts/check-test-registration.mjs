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
 *   (a) present in the package.json `test` or automatically-run `posttest`
 *       script's file list, or
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
// pnpm runs posttest automatically after a successful test script. Keep both
// phases in the registration inventory so a deliberately split curated suite
// is represented truthfully.
const testScript = [pkg.scripts?.test ?? "", pkg.scripts?.posttest ?? ""].join(" ");
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
    `\nFix: add each new file's path to the "test" or automatically-run "posttest" script in artifacts/api-server/package.json.\n` +
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

// ── Summary ───────────────────────────────────────────────────────────────────
//
// The previous summary read:
//
//   all N test files are either registered (R in package.json) or explicitly
//   allowlisted (A)
//
// which was arithmetically impossible: "either/or" implies R + A === N, but the
// two sets OVERLAP — a file can be both registered and allowlisted, in which
// case it RUNS and the allowlist entry is inert. With 392/302/129 the line
// invited the reading 129-are-excluded when the true figure was 90, and that
// wrong number was quoted downstream.
//
// Allowlisting does not prevent execution. It only suppresses this check.
//
// So the numbers below are derived from the files on disk and split by the one
// question that matters — does it run? — which makes them a real partition:
//
//   registeredOnDisk + excluded === found      (true by construction)
//
// `redundant` is reported separately and deliberately NOT added to anything: it
// is a subset of registeredOnDisk, not a third bucket.

const registeredOnDisk = found.filter((f) => registered.has(f));
const excluded = found.filter((f) => !registered.has(f));
const redundant = allowlist.filter((f) => registered.has(f));
// Registered paths with no file on disk — a typo'd entry that runs nothing.
const ghosts = [...registered].filter((f) => !found.includes(f));

console.log(
  `✅ check-test-registration: ${found.length} test file(s) on disk under src/\n` +
    `     ${registeredOnDisk.length} registered  → RUN under \`pnpm test\` (test + posttest)\n` +
    `     ${excluded.length} not registered → NEVER RUN (allowlisted)\n` +
    `     ${registeredOnDisk.length} + ${excluded.length} = ${found.length}\n` +
    `   allowlist has ${allowlist.length} entr(y/ies): ${excluded.length} actually exclude, ` +
    `${redundant.length} are redundant (also registered, so they run).`,
);

if (ghosts.length > 0) {
  console.warn(
    `\n⚠️  ${ghosts.length} registered path(s) do not exist on disk — they run nothing:\n` +
      ghosts.map((f) => `   - ${f}`).join("\n"),
  );
}
