/**
 * census G260 — the CALL SITE: an unresolved row the person taps is bound to
 * the canonical entity they already accepted in this field, before the screen
 * or either selection memory sees it.
 *
 * `services/__tests__/entityResolution.test.ts` proves the rules. This proves
 * the REAL `SmartInput` applies them on an accept ("the logic is right and
 * nothing reaches it" is the failure mode a pure test cannot see).
 *
 * The tapped row has the exact shape of a shipped-dictionary row
 * (`localDictionary.ts#dictionaryRow`): `entityType`, `source: 'local'`, NO
 * `entityId`, no action. It is served through the mocked transport only to get
 * it onto the screen; what is under test is the accept.
 *
 * Harness fact (see inputTelemetryFunnel.component.test.tsx): React 19 + RNTL 14
 * return a null tree after the fourth mount in one file, so each test mounts
 * once.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - SmartInput.tsx: `const s = bindLocally(picked, policy);` → `const s =
 *     picked;` → test 1 goes red (the screen receives no entityId).
 *   - (verifier F1) entityResolution.ts: drop the `BINDABLE_TYPES` / entity-class
 *     guard → test 3 goes red (the served "Search …" completion reaches the
 *     screen as `open_entity city-bkk`, and no raw search is counted).
 */

import React, { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — the module reaches the Supabase-backed token
// helper (apiToken.ts) at load, which has no native module under jest, so
// requireActual cannot be spread. `requestSuggestions` is its complete surface.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — `recordSuggestionSelection` is this module's
// only export, and the module reaches Supabase through apiToken.ts at load.
jest.mock('../../services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { SmartInput } from '../SmartInput.tsx';
import { requestSuggestions } from '../../services/inputAssistance.ts';
import { recordSuggestionSelection } from '../../services/selectionRecorder.ts';
import { setTelemetrySink, resetTelemetrySink, type InputTelemetryEvent } from '../../services/inputTelemetry.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import {
  recordLocalSelection,
  clearLocalZeroState,
  type LocalZeroStatePolicy,
} from '../../services/localZeroState.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';
_seedPolicy(_SEED_CONTEXTS);

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const mockRecord = recordSuggestionSelection as jest.MockedFunction<typeof recordSuggestionSelection>;
const FIELD = 'test.localBinding.city';
// The seeded policy for city_picker is public + cacheable (`_PERMISSIVE_TEST_POLICY`).
const CITY: LocalZeroStatePolicy = { context: 'city_picker', privacyClass: 'public', maxSuggestions: 8 };

function canonical(label: string, id: string): InputSuggestion {
  return {
    id: `city_picker:cities:${id}`,
    type: 'entity',
    context: 'city_picker',
    label,
    replacementText: label,
    entityType: 'city',
    entityId: id,
    action: { type: 'open_entity', entityType: 'city', entityId: id },
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
}

const UNRESOLVED: InputSuggestion = {
  id: 'local:city_picker:city:Bangkok',
  type: 'entity',
  context: 'city_picker',
  label: 'Bangkok',
  replacementText: 'Bangkok',
  entityType: 'city',
  source: 'local',
  policyVersion: 'input-2026-08',
};

beforeEach(() => {
  mockRequest.mockReset();
  mockRecord.mockReset();
  mockRequest.mockResolvedValue({ ok: true, requestId: 'req-b', policyVersion: 'input-2026-08', suggestions: [UNRESOLVED] });
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  registerField(FIELD, 'city_picker', { debounceMs: 0 });
});

afterEach(async () => {
  await cleanup();
  unregisterField(FIELD);
  clearLocalZeroState();
});

function Host({ onSelect }: { onSelect: (s: InputSuggestion) => void }) {
  const [value, setValue] = useState('bang');
  return (
    <SmartInput
      fieldId={FIELD}
      value={value}
      onChangeText={setValue}
      onSelectSuggestion={(s) => { onSelect(s); }}
      label="City"
      testID="bind-input"
    />
  );
}

test('G260: tapping an unresolved name binds it to the ONE canonical city already accepted in this field', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  const onSelect = jest.fn();
  const r = await render(<Host onSelect={onSelect} />);
  fireEvent(r.getByTestId('bind-input'), 'focus');
  await waitFor(() => expect(r.getByTestId(`ia-entity-row-${UNRESOLVED.id}`)).toBeTruthy(), { timeout: 8000 });

  fireEvent.press(r.getByTestId(`ia-entity-row-${UNRESOLVED.id}`));

  expect(onSelect).toHaveBeenCalledTimes(1);
  const got = onSelect.mock.calls[0]![0] as InputSuggestion;
  expect(got.entityId).toBe('city-bkk');
  expect(got.action).toEqual({ type: 'open_entity', entityType: 'city', entityId: 'city-bkk' });
  expect(got.label).toBe('Bangkok');
  expect(got.source).toBe('local');
  // The server's selection memory gets the canonical identity too, not a string.
  expect(mockRecord).toHaveBeenCalledTimes(1);
  expect((mockRecord.mock.calls[0]![0] as InputSuggestion).entityId).toBe('city-bkk');
  // And the field shows the person's own spelling.
  await waitFor(() => expect(r.getByTestId('bind-input').props.value).toBe('Bangkok'));
});

test('G260: with TWO accepted cities of that name the tap stays unresolved — never an auto-pick (§19)', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  recordLocalSelection(CITY, { ...canonical('Bangkok', 'city-bkk-2'), id: 'city_picker:cities:city-bkk-2' });
  const onSelect = jest.fn();
  const r = await render(<Host onSelect={onSelect} />);
  fireEvent(r.getByTestId('bind-input'), 'focus');
  await waitFor(() => expect(r.getByTestId(`ia-entity-row-${UNRESOLVED.id}`)).toBeTruthy(), { timeout: 8000 });

  fireEvent.press(r.getByTestId(`ia-entity-row-${UNRESOLVED.id}`));

  expect(onSelect).toHaveBeenCalledTimes(1);
  const got = onSelect.mock.calls[0]![0] as InputSuggestion;
  expect(got.entityId).toBeUndefined();
  expect(got.action).toBeUndefined();
  expect((mockRecord.mock.calls[0]![0] as InputSuggestion).entityId).toBeUndefined();
});

