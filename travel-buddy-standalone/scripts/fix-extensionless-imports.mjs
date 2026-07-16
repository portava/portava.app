#!/usr/bin/env node
/**
 * Adds explicit .ts / .tsx extensions to bare relative imports so
 * tsx/esm can resolve them when node:test files exercise these modules.
 *
 * Only touches files under the directories listed in TARGET_DIRS.
 * Safe to re-run: already-extended imports are left unchanged.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const TARGET_DIRS = [
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

// Collect all .ts / .tsx source files under the target dirs
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

// Given an import specifier that has no extension, find the real extension.
// Returns the specifier with extension appended, or null if not resolvable here.
function resolveExtension(specifier, fromFile) {
  const dir = dirname(fromFile);
  const abs = resolve(dir, specifier);
  for (const ext of ['.ts', '.tsx']) {
    if (existsSync(abs + ext)) return specifier + ext;
  }
  // Also check index files
  for (const ext of ['.ts', '.tsx']) {
    if (existsSync(join(abs, 'index' + ext))) return specifier + '/index' + ext;
  }
  return null;
}

// Regex that matches bare relative imports/exports without an extension.
// Captures: (quote)(./or../path-without-ext)(quote)
// We intentionally skip paths that already end with a known extension.
const BARE_IMPORT_RE = /(['"])(\.\.?\/[^'"]+?)(['"])/g;

const KNOWN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.png', '.svg',
  '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.ttf', '.otf',
]);

function hasKnownExtension(path) {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return KNOWN_EXTENSIONS.has(path.slice(dot));
}

let filesChanged = 0;
let importsFixed = 0;

for (const targetDir of TARGET_DIRS) {
  if (!existsSync(targetDir)) continue;
  const files = collectSourceFiles(targetDir);

  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    let changed = false;

    const updated = original.replace(BARE_IMPORT_RE, (match, q1, spec, q2) => {
      // Skip if already has a known extension
      if (hasKnownExtension(spec)) return match;
      const withExt = resolveExtension(spec, file);
      if (!withExt) return match; // can't resolve — leave as-is
      importsFixed++;
      changed = true;
      return q1 + withExt + q2;
    });

    if (changed) {
      writeFileSync(file, updated, 'utf8');
      filesChanged++;
      console.log(`  fixed: ${file}`);
    }
  }
}

console.log(`\nDone. ${importsFixed} imports fixed across ${filesChanged} files.`);
