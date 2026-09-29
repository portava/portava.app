/**
 * HM-F08 — the Create hub's Memory entry reaches a working create screen, and
 * a create lands on the Memory kernel route.
 *
 * WHAT WAS WRONG. The hub's Memory row pushed `/memory/edit` with no id. That
 * screen starts in `loading` and only leaves it once `getMemory(id)` settles,
 * and with no id it never asks — so the person saw a spinner forever. Nothing
 * in the client called `createMemory`, so `POST /api/memories` (the
 * CREATE_MEMORY command, routes/memories.ts) had no way in from the app.
 *
 * WHAT THIS SUITE PINS, end to end through the real service module (only
 * `fetch` is faked):
 *   - the route the hub pushes renders a create form, not a spinner;
 *   - Create sends ONE `POST /api/memories` carrying an Idempotency-Key, the
 *     title, the place and the chosen location precision, private by default;
 *   - each picked photo is uploaded and attached to the NEW Memory's id;
 *   - on success the app replaces the screen with `/memory/<new id>`;
 *   - a refused create is an error with Try again, never a navigation, and a
 *     retry of the same form reuses the same Idempotency-Key;
 *   - a photo that fails after the Memory exists is reported, and the person
 *     still lands on the Memory that was created (§19: a failed upload does not
 *     invalidate saved Memory facts);
 *   - `/memory/edit` without an id no longer spins: it sends the person to the
 *     create screen.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { CreateHubSheet } from '../../../src/components/create/CreateHubSheet.tsx';
import { _resetMemoryOperationIds } from '../../../src/services/memories.ts';

// NOTE: intentional stub — the screens under test use only `router`,
// `useLocalSearchParams` and `Redirect`; requireActual pulls expo-router's
// native navigation runtime, which is not available under Jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
  Redirect: ({ href }: { href: string }) => {
    (globalThis as any).__memoryCreateRedirects.push(href);
    return null;
  },
}));

// NOTE: intentional stub — only the insets hook is used; the real module needs
// native safe-area measurement.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../src/services/apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

// NOTE: intentional stub — the real hook opens the native image library. The
// stub returns two picked photos, as a person choosing two would.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({
    pickMedia: async () => [
      { uri: 'file:///one.jpg', mimeType: 'image/jpeg', type: 'image', width: 10, height: 10 },
      { uri: 'file:///two.jpg', mimeType: 'image/jpeg', type: 'image', width: 10, height: 10 },
    ],
  }),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location and
// other native modules that crash under jest. The stand-in selects Hoi An the
// way the real picker's onSelect does.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => {
  const R = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    GlobalPlacePicker: ({ visible, onSelect, onClose }: any) =>
      visible
        ? R.createElement(
            Pressable,
            {
              testID: 'mock-place-hoi-an',
              onPress: () => {
                onSelect({
                  id: 'place-hoi-an', displayName: 'Hoi An, Vietnam', name: 'Hoi An',
                  city: 'Hoi An', country: 'Vietnam', lat: 15.88, lng: 108.33, type: 'city',
                });
                onClose();
              },
            },
            R.createElement(Text, null, 'Hoi An'),
          )
        : null,
  };
});

const { router: mockRouter } = jest.requireMock('expo-router') as {
  router: { push: jest.Mock; replace: jest.Mock; back: jest.Mock };
};

const NEW_ID = '44444444-4444-4444-8444-444444444444';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** Fakes the network: the Memory route, the media upload, and item attach. */
function installFetch(opts: { createStatuses?: number[]; itemFailures?: number } = {}) {
  const calls: Call[] = [];
  const createStatuses = [...(opts.createStatuses ?? [201])];
  let itemFailures = opts.itemFailures ?? 0;
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    let body: any = init.body;
    try { body = typeof body === 'string' ? JSON.parse(body) : body; } catch { /* raw */ }
    calls.push({ url, method, headers: init.headers ?? {}, body });
    if (url.startsWith('file://')) {
      return { ok: true, status: 200, blob: async () => ({}), json: async () => ({}) };
    }
    if (url === 'https://api.test/api/media/upload') {
      return { ok: true, status: 200, json: async () => ({ url: `https://sb.test/storage/v1/object/public/post-media/u/${calls.length}.jpg` }) };
    }
    if (url === 'https://api.test/api/memories' && method === 'POST') {
      const status = createStatuses.length > 1 ? createStatuses.shift()! : createStatuses[0];
      if (status !== 201) {
        return { ok: false, status, json: async () => ({ error: 'degraded_unavailable', message: 'Memories are unavailable right now.' }) };
      }
      return {
        ok: true, status: 201,
        json: async () => ({ memory: { id: NEW_ID, ownerId: 'me', title: body?.title ?? null, visibility: body?.visibility, state: 'published', createdAt: '2026-09-29T00:00:00Z' } }),
      };
    }
    if (url === `https://api.test/api/memories/${NEW_ID}/items` && method === 'POST') {
      if (itemFailures > 0) {
        itemFailures -= 1;
        return { ok: false, status: 500, json: async () => ({ error: 'db_error', message: 'insert failed' }) };
      }
      return { ok: true, status: 201, json: async () => ({ item: { id: `item-${calls.length}`, mediaUrl: body?.mediaUrl, mediaType: 'image/jpeg', caption: null, position: body?.position ?? 0, createdAt: 'x' } }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  }) as unknown as typeof fetch;
  return calls;
}

/**
 * The route the hub's Memory row pushes, by pressing it. The sheet is mounted
 * ONCE per file (CreateHubSheet.routes.component.test.tsx found re-mounting it
 * across cases contaminates later renders), so the first case presses it and
 * the rest reuse what it pushed. Real timers: the hub defers its push by a
 * close-animation window, and a React commit scheduled while fake timers are
 * installed is lost when they are removed — every later render then froze.
 */
let hubRoute: string | null = null;
async function routeFromHub(): Promise<string> {
  if (hubRoute) return hubRoute;
  const onClose = jest.fn();
  const utils = await render(<CreateHubSheet visible onClose={onClose} />);
  await fireEvent.press(screen.getByLabelText('Memory'));
  expect(onClose).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledTimes(1), { timeout: 2000 });
  hubRoute = mockRouter.push.mock.calls[0][0] as string;
  await utils.unmount();
  return hubRoute;
}

