#!/usr/bin/env node
/**
 * check-avatar-icon-sizing.mjs
 *
 * Guards against new code hardcoding a circular avatar/icon box size or an
 * image aspect ratio instead of reaching for the `avatar` / `icon` / `aspect`
 * tokens in src/theme/tokens.ts.
 *
 * PROBLEM
 * -------
 * Before the `avatar` token existed (2026-08-09), there was nowhere to reach
 * for a circular avatar size, so ~100 call sites each wrote their own
 * `{ width: 36, height: 36, borderRadius: 18 }` by hand. They drifted into
 * five near-identical values (28 / 32 / 34 / 36 / 40) that mean the same
 * thing design-wise but cannot be told apart or resized as a group. The same
 * thing happened to image aspect ratios: `aspectRatio: 4 / 5` is hand-typed
 * at several call sites even though `theme/tokens.ts` exports `aspect` for
 * exactly this.
 *
 * This check does not fix any of that — see WHAT THIS CHECK DOES NOT DO. It
 * exists so the ~100 pre-existing sites can be migrated gradually without the
 * count silently growing in the meantime.
 *
 * WHAT THIS CHECK DETECTS
 * ------------------------
 * Text-based, like the other checks in this directory — it does not
 * type-check or parse an AST.
 *
 *   1. A circular box: `width: N, height: N` (same literal twice) with a
 *      `borderRadius` within the same object literal equal to N/2 (±0.6px),
 *      where N is a literal member of `avatar` or `icon` in theme/tokens.ts.
 *      That combination has exactly one honest reading — "a circular element
 *      sized like an avatar/icon token" — so it is flagged even when it does
 *      not visually render an avatar (e.g. a plain icon-button wrapper sized
 *      to an avatar token is still a token-hygiene issue worth flagging).
 *   2. `aspectRatio: <literal>` where the literal (a bare number or a `N / D`
 *      division) evaluates to within 0.005 of a value in `aspect`.
 *
 * WHAT THIS CHECK DOES NOT DO
 * ----------------------------
 * - It does NOT flag hardcoded sizes that happen to fall between token
 *   values (e.g. a deliberate one-off 30px circle). Only literal token
 *   *matches* are ambiguous enough to be worth flagging — a script cannot
 *   tell "should be a token" from "coincidentally close" for a near-miss.
 * - It does NOT scan `size={N}` props on icon components (lucide-react-native
 *   etc). That is a materially different detection shape (JSX prop, not a
 *   style object) and a much larger, separately-scoped sweep — the icon
 *   scale already has real adoption (`icon.*` imported in several files)
 *   without a growth problem the way avatar sizing has one.
 * - It does NOT migrate any existing call site. See ALLOWLIST below.
 *
 * THE ALLOWLIST — SHRINK-ONLY
 * -----------------------------
 * `check-avatar-icon-sizing.allowlist.json` is a snapshot of every violation
 * that existed when this check was introduced, grouped by
 * `file + kind + value` with a `count` (how many times that exact
 * combination appears in that file). It exists so the ~100-site migration
 * can happen gradually instead of blocking on this check on day one.
 *
 * Two independent things make it shrink-only:
 *
 *   1. Per-entry: a file's current count for a given (kind, value) must be
 *      <= the allowlisted count. If it goes UP, that file grew a new
 *      instance of an already-flagged problem — fail.
 *   2. A violation combination with NO allowlist entry at all is a violation
 *      in a file/value pair that did not exist at snapshot time — fail. That
 *      is what actually stops new hardcoded sizes in new code: there is no
 *      "just add it to the allowlist" escape hatch checked into this script,
 *      because of point 3.
 *   3. Global ceiling: `ALLOWLIST_CEILING` below is the total violation count
 *      at snapshot time, hardcoded as a literal in THIS FILE (not derived
 *      from the JSON at runtime). If the allowlist JSON's total ever exceeds
 *      it — whether from a bumped count or a hand-added entry — the check
 *      fails even if every individual entry looks locally justified. Lower
 *      this number by hand as violations are migrated to tokens. Never raise
 *      it; a real new avatar/aspect need should reach for the existing token
 *      values, not a new hardcoded one.
 *
 * Regenerate the JSON after fixing violations with:
 *   node scripts/check-avatar-icon-sizing.mjs --write-allowlist
 * This only ever shrinks counts/removes entries in practice, but nothing
 * stops a bad actor from hand-editing counts upward — that is what the
 * hardcoded ceiling in point 3 is for.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
process.chdir(ROOT);

const SCAN_ROOTS = ['app', 'src'];
const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const ALLOWLIST_PATH = join(__dirname, 'check-avatar-icon-sizing.allowlist.json');

/**
 * Frozen at authoring time (2026-08-09) to the exact total produced by
 * `--write-allowlist` against the codebase as it stood then. See point 3 in
 * the file header — this is the actual enforcement mechanism, not the
 * per-entry counts. LOWER ONLY.
 */
