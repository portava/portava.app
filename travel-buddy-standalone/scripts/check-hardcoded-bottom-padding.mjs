#!/usr/bin/env node
/**
 * Guards against hardcoded paddingBottom values ≥ 90 in TSX/TS source files.
 *
 * The app uses a three-tier bottom-inset system (useBottomInset / NavBarFiller,
 * useStickyBarInset, usePlainBottomInset / PlainBottomFiller). Any hardcoded
 * numeric paddingBottom of 90 or more bypasses that system and causes oversized
 * voids or content hidden under the nav pill / sticky bars.
 *
 * ALLOWED exceptions — add a path here with a NOTE comment when a file
 * genuinely needs a large bottom padding for a non-inset reason (e.g. a fixed
 * image crop, a specific animation offset).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['app', 'src'];

/** Relative paths (from the standalone root) that are permitted to contain
 *  a high paddingBottom value. Add with a NOTE comment explaining why. */
const ALLOWED = new Set([
  // none currently — add here if a genuine exception is needed
]);

/** Matches `paddingBottom: <number>` where the number is an integer literal. */
const HARDCODED_PAD_BOTTOM = /paddingBottom\s*:\s*(\d+)/g;

/** Threshold: values strictly below this are acceptable. */
const THRESHOLD = 90;

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
    } else {
      const ext = extname(entry.name);
      if (ext === '.tsx' || ext === '.ts') out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    if (ALLOWED.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      let m;
      HARDCODED_PAD_BOTTOM.lastIndex = 0;
      while ((m = HARDCODED_PAD_BOTTOM.exec(line)) !== null) {
        const value = parseInt(m[1], 10);
        if (value >= THRESHOLD) {
          violations.push(
            `${file}:${idx + 1}: paddingBottom: ${value} (≥ ${THRESHOLD}) — use useBottomInset / NavBarFiller / usePlainBottomInset instead`,
          );
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nbottom-padding guard: hardcoded paddingBottom ≥ ${THRESHOLD} found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nHardcoded values this large bypass the three-tier bottom-inset system\n' +
      '(useBottomInset / NavBarFiller, useStickyBarInset, usePlainBottomInset /\n' +
      'PlainBottomFiller). Pick the tier that matches the surface, or add the\n' +
      'file path to the ALLOWED set in scripts/check-hardcoded-bottom-padding.mjs\n' +
      'with a NOTE comment if the value is genuinely needed.\n',
  );
  process.exit(1);
}

console.log(
  `lint:bottom-padding — no hardcoded paddingBottom ≥ ${THRESHOLD} found in ${SCAN_ROOTS.join(', ')}.`,
);
