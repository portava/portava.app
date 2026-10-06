/**
 * §57 "wrong-selection reversal rate" — the call site (census G368).
 *
 * The server can compute the rate (lib/inputAssistance/metrics.ts) only if the
 * client says when a resolution was TAKEN BACK. Until this event, nothing did:
 * `suggestion_selected` recorded that a row was taken and no event ever said it
 * was un-taken, so §57 refused the metric outright.
 *
 * WHAT IS DRIVEN. The REAL `SmartInput`, inside a parent that owns the value the
 * way every screen does (controlled `value` + `onChangeText`), so the "arrive at
 * the accepted text" step is a real re-render and not a test fiction.
 *
 * Harness fact (see inputTelemetryFunnel.component.test.tsx): React 19 + RNTL 14
 * return a null tree after the fourth mount in one file, so each test mounts
 * once and asserts the whole interaction.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - SmartInput.tsx: drop the `value === r.text` early return → test 1 goes red
 *     (the parent applying the accepted text is itself reported as a reversal).
 *   - SmartInput.tsx: do not clear `resolvedRef` after emitting → test 1 goes red
 *     (two reversals for one resolution).
 *   - SmartInput.tsx: set `resolvedRef` even when the caller handled insertion
 *     (`applied` false) → test 2 goes red.
 */

import React, { useState } from 'react';
import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react-native';

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
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import {
  setTelemetrySink,
  resetTelemetrySink,
  type InputTelemetryEvent,
} from '../../services/inputTelemetry.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';
_seedPolicy(_SEED_CONTEXTS);

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.reversal.search';

const PARIS: InputSuggestion = {
  id: 'paris',
  type: 'entity',
  context: 'global_search',
  label: 'Paris',
  entityType: 'city',
  entityId: 'c-paris',
  source: 'canonical',
  policyVersion: 'input-2026-08',
  replacementText: 'Paris',
};

let events: InputTelemetryEvent[] = [];
const named = (n: string) => events.filter((e) => e.name === n);

beforeEach(() => {
  events = [];
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ ok: true, requestId: 'req-sel', policyVersion: 'input-2026-08', suggestions: [PARIS] });
  sharedSuggestionCache.clear();
  registerField(FIELD, 'global_search', { debounceMs: 0 });
  setTelemetrySink((e) => { events.push(e); });
});

afterEach(async () => {
  await cleanup();
  resetTelemetrySink();
  unregisterField(FIELD);
});

/** A screen that owns its value, as every real caller does. */
function Host({ initial, handleSelf }: { initial: string; handleSelf?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <SmartInput
      fieldId={FIELD}
      value={value}
      onChangeText={setValue}
      onSelectSuggestion={handleSelf ? () => false : undefined}
      label="Search"
      testID="rev-input"
    />
  );
}

test('G368: arriving at the accepted text is not a reversal; leaving it is ONE, linked to the selecting serve', async () => {
  const r = await render(<Host initial="par" />);
  fireEvent(r.getByTestId('rev-input'), 'focus');
  await waitFor(() => expect(r.getByTestId('ia-entity-row-paris')).toBeTruthy(), { timeout: 8000 });

  fireEvent.press(r.getByTestId('ia-entity-row-paris'));
  // The parent applied "Paris" — the field ARRIVED at the accepted text.
  await waitFor(() => expect(r.getByTestId('rev-input').props.value).toBe('Paris'));
  expect(named('selection_reversed')).toHaveLength(0);

  // The user edits away from it: the resolution is taken back.
  await act(async () => {
    fireEvent.changeText(r.getByTestId('rev-input'), 'Parma');
  });
  await waitFor(() => expect(named('selection_reversed')).toHaveLength(1));
  const ev = named('selection_reversed')[0]!;
  expect(ev.props).toEqual({ suggestionType: 'entity', secondsSinceSelect: expect.any(Number) });
  // Linked to the serve that PRODUCED the selection (§44 linkage).
  expect(ev.requestId).toBe('req-sel');
  // No label, no entity, no text: the event must be safe on any field.
  expect(JSON.stringify(ev.props)).not.toMatch(/Paris|Parma|c-paris/);

  // Typing on is the same reversal, not a second one.
  await act(async () => {
    fireEvent.changeText(r.getByTestId('rev-input'), 'Parmaa');
  });
  expect(named('selection_reversed')).toHaveLength(1);
});

test('G368: a caller that handled insertion itself owns its value and is never reported', async () => {
  const r = await render(<Host initial="par" handleSelf />);
  fireEvent(r.getByTestId('rev-input'), 'focus');
  await waitFor(() => expect(r.getByTestId('ia-entity-row-paris')).toBeTruthy(), { timeout: 8000 });

  fireEvent.press(r.getByTestId('ia-entity-row-paris'));
  expect(named('suggestion_selected')).toHaveLength(1);
  await act(async () => {
    fireEvent.changeText(r.getByTestId('rev-input'), 'somewhere else');
  });
  expect(named('selection_reversed')).toHaveLength(0);
});
