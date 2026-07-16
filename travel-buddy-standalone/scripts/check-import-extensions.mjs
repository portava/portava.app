#!/usr/bin/env node
/**
 * CI guard: fails if any bare (extension-free) relative import exists in a
 * non-baselined source file.
 *
 * Files listed in scripts/import-check-baseline.txt are grandfathered — they
 * may contain bare imports inherited from before enforcement began.  Any file
 * NOT in the baseline is checked strictly: a single bare import causes exit 1.
 *
 * This means:
 *   - New source files must use fully-specified relative import paths.
 *   - Pre-existing violations are tracked in the baseline and can be cleaned
 *     up incrementally; removing a file from the baseline after fixing it
 *     enforces the fix going forward.
 *
 * Run:   node scripts/check-import-extensions.mjs
 * Fix:   node scripts/fix-extensionless-imports.mjs
 *
 * Mirrors the equivalent guard in the main travel-buddy package.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dir, '..');

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
  'server',
];

const KNOWN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.png', '.svg',
  '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.ttf', '.otf',
  '.mjs', '.cjs',
]);

function hasKnownExtension(specifier) {
  const dot = specifier.lastIndexOf('.');
  if (dot === -1) return false;
  return KNOWN_EXTENSIONS.has(specifier.slice(dot));
}

function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
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

// Load the grandfathered baseline (one relative file path per line).
const baselinePath = join(__dir, 'import-check-baseline.txt');
const baseline = new Set(
  existsSync(baselinePath)
    ? readFileSync(baselinePath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : [],
);

const violations = [];
let checkedCount = 0;

for (const dir of SOURCE_DIRS) {
  const abs = join(projectRoot, dir);
  for (const file of collectFiles(abs)) {
    const rel = relative(projectRoot, file).replace(/\\/g, '/');
    if (baseline.has(rel)) continue; // grandfathered — skip

    checkedCount++;
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
      violations.push(`  ${rel}:${lineNum}  ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} extensionless relative import(s) in non-baselined file(s).\n` +
    `Add a file extension (.ts, .tsx, .js, etc.) to each import, or — if this\n` +
    `is a pre-existing file — add it to scripts/import-check-baseline.txt.\n` +
    `Run \`node scripts/fix-extensionless-imports.mjs\` to fix them automatically.\n\n` +
    violations.join('\n'),
  );
  process.exit(1);
}

console.log(
  `check-import-extensions: OK — ${checkedCount} non-baselined file(s) checked, ` +
  `${baseline.size} grandfathered file(s) skipped.`,
);
