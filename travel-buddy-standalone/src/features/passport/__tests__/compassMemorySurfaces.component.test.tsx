/**
 * "Compass remembers" and "Recaps & On this day" (testing-mode WP-12, flows
 * COMP-F16 and COMP-F17) — the real screens over the real service, with only
 * `fetch` and the token helper stubbed.
 *
 * WHAT IS PINNED
 *   1. A failed request is an ERROR with Try again — never an empty surface.
 *   2. A group the server reports `unavailable` says "Couldn't load", and a
 *      group that answered with nothing says "Nothing here." — the two are
 *      never the same words.
 *   3. Forget and Correct send the server's own targeting (projection id for
 *      derived memory, subject for source content), change the list only after
 *      the server accepted, and alert on failure without touching the list.
 *   4. Recaps: `enabled: false` reads as "not turned on", an error as an error,
 *      unreadable sources are named, and a window chip asks for that window.
 *
 * Run: npx jest src/features/passport/__tests__/compassMemorySurfaces
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentional stub — expo-router's native navigation modules are not
// available in jest-expo; the screens use router.back/push and useFocusEffect.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useFocusEffect: (cb: () => unknown) => { require('react').useEffect(cb, []); },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../services/apiToken.ts', () => ({
  ...jest.requireActual('../../../services/apiToken.ts'),
  freshToken: jest.fn(async () => 'tok'),
}));

import { CompassRemembersScreen } from '../CompassRemembersScreen.tsx';
import { MemoryRecapsScreen } from '../MemoryRecapsScreen.tsx';

type Reply = { status: number; body: unknown } | 'network';
const realFetch = global.fetch;
let routes: Record<string, Reply[]>;
let calls: Array<{ url: string; method: string; body: unknown }>;

function reply(key: string, ...r: Reply[]) { routes[key] = r; }

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  routes = {};
  calls = [];
  global.fetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace('http://api.test', '');
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).filter((k) => u.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const queue = key ? routes[key]! : [];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) return new Response('{}', { status: 404 });
    if (next === 'network') throw new TypeError('Network request failed');
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(async () => {
  await act(async () => {});
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

const REMEMBERS = '/api/compass/me/passport/remembers';

function surface(over: Partial<Record<string, unknown>> = {}) {
  return {
    ownerId: 'me', visibility: 'owner_only',
    groups: [
      {
        group: 'derived_memory', label: 'What Portava figured out', description: 'Derived.', availability: 'ok',
        items: [{
          id: 'proj-1', group: 'derived_memory', label: 'Place you visited', title: 'Lisbon', isInferred: true,
          inferredNote: 'Inferred from your check-ins', visibility: 'private', subjectType: 'city', subjectId: 'Lisbon', memoryType: 'episodic',
          controls: { correct: { supported: true }, forget: { supported: true } },
        }],
      },
      {
        group: 'saved_content', label: 'Saved & created', description: 'Things you saved.', availability: 'ok',
        items: [{
          id: 'passport:postcard:pc1', group: 'saved_content', label: 'Postcard', title: 'Beach day', isInferred: false,
          visibility: 'private', subjectType: 'passport:postcard', subjectId: 'pc1', memoryType: null,
          controls: { correct: { supported: false, note: 'This is content you created; edit it where you made it.' }, forget: { supported: true } },
        }],
      },
      { group: 'availability', label: 'Availability', description: 'Your settings.', availability: 'ok', items: [] },
    ],
    notes: ['This view is private to you.'],
    unavailable: [],
    ...over,
  };
}

describe('CompassRemembersScreen', () => {
  it('a failed request is an error with Try again, never an empty list — and retry loads it', async () => {
    reply(REMEMBERS, 'network', { status: 200, body: surface() });
    await render(<CompassRemembersScreen />);
    await waitFor(() => expect(screen.getByTestId('remembers-error')).toBeTruthy());
    expect(screen.queryByText('Nothing here.')).toBeNull();
    await act(async () => { await fireEvent.press(screen.getByLabelText('Try again')); });
    await waitFor(() => expect(screen.getByText('Lisbon')).toBeTruthy());
  });

  it('an unavailable group says "Couldn\'t load", an empty one says "Nothing here." — never the same', async () => {
    const s = surface({ unavailable: ['derived_memory'] });
    (s.groups as any[])[0] = { ...(s.groups as any[])[0], availability: 'unavailable', items: [] };
    reply(REMEMBERS, { status: 200, body: s });
    await render(<CompassRemembersScreen />);
    await waitFor(() => expect(screen.getByTestId('remembers-unavailable-derived_memory')).toBeTruthy());
    expect(screen.getByTestId('remembers-partial')).toBeTruthy();
    expect(screen.getByText('Beach day')).toBeTruthy();
    expect(screen.getByText('Nothing here.')).toBeTruthy(); // availability: ok, no items
  });

  it('every group unavailable is an error state, not a page of empty sections', async () => {
    const s = surface();
    s.groups = (s.groups as any[]).map((g) => ({ ...g, availability: 'unavailable', items: [] }));
    reply(REMEMBERS, { status: 200, body: s });
    await render(<CompassRemembersScreen />);
    await waitFor(() => expect(screen.getByTestId('remembers-error')).toBeTruthy());
  });

  it('Forget on derived memory sends its projection id and removes it only after the server accepts', async () => {
    reply(REMEMBERS, { status: 200, body: surface() });
    reply(`${REMEMBERS}/forget`, { status: 201, body: { forgotten: true, message: 'Forgotten. This memory will no longer be shown.' } });
    (Alert.alert as jest.Mock).mockImplementation((_t, _m, buttons?: Array<{ style?: string; onPress?: () => void }>) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await render(<CompassRemembersScreen />);
    await waitFor(() => expect(screen.getByText('Lisbon')).toBeTruthy());
    await act(async () => { await fireEvent.press(screen.getByTestId('remembers-forget-proj-1')); });
    await waitFor(() => expect(screen.queryByText('Lisbon')).toBeNull());
    const post = calls.find((c) => c.url.endsWith('/forget'))!;
    expect(post.method).toBe('POST');
    expect(post.body).toEqual({ projectionId: 'proj-1' });
    expect(screen.getByText('Forgotten. This memory will no longer be shown.')).toBeTruthy();
  });

  it('a refused Forget alerts and leaves the item in place', async () => {
    reply(REMEMBERS, { status: 200, body: surface() });
    reply(`${REMEMBERS}/forget`, { status: 500, body: { error: 'db_error', message: 'Could not forget this item' } });
    const alerts: string[] = [];
    (Alert.alert as jest.Mock).mockImplementation((title: string, _m, buttons?: Array<{ style?: string; onPress?: () => void }>) => {
      alerts.push(title);
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await render(<CompassRemembersScreen />);
    await waitFor(() => expect(screen.getByText('Beach day')).toBeTruthy());
    await act(async () => { await fireEvent.press(screen.getByTestId('remembers-forget-passport:postcard:pc1')); });
    await waitFor(() => expect(alerts).toContain('Could not forget this'));
    expect(screen.getByText('Beach day')).toBeTruthy();
    const post = calls.find((c) => c.url.endsWith('/forget'))!;
    expect(post.body).toEqual({ subjectType: 'passport:postcard', subjectId: 'pc1' });
  });

  it('Correct records the corrected value and says what the server did', async () => {
    reply(REMEMBERS, { status: 200, body: surface() });
    reply(`${REMEMBERS}/correct`, { status: 201, body: { corrected: true, message: 'Recorded. The prior value will no longer be shown.' } });
    await render(<CompassRemembersScreen />);
    await waitFor(() => expect(screen.getByText('Lisbon')).toBeTruthy());
    // Source content offers no Correct; it says where to edit instead.
    expect(screen.queryByTestId('remembers-correct-passport:postcard:pc1')).toBeNull();
    await act(async () => { await fireEvent.press(screen.getByTestId('remembers-correct-proj-1')); });
    await act(async () => { await fireEvent.changeText(screen.getByTestId('remembers-correct-input'), 'Porto'); });
    await act(async () => { await fireEvent.press(screen.getByTestId('remembers-correct-save')); });
    await waitFor(() => expect(screen.getByText('Recorded. The prior value will no longer be shown.')).toBeTruthy());
    const post = calls.find((c) => c.url.endsWith('/correct'))!;
    expect(post.body).toEqual({ projectionId: 'proj-1', correctedValue: 'Porto' });
  });
});

describe('MemoryRecapsScreen', () => {
  const NOW = new Date(2026, 8, 29, 12);
  const recap = (over: Record<string, unknown> = {}) => ({
    enabled: true, window: { label: '2026' }, sections: [], notes: [], unavailable: [], ...over,
  });
  const otd = (over: Record<string, unknown> = {}) => ({ enabled: true, items: [], notes: [], unavailable: [], ...over });

  it('flag off reads as "not turned on", never as "no memories"', async () => {
    reply('/api/compass/me/on-this-day', { status: 200, body: otd({ enabled: false, notes: ['Personal Recaps and On This Day are not enabled yet.'] }) });
    reply('/api/compass/me/recaps', { status: 200, body: recap({ enabled: false, notes: ['Personal Recaps and On This Day are not enabled yet.'] }) });
    await render(<MemoryRecapsScreen now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('recap-disabled')).toBeTruthy());
    expect(screen.getByTestId('otd-disabled')).toBeTruthy();
    expect(screen.queryByTestId('recap-empty')).toBeNull();
    expect(screen.queryByTestId('otd-empty')).toBeNull();
  });

  it('a failed recap is an error with Try again; a partial On this day names what it could not read', async () => {
    reply('/api/compass/me/on-this-day', { status: 200, body: otd({ unavailable: ['saved_content'] }) });
    reply('/api/compass/me/recaps', { status: 500, body: { error: 'db_error', message: 'Could not build your recap' } });
    await render(<MemoryRecapsScreen now={NOW} />);
    await waitFor(() => expect(screen.getByTestId('recap-error')).toBeTruthy());
    expect(screen.getByTestId('otd-partial')).toBeTruthy();
    expect(screen.getByText(/Saved & created/)).toBeTruthy();
  });

  it('shows the recap sections, and a window chip asks the server for that window', async () => {
    reply('/api/compass/me/on-this-day', { status: 200, body: otd({ items: [{ id: 'pc1', label: 'Postcard', title: 'Beach day', occurredAt: '2025-09-29T12:00:00Z' }] }) });
    reply('/api/compass/me/recaps', { status: 200, body: recap({ sections: [{ group: 'saved_content', label: 'Places, postcards, stamps & trips', items: [{ id: 't1', label: 'Trip', title: 'Lisbon week' }] }] }) });
    await render(<MemoryRecapsScreen now={NOW} />);
    await waitFor(() => expect(screen.getByText('Lisbon week')).toBeTruthy());
    expect(screen.getByText('Beach day')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/compass/me/recaps?kind=year&year=2026')).toBe(true);
    await act(async () => { await fireEvent.press(screen.getByTestId('recap-window-last-year')); });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/compass/me/recaps?kind=year&year=2025')).toBe(true));
  });
});
