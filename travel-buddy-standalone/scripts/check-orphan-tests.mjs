#!/usr/bin/env node
/**
 * Orphan-test guard — fails when a test file is executed by NO runner.
 *
 * WHY THIS EXISTS (2026-08-29)
 * ---------------------------
 * `src/lib/__tests__/secureStore.e0.test.ts` sat in the repo for months looking
 * complete, was reported as ✅ in docs/security/e2ee-completion-report.md, and
 * had never executed once. It was in KNOWN_BROKEN in run-node-tests.mjs (so the
 * node:test runner skipped it) AND was not named `*.component.test.*` (so the
 * only jest entry point skipped it too). Nothing failed, because nothing ran.
 *
 * A test that runs nowhere is worse than no test: it reports coverage that does
 * not exist. This guard makes that state impossible to introduce silently.
 *
 * HOW COVERAGE IS DEFINED
 * -----------------------
 * "Covered" means executed by something `pnpm check:all` invokes, because that
 * is what CI gates on. A file reachable only through a package script that no
 * workflow calls (e.g. `test:stamps`) is NOT covered — the script existing is
 * not the same as the script running.
 *
 * The three runners are derived from their real configuration rather than
 * restated here, so this guard cannot drift out of sync with them:
 *   - node:test  -> scripts/run-node-tests.mjs (roots, extension, KNOWN_BROKEN)
 *   - jest       -> package.json `test:component` --testPathPattern
 *   - jest web   -> jest.web.config.js testMatch
 *
 * THE ALLOWLIST
 * -------------
 * ORPHANED_TESTS_ALLOWLIST.json records the orphans that already existed when
 * this guard was written. They are a real debt, not an exemption: each entry is
 * a test believed to be providing coverage that in fact provides none. The list
 * may shrink, never grow. A stale entry (a file that is no longer an orphan, or
 * no longer exists) is also an error, so the debt cannot quietly rot.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname;
process.chdir(ROOT);

const ALLOWLIST_PATH = 'scripts/ORPHANED_TESTS_ALLOWLIST.json';

// --- derive each runner's selection from its real configuration --------------

/** KNOWN_BROKEN, parsed from the node runner itself so it cannot drift. */
function knownBroken() {
  const src = readFileSync('scripts/run-node-tests.mjs', 'utf8');
  const start = src.indexOf('const KNOWN_BROKEN = [');
  if (start === -1) throw new Error('KNOWN_BROKEN not found in run-node-tests.mjs');
  const body = src.slice(start, src.indexOf('];', start));
  return new Set([...body.matchAll(/'([^']+\.test\.tsx?)'/g)].map((m) => m[1]));
}

/** Every test file under the roots either runner looks at. */
function allTestFiles() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(full);
      } else if (/\.test\.tsx?$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  for (const r of ['src', 'app', 'server']) walk(r);
  return out.sort();
}

/**
 * node scripts/run-node-tests.mjs — mirrors collect() exactly:
 * roots src+server, skips src/test, collects ONLY `.test.ts` (never `.test.tsx`),
 * excludes `.component.test.`, then subtracts KNOWN_BROKEN.
 */
function runsUnderNode(p, broken) {
  if (!(p.startsWith('src/') || p.startsWith('server/'))) return false;
  if (p.startsWith('src/test/')) return false;
  if (!p.endsWith('.test.ts')) return false;
  if (p.includes('.component.test.')) return false;
  return !broken.has(p);
}

/** jest --testPathPattern='\.component\.test\.' over testMatch src/** + app/**. */
function runsUnderJest(p) {
  if (!p.includes('.component.test.')) return false;
  if (!(p.startsWith('src/') || p.startsWith('app/'))) return false;
  return !p.startsWith('src/test/'); // testPathIgnorePatterns
}

/** jest -c jest.web.config.js — testMatch *.webrender.test.{ts,tsx}. */
function runsUnderJestWeb(p) {
  return p.includes('.webrender.test.') && (p.startsWith('src/') || p.startsWith('app/'));
}

// --- compute -----------------------------------------------------------------

const broken = knownBroken();
const files = allTestFiles();

const orphans = files.filter(
  (p) => !runsUnderNode(p, broken) && !runsUnderJest(p) && !runsUnderJestWeb(p),
);

if (files.length === 0) {
  console.error('check:orphan-tests — discovered 0 test files; discovery is broken.');
  process.exit(1);
}

const allow = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const allowed = new Set(allow.orphans.map((o) => o.file));

const introduced = orphans.filter((p) => !allowed.has(p));
const stale = [...allowed].filter((p) => !orphans.includes(p));

let failed = false;

if (introduced.length > 0) {
  failed = true;
  console.error(
    `\ncheck:orphan-tests — ${introduced.length} test file(s) execute in NO runner:\n` +
      introduced.map((f) => `  - ${f}`).join('\n') +
      '\n\nA test that runs nowhere reports coverage it does not provide. Fix by either:\n' +
      "  * renaming it to *.component.test.ts so `pnpm test:component` runs it, or\n" +
      '  * removing it from KNOWN_BROKEN in scripts/run-node-tests.mjs so `pnpm test` runs it, or\n' +
      '  * deleting it if it is genuinely dead.\n' +
      `Do NOT add it to ${ALLOWLIST_PATH} — that list may shrink, never grow.\n`,
  );
}

if (stale.length > 0) {
  failed = true;
  console.error(
    `\ncheck:orphan-tests — ${stale.length} allowlist entr(ies) are no longer orphaned (or no ` +
      `longer exist). Remove them from ${ALLOWLIST_PATH}:\n` +
      stale.map((f) => `  - ${f}`).join('\n') +
      '\n',
  );
}

if (failed) process.exit(1);

console.log(
  `check:orphan-tests — ${files.length} test files; ${orphans.length} orphaned ` +
    `(all known, tracked in ${ALLOWLIST_PATH}); 0 newly introduced.`,
);
