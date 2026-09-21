/**
 * The FIRST accessibility test in the input-assistance layer (spec §46).
 *
 * The census's §46 note was blunt about the gap: "No accessibility test exists
 * anywhere in the layer. All 24 test files under
 * platform/input-assistance/ __tests__ were listed; none references
 * accessibilityLabel, accessibilityRole or any a11y assertion." Two §46 bullets
 * were BUILT-BUT-WRONG underneath that silence, and this file is what keeps them
 * from regressing:
 *
 *   §46 "announce … and selection result" — `handleSelect` applied the text and
 *        closed the overlay without a word, so a screen-reader user heard the
 *        list vanish and nothing else.
 *   §46 "non-color-only state indicators" — the keyboard-active row differed
 *        from every other row by `backgroundColor` alone.
 *
 * TWO HARNESS FACTS THIS FILE DEPENDS ON, recorded because both produce
 * confidently-green-looking failures otherwise:
 *   1. RNTL 14.0.1's `render` is ASYNC (it awaits `act`), so it must be awaited
 *      before its queries exist. An un-awaited `render` yields a Promise whose
 *      `getByTestId` is `undefined`.
 *   2. The caret is hidden from assistive tech, and RNTL's queries EXCLUDE
 *      accessibility-hidden elements by default. Every caret query therefore
 *      passes `{ includeHiddenElements: true }` — including the negative one,
 *      because a default-options `queryByTestId` would return null for a caret
 *      that IS rendered, making "an inactive row carries no marker" an
 *      assertion that cannot fail.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
 *   - SmartInput.tsx: delete the `AccessibilityInfo.announceForAccessibility`
 *     call → both call-site assertions go red.
 *   - SmartInput.tsx: pass a literal `true` for `applied` → "a row that does not
 *     rewrite the field never claims it did" goes red.
 *   - EntitySuggestionRow.tsx: delete the activeSlot caret → "the active row
 *     carries a non-colour marker" goes red.
 *   - EntitySuggestionRow.tsx: render the caret unconditionally → "an inactive
 *     row carries no marker" goes red.
 */

import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stubs — both modules import the Supabase-backed
// token helper (apiToken.ts) at module load, which has no native module under
// jest. Each factory lists that module's complete export surface, so a new
// export is a deliberate contract change rather than silent drift.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — `recordSuggestionSelection` is this module's
// only export, and the module reaches Supabase through apiToken.ts at load.
jest.mock('../../services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { EntitySuggestionRow } from '../EntitySuggestionRow.tsx';
import { SmartInput, selectionAnnouncement } from '../SmartInput.tsx';
import { requestSuggestions } from '../../services/inputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const A11Y_FIELD = 'test.a11y.search';

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? 's1',
    type: over.type ?? 'entity',
    context: over.context ?? 'global_search',
    label: over.label ?? 'Bangkok',
    entityType: over.entityType ?? 'city',
    entityId: over.entityId ?? 'c1',
    source: over.source ?? 'canonical',
    policyVersion: 'input-2026-08',
    ...over,
  };
}

// ── §46 non-colour-only active state ─────────────────────────────────────────

test('§46: the keyboard-active row carries a NON-COLOUR marker', async () => {
  const r = await render(<EntitySuggestionRow suggestion={sug()} onPress={() => {}} active />);
  expect(r.getByTestId('ia-row-active-marker', { includeHiddenElements: true })).toBeTruthy();
});

test('§46: an inactive row carries no marker', async () => {
  const r = await render(<EntitySuggestionRow suggestion={sug()} onPress={() => {}} />);
  expect(r.queryByTestId('ia-row-active-marker', { includeHiddenElements: true })).toBeNull();
});

test('§46: strip every colour and the active row is STILL distinguishable', async () => {
  const active = await render(<EntitySuggestionRow suggestion={sug()} onPress={() => {}} active />);
  const markerWhenActive = active.queryByTestId('ia-row-active-marker', { includeHiddenElements: true });
  await active.unmount();

  const idle = await render(<EntitySuggestionRow suggestion={sug()} onPress={() => {}} />);
  const markerWhenIdle = idle.queryByTestId('ia-row-active-marker', { includeHiddenElements: true });

  // Presence/absence of a mark, not a hue difference: the whole point of the row.
  expect(Boolean(markerWhenActive)).toBe(true);
  expect(Boolean(markerWhenIdle)).toBe(false);
});

