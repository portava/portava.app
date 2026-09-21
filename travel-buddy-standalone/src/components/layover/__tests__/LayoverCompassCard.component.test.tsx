/**
 * LayoverCompassCard — the §12 tools, made visible to the person the answer is
 * for.
 *
 * ── WHY A CLIENT TEST FOR A SERVER CHANGE ────────────────────────────────────
 * census L102–L113 were `W` for four passes on one sentence: the twelve
 * deterministic tools were declared and callable and were "not passed to the
 * model". They are now, on `POST /api/airport/sessions/:id/compass`. This file
 * is the other half of that claim — the one a server test cannot make: the
 * route's `toolsConsulted` reaches a mounted screen and is rendered, so a
 * traveller can see that the sentence they are reading rested on their own
 * certified return deadline rather than on a model's recollection.
 *
 * Nothing here mocks `services/layover`. The real service module runs; only
 * `fetch` and the two auth modules underneath it are replaced, so the URL and
 * the method are asserted against the real client code.
 *
 * ── MUTATION LOG ─────────────────────────────────────────────────────────────
 * Applied to the card, measured, reverted, `cmp`-verified.
 *
 *  1. `LayoverCompassCard` — drop the `compass-tools-consulted` line.  → 1 failed.
 *  2. `LayoverCompassCard.toolLabel` — return '' for an unmapped name. → 1 failed.
 *     An unmapped tool would vanish from the line, making "Checked: …" a
 *     half-truth about what the answer rested on.
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

describe('L102–L113 — the tools the server ran are shown to the traveller', () => {
  it('renders one line naming every tool the answer rested on', async () => {
    const spy = stubFetch(answerBody());
    await ask();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String((spy.mock.calls[0] as unknown[])[0])).toContain('/airport/sessions/sess-1/compass');

    const line = screen.getByTestId('compass-tools-consulted');
    const text = (line.props as { children: unknown[] }).children.flat().join('');
    expect(text).toContain('your return deadline');
    expect(text).toContain('your plan');
  });

  it('a tool name this build does not know is still named, not dropped', async () => {
    stubFetch(answerBody({ toolsConsulted: ['getReturnContract', 'somethingNewer'] }));
    await ask();
    const line = screen.getByTestId('compass-tools-consulted');
    const text = (line.props as { children: unknown[] }).children.flat().join('');
    expect(text).toContain('somethingNewer');
  });

  it('an answer with no tool calls renders no line at all', async () => {
    stubFetch(answerBody({ toolsConsulted: [] }));
    await ask();
    expect(screen.queryByTestId('compass-tools-consulted')).toBeNull();
  });

  it('a server that does not publish the member renders no line and does not crash', async () => {
    const body = answerBody();
    delete (body as Record<string, unknown>).toolsConsulted;
    stubFetch(body);
    await ask();
    expect(screen.queryByTestId('compass-tools-consulted')).toBeNull();
    expect(screen.getByTestId('compass-answer')).toBeTruthy();
  });
});