/** The screen module expo-router would mount for a static `/memory/<name>`. */
function screenFor(route: string): React.ComponentType {
  const name = route.replace(/^\/memory\//, '');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(`../${name}.tsx`).default;
}

async function fillAndCreate() {
  await fireEvent.changeText(await screen.findByTestId('memory-create-title', {}, { timeout: 1500 }), 'Hoi An lanterns');
  await fireEvent.press(screen.getByTestId('memory-create-add-photos'));
  await screen.findByTestId('memory-create-photo-1');
  await fireEvent.press(screen.getByTestId('memory-create-location-row'));
  await fireEvent.press(screen.getByTestId('mock-place-hoi-an'));
  await fireEvent.press(await screen.findByTestId('memory-create-precision-city'));
  await fireEvent.press(screen.getByTestId('memory-create-submit'));
}

describe('HM-F08 — create a Memory from the Create hub', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
    (globalThis as any).__memoryCreateRedirects = [];
    _resetMemoryOperationIds();
    mockRouter.push.mockClear();
    mockRouter.replace.mockClear();
    mockRouter.back.mockClear();
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
    alertSpy.mockRestore();
  });

  it('the hub entry opens a create form, and Create lands one CREATE_MEMORY then opens the new Memory', async () => {
    const calls = installFetch();
    const Screen = screenFor(await routeFromHub());
    await render(<Screen />);
    await fillAndCreate();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/memory/${NEW_ID}`));

    const creates = calls.filter((c) => c.url === 'https://api.test/api/memories' && c.method === 'POST');
    expect(creates).toHaveLength(1);
    const key = creates[0].headers['Idempotency-Key'];
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
    expect(creates[0].body).toMatchObject({
      title: 'Hoi An lanterns',
      visibility: 'only_me',
      placeId: 'place-hoi-an',
      locationCity: 'Hoi An',
      locationCountry: 'Vietnam',
      locationPrecision: 'city',
      state: 'published',
    });

    const attaches = calls.filter((c) => c.url === `https://api.test/api/memories/${NEW_ID}/items`);
    expect(attaches.map((c) => c.body.position)).toEqual([0, 1]);
    expect(attaches.every((c) => typeof c.headers['Idempotency-Key'] === 'string')).toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a refused create is an error with Try again — no navigation — and the retry reuses the key', async () => {
    const calls = installFetch({ createStatuses: [503, 201] });
    const Screen = screenFor(await routeFromHub());
    await render(<Screen />);
    await fillAndCreate();

    expect(await screen.findByText(/unavailable right now/i)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.endsWith('/items'))).toBe(false);

    await fireEvent.press(screen.getByTestId('memory-create-submit'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/memory/${NEW_ID}`));
    const creates = calls.filter((c) => c.url === 'https://api.test/api/memories' && c.method === 'POST');
    expect(creates).toHaveLength(2);
    expect(creates[1].headers['Idempotency-Key']).toBe(creates[0].headers['Idempotency-Key']);
  });

  it('a photo that fails after the Memory exists is reported, and the new Memory still opens', async () => {
    installFetch({ itemFailures: 1 });
    const Screen = screenFor(await routeFromHub());
    await render(<Screen />);
    await fillAndCreate();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/memory/${NEW_ID}`));
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, body] = alertSpy.mock.calls[0];
    expect(title).toBe('Memory created');
    expect(body).toMatch(/1 of 2 photos/);
  });

  it('/memory/edit with no id sends the person to the create screen instead of spinning', async () => {
    installFetch();
    const Edit = require('../edit.tsx').default as React.ComponentType;
    const route = await routeFromHub();
    await render(<Edit />);
    expect((globalThis as any).__memoryCreateRedirects).toEqual([route]);
  });
});
