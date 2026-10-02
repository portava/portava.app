/**
 * Guard — every gateway consumer on a personalization-enabled context must also
 * WRITE selection memory (§35, Phase 8).
 *
 * WHY
 * ---
 * `input_selection_history` has exactly one writer in the whole product: the
 * explicit `POST /input-assistance/select` call the SDK's
 * `recordSuggestionSelection` fires. The server reads that memory scoped per
 * (user, **context**) — `fetchSelectionMemory` filters `.eq('context', …)` —
 * so a selection recorded on `global_search` can never reach `trip_destination`.
 *
 * A measured re-audit found the consequence: `GlobalPlacePicker` (the canonical
 * geographic picker, wired to `trip_destination`) and the search SCREEN both
 * consumed the gateway and neither recorded anything. `SmartInput` — mounted on
 * the Wall header pill alone — was the only recorder in the app. Every §35
 * feature on every picker context (the learned "BKK"→Bangkok abbreviation
 * mapping, §14 zero-character recents, the §15 PriorSelection boost) was
 * therefore reading a table nothing could ever fill: a read with no writer.
 *
 * This guard makes that class visible instead of silent. It scans the real
 * source for gateway consumers OUTSIDE the SDK and requires each to reference a
 * recorder, unless it is on the exemption list below WITH a reason.
 *
 * LOAD-BEARING: delete the `recordSuggestionSelection(...)` call from
 * `GlobalPlacePicker.tsx`, or the `recordPick` wiring from
 * `useGlobalSearchSuggestions.ts`, and this test goes RED.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `dirname(fileURLToPath(import.meta.url))`, not `fileURLToPath(new URL('.', …))`.
// This workspace's tsconfig pulls in the DOM lib, so `new URL()` resolves to the
// DOM's URL while `fileURLToPath` accepts node:url's — two structurally different
// types with the same name, which fails as
// `Argument of type 'URL' is not assignable to parameter of type 'string | URL'`.
// Every other test file here passes the string form for exactly this reason.
// Resolves to the same APP_ROOT: join() normalises away the trailing separator.
const HERE = dirname(fileURLToPath(import.meta.url));
// …/src/platform/input-assistance/services/__tests__ → the standalone app root.
const APP_ROOT = join(HERE, '..', '..', '..', '..', '..');

/** Directories scanned for gateway consumers. */
const SCAN_ROOTS = ['src', 'app'];

/** The SDK itself — its internals are the machinery, not consumers of it. */
const SDK_PREFIX = join('src', 'platform', 'input-assistance');

/** Any of these means "this module records explicit selections". */
const RECORDER_TOKENS = [
  'recordSuggestionSelection',
  'recordExplicitSelection',
  'recordPick',
];

/**
 * Consumers that legitimately record nothing, each with the reason. A new entry
 * here is a deliberate, reviewed decision — not a silent omission.
 */
const EXEMPT: Record<string, string> = {
  // Creation contexts (hidden_gem_name / event_title / place_picker duplicates).
  // The rows are `disambiguation` hints inside a create flow; accepting one
  // routes to the EXISTING record rather than filling this field, and the
  // downstream picker records the canonical pick.
  [join('src', 'hooks', 'useCreationAssistance.ts')]:
    'creation duplicate/validation overlays propose, they do not accept a canonical entity into the field',
  // §22 AI writing: every row is `type:'ai_suggestion'`, which
  // selectBody.NON_SELECTION_TYPES refuses by design — an AI proposal is not a
  // canonical entity pick and must never enter selection memory.
  [join('src', 'hooks', 'useAiWritingAssist.ts')]:
    'ai_suggestion rows are non-recordable by construction (NON_SELECTION_TYPES)',
  // census-compass CG-01: the Compass screen reads the compass_prompt zero-state
  // (0 characters) for its starter chips. Every served starter is an
  // `ai_suggestion` row, refused by selectBody.NON_SELECTION_TYPES, and the
  // client policy for compass_prompt has allowPersonalization:false — there is
  // no selection memory for this context to write.
  [join('app', '(tabs)', 'ai.tsx')]:
    'compass_prompt starters are ai_suggestion rows (NON_SELECTION_TYPES) on a context with allowPersonalization:false',
};

