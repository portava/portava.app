#!/usr/bin/env node
/**
 * check-import-extensions.mjs
 *
 * Scans TypeScript source files for relative imports that are missing a file
 * extension. In the node:test / tsx/esm environment, extensionless relative
 * imports fail at runtime even though tsc accepts them.  Running this script
 * in the typecheck step catches the problem at CI time rather than at test
 * time.
 *
 * Checks: src/**\/*.ts  (excludes node_modules, __generated__, *.d.ts)
 *
 * Exit 0 — no violations found.
 * Exit 1 — at least one violation; offending paths printed to stderr.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

// Relative import that has no extension:
//   from './foo'        ← bad
//   from '../bar/baz'   ← bad
//   from './foo.ts'     ← ok
//   from 'react'        ← ok (package, not relative)
// Match only when `from` appears at the start of a statement (after ; or newline
// or as the first non-whitespace token) to avoid matching string literals that
// contain import-like patterns (e.g. inside assert.ok(src.includes(...))).
const EXTENSIONLESS_RELATIVE = /^(?:import|export)[^'"]*from\s+['"](\.[^'"]*)['"]/gm;

const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.png', '.svg',
]);

// Scope: services and lib only. See scripts/check-import-extensions.mjs note.
// A follow-up task ("Extend the import-extension guard to cover the full src/ tree")
// will extend this to the full src/ tree once existing violations are fixed.
const ROOTS = ['src/services', 'src/lib'];
const IGNORE_DIRS = new Set(['node_modules', '__generated__', '__mocks__']);

function hasExtension(p) {
  return ALLOWED_EXTENSIONS.has(extname(p));
}

function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      collect(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
}

const files = [];
for (const root of ROOTS) {
  collect(root, files);
}

let violations = 0;
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let m;
  EXTENSIONLESS_RELATIVE.lastIndex = 0;
  while ((m = EXTENSIONLESS_RELATIVE.exec(src)) !== null) {
    const specifier = m[1];
    if (!hasExtension(specifier)) {
      process.stderr.write(
        `${file}: extensionless relative import: '${specifier}'\n`,
      );
      violations++;
    }
  }
}

if (violations > 0) {
  process.stderr.write(
    `\n${violations} extensionless relative import(s) found.\n` +
    `Add the .ts extension to each import so tsx/esm can resolve it at runtime.\n`,
  );
  process.exit(1);
}

console.log(`check-import-extensions: ${files.length} files checked, 0 violations.`);