test('G260 (verifier F1): a served "Search …" COMPLETION stays a raw search — never rebound to the accepted city', async () => {
  recordLocalSelection(CITY, canonical('Bangkok', 'city-bkk'));
  const COMPLETION: InputSuggestion = {
    id: 'city_picker:completion:bangkok',
    type: 'completion',
    context: 'city_picker',
    label: 'Search "Bangkok"',
    replacementText: 'Bangkok',
    action: { type: 'submit_search', query: 'Bangkok' },
    source: 'local',
    policyVersion: 'input-2026-08',
  };
  mockRequest.mockResolvedValue({ ok: true, requestId: 'req-c', policyVersion: 'input-2026-08', suggestions: [COMPLETION] });
  const events: InputTelemetryEvent[] = [];
  setTelemetrySink((e) => { events.push(e); });
  try {
    const onSelect = jest.fn();
    const r = await render(<Host onSelect={onSelect} />);
    fireEvent(r.getByTestId('bind-input'), 'focus');
    // A completion renders through EntitySuggestionRow (SuggestionList's default arm).
    await waitFor(() => expect(r.getByTestId(`ia-entity-row-${COMPLETION.id}`)).toBeTruthy(), { timeout: 8000 });
    fireEvent.press(r.getByTestId(`ia-entity-row-${COMPLETION.id}`));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const got = onSelect.mock.calls[0]![0] as InputSuggestion;
    expect(got.entityId).toBeUndefined();
    expect(got.action).toEqual({ type: 'submit_search', query: 'Bangkok' });
    expect((mockRecord.mock.calls[0]![0] as InputSuggestion).entityId).toBeUndefined();
    // The §44 raw-search counter still sees the tap.
    expect(events.filter((e) => e.name === 'raw_search_submitted')).toHaveLength(1);
  } finally {
    resetTelemetrySink();
  }
});
