/**
 * §46 / §49 — KEYBOARD NAVIGATION, the second of §49's five accessibility
 * dimensions to be certified (census G351).
 *
 * G351 asks whether a test family exists that certifies
 * "keyboard / screen reader / focus / dynamic type / reduced motion".
 * `suggestionAccessibility.component.test.tsx` certifies the screen-reader
 * dimension. This file certifies the KEYBOARD one, which was implemented in
 * `SmartInput.handleKeyPress` (Arrow/Enter/Escape + the active-row highlight)
 * and had **no test of any kind** — a repo-wide search for `ArrowDown` across
 * the layer's test files returned nothing before this file.
 *
 * It does NOT move G351 to C. Three of the five dimensions — focus management,
 * dynamic type and reduced motion — remain uncertified, and two of those three
 * have no implementation to certify. The row stays `W`; this narrows it.
 *
 * WHY EACH ASSERTION CAN FAIL (mutation log — each applied, watched go red,
 * reverted, `cmp` byte-identical):
 *   - SmartInput: `(i + 1) % suggestions.length` → `i + 1`
 *       → "ArrowDown wraps at the end" goes red.
 *   - SmartInput: delete the `key === 'Enter'` branch
 *       → "Enter selects the active row" goes red.
 *   - SmartInput: delete the `key === 'Escape'` branch
 *       → "Escape closes the overlay without selecting" goes red.
 *   - SmartInput: pass `activeId={null}` to the overlay
 *       → "the active row is the one Enter takes" goes red.
 *   - SuggestionOverlay: delete `extraData={activeId}` from the FlatList
 *       → STAYS GREEN, and that is recorded rather than dropped. The inline
 *         `renderItem` changes identity every render and busts the cell memo by
 *         accident, so `extraData` is currently redundant. See the comment on
 *         that line for why it is kept anyway.
 *
 * TWO HARNESS FACTS, recorded because both produce confidently-wrong results:
 *   1. RNTL 14.0.1's `fireEvent(input, 'keyPress', …)` does NOT reach a
 *      TextInput's `onKeyPress` in this harness — neither spelling does, and
 *      the call SUCCEEDS silently, so every assertion below would have been
 *      asserting that nothing happened. The handler is therefore invoked as the
 *      component's own rendered prop (`input.props.onKeyPress`) inside `act`.
 *      That is the real handler off the real tree, not a re-implementation, but
 *      it does skip RNTL's event routing and is written down rather than
 *      papered over.
 *   2. The caret is hidden from assistive tech and RNTL's queries exclude
 *      accessibility-hidden elements by default, so every caret query passes
 *      `{ includeHiddenElements: true }` — including the negative one.
 *
 * Run: npx jest --testPathPattern='suggestionKeyboardNav'
 */
