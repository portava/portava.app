#!/usr/bin/env node
/**
 * Checks that all relative imports in src/services/ and src/lib/ have explicit
 * file extensions so the tsx/esm test runner can resolve them without Metro's
 * extension-inference logic.
 *
 * Mirrors the equivalent guard in travel-buddy-standalone.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['src/services', 'src/lib'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts']);

// Regex: captures the path portion of any relative import/export/require.
// Matches: from './foo', from "../bar", require('./baz'), export * from './qux'
const BARE_RELATIVE = /(?:from|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)|from\s+['"](\.[^'"]+)['"]/g;

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
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      let m;
      BARE_RELATIVE.lastIndex = 0;
      while ((m = BARE_RELATIVE.exec(line)) !== null) {
        const importPath = m[1] ?? m[2];
        if (!importPath) continue;
        if (extname(importPath) === '') {
          violations.push(`${file}:${idx + 1}: bare relative import '${importPath}'`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nExtensionless relative imports found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nAdd the explicit .ts / .tsx extension so tsx/esm can resolve them.\n',
  );
  process.exit(1);
}

console.log(`lint:imports — no bare relative imports found in ${SCAN_ROOTS.join(', ')}.`);
