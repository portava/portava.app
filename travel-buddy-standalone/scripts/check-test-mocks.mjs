#!/usr/bin/env node
/**
 * Guards all jest-run test files against crash-prone jest.mock stand-ins.
 *
 * 1. Object-literal factories — `jest.mock('mod', () => ({ ... }))` — must
 *    either spread `jest.requireActual(...)` or be preceded (within a few
 *    lines) by a NOTE comment explaining why they stay exhaustive. Bare
 *    object literals crash the whole suite when the real module gains an
 *    export ("Element type is invalid" / "X is not a function").
 *
 * 2. Per-file `jest.mock('lucide-react-native', ...)` mocks are forbidden —
 *    the global Proxy mock (src/__mocks__/lucide-react-native.tsx, wired via
 *    jest.config moduleNameMapper) already covers every icon and never drifts.
 *
 * Scans every file matched by jest.config testMatch (src/ and app/, all
 * *.test.* files — not just component tests).
 *
 * Mirrors the equivalent guard in artifacts/travel-buddy.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['src', 'app'];
const NOTE_LOOKBEHIND_LINES = 4;

// Start of an object-literal factory: jest.mock('mod', () => ({
const OBJECT_LITERAL_MOCK =
  /jest\.mock\(\s*['"]([^'"]+)['"]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\(\{/;
const LUCIDE_MOCK = /jest\.mock\(\s*['"]lucide-react-native['"]/;

function collectTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, out);
    } else if (/\.test\.[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Extract the factory body: from the `({` that opens the returned object
 *  literal to its matching `}`. Brace matching is approximate (ignores
 *  braces inside strings) but good enough for lint purposes. */
function extractFactoryBody(src, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx, i + 1);
    }
  }
  return src.slice(openBraceIdx); // unbalanced — take the rest
}

function hasNoteNearby(lines, lineIdx) {
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - NOTE_LOOKBEHIND_LINES); i--) {
    const line = lines[i];
    if (/(?:\/\/|\/\*|\*).*NOTE/.test(line)) return true;
  }
  return false;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectTestFiles(root)) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, idx) => {
      // Skip comment lines (e.g. docblocks that *mention* jest.mock).
      if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;

      if (LUCIDE_MOCK.test(line)) {
        violations.push(
          `${file}:${idx + 1}: per-file lucide-react-native mock — remove it; the global Proxy mock (jest.config moduleNameMapper) already covers every icon.`,
        );
        return;
      }

      const m = OBJECT_LITERAL_MOCK.exec(line);
      if (!m) return;

      // Absolute offset of the object literal's `{` within the file.
      const lineStart = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
      const braceIdx = lineStart + line.indexOf(m[0]) + m[0].length - 1;
      const body = extractFactoryBody(src, braceIdx);

      if (/jest\.requireActual/.test(body)) return;
      if (hasNoteNearby(lines, idx)) return;

      violations.push(
        `${file}:${idx + 1}: bare object-literal jest.mock('${m[1]}') — spread jest.requireActual('${m[1]}') into the factory, or add a preceding "// NOTE: ..." comment explaining why it must stay exhaustive.`,
      );
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nCrash-prone jest.mock stand-ins found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nBare object-literal factories crash the whole suite when the real module gains an\n' +
      'export ("Element type is invalid" / "X is not a function"). Spread jest.requireActual\n' +
      'or document the exception with a NOTE comment directly above the mock.\n',
  );
  process.exit(1);
}

console.log(
  `lint:mocks — no crash-prone jest.mock stand-ins found in ${SCAN_ROOTS.join(', ')} (all jest test files).`,
);
