#!/usr/bin/env node
/**
 * Checks that all relative imports in the src/ tree have explicit
 * file extensions so the tsx/esm test runner can resolve them without Metro's
 * extension-inference logic.
 *
 * Exception: imports that resolve via Metro platform siblings
 * (foo.web.tsx / foo.native.tsx / foo.ios.tsx / foo.android.tsx) MUST stay
 * extensionless — an explicit extension would bypass platform resolution and
 * pull the native implementation into web bundles (or vice versa). The check
 * also fails when an explicit-extension import points at a module that has a
 * platform sibling.
 *
 * Mirrors the equivalent guard in travel-buddy-standalone.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['src'];
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts']);
const PLATFORM_SUFFIXES = ['web', 'native', 'ios', 'android'];

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

function hasPlatformSibling(fromDir, extensionlessSpec) {
  const base = resolve(fromDir, extensionlessSpec);
  for (const suffix of PLATFORM_SUFFIXES) {
    for (const ext of SOURCE_EXTS) {
      if (existsSync(`${base}.${suffix}${ext}`)) return true;
    }
  }
  return false;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    const src = readFileSync(file, 'utf8');
    const dir = dirname(file);
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      let m;
      BARE_RELATIVE.lastIndex = 0;
      while ((m = BARE_RELATIVE.exec(line)) !== null) {
        const importPath = m[1] ?? m[2];
        if (!importPath) continue;
        const ext = extname(importPath);
        if (ext === '') {
          if (hasPlatformSibling(dir, importPath)) continue; // Metro platform-resolved — must stay bare
          violations.push(`${file}:${idx + 1}: bare relative import '${importPath}'`);
        } else if (SOURCE_EXTS.has(ext)) {
          const bare = importPath.slice(0, -ext.length);
          if (hasPlatformSibling(dir, bare)) {
            violations.push(
              `${file}:${idx + 1}: explicit-extension import '${importPath}' bypasses Metro platform resolution (a .web/.native/.ios/.android sibling exists) — drop the extension`,
            );
          }
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nImport-extension violations found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nAdd the explicit .ts / .tsx extension so tsx/esm can resolve them —\n' +
      'unless the module has a platform sibling (.web/.native/.ios/.android), in which case keep it extensionless.\n',
  );
  process.exit(1);
}

console.log(`lint:imports — no import-extension violations found in ${SCAN_ROOTS.join(', ')}.`);
