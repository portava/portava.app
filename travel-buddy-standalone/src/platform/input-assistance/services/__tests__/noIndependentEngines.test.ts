/**
 * Guard — no NEW independent autocomplete engine outside the platform layer
 * (spec §2/§16/§58: "feature teams must not build independent autocomplete
 * engines"; census G6, G16, G359).
 *
 * WHY
 * ---
 * Census G359 grades the prohibition `W` for one reason: "a prohibition with no
 * detector is a convention." Four pre-existing engines are still live — each
 * debounces keystrokes, aborts the stale request and fetches suggestions on its
 * own, beside the platform's `useInputAssistance` — and nothing stopped a fifth.
 * This file is the detector, in the shape the census asked for
 * (`selectionWriterCoverage.test.ts`): it scans the real UI source and requires
 * every file with an engine's shape to be CLASSIFIED, with a reason.
 *
 * THE SHAPE. A typeahead engine is a debounced, cancellable request driven by
 * typed text, and in this codebase every one of them carries the same three
 * marks in one file: a `setTimeout` debounce, a `clearTimeout` on the next
 * keystroke, and an `AbortController` for the stale request. The scan covers
 * the UI layer (hooks, components, features, screens) — where keystroke state
 * lives — and not `src/services`, whose clients carry request timeouts and are
 * called BY engines rather than being engines.
 *
 * THE RULES (each a separate assertion, each able to fail):
 *   1. Every file with the shape is classified as a KNOWN ENGINE or NOT AN ENGINE.
 *      A new unclassified match fails: migrate it onto `useInputAssistance`, or
 *      classify it here with the reason it is not an engine.
 *   2. KNOWN ENGINES is CLOSED: only the four the census named may appear, and
 *      the list may only shrink. A fifth cannot be waved through by adding it.
 *   3. No stale entry: a classified file must still exist and still have the
 *      shape. Migrating an engine (removing its own debounce) turns this red
 *      until its entry is deleted — the list cannot outlive the debt.
 *   4. The scan is not vacuous: it must see at least the engines still listed.
 *
 * WHAT IT DOES NOT CATCH, stated rather than implied: an engine built without
 * one of the three marks (e.g. debounced by a library, or uncancelled), or one
 * placed under `src/services`. It ratchets the shape every existing engine has;
 * it is not a proof that no other shape exists.
 *
 * LOAD-BEARING (mutation proofs, each watched red then reverted):
 *   - add a file under src/hooks with setTimeout + clearTimeout + AbortController
 *     → rule 1 red;
 *   - add a fifth name to KNOWN_ENGINES → rule 2 red;
 *   - delete MentionInput's entry → rule 1 red; point an entry at a missing file
 *     → rule 3 red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/platform/input-assistance/services/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..', '..');

/** The UI layer — where keystroke state, and therefore an engine, lives. */
const SCAN_ROOTS = ['src/hooks', 'src/components', 'src/features', 'src/screens', 'app'];
/** The platform itself is the sanctioned engine. */
const PLATFORM = `src${sep}platform${sep}input-assistance${sep}`;

/**
 * The four engines the census named (G6/G16/G359). CLOSED and SHRINK-ONLY:
 * when one is migrated onto `useInputAssistance`, delete its entry.
 */
const CENSUS_NAMED_ENGINES: ReadonlySet<string> = new Set([
  'src/hooks/useGooglePlacesAutocomplete.ts',
  'src/hooks/usePlaceSearch.ts',
  'src/components/MentionInput.tsx',
  'src/hooks/useSearchSuggestions.ts',
]);

const KNOWN_ENGINES: Readonly<Record<string, string>> = {
  'src/hooks/useGooglePlacesAutocomplete.ts':
    'Google Places autocomplete via the backend proxy; consumed by GlobalPlacePicker beside the platform. Unmigrated (G6).',
  'src/hooks/usePlaceSearch.ts':
    '/api/places/search typeahead; consumed by GlobalPlacePicker beside the platform. Unmigrated (G6).',
  'src/components/MentionInput.tsx':
    'Its own 200 ms @-mention/#-tag debounce and abort, mounted on six composers. Unmigrated (G6/G16).',
  'src/hooks/useSearchSuggestions.ts':
    'Legacy search typeahead, run only as the gated fallback (useGlobalSearchSuggestions legacyEnabled) — §38 degradation, still its own engine (G6).',
};

/** Files with the shape that are NOT keystroke engines, each with the reason. */
const NOT_ENGINES: Readonly<Record<string, string>> = {
  'src/components/selectors/GlobalPlacePicker.tsx':
    'HOSTS the platform (useInputAssistance) and the two engines above; its own timer/abort is a 2.5 s timeout on the one-off reverse geocode for the "Near you" row, not a keystroke loop.',
  'src/hooks/useMapEntities.ts':
    'Debounces MAP VIEWPORT changes (pan/zoom) and aborts the stale region fetch; it is driven by the camera, not by typed text.',
};

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
}

function hasEngineShape(src: string): boolean {
  return /\bsetTimeout\s*\(/.test(src) && /\bclearTimeout\s*\(/.test(src) && /\bAbortController\b/.test(src);
}

function engineShapedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(APP_ROOT, root), files);
  return files
    .map((f) => relative(APP_ROOT, f))
    .filter((rel) => !rel.startsWith(PLATFORM))
    .filter((rel) => hasEngineShape(readFileSync(join(APP_ROOT, rel), 'utf8')))
    .map((rel) => rel.split(sep).join('/'))
    .sort();
}

test('G359 rule 1: every engine-shaped file outside the platform is classified, with a reason', () => {
  const unclassified = engineShapedFiles().filter((f) => !(f in KNOWN_ENGINES) && !(f in NOT_ENGINES));
  assert.deepEqual(
    unclassified,
    [],
    'a NEW independent typeahead engine (debounce + clearTimeout + AbortController) outside ' +
      'src/platform/input-assistance. Build it on useInputAssistance instead, or — if it is not ' +
      'driven by typed text — add it to NOT_ENGINES with the reason.',
  );
});

test('G359 rule 2: the known-engine list is CLOSED to the four the census named', () => {
  for (const f of Object.keys(KNOWN_ENGINES)) {
    assert.ok(CENSUS_NAMED_ENGINES.has(f), `${f} is not one of the four pre-existing engines; a fifth cannot be exempted`);
  }
  assert.ok(Object.keys(KNOWN_ENGINES).length <= 4);
  for (const reason of [...Object.values(KNOWN_ENGINES), ...Object.values(NOT_ENGINES)]) {
    assert.ok(reason.trim().length >= 40, 'every classification states its reason');
  }
});

test('G359 rule 3: no stale entry — each classified file exists and still has the shape', () => {
  for (const f of [...Object.keys(KNOWN_ENGINES), ...Object.keys(NOT_ENGINES)]) {
    const abs = join(APP_ROOT, f);
    assert.ok(existsSync(abs), `${f} is classified but does not exist — delete its entry`);
    assert.ok(
      hasEngineShape(readFileSync(abs, 'utf8')),
      `${f} no longer has an engine's shape — if it was migrated, delete its entry (the list only shrinks)`,
    );
  }
});

test('G359 rule 4: the scan sees every engine still listed (it is not vacuous)', () => {
  const seen = new Set(engineShapedFiles());
  for (const f of Object.keys(KNOWN_ENGINES)) assert.ok(seen.has(f), `the detector no longer sees ${f}`);
});
