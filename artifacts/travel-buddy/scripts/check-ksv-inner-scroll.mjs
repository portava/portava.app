#!/usr/bin/env node
/**
 * Guards against bare KeyboardSafeScrollView + inner ScrollView nesting.
 *
 * KeyboardSafeScrollView is meant for screens that ALREADY have their own
 * scroll container — it is just a bare KeyboardAvoidingView wrapper. Nesting a
 * ScrollView directly inside it creates a double-scroll-container anti-pattern:
 *
 *   ❌ Bad
 *      <KeyboardSafeScrollView>
 *        <ScrollView>…</ScrollView>
 *      </KeyboardSafeScrollView>
 *
 *   ✅ Good — use the wrapper that already has a built-in ScrollView:
 *      <KeyboardSafeView>…</KeyboardSafeView>
 *
 * How it works:
 *   1. Collect every .tsx file under app/ and src/components/.
 *   2. For each file, detect lines that open a <KeyboardSafeScrollView tag.
 *   3. Scan forward from that line to find the end of the opening tag (the
 *      first '>') and then look at the next non-empty line. If it starts a
 *      <ScrollView element, the file is flagged.
 *
 * SCOPE LIMITATION — this guard only catches DIRECT JSX children.
 *   If the inner <ScrollView> is wrapped inside a helper component
 *   (e.g. <MyList> that itself renders a <ScrollView>), the static
 *   line-by-line scan cannot see through the component boundary and
 *   will NOT flag the file. This is an intentional trade-off: the
 *   analysis is fast, zero-dependency, and catches the common case.
 *
 * NOTE exceptions — files added to ALLOWED are skipped entirely.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['app', 'src/components'];

// Relative paths (from the travel-buddy package root) that are permitted to
// contain this nesting. Add with a NOTE comment explaining why.
const ALLOWED = new Set([
  // none currently — add here if a genuine exception is needed
]);

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

/** Matches the start of a <KeyboardSafeScrollView JSX opening tag. */
const KSV_OPEN = /<KeyboardSafeScrollView[\s/>]/;

/** Matches the start of a <ScrollView JSX element (not a closing tag). */
const SCROLL_VIEW_OPEN = /<ScrollView[\s/>]/;

/**
 * Given the lines array and the index of a line that contains a
 * <KeyboardSafeScrollView opening tag, find the index of the first line that
 * has non-whitespace content after the end of that opening tag (i.e. after
 * the first '>' that closes it).
 *
 * Returns -1 if we can't locate the end of the tag within 20 lines.
 */
function firstContentLineAfterKsvOpen(lines, startIdx) {
  // Scan forward to find the '>' that closes the opening tag.
  // A self-closing '/>' also ends the tag, but a self-closed KSV has no
  // children, so we don't need to worry about it here.
  let tagClosed = false;
  for (let i = startIdx; i < lines.length && i < startIdx + 20; i++) {
    const line = lines[i];
    // Check whether this line closes the opening tag.
    const gtIdx = line.indexOf('>');
    if (gtIdx !== -1) {
      tagClosed = true;
      // The rest of this line after '>' may already contain the first child.
      const rest = line.slice(gtIdx + 1).trim();
      if (rest.length > 0) {
        return i; // content starts on the same line as the closing '>'
      }
      // Otherwise look at the next non-empty line.
      for (let j = i + 1; j < lines.length && j < startIdx + 30; j++) {
        if (lines[j].trim().length > 0) return j;
      }
      return -1;
    }
  }
  return tagClosed ? -1 : -1;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectTsx(root)) {
    if (ALLOWED.has(file)) continue;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, idx) => {
      if (!KSV_OPEN.test(line)) return;

      const contentLine = firstContentLineAfterKsvOpen(lines, idx);
      if (contentLine === -1) return;

      if (SCROLL_VIEW_OPEN.test(lines[contentLine])) {
        violations.push(
          `${file}:${idx + 1}: <KeyboardSafeScrollView> has a direct <ScrollView> child (line ${contentLine + 1})`,
        );
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nKSV inner-scroll guard: nesting found (${violations.length}):\n` +
      violations.map((v) => `  ${v}`).join('\n') +
      '\n\n<KeyboardSafeScrollView> already expects the screen to supply its\n' +
      'own scroll container. Wrapping a <ScrollView> inside it creates a\n' +
      'double-scroll-container. Use <KeyboardSafeView> instead — it provides\n' +
      'the built-in ScrollView:\n\n' +
      '  import { KeyboardSafeView } from\n' +
      "    'src/components/ui/KeyboardSafeView';\n\n" +
      '  <KeyboardSafeView>…children…</KeyboardSafeView>\n\n' +
      'If a genuine exception is needed, add the file path to the ALLOWED\n' +
      'set in scripts/check-ksv-inner-scroll.mjs with a NOTE comment.\n',
  );
  process.exit(1);
}

console.log(
  `lint:ksv — no KeyboardSafeScrollView+ScrollView nesting found in ${SCAN_ROOTS.join(', ')}.`,
);
