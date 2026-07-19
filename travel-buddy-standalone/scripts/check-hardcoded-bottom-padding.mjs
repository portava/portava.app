#!/usr/bin/env node
/**
 * Guards against hardcoded bottom padding values ≥ 90 creeping back into scroll
 * surfaces and stack screens.
 *
 * The project uses a three-tier inset system (see src/hooks/useBottomInset.ts):
 *   • Tab surfaces  → useBottomInset() / NavBarFiller (96 + safe-area)
 *   • Sticky-bar stack screens → useStickyBarInset() (measure the bar)
 *   • Bar-less stack/sheets   → usePlainBottomInset() / PlainBottomFiller
 *
 * Hardcoded paddingBottom values ≥ 90 indicate the author ignored the shared
 * primitives and invented their own clearance, which creates oversized voids
 * on tall devices and fails on notched/dynamic-island phones.
 *
 * What is flagged:
 *   paddingBottom: 90           ← number literal in StyleSheet or inline style
 *   paddingBottom: 120,         ← trailing comma variant
 *   paddingBottom: 160          ← any value 90–9999
 *
 * What is NOT flagged:
 *   paddingBottom: 24           ← small values (< 90) are fine
 *   // paddingBottom: 120       ← commented-out lines are skipped
 *   useBottomInset()            ← dynamic hook usage (no literal)
 *
 * NOTE exceptions — add file paths to ALLOWED with a comment explaining why.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['app', 'src/components', 'src/screens'];

// Relative paths (from the standalone root) that are permitted to contain a
// hardcoded large paddingBottom. Add with a NOTE comment explaining why.
const ALLOWED = new Set([
  // none currently — add here only for genuine exceptions
]);

/** Matches `paddingBottom: <number>` where the number is >= 90. */
const HARDCODED_BOTTOM = /paddingBottom\s*:\s*(\d+)/;

function collectTsx(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsx(full, out);
    } else if (extname(entry.name) === '.tsx' || extname(entry.name) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectTsx(root)) {
    if (ALLOWED.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      const match = HARDCODED_BOTTOM.exec(stripped);
      if (!match) return;
      const value = parseInt(match[1], 10);
      if (value >= 90) {
        violations.push(
          `${file}:${idx + 1}: hardcoded paddingBottom: ${value} (use useBottomInset / NavBarFiller / usePlainBottomInset instead)`,
        );
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nlint:bottom-padding — hardcoded large bottom padding found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nUse the shared bottom-inset primitives instead of magic numbers:\n' +
      '  • Tab screens / FlatList footers → <NavBarFiller /> or useBottomInset()\n' +
      '  • Stack screens with a sticky bar → useStickyBarInset()\n' +
      '  • Bar-less stack screens / sheets → <PlainBottomFiller /> or usePlainBottomInset()\n\n' +
      'If a genuine exception is needed, add the file path to the ALLOWED\n' +
      'set in scripts/check-hardcoded-bottom-padding.mjs with a NOTE comment.\n',
  );
  process.exit(1);
}

console.log(
  `lint:bottom-padding — no hardcoded paddingBottom ≥ 90 found in ${SCAN_ROOTS.join(', ')}.`,
);
