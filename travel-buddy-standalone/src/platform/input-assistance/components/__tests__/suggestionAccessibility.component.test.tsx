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
 * EXTENDED (census G326, G327, G328) with three more §46 dimensions:
 *
 *   §46 "VoiceOver/TalkBack focus management on mobile" — the accessibility
 *        cursor was never moved anywhere. When the overlay closed it was left
 *        on a node that had unmounted. The tests below drive the REAL
 *        `SmartInput` and assert the restore happens on close, does NOT happen
 *        on open (stealing focus mid-keystroke would stop the user typing),
 *        and does NOT happen when the user left the field.
 *   §46 "dynamic type and large text support" — the overlay's height cap and
 *        the rows' line budget now read `PixelRatio.getFontScale()`. These
 *        tests set the scale and assert both change.
 *   §46 "no suggestion overlay trapped behind the software keyboard" — the
 *        component subscribes to the keyboard height. What is asserted here is
 *        the SUBSCRIPTION; the geometry it feeds is proven in
 *        `overlayFit.test.ts`, and NEITHER is a device result. Census G327 and
 *        G328 stay CANNOT-VERIFY, and
 *        `docs/architecture/input-assistance-a11y-device-protocol.md` carries
 *        the handset procedure that would settle them.
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
import { AccessibilityInfo, Keyboard, PixelRatio } from 'react-native';
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
// NOTE: partial mock over requireActual — only the BRIDGE call is replaced, so
// `shouldRestoreFieldFocus` (the decision these tests are really about) stays
// real and can still be wrong. The bridge call itself is proven unmocked in
// `a11yFocus.component.test.tsx`; under the jest renderer `findNodeHandle`
// returns undefined for every host node, so an unmocked call here could only
// ever assert "nothing happened".
jest.mock('../a11yFocus.ts', () => {
  const actual = jest.requireActual('../a11yFocus.ts');
  return { ...actual, moveAccessibilityFocusTo: jest.fn(() => true) };
});

import { EntitySuggestionRow } from '../EntitySuggestionRow.tsx';
import { moveAccessibilityFocusTo } from '../a11yFocus.ts';
import { SmartInput, selectionAnnouncement } from '../SmartInput.tsx';
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
const mockMoveFocus = moveAccessibilityFocusTo as jest.MockedFunction<typeof moveAccessibilityFocusTo>;
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

// ── §46 VoiceOver/TalkBack focus management (census G326) ────────────────────
//
// The defect was not that focus was moved WRONG. It was that focus was never
// moved at all: `setAccessibilityFocus` appeared nowhere in the layer, so a
// screen-reader cursor that had walked into the suggestion list stayed on a
// node that unmounted underneath it.
//
// WHAT THESE PROVE: that the component asks for the cursor back, on the
// transitions where asking is right, and does not ask on the ones where asking
// would hurt. WHAT THEY DO NOT PROVE: that VoiceOver or TalkBack honoured the
// request on a handset. No test in this environment can; see the device
// protocol named in the file header.

describe('§46: focus management around the overlay', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockMoveFocus.mockClear();
    sharedSuggestionCache.clear();
    registerField(A11Y_FIELD, 'global_search', { debounceMs: 0 });
  });

  afterEach(() => {
    unregisterField(A11Y_FIELD);
  });

  async function openOverlay(suggestion: InputSuggestion) {
    mockRequest.mockResolvedValue({
      ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions: [suggestion],
    });
    const r = await render(
      <SmartInput fieldId={A11Y_FIELD} value="bang" onChangeText={() => {}} label="Search" testID="a11y-input" />,
    );
    fireEvent(r.getByTestId('a11y-input'), 'focus');
    await waitFor(() => expect(r.getByTestId(`ia-entity-row-${suggestion.id}`)).toBeTruthy());
    return r;
  }

  test('OPENING the overlay never steals the cursor out of the field', async () => {
    // A suggestion list opens on a keystroke. Moving the screen-reader cursor
    // into it would take the user out of the text field between characters —
    // the "accessible" build that cannot be typed in. This assertion is what
    // stops a later pass from closing G326 that way.
    await openOverlay(sug({ id: 'f0', label: 'Bangkok' }));
    expect(mockMoveFocus).not.toHaveBeenCalled();
  });

  test('CLOSING it after a selection pulls the cursor back to the input', async () => {
    // A CONTROLLED host, because an uncontrolled `value` is the one fixture in
    // which this cannot fail: the field text never changes, the hook re-serves
    // the same rows, and the overlay the assertion is about never closes.
    function Controlled() {
      const [v, setV] = React.useState('bang');
      return (
        <SmartInput fieldId={A11Y_FIELD} value={v} onChangeText={setV} label="Search" testID="a11y-input" />
      );
    }
    const chosen = sug({ id: 'f1', label: 'Bangkok', replacementText: 'Bangkok' });
    mockRequest.mockResolvedValueOnce({
      ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions: [chosen],
    });
    // Everything after the accept resolves to nothing, so the list goes away —
    // which is exactly the transition that used to orphan the cursor.
    mockRequest.mockResolvedValue({
      ok: true, requestId: 'req-test-2', policyVersion: 'input-2026-08', suggestions: [],
    });

    const r = await render(<Controlled />);
    fireEvent(r.getByTestId('a11y-input'), 'focus');
    await waitFor(() => expect(r.getByTestId('ia-entity-row-f1')).toBeTruthy());
    mockMoveFocus.mockClear();

    fireEvent.press(r.getByTestId('ia-entity-row-f1'));
    await waitFor(() => expect(r.queryByTestId('ia-entity-row-f1')).toBeNull());
    await waitFor(() => expect(mockMoveFocus).toHaveBeenCalled());

    // It is the INPUT that is asked for, not some other node.
    const target = mockMoveFocus.mock.calls[0]![0] as { props?: Record<string, unknown> } | null;
    expect(target).toBeTruthy();
    expect(target?.props?.accessibilityLabel).toBe('Search');
  });

  test('leaving the field does NOT drag the cursor back to it', async () => {
    // The overlay also closes on blur. Yanking the cursor back to an input the
    // user just left is the same defect pointing the other way.
    const r = await openOverlay(sug({ id: 'f2', label: 'Bangkok' }));
    mockMoveFocus.mockClear();
    fireEvent(r.getByTestId('a11y-input'), 'blur');
    await waitFor(() => expect(r.queryByTestId('ia-entity-row-f2')).toBeNull());
    expect(mockMoveFocus).not.toHaveBeenCalled();
  });
});

