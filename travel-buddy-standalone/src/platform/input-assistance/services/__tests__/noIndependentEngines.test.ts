/**
 * Guard — no NEW independent typeahead engine outside the platform layer
 * (spec §2/§16/§58: "feature teams must not build independent autocomplete
 * engines"; census G6, G16, G359).
 *
 * WHY
 * ---
 * Census G359 grades the prohibition on one fact: "a prohibition with no
 * detector is a convention." The first version of this file (census §37) was a
 * detector with three holes, all found by the independent verifier: its
 * not-an-engine list had no ceiling (it could grow to swallow anything), it
 * scanned five directories rather than the client, and its shape REQUIRED an
 * `AbortController` — so `components/map/MapSearchSheet.tsx`, a 300 ms debounce
 * over a request with no abort, passed unseen. This version closes each one.
 *
 * THE SHAPE. A typeahead engine is a timer re-armed on every keystroke whose
 * callback issues the request (or carries the typed text to one). In one file:
 *   - a `clearTimeout(` — the re-arm that makes a timer a debounce;
 *   - a request somewhere in the file (`fetch(`, supabase, `.rpc(`, or a call
 *     named search…/fetch…/get…/load…/query…/lookup…/request…/run…/api…);
 *   - a `setTimeout(` whose callback names a request or a typed-text identifier.
 * No abort is required: cancelling the stale request is good practice, not
 * what makes a loop an engine.
 *
 * THE SCAN is the whole standalone client root — every `.ts/.tsx/.js/.jsx`
 * file — minus `node_modules`, dot-directories, tests (`__tests__`, `__mocks__`,
 * `e2e`, `*.test.*`, `*.spec.*`), local build output (`dist`, `web-build`,
 * `ios`, `android`), and the platform itself (`src/platform/input-assistance/`,
 * the sanctioned engine). Rule 5 proves the scan reaches every client directory.
 *
 * THE RULES (each a separate assertion, each able to fail):
 *   1. Every file with the shape is classified as a KNOWN ENGINE or NOT AN ENGINE.
 *   2. KNOWN ENGINES is the exact set measured at this commit and may only
 *      shrink: a fourteenth fails, even if it is added to the list.
 *   3. NOT ENGINES is the exact set measured at this commit and may only shrink,
 *      and its exemptions are PER CALLBACK, not per file: every engine-shaped
 *      timer in an exempted file must match one of that entry's patterns, so a
 *      real engine added to an exempted file is still caught.
 *   4. No stale entry: a classified file exists and still has the shape; every
 *      NOT-ENGINE pattern still matches a timer. Migrating an engine turns this
 *      red until its entry is deleted.
 *   5. The scan is not vacuous: it sees every listed engine and reaches every
 *      top-level client directory.
 *   6. No debounce helper or library: there is none today, and one would let an
 *      engine debounce without `clearTimeout` in its own file. Adding a
 *      `debounce` dependency, or calling `debounce(` / `useDebounce…(` outside
 *      the platform, fails until this detector is taught that shape.
 *
 * MEASURED AT THIS COMMIT: THIRTEEN engines, not the four the census named.
 * The four (`useGooglePlacesAutocomplete`, `usePlaceSearch`, `MentionInput`,
 * the gated `useSearchSuggestions`) carry an abort; the nine others do not,
 * which is why the abort-requiring shape never saw them. The truth is
 * "thirteen, ratcheted at thirteen" until they are migrated (G6/G16).
 *
 * WHAT IT DOES NOT CATCH, stated rather than implied: a request fired on every
 * keystroke with no timer at all; a debounce whose callback names neither a
 * request verb nor a typed-text identifier (e.g. `setTimeout(go, 300)` where
 * `go` lives in another file). It ratchets the shape every measured engine has.
 *
 * LOAD-BEARING (mutation proofs, each watched red then reverted):
 *   - plant src/utils/plantedEngine.ts — setTimeout + clearTimeout + fetch, no
 *     abort → rule 1 red;
 *   - add a fourteenth name to KNOWN_ENGINES → rule 2 red;
 *   - add an eleventh NOT_ENGINES entry → rule 3 red;
 *   - add a keystroke `searchUsers(query)` debounce to an exempted file → rule 3 red;
 *   - delete MapSearchSheet's entry → rule 1 red;
 *   - narrow the scan back to the old five roots → rule 5 red;
 *   - require AbortController again → rules 4/5 red (nine engines vanish);
 *   - call `debounce(` in app/discover.tsx → rule 6 red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/platform/input-assistance/services/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..', '..');

/** The platform itself is the sanctioned engine. */
const PLATFORM = 'src/platform/input-assistance/';
/** Not client source: dependencies, tests, and local build output. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '__tests__', '__mocks__', 'e2e', 'dist', 'web-build', 'ios', 'android',
]);
/** Every top-level directory that holds client source today (rule 5). */
const CLIENT_DIRS = ['app', 'src', 'components', 'hooks', 'constants'];