test('§46: the marker is hidden from assistive tech (accessibilityState already carries it)', async () => {
  const r = await render(<EntitySuggestionRow suggestion={sug()} onPress={() => {}} active />);
  const marker = r.getByTestId('ia-row-active-marker', { includeHiddenElements: true });
  expect(marker.props.accessibilityElementsHidden).toBe(true);
  expect(marker.props.importantForAccessibility).toBe('no');
});

test('§46: the row still announces itself and its selected state', async () => {
  const r = await render(
    <EntitySuggestionRow
      suggestion={sug({ subtitle: 'Thailand', verified: true })}
      onPress={() => {}}
      active
    />,
  );
  const row = r.getByTestId('ia-entity-row-s1');
  expect(row.props.accessibilityRole).toBe('button');
  expect(row.props.accessibilityLabel).toContain('Bangkok');
  expect(row.props.accessibilityLabel).toContain('Thailand');
  expect(row.props.accessibilityState).toMatchObject({ selected: true });
});

test('§46: pressing the row still selects it (the marker is not in the way)', async () => {
  const onPress = jest.fn();
  const r = await render(<EntitySuggestionRow suggestion={sug()} onPress={onPress} active />);
  fireEvent.press(r.getByTestId('ia-entity-row-s1'));
  expect(onPress).toHaveBeenCalledTimes(1);
});

// ── §46 the selection-result sentence ────────────────────────────────────────

test('§46: the announcement names the suggestion', () => {
  expect(selectionAnnouncement(sug({ label: 'Bangkok' }), false)).toBe('Bangkok selected.');
});

test('§46: a row that REWRITES the field says so; one that does not, does not', () => {
  // The distinction is the point: claiming "field updated" when the user's own
  // text is untouched is a false statement about their input.
  expect(selectionAnnouncement(sug({ label: 'Bangkok' }), true)).toBe(
    'Bangkok selected. Field updated.',
  );
  expect(selectionAnnouncement(sug({ label: 'Add to Trip', type: 'action' }), false)).toBe(
    'Add to Trip selected.',
  );
});

test('§46: an empty label never produces a headless sentence', () => {
  expect(selectionAnnouncement(sug({ label: '   ' }), false)).toBe('Suggestion selected.');
});

// ── §46 the CALL SITE, not just the sentence ─────────────────────────────────
//
// The three assertions above prove the sentence is right. On their own they
// would be worthless for this row: `selectionAnnouncement` could be perfect and
// never called, which is exactly the state §46 was BUILT-BUT-WRONG in. These
// drive the real SmartInput and assert the announcement actually leaves it.

describe('§46: selecting a suggestion through SmartInput announces the result', () => {
  let announce: jest.SpyInstance;

  beforeEach(() => {
    mockRequest.mockReset();
    sharedSuggestionCache.clear();
    registerField(A11Y_FIELD, 'global_search', { debounceMs: 0 });
    announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
    unregisterField(A11Y_FIELD);
  });

  async function renderWithSuggestion(suggestion: InputSuggestion) {
    mockRequest.mockResolvedValue({ ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions: [suggestion] });
    const r = await render(
      <SmartInput
        fieldId={A11Y_FIELD}
        value="bang"
        onChangeText={() => {}}
        label="Search"
        testID="a11y-input"
      />,
    );
    fireEvent(r.getByTestId('a11y-input'), 'focus');
    await waitFor(() => expect(r.getByTestId(`ia-entity-row-${suggestion.id}`)).toBeTruthy());
    return r;
  }

  test('a row that rewrites the field announces the selection AND the rewrite', async () => {
    const s = sug({ id: 'r1', label: 'Bangkok', replacementText: 'Bangkok' });
    const r = await renderWithSuggestion(s);

    fireEvent.press(r.getByTestId('ia-entity-row-r1'));
    expect(announce).toHaveBeenCalledWith('Bangkok selected. Field updated.');
  });

  test('a row that does NOT rewrite the field never claims it did', async () => {
    const s = sug({ id: 'r2', label: 'Bangkok', replacementText: undefined });
    const r = await renderWithSuggestion(s);

    fireEvent.press(r.getByTestId('ia-entity-row-r2'));
    expect(announce).toHaveBeenCalledWith('Bangkok selected.');
  });
});
