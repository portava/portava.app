/**
 * §48 — a surface may declare what it can render/dispatch through SmartInput's
 * `capabilities` prop, and the declaration reaches the request (G134 review:
 * the Wall's steer bar takes no action rows).
 *
 * MUTATION LOG (applied, watched go red, reverted):
 *   - SmartInput.tsx: `capabilities: capabilities ?? SDK_CAPABILITIES` →
 *     `capabilities: SDK_CAPABILITIES` → test 1 red (the Wall's narrowing never
 *     leaves the device).
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts reaches the
// Supabase-backed token helper at load. `requestSuggestions` is its only export.
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
import { WALL_STEER_CAPABILITIES } from '../../contexts/clientCapabilities.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';
_seedPolicy(_SEED_CONTEXTS);

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.capabilities.wall';

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] });
  sharedSuggestionCache.clear();
  registerField(FIELD, 'global_search', { debounceMs: 0 });
});

afterEach(async () => {
  await cleanup();
  unregisterField(FIELD);
});

test('a surface that declares no action rows sends that declaration with every request', async () => {
  const r = await render(
    <SmartInput fieldId={FIELD} value="lantern" onChangeText={() => {}} capabilities={WALL_STEER_CAPABILITIES} testID="cap-input" />,
  );
  fireEvent(r.getByTestId('cap-input'), 'focus');
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  const body = mockRequest.mock.calls[0]![0] as { client?: { suggestionTypes?: string[] } };
  expect(body.client?.suggestionTypes).toBeDefined();
  expect(body.client?.suggestionTypes).not.toContain('action');
});

test('CONTROL: without a declaration the shared overlay\'s (which renders action rows) is sent', async () => {
  const r = await render(<SmartInput fieldId={FIELD} value="lanterns" onChangeText={() => {}} testID="cap-input" />);
  fireEvent(r.getByTestId('cap-input'), 'focus');
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  const body = mockRequest.mock.calls[0]![0] as { client?: { suggestionTypes?: string[] } };
  expect(body.client?.suggestionTypes).toContain('action');
});