/**
 * The engines measured at this commit. CLOSED and SHRINK-ONLY: when one is
 * migrated onto `useInputAssistance`, delete its entry and lower the ceiling.
 */
const ENGINE_CEILING = 13;
const KNOWN_ENGINES: Readonly<Record<string, string>> = {
  // The four the census named (they carry an abort).
  'src/hooks/useGooglePlacesAutocomplete.ts':
    'Google Places autocomplete via the backend proxy; consumed by GlobalPlacePicker beside the platform. Unmigrated (G6).',
  'src/hooks/usePlaceSearch.ts':
    '/api/places/search typeahead; consumed by GlobalPlacePicker beside the platform. Unmigrated (G6).',
  'src/components/MentionInput.tsx':
    'Its own 200 ms @-mention/#-tag debounce and abort, mounted on six composers. Unmigrated (G6/G16).',
  'src/hooks/useSearchSuggestions.ts':
    'Legacy search typeahead, run only as the gated fallback (useGlobalSearchSuggestions legacyEnabled) — §38 degradation, still its own engine (G6).',
  // The nine the abort-requiring shape could not see (none carries an abort).
  'src/components/map/MapSearchSheet.tsx':
    'Map search: a 300 ms per-keystroke debounce over requestMapSearchPage. The request is the platform transport, but the keystroke loop is the screen\'s own.',
  'src/components/DiscoveryShareSheet.tsx':
    'Share-to-traveller picker: a 350 ms debounce over searchUsers(text) on every keystroke.',
  'src/components/ShareSheet.tsx':
    'Share-to-traveller picker: a 350 ms debounce over searchUsers(text) on every keystroke.',
  'src/features/media/components/MediaActionPanels.tsx':
    'Tag-people picker: a 300 ms debounce over searchUsers(q) on every keystroke, sequence-guarded.',
  'app/events/create/index.tsx':
    'Event invite search: a 400 ms debounce over searchUsers(q) in handleInviteQueryChange, sequence-guarded.',
  'src/components/layover/LayoverModeSheet.tsx':
    'Airport picker: a 280 ms debounce over searchAirports(q) on every keystroke, ticket-guarded.',
  'src/features/telegraph/components/TelegraphSearchScreen.tsx':
    'Telegraph search-as-you-type: a 300 ms debounce over searchTelegraph via run(text, bucket).',
  'app/discover.tsx':
    'Traveller discovery search-as-you-type: a 300 ms debounce over searchUsers via runSearch(query).',
  'app/search.tsx':
    'Main search results-as-you-type: a 300 ms debounce over runSearch(query, tab). Its suggestions are the platform\'s; its live results loop is its own.',
};

/**
 * Files with the shape that are NOT keystroke engines. CLOSED and
 * SHRINK-ONLY, and PER CALLBACK: `timers` lists the only engine-shaped
 * `setTimeout` callbacks this file may contain, each by a token of its body.
 */
