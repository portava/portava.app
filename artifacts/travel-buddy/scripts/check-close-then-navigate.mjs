#!/usr/bin/env node
/**
 * check-close-then-navigate.mjs
 *
 * Guards against the close-sheet-then-immediately-navigate race (BUG CC/CD).
 *
 * PROBLEM
 * -------
 * Closing a sheet/Modal and calling router.push/router.replace in the same
 * synchronous tick races the native close animation. The overlay keeps
 * intercepting touches while it slides out, leaving the newly pushed screen
 * (including its back button) silently unresponsive until a full reload.
 *
 * FIX
 * ---
 * Always use closeThenNavigate from src/lib/deferredNavigate.ts, which calls
 * close() first and then defers the navigation with setTimeout so the close
 * animation can finish before the new screen mounts:
 *
 *   import { closeThenNavigate } from 'src/lib/deferredNavigate.ts';
 *
 *   // Instead of:
 *   onClose();
 *   router.push('/some-path');
 *
 *   // Use:
 *   closeThenNavigate(onClose, '/some-path');
 *   // or with an Expo Router Href object (pathname + params):
 *   closeThenNavigate(onClose, { pathname: '/some-path', params: { id } });
 *   // or with a lambda:
 *   closeThenNavigate(() => { onClose(); }, '/some-path');
 *
 * WHAT THIS CHECK DETECTS
 * -----------------------
 * Any .ts/.tsx file in app/ or src/ (outside test files) where a
 * router.push / router.replace call appears on the same line — or on the
 * immediately preceding non-blank line — as one of the recognised close
 * patterns, WITHOUT the navigation being wrapped in setTimeout (i.e. not
 * already deferred).
 *
 * Close patterns covered:
 *   onClose(             — prop close callback
 *   setOpen(false        — boolean state setter
 *   setIsOpen(false
 *   setVisible(false
 *   setModalVisible(false
 *   setSheetOpen(false
 *   setSheetVisible(false
 *   hideModal(           — imperative hide call
 *   hideSheet(
 *   closeSheet(          — imperative close call
 *   closeModal(
 *   dismiss(             — dismiss() on modal refs
 *
 * SCOPE LIMITATION
 * ----------------
 * The check is line-by-line, so it catches the common literal adjacency
 * pattern (the most frequent way the bug is introduced). Multi-statement
 * sequences split across 3+ lines with other code in between, or indirect
 * calls that ultimately close-then-navigate, are outside scope. The check is
 * intentionally fast and zero-dependency.
 *
 * EXCEPTIONS
 * ----------
 * Files in the ALLOWED set below are skipped. Add a file here only when the
 * pattern is genuinely correct (e.g. the navigation IS already deferred by
 * some other mechanism) and annotate with a NOTE explaining why.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import process from 'node:process';

const SCAN_ROOTS = ['app', 'src'];
const SOURCE_EXTS = new Set(['.ts', '.tsx']);

/**
 * Files (relative paths from the package root) intentionally allowed to
 * contain the close+navigate pattern. Add with a NOTE comment.
 */
const ALLOWED = new Set([
  // The deferred-navigate implementation itself — router.push lives inside
  // setTimeout so the literal adjacent-line pattern never fires, but listed
  // here for documentation clarity.
  'src/lib/deferredNavigate.ts',
]);

/**
 * Matches a line that contains a router.push or router.replace call.
 * Excludes comments (lines where the first non-space chars are //).
 */
const NAVIGATE_RE = /\brouter\s*\.\s*(push|replace)\s*\(/;

/**
 * Matches a line that ALREADY defers the navigation inside setTimeout — these
 * are safe because the navigation won't fire until after the close animation.
 */
const ALREADY_DEFERRED_RE = /\bsetTimeout\s*\(/;

/**
 * Matches a "close sheet/modal" call on a source line.
 * All patterns below represent closing a sheet or modal, and are the
 * first half of the BUG CC/CD race when immediately followed by a navigate.
 */
const CLOSE_RE =
  /\bonClose\s*\(|set(?:Open|IsOpen|Visible|ModalVisible|SheetOpen|SheetVisible)\s*\(\s*false|hide(?:Modal|Sheet)\s*\(|close(?:Sheet|Modal)\s*\(|\bdismiss\s*\(/;

function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    // Skip test directories entirely.
    if (entry.isDirectory() && entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      // Skip test and spec files.
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    const rel = relative('.', file);
    if (ALLOWED.has(rel)) continue;

    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');

    lines.forEach((line, idx) => {
      // Only examine lines that have a router navigate call.
      if (!NAVIGATE_RE.test(line)) return;

      // If the navigate is inside a setTimeout on the same line, it is
      // already deferred — not a race.
      if (ALREADY_DEFERRED_RE.test(line)) return;

      // Skip pure comment lines.
      if (/^\s*\/\//.test(line)) return;

      // Case 1: close call and navigate call on the same line (e.g.
      // `onClose(); router.push('/foo')`).
      if (CLOSE_RE.test(line)) {
        violations.push({
          file: rel,
          line: idx + 1,
          text: line.trim(),
          reason: 'close + navigate on same line',
        });
        return;
      }

      // Case 2: the immediately preceding non-blank line has a close call.
      // We look back at most 2 blank lines so layout-formatted code is caught.
      let blanksSkipped = 0;
      for (let j = idx - 1; j >= 0 && blanksSkipped <= 1; j--) {
        const prev = lines[j].trim();
        if (prev === '') {
          blanksSkipped++;
          continue;
        }
        // Skip pure comment lines above.
        if (/^\/\//.test(prev)) break;
        if (CLOSE_RE.test(prev)) {
          violations.push({
            file: rel,
            line: idx + 1,
            text: line.trim(),
            reason: `close call at line ${j + 1} immediately precedes navigate`,
            context: prev,
          });
        }
        break; // only check the single previous non-blank source line
      }
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nclose-then-navigate guard: ${violations.length} violation(s) found:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.text}`);
    if (v.context) console.error(`    preceded by: ${v.context}`);
  }
  console.error(`
WHY THIS IS A BUG (BUG CC/CD)
  Closing a sheet and calling router.push/router.replace in the same tick
  races the native close animation. The overlay stays on top while it slides
  out, making the new screen — including its back button — unresponsive until
  a full reload.

FIX — use closeThenNavigate from src/lib/deferredNavigate.ts:

  import { closeThenNavigate } from 'src/lib/deferredNavigate.ts';

  // ❌ BAD — races the close animation
  onClose();
  router.push('/destination');

  // ✅ GOOD — defers navigation until after the close animation
  closeThenNavigate(onClose, '/destination');
  // or with a lambda if you need to do more than just call onClose:
  closeThenNavigate(() => { onClose(); setExtra(null); }, '/destination');

If a genuine exception is needed, add the file path to the ALLOWED set in
scripts/check-close-then-navigate.mjs with a NOTE comment explaining why.
`);
  process.exit(1);
}

console.log(
  `lint:close-then-navigate — no close-then-navigate races found in ${SCAN_ROOTS.join(', ')}.`,
);