const ALLOWLIST_CEILING = 0;

/** Files that ARE the token/component definitions — a literal here is the point. */
const ALLOWED_FILES = new Set([
  'src/theme/tokens.ts',
  'src/components/CachedImage.tsx',
  'src/components/ui/Avatar.tsx',
]);

// Keep in sync with src/theme/tokens.ts `avatar` / `icon` / `aspect`. Not
// imported directly: this is a zero-build-step Node script, and re-deriving
// the plain numbers here is simpler than adding a ts-node/tsx dependency
// just for this check.
const AVATAR_VALUES = new Set([28, 32, 34, 36, 40, 44, 48, 56]);
const ICON_VALUES = new Set([14, 18, 22, 26, 20]);
const ASPECT_VALUES = [
  { name: 'wide', value: 16 / 9 },
  { name: 'card', value: 4 / 3 },
  { name: 'square', value: 1 },
  { name: 'portrait', value: 4 / 5 },
  { name: 'story', value: 9 / 16 },
];

function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory doesn't exist — skip silently
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === '__tests__' || entry.name === '__mocks__')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (SOURCE_EXTS.has(extname(entry.name))) {
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      out.push(full);
    }
  }
  return out;
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (src[i] === '\n') line++;
  return line;
}

/** Evaluates a `N` or `N / D` literal to a number, or null if not a plain literal. */
function evalRatioLiteral(text) {
  const m = text.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*([0-9]+(?:\.[0-9]+)?))?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const den = m[2] ? parseFloat(m[2]) : 1;
  return den === 0 ? null : num / den;
}

function matchAspectName(value) {
  const hit = ASPECT_VALUES.find((a) => Math.abs(a.value - value) < 0.005);
  return hit ? hit.name : null;
}

/**
 * Scans one file's source for both violation shapes. Returns a list of
 * { line, kind: 'avatar'|'icon'|'aspect', value, token }.
 */
function scanFile(src) {
  const found = [];

  // 1. Circular width/height box matching an avatar/icon token value.
  const boxRe = /width:\s*([0-9]+)\s*,\s*height:\s*\1\b/g;
  let m;
  while ((m = boxRe.exec(src)) !== null) {
    const n = parseInt(m[1], 10);
    if (!AVATAR_VALUES.has(n) && !ICON_VALUES.has(n)) continue;

    // borderRadius must be in the same object literal — look ahead to the
    // next `}` (object literals in this codebase's style declarations are
    // not nested) and confirm it is ~n/2.
    const closeIdx = src.indexOf('}', m.index);
    const window = closeIdx === -1 ? src.slice(m.index, m.index + 200) : src.slice(m.index, closeIdx);
    const brMatch = window.match(/borderRadius:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!brMatch) continue;
    const br = parseFloat(brMatch[1]);
    if (Math.abs(br - n / 2) > 0.6) continue;

    const kind = AVATAR_VALUES.has(n) ? 'avatar' : 'icon';
    found.push({ line: lineAt(src, m.index), kind, value: n });
  }

  // 2. aspectRatio literal matching an `aspect` token value.
  const aspectRe = /aspectRatio:\s*([0-9.\/\s]+?)\s*[,}]/g;
  while ((m = aspectRe.exec(src)) !== null) {
    const value = evalRatioLiteral(m[1]);
    if (value === null) continue;
    const name = matchAspectName(value);
    if (!name) continue; // not a token-matching ratio (e.g. an intentional one-off)
    found.push({ line: lineAt(src, m.index), kind: 'aspect', value: name });
  }

  return found;
}

// ── Run the scan ──────────────────────────────────────────────────────────────

/** key -> count, where key = `${file}::${kind}::${value}` */
const currentCounts = new Map();
/** key -> sample lines, for reporting */
const sampleLines = new Map();