// ── §46 dynamic type (census G328 — the code-answerable half) ────────────────

describe('§46: the overlay and its rows read the OS text scale', () => {
  let scaleSpy: jest.SpyInstance;

  beforeEach(() => {
    mockRequest.mockReset();
    sharedSuggestionCache.clear();
    registerField(A11Y_FIELD, 'global_search', { debounceMs: 0 });
  });

  afterEach(() => {
    scaleSpy?.mockRestore();
    unregisterField(A11Y_FIELD);
  });

  test('a row wraps its label at large text instead of truncating the answer', async () => {
    scaleSpy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    const r = await render(
      <EntitySuggestionRow suggestion={sug({ label: 'Đà Nẵng', subtitle: 'Vietnam' })} onPress={() => {}} />,
    );
    // Was a hard `numberOfLines={1}`: at 2x the label became "Đà N…".
    expect(r.getByTestId('ia-row-title').props.numberOfLines).toBe(3);
    expect(r.getByTestId('ia-row-subtitle').props.numberOfLines).toBe(3);
  });

  test('at the default scale the row is unchanged — one line, as before', async () => {
    scaleSpy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
    const r = await render(
      <EntitySuggestionRow suggestion={sug({ label: 'Đà Nẵng', subtitle: 'Vietnam' })} onPress={() => {}} />,
    );
    expect(r.getByTestId('ia-row-title').props.numberOfLines).toBe(1);
  });

  test('the overlay cap grows with the scale, so the row COUNT survives it', async () => {
    scaleSpy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
    mockRequest.mockResolvedValue({
      ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [sug({ id: 'd1' })],
    });
    const r = await render(
      <SmartInput fieldId={A11Y_FIELD} value="bang" onChangeText={() => {}} label="Search" testID="a11y-input" />,
    );
    fireEvent(r.getByTestId('a11y-input'), 'focus');
    await waitFor(() => expect(r.getByTestId('ia-entity-row-d1')).toBeTruthy());

    const card = r.getByTestId('ia-suggestion-overlay');
    const style = Array.isArray(card.props.style) ? Object.assign({}, ...card.props.style.flat()) : card.props.style;
    // Was a literal 320 at every text scale.
    expect(style.maxHeight).toBe(640);
  });
});

// ── §46 keyboard awareness (census G327 — the wiring half only) ──────────────

describe('§46: the field subscribes to the software keyboard', () => {
  let addSpy: jest.SpyInstance;

  beforeEach(() => {
    mockRequest.mockReset();
    sharedSuggestionCache.clear();
    addSpy = jest.spyOn(Keyboard, 'addListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    unregisterField(A11Y_FIELD);
  });

  test('an assisted field listens for the keyboard height', async () => {
    // The overlay hangs BELOW the field, which is where the keyboard is. Until
    // this subscription existed the layer had no way to know the keyboard was
    // even up — census G327's "no `Keyboard` height listener".
    registerField(A11Y_FIELD, 'global_search', { debounceMs: 0 });
    mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] });
    await render(
      <SmartInput fieldId={A11Y_FIELD} value="" onChangeText={() => {}} label="Search" testID="a11y-input" />,
    );
    const events = addSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('keyboardDidShow');
    expect(events).toContain('keyboardDidHide');
  });

  test('a no_assistance field subscribes to nothing — it has no overlay to fit', async () => {
    registerField(A11Y_FIELD, 'global_search', { debounceMs: 0, mode: 'no_assistance' });
    mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] });
    await render(
      <SmartInput fieldId={A11Y_FIELD} value="" onChangeText={() => {}} label="Search" testID="a11y-input" />,
    );
    const events = addSpy.mock.calls.map((c) => c[0]);
    expect(events).not.toContain('keyboardDidShow');
  });
});
