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

// ── Sentry static-import guard ────────────────────────────────────────────────
// Direct `import * as Sentry from '@sentry/react-native'` in src/services/ or
// src/lib/ causes an esbuild "Unexpected typeof" TransformError whenever that
// file is imported by a node:test runner. Use getSentry() from src/lib/sentry.ts
// instead (lazy require()-in-try/catch).
//
// Exclusions:
//   src/__mocks__/ — mock module stubs are intentional static re-exports.
//   src/lib/sentry.ts — the wrapper itself uses a type-only import for the
//                       return annotation; no runtime static import.
const SENTRY_GUARDED_ROOTS = ['src/services', 'src/lib'];
const SENTRY_EXCLUSIONS = new Set(['src/__mocks__', 'src/lib/sentry.ts']);
const STATIC_SENTRY_IMPORT = /^\s*import\s+.+from\s+['"]@sentry\/react-native['"]/;

const sentryViolations = [];

for (const root of SENTRY_GUARDED_ROOTS) {
  for (const file of collectFiles(root)) {
    // Skip explicitly excluded paths.
    if (SENTRY_EXCLUSIONS.has(file)) continue;
    const isUnderExcluded = [...SENTRY_EXCLUSIONS].some(
      (ex) => file.startsWith(ex + '/') || file.startsWith(ex.replace(/\\/g, '/') + '/'),
    );
    if (isUnderExcluded) continue;

    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      if (STATIC_SENTRY_IMPORT.test(line)) {
        sentryViolations.push(
          `${file}:${idx + 1}: static '@sentry/react-native' import — use getSentry() from src/lib/sentry.ts instead`,
        );
      }
    });
  }
}

if (sentryViolations.length > 0) {
  console.error(
    `\nSentry static-import violations found (${sentryViolations.length}):\n` +
      sentryViolations.map((v) => `  ${v}`).join('\n') +
      '\n\nDirect static imports of @sentry/react-native in src/services/ or src/lib/ pull\n' +
      'react-native into node:test via esbuild and cause an "Unexpected typeof" crash.\n' +
      'Replace with: import { getSentry } from \'../lib/sentry.ts\'; (or the appropriate relative path)\n',
  );
  process.exit(1);
}

console.log(`lint:imports — no import-extension violations found in ${SCAN_ROOTS.join(', ')}.`);
console.log(`lint:sentry  — no static @sentry/react-native imports found in guarded paths.`);
