#!/usr/bin/env node
/**
 * CI guard: fails if any bare (extension-free) relative import exists in the
 * source directories listed below.
 *
 * Run:   node scripts/check-import-extensions.mjs
 * Fix:   node scripts/fix-extensionless-imports.mjs
 *
 * A bare relative import is one whose specifier matches /^\.\.?\// and does
 * NOT end with a known file extension (.ts, .tsx, .js, .jsx, .json, …).
 * These cause "Cannot find module" failures under tsx/esm in node:test.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const SOURCE_DIRS = [
  'src/components',
  'src/hooks',
  'src/screens',
  'src/utils',
  'src/context',
  'src/theme',
  'src/data',
  'src/constants',
  'src/__fixtures__',
  'src/types',
  'src/tasks',
  'src/shims',
  'src/lib',
  'src/services',
];

const KNOWN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.png', '.svg',
  '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.ttf', '.otf',
]);

function hasKnownExtension(specifier) {
  const dot = specifier.lastIndexOf('.');
  if (dot === -1) return false;
  return KNOWN_EXTENSIONS.has(specifier.slice(dot));
}

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

// Only match specifiers in actual import/export statements:
//   import ... from 'SPEC'
//   export ... from 'SPEC'
//   import 'SPEC'  (side-effect import)
// Does NOT match arbitrary string literals.
const IMPORT_STMT_RE =
  /(?:^|\n)[ \t]*(?:import|export)\b[^;'"]*?from\s+(['"])(\.[^'"]+)\1|(?:^|\n)[ \t]*import\s+(['"])(\.[^'"]+)\3/g;

const violations = [];

for (const dir of SOURCE_DIRS) {
  if (!existsSync(dir)) continue;
  for (const file of collectSourceFiles(dir)) {
    const src = readFileSync(file, 'utf8');
    let match;
    IMPORT_STMT_RE.lastIndex = 0;
    while ((match = IMPORT_STMT_RE.exec(src)) !== null) {
      // group 2 for `from '...'`, group 4 for bare `import '...'`
      const specifier = match[2] ?? match[4];
      if (!specifier) continue;
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      if (hasKnownExtension(specifier)) continue;
      const lineNum = src.slice(0, match.index).split('\n').length;
      violations.push(`  ${file}:${lineNum}  ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} extensionless relative import(s).\n` +
    `Run \`node scripts/fix-extensionless-imports.mjs\` to fix them.\n\n` +
    violations.join('\n'),
  );
  process.exit(1);
}

console.log(`check-import-extensions: OK (no bare relative imports found)`);
