#!/usr/bin/env node
/**
 * check-import-extensions.mjs
 *
 * Fails with a non-zero exit code if any TypeScript source file under the
 * checked directories contains a relative import that is missing its file
 * extension.  Under tsx/esm, extensionless relative imports silently break
 * test files at load time, so this script acts as the automated guard that
 * prevents regressions.
 *
 * Checked directories (all .ts / .tsx files, recursively):
 *   src/services/
 *   src/lib/
 *
 * Usage:
 *   node scripts/check-import-extensions.mjs
 *
 * Add it to CI / pre-commit by running `pnpm lint:imports`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Relative-import path extensions that are explicitly allowed. */
const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.wasm',
]);

/** Directories to scan, relative to ROOT. */
const SCAN_DIRS = ['src/services', 'src/lib'];

/**
 * Matches the path argument of any `from '...'` or `from "..."` that starts
 * with ./ or ../ (i.e. a relative import).
 * Captures only the path string (group 1).
 */
const IMPORT_RE = /(?:^|[\s;])(?:import|export)[^'"]*from\s+['"](\.[^'"]+)['"]/gm;

// ── helpers ──────────────────────────────────────────────────────────────────

function* walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full);
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      yield full;
    }
  }
}

function checkFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const importPath = m[1];
      const ext = path.extname(importPath);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        violations.push({ line: i + 1, importPath, lineText: line.trim() });
      }
    }
  }

  return violations;
}

// ── main ─────────────────────────────────────────────────────────────────────

let totalViolations = 0;

for (const relDir of SCAN_DIRS) {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) continue;

  for (const filePath of walkDir(absDir)) {
    const violations = checkFile(filePath);
    if (violations.length > 0) {
      const rel = path.relative(ROOT, filePath);
      for (const { line, importPath, lineText } of violations) {
        console.error(`${rel}:${line}  extensionless import: '${importPath}'`);
        console.error(`  ${lineText}`);
        totalViolations++;
      }
    }
  }
}

if (totalViolations > 0) {
  console.error(
    `\n✖  ${totalViolations} extensionless relative import(s) found.` +
    `\n   Append the correct extension (.ts, .tsx, …) to each import path.` +
    `\n   Under tsx/esm, bare relative imports silently break test files at load time.\n`,
  );
  process.exit(1);
} else {
  console.log(`✔  No extensionless relative imports found in ${SCAN_DIRS.join(', ')}.`);
}
