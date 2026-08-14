#!/usr/bin/env node
/**
 * check-hook-order — gate on react-hooks/rules-of-hooks in the canonical
 * mobile tree.
 *
 * ## Why this exists
 *
 * A conditional hook is not a style nit: on 2026-07-29 a useEffect was added
 * between two early returns in app/gems/[id].tsx, so the first render ran 16
 * hooks and bailed at `if (loading)` while the render after the fetch resolved
 * reached a 17th. React threw "Rendered more hooks than during the previous
 * render" on every hidden-gem detail view. It survived a week and 1634 passing
 * component tests, because every gem test pins `loading` to a constant and so
 * never drives the transition that triggers it.
 *
 * This check fails the build on rules-of-hooks ERRORS ONLY. It deliberately
 * ignores every other rule and all warnings, so it stays a hard gate that can
 * be trusted rather than a noisy one people learn to skip.
 *
 * Scope is travel-buddy-standalone/{app,src} — the only mobile tree.
 * (artifacts/travel-buddy was legacy-frozen and intentionally excluded; it was
 * archived at bc1bef404, so the exclusion is now moot.)
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const RULE = 'react-hooks/rules-of-hooks';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = [
  'travel-buddy-standalone/app',
  'travel-buddy-standalone/src',
];

const started = Date.now();
const eslint = new ESLint({ cwd: repoRoot });
const results = await eslint.lintFiles(TARGETS);

const hits = [];
for (const result of results) {
  for (const m of result.messages) {
    if (m.ruleId === RULE && m.severity === 2) {
      hits.push({
        file: result.filePath.replace(repoRoot + '/', ''),
        line: m.line,
        message: m.message,
      });
    }
  }
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (hits.length === 0) {
  console.log(
    `check-hook-order PASSED — no ${RULE} violations in ` +
      `${TARGETS.join(', ')} (${results.length} files, ${elapsed}s)`,
  );
  process.exit(0);
}

console.error(
  `\ncheck-hook-order FAILED — ${hits.length} ${RULE} violation(s).\n\n` +
    'A hook below an early return changes the hook count between renders.\n' +
    'React throws "Rendered more/fewer hooks than during the previous render"\n' +
    'the moment the condition flips, which crashes the screen.\n',
);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}`);
  console.error(`    ${h.message}`);
}
console.error(
  '\nFix: move the hook above every early return. If the hook has a side\n' +
    'effect, guard its body on the condition instead of moving the return,\n' +
    'and add that condition to the dep array.\n',
);
process.exit(1);