import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stubs — both modules import the Supabase-backed
// token helper at module load, which has no native module under jest. Each
// factory lists that module's complete export surface.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — `recordSuggestionSelection` is this module's
// only export and it reaches Supabase at load.
jest.mock('../../services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { SmartInput } from '../SmartInput.tsx';
import { requestSuggestions } from '../../services/inputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

// ── SEEDED 2026-09-21 (G340) ────────────────────────────────────────────────
// `useInputAssistance` derives its policy from the context descriptor, which
// since G340 comes from `GET /input-assistance/policies` rather than a local
// table. With nothing fetched every context resolves CONSERVATIVE — mode
// `no_assistance`, an unreachable `minChars` — so the hook correctly makes no
// request and renders no rows, and every assertion below about suggestions
// would be vacuous. Seeding states the premise these tests always relied on.
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';
_seedPolicy(_SEED_CONTEXTS);


const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.keyboardnav.search';

function sug(id: string, label: string): InputSuggestion {
  return {
    id,
    type: 'entity',
    context: 'global_search',
    label,
    entityType: 'city',
    entityId: `c_${id}`,
    replacementText: label,
    source: 'canonical',
    confidence: 0.9,
    action: { type: 'open_entity', entityType: 'city', entityId: `c_${id}` },
    policyVersion: 'input-2026-08',
  } as InputSuggestion;
}

const ROWS = [sug('k1', 'Bangkok'), sug('k2', 'Bangalore'), sug('k3', 'Banff')];

/** The caret marker only renders on the keyboard-ACTIVE row (see §46 suite). */
function activeLabels(r: ReturnType<typeof render> extends Promise<infer T> ? T : never) {
  return (r as any)
    .queryAllByTestId('ia-row-active-marker', { includeHiddenElements: true })
    .length;
}

describe('§46/§49: keyboard navigation over the suggestion list', () => {
  let picked: InputSuggestion[];

  beforeEach(() => {
    picked = [];
    mockRequest.mockReset();
    sharedSuggestionCache.clear();
    registerField(FIELD, 'global_search', { debounceMs: 0 });
    mockRequest.mockResolvedValue({
      ok: true,
      requestId: 'req-kbd',
      policyVersion: 'input-2026-08',
      suggestions: ROWS,
    } as any);
  });

  afterEach(() => {
    cleanup();
    unregisterField(FIELD);
  });

  async function mount() {
    const r = await render(
      <SmartInput
        fieldId={FIELD}
        value="ban"
        onChangeText={() => {}}
        onSelectSuggestion={(s) => {
          picked.push(s);
        }}
        label="Search"
        testID="kbd-input"
      />,
    );
    fireEvent(r.getByTestId('kbd-input'), 'focus');
    await waitFor(() => expect(r.getByTestId('ia-entity-row-k1')).toBeTruthy());
    return r;
  }

  async function press(r: any, key: string) {
    const handler = r.getByTestId('kbd-input').props.onKeyPress;
    await act(async () => {
      handler({ nativeEvent: { key } });
    });
  }

  test('nothing is active until a key is pressed, then ArrowDown walks the list', async () => {
    const r = await mount();
    expect(activeLabels(r as any)).toBe(0);
    await press(r, 'ArrowDown');
    expect(activeLabels(r as any)).toBe(1);
    expect(r.getByTestId('ia-entity-row-k1').props.accessibilityState.selected).toBe(true);
    await press(r, 'ArrowDown');
    expect(r.getByTestId('ia-entity-row-k2').props.accessibilityState.selected).toBe(true);
    expect(r.getByTestId('ia-entity-row-k1').props.accessibilityState.selected).toBe(false);
  });

  test('ArrowDown WRAPS at the end and ArrowUp wraps at the start', async () => {
    const r = await mount();
    await press(r, 'ArrowDown');
    await press(r, 'ArrowDown');
    await press(r, 'ArrowDown');
    expect(r.getByTestId('ia-entity-row-k3').props.accessibilityState.selected).toBe(true);
    await press(r, 'ArrowDown'); // wrap forward
    expect(r.getByTestId('ia-entity-row-k1').props.accessibilityState.selected).toBe(true);
    await press(r, 'ArrowUp'); // wrap backward
    expect(r.getByTestId('ia-entity-row-k3').props.accessibilityState.selected).toBe(true);
  });

  test('Enter selects the ACTIVE row — and selects NOTHING when none is active', async () => {
    const r = await mount();
    // No accidental commit: Enter before any Arrow key takes nothing.
    await press(r, 'Enter');
    expect(picked).toEqual([]);
    await press(r, 'ArrowDown');
    await press(r, 'ArrowDown');
    await press(r, 'Enter');
    expect(picked.map((s) => s.id)).toEqual(['k2']);
  });

  test('Escape closes the overlay and selects nothing', async () => {
    const r = await mount();
    await press(r, 'ArrowDown');
    await press(r, 'Escape');
    expect(picked).toEqual([]);
    await waitFor(() => expect(r.queryByTestId('ia-entity-row-k1')).toBeNull());
  });
});
