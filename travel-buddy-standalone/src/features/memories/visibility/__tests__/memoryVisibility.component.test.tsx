/**
 * memoryVisibilityPolicy / MemoryVisibilityCard — the app's half of census-
 * highlights-memories H33 (§3 `memory_visibility_policies`, migration 3810;
 * server: GET/PUT /api/memories/:id/visibility-policy).
 *
 * Pins:
 *   - GET maps to four states, never a boolean: ok; unavailable (404
 *     feature_disabled — 3810 not applied); not_found; error (503, malformed,
 *     a network throw). An error is never read as "No limit";
 *   - PUT sends exactly { personVisibilityCeiling } and only a 200 that echoes
 *     the value is success;
 *   - the card renders NOTHING while the setting does not exist or the Memory is
 *     not the caller's; an error is shown as an error with a retry;
 *   - choosing a rung PUTs it and re-reads; a refused PUT is reported and the
 *     shown selection does not move.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../../services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

import { fetchVisibilityStatus, setPersonCeiling } from '../memoryVisibilityPolicy.ts';
import { MemoryVisibilityCard } from '../MemoryVisibilityCard.tsx';

const MID = '11111111-1111-4111-8111-111111111111';
const URL = `https://api.test/api/memories/${MID}/visibility-policy`;
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
type Reply = { status: number; body: unknown } | Error;
let replies: Reply[] = [];
function serve(...r: Reply[]) {
  replies = r;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as unknown as Response;
  }) as typeof fetch;
}
function statusBody(ceiling: string | null, over: Record<string, unknown> = {}) {
  return {
    memoryId: MID,
    audience: { visibility: 'public', allowedUserIds: [], hiddenUserIds: ['x', 'y'] },
    locationPrecision: { chosen: 'city', enforcement: 'on' },
    personVisibility: { ceiling, recognised: true, updatedAt: null, appliesTo: 'everyone except you and the person themself' },
    ...over,
  };
}
let alertSpy: jest.SpyInstance;
beforeEach(() => { calls = []; process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
afterEach(() => { globalThis.fetch = realFetch; alertSpy.mockRestore(); });

describe('fetchVisibilityStatus', () => {
  it('reads the owner status from GET, authenticated', async () => {
    serve({ status: 200, body: statusBody('ANONYMOUS_COUNT') });
    const r = await fetchVisibilityStatus(MID);
    expect(r).toEqual({ state: 'ok', status: {
      memoryId: MID, audience: { visibility: 'public', allowedCount: 0, hiddenCount: 2 },
      locationPrecision: { chosen: 'city', enforcement: 'on' }, personCeiling: 'ANONYMOUS_COUNT' } });
    expect(calls[0]!.url).toBe(URL);
    expect(calls[0]!.init?.method).toBe('GET');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('404 feature_disabled is "unavailable"; another 404 is "not_found"', async () => {
    serve({ status: 404, body: { error: 'feature_disabled', message: 'not yet' } });
    expect(await fetchVisibilityStatus(MID)).toEqual({ state: 'unavailable' });
    serve({ status: 404, body: { error: 'not_found', message: 'Memory not found' } });
    expect(await fetchVisibilityStatus(MID)).toEqual({ state: 'not_found' });
  });
  it('a 503, an unknown ceiling, a missing block and a network failure are errors, never "No limit"', async () => {
    serve({ status: 503, body: { error: 'degraded_unavailable', message: 'down' } });
    expect((await fetchVisibilityStatus(MID)).state).toBe('error');
    serve({ status: 200, body: statusBody('SECRET') });
    expect((await fetchVisibilityStatus(MID)).state).toBe('error');
    serve({ status: 200, body: statusBody(null, { locationPrecision: undefined }) });
    expect((await fetchVisibilityStatus(MID)).state).toBe('error');
    serve(new Error('offline'));
    expect(await fetchVisibilityStatus(MID)).toEqual({ state: 'error', message: 'offline' });
  });
});

describe('setPersonCeiling', () => {
  it('PUTs exactly { personVisibilityCeiling }, and only an echoing 200 is success', async () => {
    serve({ status: 200, body: { memoryId: MID, personVisibilityCeiling: 'HIDDEN' } });
    expect(await setPersonCeiling(MID, 'HIDDEN')).toEqual({ ok: true });
    expect(calls[0]!.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ personVisibilityCeiling: 'HIDDEN' });
    serve({ status: 200, body: { memoryId: MID, personVisibilityCeiling: null } });
    expect(await setPersonCeiling(MID, null)).toEqual({ ok: true });
    serve({ status: 200, body: { memoryId: MID, personVisibilityCeiling: 'NAMED' } });
    expect((await setPersonCeiling(MID, 'HIDDEN')).ok).toBe(false);
    serve({ status: 503, body: { message: 'That could not be saved.' } });
    expect(await setPersonCeiling(MID, 'HIDDEN')).toEqual({ ok: false, message: 'That could not be saved.' });
  });
});

describe('MemoryVisibilityCard', () => {
  it('renders nothing while the server has no such setting (3810 not applied)', async () => {
    serve({ status: 404, body: { error: 'feature_disabled' } });
    await render(<MemoryVisibilityCard memoryId={MID} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByTestId('memory-visibility-card')).toBeNull();
    expect(screen.queryByTestId('memory-visibility-error')).toBeNull();
  });
  it('renders nothing for a Memory that is not the caller\'s', async () => {
    serve({ status: 404, body: { error: 'not_found' } });
    await render(<MemoryVisibilityCard memoryId={MID} />);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByTestId('memory-visibility-card')).toBeNull();
  });
  it('shows an unreadable status as an error with a retry, not as "No limit"', async () => {
    serve({ status: 503, body: { message: 'down' } }, { status: 200, body: statusBody(null) });
    await render(<MemoryVisibilityCard memoryId={MID} />);
    expect(await screen.findByTestId('memory-visibility-error')).toBeTruthy();
    expect(screen.queryByTestId('memory-visibility-ceiling-NONE')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByTestId('memory-visibility-retry')); });
    expect(await screen.findByTestId('memory-visibility-card')).toBeTruthy();
  });
  it('shows the audience, the place rung and the current ceiling', async () => {
    serve({ status: 200, body: statusBody('CREW_ONLY', { locationPrecision: { chosen: 'city', enforcement: 'off' } }) });
    await render(<MemoryVisibilityCard memoryId={MID} />);
    expect((await screen.findByTestId('memory-visibility-audience')).props.children).toBe('Everyone (2 hidden from)');
    expect(screen.getByTestId('memory-visibility-precision').props.children).toBe('City (not applied yet: others see the place as recorded)');
    expect(screen.getByTestId('memory-visibility-ceiling-CREW_ONLY').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId('memory-visibility-ceiling-NONE').props.accessibilityState).toMatchObject({ selected: false });
  });
  it('choosing "Just a count" PUTs ANONYMOUS_COUNT and shows it once the server confirms', async () => {
    serve({ status: 200, body: statusBody(null) });
    await render(<MemoryVisibilityCard memoryId={MID} />);
    await screen.findByTestId('memory-visibility-card');
    serve({ status: 200, body: { memoryId: MID, personVisibilityCeiling: 'ANONYMOUS_COUNT' } }, { status: 200, body: statusBody('ANONYMOUS_COUNT') });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-visibility-ceiling-ANONYMOUS_COUNT')); });
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(JSON.parse(String(put.init?.body))).toEqual({ personVisibilityCeiling: 'ANONYMOUS_COUNT' });
    await waitFor(() => expect(screen.getByTestId('memory-visibility-ceiling-ANONYMOUS_COUNT').props.accessibilityState).toMatchObject({ selected: true }));
  });
  it('a refused change is reported, and the shown selection does not move', async () => {
    serve({ status: 200, body: statusBody('NAMED') });
    await render(<MemoryVisibilityCard memoryId={MID} />);
    await screen.findByTestId('memory-visibility-card');
    serve({ status: 503, body: { message: 'That could not be saved.' } });
    await act(async () => { fireEvent.press(screen.getByTestId('memory-visibility-ceiling-HIDDEN')); });
    expect(alertSpy).toHaveBeenCalledWith('Could not change who sees the people', 'That could not be saved.');
    expect(screen.getByTestId('memory-visibility-ceiling-NAMED').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId('memory-visibility-ceiling-HIDDEN').props.accessibilityState).toMatchObject({ selected: false });
  });
});
