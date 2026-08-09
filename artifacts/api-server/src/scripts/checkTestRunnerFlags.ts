/**
 * Test-runner truncation-flag guard
 *
 * WHY THIS EXISTS
 * ---------------
 * `--test-force-exit` was in this package's `test` script for months. It
 * terminated runs while child processes were still executing tests, so
 * **54–133 tests (12–30 top-level suites) silently did not run on any given
 * green run**, and which ones varied randomly per run. `ℹ fail 0` only ever
 * meant "zero failures among the tests that reported".
 *
 *   with --test-force-exit    6037 / 6009 / 5986 / 6002 / 6016 / 6065 / 5998
 *   without                   6119 / 6119 / 6119  (byte-identical suite sets)
 *
 * It was removed in bb6369c45 (2026-08-07, "drop --test-force-exit — it was
 * truncating the suite"). But `.agents/memory/api-server-testing.md` went on
 * telling agents the flag was REQUIRED and that the suite would stall without
 * it, so the next agent to read that memory would have put it straight back.
 * The memory is fixed; this guard is the part that does not depend on anyone
 * reading the right file.
 *
 * A silently shrinking count is the worst failure mode in this repo: the
 * suite stays green, the number goes down, and nothing anywhere says so.
 *
 * NOT JUST THAT ONE FLAG
 * ----------------------
 * `--test-force-exit` is not the only node flag that reduces the set of tests
 * that RUN while leaving `fail 0`. Measured 2026-08-09 on a fixed 5-file set
 * (node v24.13.0), baseline 201 tests / 201 pass / 0 fail:
 *
 *   --test-only                             →   5 tests, 0 fail  (196 vanish)
 *   --test-name-pattern=<no match>          →   5 tests, 0 fail  (196 vanish)
 *   --test-skip-pattern=.                   →   5 tests, 0 fail  (196 vanish)
 *   --test-shard=1/2                        →  93 tests, 0 fail  (108 vanish)
 *
 * Every one of those is a GREEN run with a smaller count. `--test-force-exit`
 * did not truncate that small fast set — its damage only appears at full-suite
 * scale, which is exactly why it survived so long.
 *
 * MATCHING IS BY EXACT TOKEN, and the banned names are node-specific. Jest
 * (used by travel-buddy-standalone's `test:component`) spells its equivalents
 * differently — `--testNamePattern`, `--testPathPattern`, `--shard`,
 * `--forceExit` — so none of those collide here and legitimate jest scripts
 * are untouched.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:test-runner-flags
 *
 * Exit 0 → no truncating flag present
 * Exit 1 → a truncating flag is present (with file, script name and reason)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, "../../../..");

/** Flags that reduce the set of tests executed. `null` reason suffix = always banned. */
interface Banned {
  flag: string;
  /** When set, the flag is only banned if followed by `=` and this value. */
  onlyWhenValue?: string;
  why: string;
}

const BANNED: Banned[] = [
  {
    flag: "--test-force-exit",
    why:
      "kills the runner while child processes are still executing — dropped 54-133 tests " +
      "at random per green run (bb6369c45). Never re-add it; the suite exits cleanly on its own.",
  },
  {
    flag: "--test-only",
    why: "runs ONLY tests marked `only` — measured 201 tests -> 5, still `fail 0`.",
  },
  {
    flag: "--test-name-pattern",
    why: "runs only name-matching tests — a non-matching pattern gives 201 -> 5, still `fail 0`.",
  },
  {
    flag: "--test-skip-pattern",
    why: "skips name-matching tests — a broad pattern gives 201 -> 5, still `fail 0`.",
  },
  {
    flag: "--test-shard",
    why: "runs one shard only — measured 201 tests -> 93, still `fail 0`.",
  },
  {
    flag: "--test-rerun-failures",
    why: "reruns only the failures recorded in a state file, so a green run proves nothing about the rest.",
  },
  {
    flag: "--test-isolation",
    onlyWhenValue: "none",
    why:
      "isolation=none runs every file in one process, so a single crash or leak takes the " +
      "remaining files down with it and their tests never report.",
  },
  {
    flag: "--experimental-test-isolation",
    onlyWhenValue: "none",
    why: "same as --test-isolation=none (older spelling).",
  },
];

