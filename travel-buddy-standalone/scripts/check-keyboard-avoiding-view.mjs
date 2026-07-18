#!/usr/bin/env node
/**
 * Checks that no .tsx file under app/ or src/components/ uses a raw
 * <KeyboardAvoidingView directly. All screens and sheets must go through the
 * canonical wrappers:
 *
 *   KeyboardSafeView        — for screens that need a built-in ScrollView
 *   KeyboardSafeScrollView  — for screens that already have a scroll container
 *
 * Both are exported from src/components/ui/KeyboardSafeView.tsx and handle
 * the correct behavior ("padding" on iOS, "height" on Android) automatically.
 *
 * NOTE exceptions — files that ARE allowed to use KeyboardAvoidingView raw:
 *   src/components/ui/KeyboardSafeView.tsx
 *     — this IS the canonical wrapper; it wraps KeyboardAvoidingView by design.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['app', 'src/components'];

// Relative paths (from the travel-buddy package root) that are permitted to
// contain a raw <KeyboardAvoidingView.
const ALLOWED = new Set([
  'src/components/ui/KeyboardSafeView.tsx',
]);

/** Regex that matches the JSX opening tag for KeyboardAvoidingView. */
const RAW_KAV = /<KeyboardAvoidingView[\s/>]/;

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
    } else if (extname(entry.name) === '.tsx') {
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
      if (RAW_KAV.test(line)) {
        violations.push(`${file}:${idx + 1}: raw <KeyboardAvoidingView`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nKeyboardAvoidingView guard: raw usage found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\nUse KeyboardSafeView or KeyboardSafeScrollView from\n' +
      'src/components/ui/KeyboardSafeView.tsx instead.\n' +
      'These wrappers apply the correct behavior on both iOS and Android.\n' +
      'If an exception is genuinely needed, add the file path to the ALLOWED\n' +
      'set in scripts/check-keyboard-avoiding-view.mjs with a NOTE comment.\n',
  );
  process.exit(1);
}

console.log(
  `lint:kav — no raw KeyboardAvoidingView usage found in ${SCAN_ROOTS.join(', ')}.`,
);
