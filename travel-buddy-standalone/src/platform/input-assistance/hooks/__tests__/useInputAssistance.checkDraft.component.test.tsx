/**
 * Census G149 — the creation pair (`checkDraft`) through the REAL hook, on a
 * PUBLIC creation field (`event_title`, cacheable), where a stale verdict could
 * otherwise be served from the shared cache.
 *
 *   1. the pair is sent with NO AI opt-in, and only the pair;
 *   2. changing the pair re-asks for the same text (the effect depends on it),
 *      and the answer for one pair is never served for another (cache key);
 *   3. returning to the first pair is served from the cache — the key is the pair;
 *   4. a field that passes no pair sends no draft (today's request, byte for byte).
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - `checkKey` left out of the cache key → 2 red (France is served Japan's answer).
 *   - `checkKey` left out of the effect deps → 2 red (no request for France).
 *   - `checkPair` not sent → 1 red.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper (apiToken.ts) at module load.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
  requestMapSearchPage: jest.fn(),
  SUGGEST_TIMEOUT_MS: 5000,
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, { event_title: { debounceMs: 0, privacyClass: 'public' } });

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.checkDraft.eventTitle';

function Probe({ pair }: { pair: { city?: string; country?: string } | null }) {
  const { suggestions } = useInputAssistance({ fieldId: FIELD, text: 'Night Market', checkDraft: pair });
  return <Text testID="labels">{suggestions.map((s) => s.label).join('|')}</Text>;
}

function verdictFor(country: string | undefined) {
  return [{
    id: `v-${country}`, type: 'correction', context: 'event_title', label: `verdict:${country ?? 'none'}`,
    confidence: 0.7, source: 'canonical', policyVersion: 'input-2026-08',
    action: { type: 'replace_text', text: 'x' },
  }];
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation((req: any) => Promise.resolve({
    ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: verdictFor(req.draft?.country) as any,
  }));
  sharedSuggestionCache.clear();
  registerField(FIELD, 'event_title', { debounceMs: 0 });
});

afterEach(() => unregisterField(FIELD));

describe('G149 — checkDraft through the real hook', () => {
  it('sends the pair with no AI opt-in, and only the pair', async () => {
    await render(<Probe pair={{ city: 'Paris', country: 'Japan' }} />);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    const req = mockRequest.mock.calls[0][0] as any;
    expect(req.draft).toEqual({ city: 'Paris', country: 'Japan' });
    expect(req.aiAssist).toBeUndefined();
    await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('verdict:Japan'));
  });

  it('a new pair re-asks for the same text, is never served the old pair’s answer, and the old pair is cached', async () => {
    const r = await render(<Probe pair={{ city: 'Paris', country: 'Japan' }} />);
    await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('verdict:Japan'));
    await r.rerender(<Probe pair={{ city: 'Paris', country: 'France' }} />);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
    expect((mockRequest.mock.calls[1][0] as any).draft).toEqual({ city: 'Paris', country: 'France' });
    await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('verdict:France'));
    // Back to the first pair: its own answer, from the cache, with no request.
    await r.rerender(<Probe pair={{ city: 'Paris', country: 'Japan' }} />);
    await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('verdict:Japan'));
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('a field that passes no pair sends no draft', async () => {
    await render(<Probe pair={null} />);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    expect((mockRequest.mock.calls[0][0] as any).draft).toBeUndefined();
  });
});
