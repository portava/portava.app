#!/usr/bin/env node
/**
 * Fails when any app/src file (tests excluded) contains a hardcoded
 * paddingBottom literal in the 90–160 range.
 *
 * These values were swept out in favour of the shared three-tier bottom-inset
 * system (useBottomInset.ts). This guard prevents them from creeping back in
 * via careless ports from older revisions of the main tree.
 *
 * Mirrors the style of check-import-extensions.mjs.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['src', 'app'];
const SOURCE_EXTS = new Set(['.ts', '.tsx']);

// Matches:  paddingBottom: 90  /  paddingBottom: 160  (any integer 90–160)
// Also catches string literals: paddingBottom: '120'  or  paddingBottom: "120"
const HARDCODED_PADDING = /paddingBottom\s*:\s*['"]?(\d+)['"]?/g;

const LO = 90;
const HI = 160;

// Files whose names suggest they are tests — excluded from the check.
function isTestFile(filePath) {
  return (
    filePath.includes('__tests__') ||
    filePath.includes('.test.') ||
    filePath.includes('.spec.')
  );
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
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    if (isTestFile(file)) continue;

    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      HARDCODED_PADDING.lastIndex = 0;
      let m;
      while ((m = HARDCODED_PADDING.exec(line)) !== null) {
        const value = parseInt(m[1], 10);
        if (value >= LO && value <= HI) {
          violations.push(
            `${file}:${idx + 1}: hardcoded paddingBottom: ${value} (use useBottomInset() instead)`,
          );
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nHardcoded bottom-padding violations found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nReplace these with the appropriate useBottomInset() tier:\n' +
      '  • pill       — content below the floating tab pill\n' +
      '  • stickyBar  — content below a measured sticky action bar\n' +
      '  • plain      — content that just needs safe-area clearance\n',
  );
  process.exit(1);
}

console.log(
  `lint:bottom-padding — no hardcoded paddingBottom ${LO}–${HI} found in ${SCAN_ROOTS.join(', ')}.`,
);
