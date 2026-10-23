/**
 * useVisualGeneration — the generated-header poll is bounded.
 *
 * A job that stays `generating` (or a poll that keeps failing) used to be polled every 2.5 s for as long as the picker
 * stayed open, errors included (2026-10-22 refresh-loop hunt). Now: at most POLL_MAX_ATTEMPTS polls per job (≤ 3 min)
 * and a stop after POLL_MAX_CONSECUTIVE_FAILURES failures in a row, with a message instead of a silent spinner.
 */
import React from 'react';
import { Text } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { useVisualGeneration, POLL_MAX_ATTEMPTS, POLL_MAX_CONSECUTIVE_FAILURES } from '../useVisualGeneration.ts';

// NOTE: intentionally exhaustive — the hook reads one flag.
jest.mock('../../context/FeatureFlagsContext.tsx', () => ({ useFeatureFlags: () => ({ isEnabled: () => true, loading: false }) }));
// NOTE: intentionally exhaustive — token minting is not under test.
jest.mock('../../services/apiToken.ts', () => ({ freshToken: jest.fn(async () => 'tok') }));

const GENERATING = { id: 'vis-1', status: 'generating', purpose: 'hero', source_image_url: null, hero_path: null, style: 'portava_editorial' };
let pollMode: 'generating' | 'failing' = 'generating';
const fetchMock = jest.fn(async (url: string) => {
  if (url.includes('/api/visuals/entity/')) return { ok: true, status: 200, json: async () => ({ visuals: [GENERATING] }) };
  if (pollMode === 'failing') return { ok: false, status: 503, json: async () => ({ error: 'degraded_unavailable' }) };
  return { ok: true, status: 200, json: async () => ({ visual: GENERATING }) };
});
const polls = () => fetchMock.mock.calls.filter(([u]) => /\/api\/visuals\/vis-1$/.test(String(u))).length;

let errorSeen: string | null = null;
function Harness() {
  const g = useVisualGeneration('event' as never, 'ev-1', 'hero' as never);
  errorSeen = g.error;
  return <Text>{g.status}</Text>;
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockClear();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  errorSeen = null;
});
afterEach(() => { jest.useRealTimers(); });

async function tick(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 2500) {
    await act(async () => { jest.advanceTimersByTime(2500); });
    await act(async () => {});
  }
}

it('a job that never finishes is polled at most POLL_MAX_ATTEMPTS times, then says so', async () => {
  pollMode = 'generating';
  await render(<Harness />);
  await act(async () => {});
  await tick(2500 * (POLL_MAX_ATTEMPTS + 40));
  expect(polls()).toBe(POLL_MAX_ATTEMPTS);
  expect(errorSeen).toMatch(/taking longer than expected/);
});

it('a poll that keeps failing stops after POLL_MAX_CONSECUTIVE_FAILURES', async () => {
  pollMode = 'failing';
  await render(<Harness />);
  await act(async () => {});
  await tick(2500 * 40);
  expect(polls()).toBe(POLL_MAX_CONSECUTIVE_FAILURES);
  expect(errorSeen).toMatch(/taking longer than expected/);
});