/** Files whose script/command strings are scanned. */
function targets(): string[] {
  const out: string[] = [];
  const add = (p: string) => existsSync(p) && out.push(p);

  add(resolve(repoRoot, "package.json"));
  add(resolve(repoRoot, "artifacts/api-server/package.json"));
  add(resolve(repoRoot, "scripts/package.json"));
  add(resolve(repoRoot, "travel-buddy-standalone/package.json"));
  add(resolve(repoRoot, ".replit"));

  const pkgDir = resolve(repoRoot, "packages");
  if (existsSync(pkgDir)) {
    for (const d of readdirSync(pkgDir)) {
      add(resolve(pkgDir, d, "package.json"));
    }
  }
  return out;
}

/**
 * True when `haystack` contains `flag` as its own token — i.e. followed by
 * end, whitespace, or `=`. Prevents `--test-shard` matching `--test-sharding`
 * and keeps jest's `--testNamePattern` from matching `--test-name-pattern`.
 */
function hasFlag(haystack: string, flag: string): { present: boolean; value: string | null } {
  const re = new RegExp(`${flag.replace(/[-]/g, "\\-")}(=(\\S*))?(?=\\s|$)`);
  const m = re.exec(haystack);
  if (!m) return { present: false, value: null };
  return { present: true, value: m[2] ?? null };
}

interface Violation {
  file: string;
  where: string;
  flag: string;
  snippet: string;
  why: string;
}

const violations: Violation[] = [];

for (const file of targets()) {
  const rel = relative(repoRoot, file);
  const raw = readFileSync(file, "utf8");

  // For package.json inspect each script separately so the report names it.
  // For .replit (and any parse failure) scan the file as one blob.
  let entries: Array<[string, string]>;
  if (file.endsWith("package.json")) {
    try {
      const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
      entries = Object.entries(scripts);
    } catch {
      entries = [["<unparseable package.json>", raw]];
    }
  } else {
    entries = [["<file>", raw]];
  }

  for (const [name, command] of entries) {
    for (const b of BANNED) {
      const { present, value } = hasFlag(command, b.flag);
      if (!present) continue;
      if (b.onlyWhenValue !== undefined && value !== b.onlyWhenValue) continue;
      violations.push({
        file: rel,
        where: name,
        flag: b.onlyWhenValue ? `${b.flag}=${b.onlyWhenValue}` : b.flag,
        snippet: command.length > 120 ? `${command.slice(0, 117)}...` : command,
        why: b.why,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    "\nERROR: a test-runner flag that SILENTLY REDUCES the number of tests run\n" +
      "       is present. These leave the run GREEN (`ℹ fail 0`) while executing\n" +
      "       fewer tests than the suite contains — the failure mode that hid\n" +
      "       54-133 missing tests per run for months (bb6369c45).\n",
  );
  for (const v of violations) {
    console.error(`  ${v.file} → ${v.where}`);
    console.error(`    flag: ${v.flag}`);
    console.error(`    why:  ${v.why}`);
    console.error(`    in:   ${v.snippet}`);
    console.error();
  }
  console.error(
    "  If one of these is genuinely needed for a narrow, non-gating script,\n" +
      "  it still must not appear in anything the gates run. Compare test counts\n" +
      "  before and after — not just pass/fail — before concluding it is safe.\n",
  );
  process.exit(1);
}

console.log(
  `check:test-runner-flags PASSED (${targets().length} file(s) scanned, ` +
    `${BANNED.length} truncating flag(s) checked, none present)`,
);
process.exit(0);
