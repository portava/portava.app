/**
 * useInputAssistance — the serve's COVERAGE reaches the field, and an outage is
 * never cached. census-discovery §80 (DV-83, register D-W10-S1-2).
 *
 * Since §80 the gateway envelope says, in the Discovery refusal vocabulary, when
 * it could not read what it would have suggested from (`coverage: "nothing"`)
 * or read only part of it (`"partial"`). Before, a failed read and a query that
 * matched nothing were the same envelope. This hook is the one place every
 * field reads the envelope, so it is where the distinction must survive:
 *
 *   1. `refusal` is exposed exactly as the serve sent it, and is null when the
 *      serve read everything;
 *   2. a refused or partial serve is NOT written to the shared suggestion cache
 *      — the owner's "Do not cache rate limits or outages" — so the next
 *      keystroke to the same text asks again instead of replaying the outage;
 *   3. a complete serve IS cached, as before (the control).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper at module load. The hook reaches only
// `requestSuggestions`.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

_seedPolicy(_SEED_CONTEXTS, {
  global_search: {
    offlinePolicy: 'cached_local',
    entityTypes: ['city', 'place'],
    allowedSuggestionTypes: ['entity', 'recent', 'completion', 'action'],
    minChars: 2,
  },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.coverage.search';

const ROW: InputSuggestion = {
  id: 'global_search:places:p1', type: 'entity', context: 'global_search', label: 'Senso-ji',
  entityType: 'place', entityId: 'p1', source: 'canonical', policyVersion: 'input-2026-08',
};
const PARTIAL = { class: 'transient_db', code: 'suggest_sources_unreadable', route: 'POST /input-assistance/suggest', coverage: 'partial' as const, failedSources: ['circles'] };

function served(refusal?: typeof PARTIAL) {
  return { ok: true as const, requestId: 'r1', policyVersion: 'input-2026-08', suggestions: [ROW], ...(refusal ? { refusal } : {}) };
}

function Probe({ text }: { text: string }) {
  const { suggestions, refusal } = useInputAssistance({ fieldId: FIELD, text });
  return (
    <>
      <Text testID="labels">{suggestions.map((s) => s.label).join('|')}</Text>
      <Text testID="coverage">{refusal ? refusal.coverage : 'complete'}</Text>
    </>
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  registerField(FIELD, 'global_search', { debounceMs: 0 });
});
afterEach(() => unregisterField(FIELD));

test('§80: a partial serve is exposed as partial, and its rows are shown', async () => {
  mockRequest.mockResolvedValue(served(PARTIAL));
  await render(<Probe text="senso" />);
  await waitFor(() => expect(screen.getByTestId('coverage').props.children).toBe('partial'));
  expect(screen.getByTestId('labels').props.children).toBe('Senso-ji');
});

test('§80: a partial serve is NOT cached — the same text asks again', async () => {
  mockRequest.mockResolvedValue(served(PARTIAL));
  const view = await render(<Probe text="senso" />);
  await waitFor(() => expect(screen.getByTestId('coverage').props.children).toBe('partial'));
  await view.rerender(<Probe text="sensoj" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  await view.rerender(<Probe text="senso" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
});

test('a partial serve naming the zero-state place lanes (2026-10-10) is exposed and NOT cached — the kept copy is never replaced by it', async () => {
  const ZS = { ...PARTIAL, failedSources: ['nearby_places', 'recent_places'] };
  mockRequest.mockResolvedValue(served(ZS as typeof PARTIAL));
  const view = await render(<Probe text="senso" />);
  await waitFor(() => expect(screen.getByTestId('coverage').props.children).toBe('partial'));
  expect(sharedSuggestionCache.size).toBe(0);
  await view.rerender(<Probe text="sensoj" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  await view.rerender(<Probe text="senso" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
});

test('CONTROL: a complete serve reads "complete" and IS cached', async () => {
  mockRequest.mockResolvedValue(served());
  const view = await render(<Probe text="senso" />);
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Senso-ji'));
  expect(screen.getByTestId('coverage').props.children).toBe('complete');
  await view.rerender(<Probe text="sensoj" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
  await view.rerender(<Probe text="senso" />);
  await new Promise((r) => setTimeout(r, 100));
  expect(mockRequest).toHaveBeenCalledTimes(2);
});
