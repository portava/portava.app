/**
 * §44 ACTION/RESULT LINKAGE — driving the REAL `SmartInput` (census G355).
 *
 * G355's own words: "`requestId` is generated per request and no event carries
 * it back, so an impression still cannot be joined to the selection that
 * followed it, and `action_completed` / `downstream_task_completed` still have
 * no callers." The id has ALWAYS travelled on the suggest response
 * (`SuggestResponse.requestId`); `useInputAssistance` threw it away. These
 * tests are the join, plus §57's two latencies (census G372).
 *
 * WHY THIS IS ITS OWN FILE AND NOT AN APPENDIX TO
 * `inputTelemetryFunnel.component.test.tsx`. It was written there first. Under
 * RNTL 14.0.1 in this harness the FIFTH `render` in a single file returns a
 * tree whose queries find nothing — every earlier mounting test passes and the
 * next one fails with "Unable to find an element with testID", in that file and
 * regardless of the order the tests are declared in. The same tests in their
 * own file pass. That is a harness limit, not a product fact, and it is
 * recorded here rather than worked around silently, because the failure looks
 * exactly like a broken component.
 *
 * Run: npx jest --testPathPattern='telemetryLinkage'
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

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

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.linkage.search';

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

let events: InputTelemetryEvent[] = [];
const names = () => events.map((e) => e.name);
const named = (n: string) => events.filter((e) => e.name === n);

beforeEach(() => {
  events = [];
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  registerField(FIELD, 'global_search', { debounceMs: 0 });
  setTelemetrySink((e) => { events.push(e); });
});

afterEach(async () => {
  await cleanup();
  resetTelemetrySink();
  unregisterField(FIELD);
});

test('§44: the impression and the selection that followed it name the SAME serve', async () => {
  mockRequest.mockResolvedValue({
    ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions: [sug({ label: 'Bangkok' })],
  });
  const r = await render(
    <SmartInput fieldId={FIELD} value="bang" onChangeText={() => {}} label="Search" testID="lnk-input" />,
  );
  fireEvent(r.getByTestId('lnk-input'), 'focus');
  await waitFor(() => expect(names()).toContain('suggestion_rendered'));

  const rendered = named('suggestion_rendered')[0];
  // MUTATION-PROOF: drop `requestId` from the hook's return, or from
  // SmartInput's telemetryField, and this goes red.
  expect(rendered.requestId).toBe('req-test');

  fireEvent.press(r.getByText('Bangkok'));
  await waitFor(() => expect(names()).toContain('suggestion_selected'));
  const selected = named('suggestion_selected')[0];
  expect(selected.requestId).toBe('req-test');
  // THE JOIN. This pair is what §57's "valid entity resolution rate" and
  // "wrong-selection reversal rate" both need and could never form: an
  // impression and the acceptance that answered it, naming one serve.
  expect(selected.requestId).toBe(rendered.requestId);
});

test('§44: an event emitted BEFORE any serve carries no requestId rather than a borrowed one', async () => {
  // `input_opened` fires on focus, before any response. Attributing it to a
  // serve that had not happened yet would be worse than null: it would make the
  // funnel's first step look like it belonged to a request it preceded, and
  // "time to valid selection" (G365) would measure a negative interval.
  mockRequest.mockResolvedValue({
    ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions: [],
  });
  const r = await render(
    <SmartInput fieldId={FIELD} value="" onChangeText={() => {}} label="Search" testID="lnk-input" />,
  );
  fireEvent(r.getByTestId('lnk-input'), 'focus');
  await waitFor(() => expect(names()).toContain('input_opened'));
  expect(named('input_opened')[0].requestId).toBeNull();
});

test('§57: the completion event carries BOTH latencies (census G372)', async () => {
  // `serverMs` is measured by the serve and carried on the envelope; `clientMs`
  // is the round trip this device saw. The difference between them is the
  // network, which is the part neither side can measure alone.
  mockRequest.mockResolvedValue({
    ok: true,
    requestId: 'req-test',
    policyVersion: 'input-2026-08',
    suggestions: [sug()],
    serverMs: 42,
  });
  const r = await render(
    <SmartInput fieldId={FIELD} value="bang" onChangeText={() => {}} label="Search" testID="lnk-input" />,
  );
  fireEvent(r.getByTestId('lnk-input'), 'focus');
  await waitFor(() => expect(names()).toContain('suggestion_request_completed'));
  const done = named('suggestion_request_completed')[0];
  expect(done.props?.serverMs).toBe(42);
  expect(typeof done.props?.clientMs).toBe('number');
  expect(done.requestId).toBe('req-test');
});

test('§57: the HOOK invents no serverMs when the result carries none', async () => {
  // SCOPE, stated because the first version of this test overclaimed. The fetch
  // client is a jest mock here, so this proves what the HOOK does with a result
  // that has no `serverMs` — it passes the absence through rather than
  // defaulting. Whether the ENVELOPE PARSE turns a missing field into 0 is a
  // different question, it lives in a pure module, and it is proven in
  // `services/__tests__/suggestResponse.test.ts`. Mutating the parse leaves
  // this file green; that is why the parse was extracted.
  mockRequest.mockResolvedValue({
    ok: true, requestId: 'req-old', policyVersion: 'input-2026-08', suggestions: [sug()],
  });
  const r = await render(
    <SmartInput fieldId={FIELD} value="bang" onChangeText={() => {}} label="Search" testID="lnk-input" />,
  );
  fireEvent(r.getByTestId('lnk-input'), 'focus');
  await waitFor(() => expect(names()).toContain('suggestion_request_completed'));
  expect(named('suggestion_request_completed')[0].props?.serverMs).toBeUndefined();
});