for (const root of SCAN_ROOTS) {
  for (const file of collectFiles(root)) {
    const rel = relative('.', file).split(sep).join('/');
    if (ALLOWED_FILES.has(rel)) continue;

    const src = readFileSync(file, 'utf8');
    for (const hit of scanFile(src)) {
      const key = `${rel}::${hit.kind}::${hit.value}`;
      currentCounts.set(key, (currentCounts.get(key) ?? 0) + 1);
      const lines = sampleLines.get(key) ?? [];
      if (lines.length < 3) lines.push(hit.line);
      sampleLines.set(key, lines);
    }
  }
}

// ── --write-allowlist: regenerate the snapshot and exit ────────────────────────

if (process.argv.includes('--write-allowlist')) {
  const entries = [...currentCounts.entries()]
    .map(([key, count]) => {
      const [file, kind, value] = key.split('::');
      return { file, kind, value: kind === 'aspect' ? value : Number(value), count };
    })
    .sort((a, b) => (a.file === b.file ? a.kind.localeCompare(b.kind) : a.file.localeCompare(b.file)));
  writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(entries, null, 2)}\n`);
  const total = entries.reduce((sum, e) => sum + e.count, 0);
  console.log(`Wrote ${entries.length} entries (${total} total violations) to ${relative('.', ALLOWLIST_PATH)}.`);
  if (total > ALLOWLIST_CEILING) {
    console.error(
      `\nWARNING: this total (${total}) exceeds ALLOWLIST_CEILING (${ALLOWLIST_CEILING}) hardcoded in `
      + `check-avatar-icon-sizing.mjs. Lower it only if you have confirmed new violations were added `
      + `deliberately and reviewed — otherwise something regressed. The check below will fail until `
      + `the ceiling and this file agree.`,
    );
  }
  process.exit(0);
}

// ── Compare against the allowlist ───────────────────────────────────────────────

if (!existsSync(ALLOWLIST_PATH)) {
  console.error(
    `\navatar/icon sizing guard: ${relative('.', ALLOWLIST_PATH)} is missing. `
    + `Run "node scripts/check-avatar-icon-sizing.mjs --write-allowlist" once to seed it.\n`,
  );
  process.exit(1);
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const allowlistMap = new Map(
  allowlist.map((e) => [`${e.file}::${e.kind}::${e.value}`, e.count]),
);
const allowlistTotal = allowlist.reduce((sum, e) => sum + e.count, 0);

const problems = [];

if (allowlistTotal > ALLOWLIST_CEILING) {
  problems.push(
    `the allowlist total is ${allowlistTotal}, above the frozen ceiling of ${ALLOWLIST_CEILING} in `
    + `check-avatar-icon-sizing.mjs. The allowlist can only shrink — if this was intentional, someone `
    + `still needs to lower ALLOWLIST_CEILING by hand after review; if not, an entry was added or bumped `
    + `and should be reverted.`,
  );
}

for (const [key, count] of currentCounts) {
  const allowed = allowlistMap.get(key);
  const [file, kind, value] = key.split('::');
  if (allowed === undefined) {
    const lines = sampleLines.get(key).join(', ');
    problems.push(
      `${file} has a new hardcoded ${kind} value ${value} not in the allowlist (line${sampleLines.get(key).length > 1 ? 's' : ''} ${lines}). `
      + `Use the ${kind === 'aspect' ? `aspect.${value}` : `${kind}.*`} token from theme/tokens.ts instead.`,
    );
  } else if (count > allowed) {
    problems.push(
      `${file} now has ${count} instances of hardcoded ${kind} value ${value}, up from the allowlisted ${allowed}. `
      + `Use the ${kind === 'aspect' ? `aspect.${value}` : `${kind}.*`} token from theme/tokens.ts for the new one(s) instead.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`\navatar/icon sizing guard: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`
This check only blocks NEW hardcoded avatar/icon boxes and aspect ratios —
the ~100 pre-existing sites are intentionally left for a separate migration
pass and are recorded in scripts/check-avatar-icon-sizing.allowlist.json.
Import { avatar, icon, aspect } from '../theme/tokens.ts' instead of typing
the matching literal again.
`);
  process.exit(1);
}

const currentTotal = [...currentCounts.values()].reduce((a, b) => a + b, 0);
console.log(
  `lint:avatar-icon-sizing — no new hardcoded avatar/icon/aspect literals `
  + `(${currentTotal} pre-existing, allowlisted, ceiling ${ALLOWLIST_CEILING}).`,
);