// The exemption list above USED to carry `src/hooks/useTelegraphRecipients.ts`
// as a KNOWN REMAINING GAP: `telegraph_recipient` allows personalization, the
// picker consumed the gateway, and nothing recorded — so that context's
// selection memory could never be filled, and "recently selected USERS" (§35)
// had no writer anywhere in the product. It is wired now and the exemption is
// GONE rather than reworded, which is what makes the guard below load-bearing:
// remove the wiring and the generic scan above fails, not just the fence.
//
// The reason the exemption gave for deferring it — "boost-only benefit" — was
// also true when it was written and is not any more: the gateway's recipient
// branch is a full takeover that returned before the generic
// `applyPriorSelectionBoost`, so a recorded recipient pick fed NOTHING. It now
// applies the §15 boost inside that branch, over the eligibility-scoped list.

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

test('every gateway consumer outside the SDK records explicit selections (§35)', () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) files.push(...walk(join(APP_ROOT, root)));

  assert.ok(files.length > 50, `the scan must actually reach the source tree (found ${files.length} files)`);

  const consumers: string[] = [];
  for (const abs of files) {
    const rel = relative(APP_ROOT, abs);
    if (rel.startsWith(SDK_PREFIX + sep)) continue; // the SDK is the machinery
    const src = readFileSync(abs, 'utf8');
    if (!src.includes('useInputAssistance(')) continue;
    consumers.push(rel);
  }

  // If this ever hits zero the assertions below become vacuous — the wiring was
  // deleted or moved, which is itself the thing worth failing on.
  assert.ok(
    consumers.length >= 4,
    `expected the known gateway consumers to be found; got ${consumers.length}: ${consumers.join(', ')}`,
  );

  const missing: string[] = [];
  for (const rel of consumers) {
    if (rel in EXEMPT) continue;
    const src = readFileSync(join(APP_ROOT, rel), 'utf8');
    if (!RECORDER_TOKENS.some((tok) => src.includes(tok))) missing.push(rel);
  }

  assert.deepEqual(
    missing,
    [],
    'these surfaces read Input Intelligence personalization but never write it — ' +
      'add a recordSuggestionSelection/recordPick call on the accept handler, or an EXEMPT entry with the reason: ' +
      missing.join(', '),
  );
});

test('the two surfaces the audit found unwired are wired (regression fence)', () => {
  const picker = readFileSync(
    join(APP_ROOT, 'src', 'components', 'selectors', 'GlobalPlacePicker.tsx'),
    'utf8',
  );
  assert.ok(
    picker.includes('recordSuggestionSelection('),
    'GlobalPlacePicker must record the gateway suggestion the user accepted (trip_destination §35)',
  );

  const searchHook = readFileSync(
    join(APP_ROOT, 'src', 'hooks', 'useGlobalSearchSuggestions.ts'),
    'utf8',
  );
  assert.ok(
    searchHook.includes('recordSuggestionSelection('),
    'useGlobalSearchSuggestions must expose a recording path for an accepted row (global_search §35)',
  );

  const searchScreen = readFileSync(join(APP_ROOT, 'app', 'search.tsx'), 'utf8');
  assert.ok(
    searchScreen.includes('recordPick('),
    'the search screen must call recordPick on an explicit suggestion pick',
  );
});

test('the telegraph_recipient gap the exemption list used to carry is wired (§35 "users")', () => {
  // "Recently selected cities / places / users" — the USERS arm. The only
  // context in the registry whose entityTypes are ['user'] is
  // telegraph_recipient, so this hook and this screen are the whole of it.
  const hook = readFileSync(
    join(APP_ROOT, 'src', 'hooks', 'useTelegraphRecipients.ts'),
    'utf8',
  );
  assert.ok(
    hook.includes('recordSuggestionSelection('),
    'useTelegraphRecipients must expose a recording path for an accepted recipient (telegraph_recipient §35)',
  );

  const pickerScreen = readFileSync(join(APP_ROOT, 'app', 'telegraph', 'new.tsx'), 'utf8');
  assert.ok(
    pickerScreen.includes('recordPick('),
    'the new-Telegraph picker must call recordPick on the recipient the user chose',
  );

  // The exemption must be GONE, not reworded. A future pass that re-adds it
  // silently would put the users arm back to a read with no writer.
  assert.ok(
    !Object.keys(EXEMPT).some((k) => k.includes('useTelegraphRecipients')),
    'useTelegraphRecipients must not be on the exemption list — it records now',
  );
});
