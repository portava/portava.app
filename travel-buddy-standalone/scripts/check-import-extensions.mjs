#!/usr/bin/env node
/**
 * check-import-extensions.mjs
 *
 * Scans node:test files for extensionless relative imports.
 *
 * Discovery mirrors scripts/run-node-tests.mjs exactly:
 *   Roots  : src/  server/
 *   Include: *.test.ts
 *   Exclude: *.component.test.*   (jest, not node:test)
 *            src/test/**           (special manual runners)
 *
 * The tsx/esm loader used by the node:test runner requires explicit file
 * extensions on relative imports.  An extensionless specifier silently
 * resolves to undefined at runtime and produces confusing test failures.
 * Running this check inside `typecheck` catches the problem at write-time.
 *
 * Extensions considered valid: .ts  .tsx  .js  .jsx  .json  .mjs  .cjs
 *
 * Exits with code 1 when violations are found.
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname } from 'node:path';

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;
// Mirrors the ROOTS constant in run-node-tests.mjs
const ROOTS = ['src', 'server'];

const VALID_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs']);

/**
 * Returns true when a source line is an actual import/export/require statement
 * rather than a string literal that happens to contain import-like syntax.
 */
function isImportLine(line) {
  const t = line.trimStart();
  return (
    t.startsWith('import ') ||
    t.startsWith('import(') ||
    t.startsWith('export ') ||
    t.startsWith('} from ') ||
    /\brequire\s*\(/.test(t)
  );
}

// Matches the specifier inside: from './foo'  import('./foo')  require('./foo')
const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()['"](\.[^'"]+)['"]/g;

/**
 * Yields .test.ts files under `dir`, applying the same exclusions as
 * run-node-tests.mjs:
 *   - Skip the src/test/ subtree (special runners)
 *   - Skip *.component.test.* (jest, not node:test)
 */
async function* walkTestFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist — skip silently
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Mirror run-node-tests.mjs: skip src/test
      if (full === join(PACKAGE_ROOT, 'src', 'test')) continue;
      yield* walkTestFiles(full);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.test.ts') &&
      !entry.name.includes('.component.test.')
    ) {
      yield full;
    }
  }
}

let violations = 0;

for (const root of ROOTS) {
  const rootPath = join(PACKAGE_ROOT, root);
  for await (const file of walkTestFiles(rootPath)) {
    const src = await readFile(file, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, idx) => {
      // Skip comment lines
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

      // Only inspect actual import/export/require statements
      if (!isImportLine(line)) return;

      let match;
      IMPORT_RE.lastIndex = 0;
      while ((match = IMPORT_RE.exec(line)) !== null) {
        const specifier = match[1];
        if (!VALID_EXTENSIONS.has(extname(specifier))) {
          const rel = file.replace(PACKAGE_ROOT, '').replace(/^\//, '');
          console.error(`${rel}:${idx + 1}: extensionless import → '${specifier}'`);
          violations++;
        }
      }
    });
  }
}

if (violations > 0) {
  console.error(
    `\n✖ ${violations} extensionless relative import(s) found in node:test files.` +
      `\n  Add the file extension (.ts / .tsx / etc.) — the tsx/esm loader requires it.`,
  );
  process.exit(1);
} else {
  console.log('✔ No extensionless relative imports found in node:test files.');
}