const NOT_ENGINE_CEILING = 10;
const NOT_ENGINES: Readonly<Record<string, { reason: string; timers: readonly RegExp[] }>> = {
  'app/(rent-a-buddy)/index.tsx': {
    reason: 'The city is set only by GlobalPlacePicker onSelect (a picked Place), never by keystrokes; the timers debounce the launch-status and top-buddies lookups for the picked city.',
    timers: [/getLaunchStatus\(city\.trim\(\)\)/, /loadTopBuddies\(city\)/],
  },
  'app/(tabs)/_layout.tsx': {
    reason: 'Warms the discovery counts cache 300 ms after landing on an adjacent tab; driven by the route and the active city, not typed text.',
    timers: [/getDiscoveryCategoryCountsBatch\(/],
  },
  'app/(tabs)/index.tsx': {
    reason: 'Debounces the city-picker selection (activeCity) before reading the buddy-availability count; no text field drives it.',
    timers: [/getLaunchStatus\(activeCity\)/],
  },
  'app/profile/verification.tsx': {
    reason: 'Polls verification status on POLL_INTERVAL_MS while the row is active; a status poll, not a keystroke loop.',
    timers: [/loadStatus\(true\)/],
  },
  'src/components/DiscoveryWall.tsx': {
    reason: 'Live open-now pill for a rendered place, keyed on the place props; the 600 ms delay skips cards flung past while scrolling.',
    timers: [/getPlaceLiveStatusCached\(name, anchor\)/],
  },
  'src/components/discovery/PlaceCard.tsx': {
    reason: 'Live open-now pill (600 ms viewport delay) and the deferred saved-count badge (800 ms) for a rendered card, keyed on the place id.',
    timers: [/getPlaceLiveStatusCached\(place\.name, anchor\)/, /getSavedListIds\(place\.id\)/],
  },
  'src/components/safeReturn/SafeReturnSetupSheet.tsx': {
    reason: 'After a slow session pre-check, lingers then opens the form fail-open and loads contacts once; a timeout, not a keystroke loop.',
    timers: [/runContactLoad\(/],
  },
  'src/context/CallContext.tsx': {
    reason: 'Ring timeout: ends an unanswered call after ringTimeoutMs; driven by call state, not typed text.',
    timers: [/apiEnd\(grant\.session\.id\)/],
  },
  'src/hooks/useFsqPhoto.ts': {
    reason: 'Deferred photo lookup for a rendered place card, keyed on its name and coordinates; not driven by typed text.',
    timers: [/lookupFsqPhoto\(/],
  },
  'src/hooks/useMapEntities.ts': {
    reason: 'Debounces MAP CAMERA settling (pan/zoom) before committing the quantized camera; driven by the camera, not by typed text.',
    timers: [/setSettledCamera\(q\)/],
  },
};

const REQUEST =
  /\bfetch\s*\(|\bsupabase\b|\.rpc\s*\(|\b(?:search|fetch|get|load|query|lookup|request|run|api)[A-Z]\w*\s*\(|\brun\s*\(/;
const TYPED = /\b(?:query|text|term|trimmed|q|keyword|searchText|input|debouncedQuery|value|prefix)\b/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(name)) out.push(full);
  }
}

/** The body of every `setTimeout(` call, bracket-matched. */
function timerBodies(src: string): string[] {
  const bodies: string[] = [];
  const re = /\bsetTimeout\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    bodies.push(src.slice(start, i - 1));
  }
  return bodies;
}

/** The engine-shaped timer callbacks in one file (empty when the file has no shape). */
function engineTimers(src: string): string[] {
  if (!/\bclearTimeout\s*\(/.test(src) || !REQUEST.test(src)) return [];
  return timerBodies(src).filter((body) => REQUEST.test(body) || TYPED.test(body));
}

function clientFiles(): string[] {
  const files: string[] = [];
  walk(APP_ROOT, files);
  return files
    .map((f) => relative(APP_ROOT, f).split(sep).join('/'))
    .filter((rel) => !rel.startsWith(PLATFORM))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(APP_ROOT, rel), 'utf8');
}

function engineShapedFiles(): string[] {
  return clientFiles().filter((rel) => engineTimers(read(rel)).length > 0);
}

test('G359 rule 1: every engine-shaped file outside the platform is classified, with a reason', () => {
  const unclassified = engineShapedFiles().filter((f) => !(f in KNOWN_ENGINES) && !(f in NOT_ENGINES));
  assert.deepEqual(
    unclassified,
    [],
    'a NEW independent typeahead engine (a keystroke debounce over a request) outside ' +
      'src/platform/input-assistance. Build it on useInputAssistance instead; NOT_ENGINES is closed.',
  );
});

test('G359 rule 2: the known-engine list is CLOSED at thirteen and may only shrink', () => {
  assert.ok(
    Object.keys(KNOWN_ENGINES).length <= ENGINE_CEILING,
    `${Object.keys(KNOWN_ENGINES).length} engines exempted; the ceiling is ${ENGINE_CEILING} and only falls`,
  );
  for (const reason of Object.values(KNOWN_ENGINES)) {
    assert.ok(reason.trim().length >= 40, 'every classification states its reason');
  }
});

test('G359 rule 3: NOT_ENGINES is CLOSED at ten, and each exemption covers only the timers it names', () => {
  assert.ok(
    Object.keys(NOT_ENGINES).length <= NOT_ENGINE_CEILING,
    `${Object.keys(NOT_ENGINES).length} files exempted as not-engines; the ceiling is ${NOT_ENGINE_CEILING} and only falls`,
  );
  for (const [file, { reason, timers }] of Object.entries(NOT_ENGINES)) {
    assert.ok(reason.trim().length >= 40, `${file}: every exemption states its reason`);
    assert.ok(!(file in KNOWN_ENGINES), `${file} cannot be both an engine and not one`);
    const unexplained = engineTimers(read(file)).filter((body) => !timers.some((p) => p.test(body)));
    assert.deepEqual(
      unexplained.map((b) => b.replace(/\s+/g, ' ').slice(0, 120)),
      [],
      `${file} is exempted for its named timers only; a new engine-shaped timer in it is not covered`,
    );
  }
});

test('G359 rule 4: no stale entry — each classified file exists, keeps the shape, and every pattern still matches', () => {
  for (const f of [...Object.keys(KNOWN_ENGINES), ...Object.keys(NOT_ENGINES)]) {
    assert.ok(existsSync(join(APP_ROOT, f)), `${f} is classified but does not exist — delete its entry`);
    assert.ok(
      engineTimers(read(f)).length > 0,
      `${f} no longer has an engine's shape — if it was migrated, delete its entry (the list only shrinks)`,
    );
  }
  for (const [file, { timers }] of Object.entries(NOT_ENGINES)) {
    const bodies = engineTimers(read(file));
    for (const p of timers) assert.ok(bodies.some((b) => p.test(b)), `${file}: pattern ${p} matches no timer — delete it`);
  }
});

test('G359 rule 5: the scan is not vacuous — it sees every listed engine and reaches every client directory', () => {
  const seen = new Set(engineShapedFiles());
  for (const f of Object.keys(KNOWN_ENGINES)) assert.ok(seen.has(f), `the detector no longer sees ${f}`);
  const scanned = clientFiles();
  for (const dir of CLIENT_DIRS) {
    assert.ok(scanned.some((f) => f.startsWith(`${dir}/`)), `the scan does not reach ${dir}/`);
  }
  assert.ok(scanned.some((f) => f.startsWith('src/services/')), 'the scan reaches src/services (the old scan skipped it)');
});

test('G359 rule 6: no debounce helper or library exists outside the platform (the shape would miss it)', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string> | undefined>;
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  assert.deepEqual(deps.filter((d) => /debounce|throttle|^lodash|^rxjs$/.test(d)), []);
  const helpers = clientFiles().filter((rel) => /\b(?:debounce\w*|useDebounce\w*)\s*\(/.test(read(rel)));
  assert.deepEqual(helpers, [], 'a debounce helper lets an engine debounce without clearTimeout; teach the detector that shape first');
});
