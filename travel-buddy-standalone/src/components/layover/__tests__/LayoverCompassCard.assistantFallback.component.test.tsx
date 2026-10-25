/**
 * census-layover §83 (L100) — the flag-versus-app audit of 2026-10-23: with `layover_compass_assistant_enabled` ON in
 * production, POST /compass answers either with the model's admitted content (`assistant.status: "answered"`) or with the
 * certified answer on its own (`"fallback"`, and why). The app read neither, so a fallback looked like an assisted answer
 * and the owner's signed-in retest of L100 could not tell whether the model ran. The card now says so on a fallback.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { LayoverCompassCard } from '../LayoverCompassCard.tsx';

// NOTE: intentionally exhaustive — requireActual on lib/supabase.ts constructs a
// real Supabase client through SecureStoreAdapter, which needs native modules.
jest.mock('../../../lib/supabase.ts', () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken.ts imports lib/supabase.ts at module
// scope; a requireActual spread would defeat the mock above.
jest.mock('../../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'test-token'),
}));

const CERTIFICATION = {
  engineVersion: '2026.09.14-1',
  feasibilityVersion: '2026.09.14-1',
  inputHash: 'a1b2c3d4e5f60718',
  computedAt: '2026-09-14T09:00:00.000Z',
  verdict: 'yes',
  confidence: 'LOW',
  bufferPercentile: 'p90',
};

/** The real `CompassLayoverAnswer`, as the route spreads it under `ok: true`. */
function answerBody(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    answer: 'Be back at security by 18:40 and you have time for the night market.',
    safetyNote: null,
    hardReturnTime: '2026-09-14T10:40:00.000Z',
    bufferMinutes: 90,
    involvesLeaving: true,
    clarifyingQuestion: null,
    boundaryViolations: [],
    certification: CERTIFICATION,
    toolsConsulted: ['getReturnContract', 'simulatePlan'],
    ...over,
  };
}

function stubFetch(body: Record<string, unknown>) {
  const spy = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
  (global as { fetch: unknown }).fetch = spy;
  return spy;
}

afterEach(() => { jest.clearAllMocks(); });

async function ask() {
  await render(<LayoverCompassCard sessionId="sess-1" timezone="Asia/Taipei" />);
  fireEvent.press(screen.getByTestId('compass-toggle'));
  await waitFor(() => expect(screen.getByTestId('compass-input')).toBeTruthy());
  fireEvent.changeText(screen.getByTestId('compass-input'), 'Can I make it to the night market?');
  await waitFor(() =>
    expect((screen.getByTestId('compass-ask-btn').props as { accessibilityState?: { disabled?: boolean } })
      .accessibilityState?.disabled).toBe(false));
  // Pressed by its label rather than by `compass-ask-btn`: RNTL v14 does not
  // dispatch onto the Pressable's own host view here, and a press that silently
  // does nothing would make every assertion below vacuous.
  fireEvent.press(screen.getByText('Ask'));
  await waitFor(() => expect(screen.getByTestId('compass-answer')).toBeTruthy());
}

describe('L100 — a fallback answer says it is the certified answer on its own', () => {
  for (const [reason, words] of [['model_error', /could not be reached/], ['boundary_violation', /went beyond what your certified plan allows/], ['rate_limited', /busy right now/]] as const) {
    it(`fallback (${reason}): the reason is said, beside the certified answer`, async () => {
      stubFetch(answerBody({ assistant: { enabled: true, status: 'fallback', fallbackReason: reason, model: 'm' } }));
      await ask();
      const line = screen.getByTestId('compass-assistant-fallback');
      const text = String((line.props as { children: unknown }).children);
      expect(text).toMatch(words);
      expect(text).toMatch(/This is your certified answer on its own\./);
      expect(screen.getByText('Be back at security by 18:40 and you have time for the night market.')).toBeTruthy();
    });
  }
  it('an unknown reason is still a fallback, said generically', async () => {
    stubFetch(answerBody({ assistant: { enabled: true, status: 'fallback', fallbackReason: 'something_newer', model: 'm' } }));
    await ask();
    expect(String((screen.getByTestId('compass-assistant-fallback').props as { children: unknown }).children)).toBe('The assistant did not shape this answer. This is your certified answer on its own.');
  });
  for (const assistant of [{ enabled: true, status: 'answered', fallbackReason: null, model: 'm' }, { enabled: false, status: 'off', fallbackReason: null, model: null }, undefined]) {
    it(`no line when ${assistant ? assistant.status : 'the server does not send it'}`, async () => {
      const body = answerBody(assistant ? { assistant } : {});
      stubFetch(body);
      await ask();
      expect(screen.queryByTestId('compass-assistant-fallback')).toBeNull();
    });
  }
});
