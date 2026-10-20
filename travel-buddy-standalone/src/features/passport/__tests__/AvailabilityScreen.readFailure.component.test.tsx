import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import AvailabilityRoute from '../../../../app/passport/availability.tsx';
import { useAvailabilityEditor, type SaveResult } from '../useAvailabilityEditor.ts';
import { freshToken } from '../../../services/apiToken.ts';
import type { AvailabilityWindow } from '../../../services/availability.ts';
import { resetPassportTelemetrySink, setPassportTelemetrySink, type PassportTelemetryEvent } from '../passportTelemetry.ts';

jest.mock('../../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));
jest.mock('../../../services/apiToken.ts', () => ({
  ...jest.requireActual('../../../services/apiToken.ts'),
  freshToken: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

type Reply = Pick<Response, 'ok' | 'status' | 'json'>;
type Write = { method: string; url: string; body: Record<string, unknown> };

const originalFetch = global.fetch;
const originalApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const mockFetch = jest.fn();
const mockFreshToken = jest.mocked(freshToken);
const writes: Write[] = [];
const events: PassportTelemetryEvent[] = [];
let storedGrid: Record<string, string[]>;
let existingWindow: AvailabilityWindow | null;
let gridRead: () => Promise<Reply>;
let windowRead: () => Promise<Reply>;
let gridWrite: (() => Promise<Reply>) | null;
let windowsEnabled: boolean;

function reply(body: unknown, status = 200): Reply {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function gridReply(weeklyDays: Record<string, string[]> = storedGrid): Reply {
  return reply({ weeklyDays, openToMeet: false, strictMode: false, quickStatus: null });
}

function windowReply(): Reply {
  return reply({ windows: windowsEnabled && existingWindow ? [existingWindow] : [], enabled: windowsEnabled });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((fulfill, refuse) => { resolve = fulfill; reject = refuse; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  writes.length = 0;
  events.length = 0;
  setPassportTelemetrySink(event => events.push(event));
  windowsEnabled = true;
  storedGrid = { tue: ['evening'] };
  existingWindow = {
    id: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222',
    type: 'one_time', startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 3600000).toISOString(),
    tripId: null, openToPlans: true, intents: ['Food'], groupPreference: 'small_group', maxTravelMinutes: 20,
    visibility: 'private', source: 'explicit', socialAvailability: 'crew_only', expiresAt: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  gridRead = async () => gridReply();
  windowRead = async () => windowReply();
  gridWrite = null;
  mockFreshToken.mockReset().mockResolvedValue('synthetic-token');
  global.fetch = mockFetch as typeof fetch;
  mockFetch.mockReset().mockImplementation(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const url = new URL(input).pathname;
    if (method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      writes.push({ method, url, body });
      if (url === '/api/me/availability') {
        if (gridWrite) return gridWrite();
        storedGrid = body.weeklyDays as Record<string, string[]>;
        return gridReply();
      }
      if (url.startsWith('/api/me/availability-windows')) {
        return reply({ window: existingWindow, enabled: windowsEnabled });
      }
      throw new Error(`Unexpected synthetic write: ${method} ${url}`);
    }
    if (url === '/api/me/availability') return gridRead();
    if (url === '/api/me/availability-windows') return windowRead();
    throw new Error(`Unexpected synthetic read: ${url}`);
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalApiBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalApiBase;
  resetPassportTelemetrySink();
});

async function settledRoute() {
  await render(<AvailabilityRoute />);
  await waitFor(() => expect(screen.queryByText('Loading your availability…')).toBeNull());
}

function expectUnreadable() {
  expect(screen.getByText("Couldn't load your availability")).toBeTruthy();
  expect(screen.getByText('Tap to retry')).toBeTruthy();
  expect(screen.queryByLabelText('Set Availability')).toBeNull();
  expect(screen.queryByLabelText('Tue Evening')).toBeNull();
  expect(screen.queryByText(/Open to Plans windows are rolling out/)).toBeNull();
  expect(writes).toEqual([]);
  expect(events).toEqual([]);
}

describe('Passport Availability mounted required-read boundary', () => {
  it.each(['weekly', 'windows', 'both'] as const)('reports %s HTTP failure instead of an editable fabricated bundle', async source => {
    if (source !== 'windows') gridRead = async () => reply({ message: 'Synthetic weekly read failed' }, 503);
    if (source !== 'weekly') windowRead = async () => reply({ message: 'Synthetic window read failed' }, 503);
    await settledRoute();
    expectUnreadable();
  });

  it.each(['weekly', 'windows'] as const)('cannot overwrite unread %s state through the mounted Save action', async source => {
    if (source === 'weekly') gridRead = async () => reply({ message: 'Synthetic failure' }, 503);
    else windowRead = async () => reply({ message: 'Synthetic failure' }, 503);
    await settledRoute();
    const save = screen.queryByLabelText('Set Availability');
    if (save) await act(async () => { fireEvent.press(save); });
    expect(storedGrid).toEqual({ tue: ['evening'] });
    expect(writes).toEqual([]);
    expect(events).toEqual([]);
  });

  it.each(['weekly', 'windows'] as const)('settles a rejected %s fetch to unavailable', async source => {
    const rejected = async () => { throw new Error('Synthetic fetch rejection'); };
    if (source === 'weekly') gridRead = rejected;
    else windowRead = rejected;
    await settledRoute();
    expectUnreadable();
  });

  it.each(['weekly', 'windows'] as const)('settles a rejected %s JSON read to unavailable', async source => {
    const malformed = async () => ({ ...reply(null), json: async () => { throw new Error('Synthetic JSON rejection'); } });
    if (source === 'weekly') gridRead = malformed;
    else windowRead = malformed;
    await settledRoute();
    expectUnreadable();
  });

  it.each(['weekly', 'windows'] as const)('rejects a successful null %s response rather than assuming empty', async source => {
    if (source === 'weekly') gridRead = async () => reply(null);
    else windowRead = async () => reply(null);
    await settledRoute();
    expectUnreadable();
  });

  it.each([
    ['weekly', {}],
    ['weekly', { weeklyDays: null }],
    ['weekly', { weeklyDays: [] }],
    ['windows', { enabled: true }],
    ['windows', { windows: [] }],
    ['windows', { enabled: 'false', windows: [] }],
  ])('rejects an incomplete %s envelope: %j', async (source, body) => {
    if (source === 'weekly') gridRead = async () => reply(body);
    else windowRead = async () => reply(body);
    await settledRoute();
    expectUnreadable();
  });

  it('recovers only after explicit retry and keeps the saved grid and private window', async () => {
    gridRead = async () => reply({ message: 'Synthetic failure' }, 503);
    await settledRoute();
    expectUnreadable();
    const requestCount = mockFetch.mock.calls.length;
    gridRead = async () => gridReply();
    await act(async () => { await Promise.resolve(); });
    expect(mockFetch).toHaveBeenCalledTimes(requestCount);
    await act(async () => { fireEvent.press(screen.getByText('Tap to retry')); });
    await waitFor(() => expect(screen.getByLabelText('Tue Evening').props.accessibilityState.selected).toBe(true));
    expect(screen.getByTestId('availability-audience')).toHaveTextContent('Who sees it: Only you');
    expect(writes).toEqual([]);
    await act(async () => { fireEvent.press(screen.getByLabelText('Set Availability')); });
    expect(storedGrid).toEqual({ tue: ['evening'] });
    expect(writes.map(write => write.method)).toEqual(['PATCH', 'PATCH']);
    expect(writes[1].body.visibility).toBe('private');
    expect(writes[1].url).toBe(`/api/me/availability-windows/${existingWindow!.id}`);
    expect(events.filter(event => event.type === 'availability_set')).toHaveLength(1);
  });

  it('preserves the known feature-disabled weekly workflow without confusing it with unreadable', async () => {
    windowsEnabled = false;
    await settledRoute();
    expect(screen.getByLabelText('Tue Evening').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText(/Open to Plans windows are rolling out/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Set Availability')); });
    expect(storedGrid).toEqual({ tue: ['evening'] });
    expect(screen.getByText('Weekly availability saved. Open to Plans is rolling out soon.')).toBeTruthy();
  });

  it('keeps genuine known empty state editable and creates only after explicit Save', async () => {
    storedGrid = {};
    existingWindow = null;
    await settledRoute();
    expect(screen.getByLabelText('Tue Evening').props.accessibilityState.selected).toBe(false);
    expect(writes).toEqual([]);
    await act(async () => { fireEvent.press(screen.getByLabelText('Tue Evening')); });
    expect(writes).toEqual([]);
    await act(async () => { fireEvent.press(screen.getByLabelText('Set Availability')); });
    expect(writes[0].body).toEqual({ weeklyDays: { tue: ['evening'] } });
    expect(writes[1].method).toBe('POST');
    expect(writes[1].body.source).toBe('explicit');
  });
});

describe('Availability required DTO read shapes', () => {
  it.each([undefined, null, 'unrecognized', '', 7])('refuses the whole bundle for window source %j before any guessed create', async source => {
    windowRead = async () => reply({ enabled: true, windows: [{ ...existingWindow, source }] });
    await settledRoute();
    const save = screen.queryByLabelText('Set Availability');
    if (save) await act(async () => { fireEvent.press(save); });
    expect(writes).toEqual([]);
    expectUnreadable();
  });

  it.each([null, 7, [], false])('refuses a non-object window member %j', async window => {
    windowRead = async () => reply({ enabled: true, windows: [window] });
    await settledRoute();
    expectUnreadable();
  });

  it.each([null, 'evening', {}, 7, ['unknown'], ['evening', null], ['evening', 7]])('refuses malformed weekly blocks %j instead of granting a saveable generation', async blocks => {
    gridRead = async () => reply({ weeklyDays: { tue: blocks } });
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let outcome: SaveResult | undefined;
    await act(async () => { outcome = await result.current.save(); });
    expect(outcome?.ok).toBe(false);
    expect(result.current.error).toEqual(expect.any(String));
    expect(writes).toEqual([]);
  });

  it('refuses an unknown weekday key rather than forwarding an invalid weekly DTO', async () => {
    gridRead = async () => reply({ weeklyDays: { tue: ['evening'], tuesday: ['late'] } });
    await settledRoute();
    expectUnreadable();
  });

  it.each([true, false])('refuses a mixed valid/unknown-source window bundle with enabled=%s', async enabled => {
    windowRead = async () => reply({ enabled, windows: [existingWindow, { ...existingWindow, source: 'unknown' }] });
    await settledRoute();
    expectUnreadable();
  });

  describe.each(['weekly', 'windows'] as const)('%s read error message', source => {
    it.each(['', ' \t\n ', 0, false, {}, ['message']])('keeps unusable message %j unavailable with a real retry control', async message => {
      const failed = async () => reply({ message }, 503);
      if (source === 'weekly') gridRead = failed;
      else windowRead = failed;
      await settledRoute();
      expectUnreadable();
      expect(screen.getByText('Could not load your availability')).toBeTruthy();
    });
  });

  it('preserves a usable failed-read message', async () => {
    windowRead = async () => reply({ message: 'Synthetic window read unavailable' }, 503);
    await settledRoute();
    expectUnreadable();
    expect(screen.getByText('Synthetic window read unavailable')).toBeTruthy();
  });

  it('recovers malformed source only on explicit retry and patches the existing private window', async () => {
    windowRead = async () => reply({ enabled: true, windows: [{ ...existingWindow, source: null }] });
    await settledRoute();
    expectUnreadable();
    const requests = mockFetch.mock.calls.length;
    windowRead = async () => windowReply();
    await act(async () => { await Promise.resolve(); });
    expect(mockFetch).toHaveBeenCalledTimes(requests);
    await act(async () => { fireEvent.press(screen.getByText('Tap to retry')); });
    await waitFor(() => expect(screen.getByLabelText('Set Availability')).toBeTruthy());
    expect(writes).toEqual([]);
    await act(async () => { fireEvent.press(screen.getByLabelText('Set Availability')); });
    expect(writes.map(write => write.method)).toEqual(['PATCH', 'PATCH']);
    expect(writes[1].url).toBe(`/api/me/availability-windows/${existingWindow!.id}`);
    expect(writes[1].body.visibility).toBe('private');
    expect(writes[1].body.intents).toEqual(['Food']);
    expect(writes[1].body.openToPlans).toBe(true);
  });

  it('preserves all declared weekday/block values, empty arrays and duplicate blocks without normalization', async () => {
    storedGrid = { mon: ['morning', 'afternoon', 'evening', 'late', 'late'], tue: [], wed: ['morning'],
      thu: ['afternoon'], fri: ['evening'], sat: ['late'], sun: [] };
    const expected = structuredClone(storedGrid);
    await settledRoute();
    expect(screen.getByLabelText('Mon Morning').props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText('Tue Evening').props.accessibilityState.selected).toBe(false);
    expect(writes).toEqual([]);
    await act(async () => { fireEvent.press(screen.getByLabelText('Set Availability')); });
    expect(writes[0].body.weeklyDays).toEqual(expected);
  });

  it.each(['public', 'followers', 'following', 'crew', 'private'] as const)('preserves the declared %s audience and nullable explicit-window fields', async visibility => {
    existingWindow = { ...existingWindow!, visibility, tripId: null, groupPreference: null, maxTravelMinutes: null,
      socialAvailability: null, expiresAt: null, intents: [], openToPlans: false };
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.currentWindow).toEqual(existingWindow);
    expect(result.current.draft).toMatchObject({ visibility, groupPreference: null, maxTravelMinutes: null,
      socialAvailability: 'not_open', intents: [], openToPlans: false });
    expect(writes).toEqual([]);
    await act(async () => { await result.current.save(); });
    expect(writes.map(write => write.method)).toEqual(['PATCH', 'PATCH']);
    expect(writes[1].body).toMatchObject({ visibility, groupPreference: null, maxTravelMinutes: null });
  });

  it.each(['recurring', 'trip', 'one_time', 'derived'] as const)('does not narrow the existing %s window type', async type => {
    existingWindow = { ...existingWindow!, type };
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.currentWindow).toEqual(existingWindow);
    expect(writes).toEqual([]);
  });

  it('keeps plan-derived data a private prompt with no synthetic explicit current window or write', async () => {
    existingWindow = { ...existingWindow!, type: 'derived', source: 'plan_derived', visibility: 'private' };
    await settledRoute();
    expect(screen.getByText('Free tonight? Set it below to let people plan with you.')).toBeTruthy();
    expect(screen.getByText('Not set yet — press Set Availability.')).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it.each(['end', 'expiry', 'unparseable'] as const)('keeps the existing %s expiry behavior without treating a known source as malformed', async horizon => {
    const past = new Date(Date.now() - 60000).toISOString();
    existingWindow = { ...existingWindow!, ...(horizon === 'expiry' ? { expiresAt: past }
      : { endAt: horizon === 'end' ? past : 'unparseable-existing-time' }) };
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.currentWindow).toBeNull();
    expect(writes).toEqual([]);
  });

  it('keeps a pre-malformed-read Save refused after a later healthy recovery', async () => {
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const staleSave = result.current.save;
    windowRead = async () => reply({ enabled: true, windows: [{ ...existingWindow, source: null }] });
    await act(async () => { await result.current.reload(); });
    expect(result.current.error).not.toBeNull();
    let outcome: SaveResult | undefined;
    await act(async () => { outcome = await staleSave(); });
    expect(outcome?.ok).toBe(false);
    windowRead = async () => windowReply();
    await act(async () => { await result.current.reload(); });
    expect(result.current.error).toBeNull();
    await act(async () => { outcome = await staleSave(); });
    expect(outcome?.ok).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('Availability actual hook and transport lifecycle', () => {
  it('settles a thrown auth-helper read without leaving loading stuck or writing', async () => {
    mockFreshToken.mockRejectedValueOnce(new Error('Synthetic auth-helper rejection'));
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(writes).toEqual([]);
  });

  it('refuses a Save captured before the first bundle even after that bundle arrives', async () => {
    const pending = deferred<Reply>();
    gridRead = () => pending.promise;
    const { result } = await renderHook(() => useAvailabilityEditor());
    const staleSave = result.current.save;
    await act(async () => { pending.resolve(gridReply()); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let outcome: SaveResult | undefined;
    await act(async () => { outcome = await staleSave(); });
    expect(outcome?.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('refuses a captured Save during a pending reload, after read failure and after later recovery', async () => {
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const staleSave = result.current.save;
    const pending = deferred<Reply>();
    gridRead = () => pending.promise;
    let reload!: Promise<void>;
    await act(async () => { reload = result.current.reload(); });
    let outcome: SaveResult | undefined;
    let pendingSave!: Promise<SaveResult>;
    await act(async () => { pendingSave = staleSave(); });
    await act(async () => {
      pending.resolve(reply({ message: 'Synthetic failure' }, 503));
      await reload;
      outcome = await pendingSave;
    });
    expect(outcome?.ok).toBe(false);
    await act(async () => { outcome = await staleSave(); });
    expect(outcome?.ok).toBe(false);
    gridRead = async () => gridReply();
    await act(async () => { await result.current.reload(); });
    await act(async () => { outcome = await staleSave(); });
    expect(outcome?.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('refuses a captured Save after a later local draft edit', async () => {
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const staleSave = result.current.save;
    await act(async () => { result.current.toggleWeeklyBlock('fri', 'late'); });
    let outcome: SaveResult | undefined;
    await act(async () => { outcome = await staleSave(); });
    expect(outcome?.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it.each(['success', 'failure'] as const)('ignores an older %s after the latest bundle succeeds', async older => {
    const pending = deferred<Reply>();
    gridRead = () => pending.promise;
    const { result } = await renderHook(() => useAvailabilityEditor());
    gridRead = async () => gridReply({ fri: ['late'] });
    await act(async () => { await result.current.reload(); });
    expect(result.current.weeklyDays).toEqual({ fri: ['late'] });
    await act(async () => { pending.resolve(older === 'success' ? gridReply() : reply({}, 503)); });
    expect(result.current.weeklyDays).toEqual({ fri: ['late'] });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not let older success reopen a newer failed bundle', async () => {
    const pending = deferred<Reply>();
    gridRead = () => pending.promise;
    const { result } = await renderHook(() => useAvailabilityEditor());
    gridRead = async () => reply({ message: 'Latest failure' }, 503);
    await act(async () => { await result.current.reload(); });
    await act(async () => { pending.resolve(gridReply()); });
    expect(result.current.error).not.toBeNull();
    let outcome: SaveResult | undefined;
    await act(async () => { outcome = await result.current.save(); });
    expect(outcome?.ok).toBe(false);
    expect(writes).toEqual([]);
  });

  it('does not clear current loading when an older bundle finishes first', async () => {
    const older = deferred<Reply>();
    const latest = deferred<Reply>();
    gridRead = () => older.promise;
    const { result } = await renderHook(() => useAvailabilityEditor());
    gridRead = () => latest.promise;
    let reload!: Promise<void>;
    await act(async () => { reload = result.current.reload(); });
    await act(async () => { older.resolve(gridReply()); });
    expect(result.current.loading).toBe(true);
    await act(async () => { latest.resolve(gridReply()); await reload; });
    expect(result.current.loading).toBe(false);
  });

  it('refuses captured Save and reload after unmount, including a late successful read', async () => {
    const pending = deferred<Reply>();
    gridRead = () => pending.promise;
    const { result, unmount } = await renderHook(() => useAvailabilityEditor());
    const staleSave = result.current.save;
    const staleReload = result.current.reload;
    await unmount();
    await act(async () => { pending.resolve(gridReply()); });
    const requests = mockFetch.mock.calls.length;
    const outcome = await staleSave();
    await staleReload();
    expect(outcome.ok).toBe(false);
    expect(writes).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(requests);
  });

  it('refuses duplicate same-turn Save callbacks', async () => {
    const { result } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const pending = deferred<Reply>();
    gridWrite = () => pending.promise;
    const save = result.current.save;
    let first!: Promise<SaveResult>;
    let second!: Promise<SaveResult>;
    let duplicate: SaveResult | undefined;
    await act(async () => { first = save(); second = save(); });
    const pendingWrites = writes.length;
    await act(async () => { pending.resolve(gridReply()); await first; duplicate = await second; });
    expect(duplicate?.ok).toBe(false);
    expect(pendingWrites).toBe(1);
  });

  it.each(['reload', 'unmount'] as const)('does not continue to a window write after %s during the weekly write', async interruption => {
    const { result, unmount } = await renderHook(() => useAvailabilityEditor());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const pending = deferred<Reply>();
    gridWrite = () => pending.promise;
    let saving!: Promise<SaveResult>;
    await act(async () => { saving = result.current.save(); });
    expect(writes).toHaveLength(1);
    if (interruption === 'reload') await act(async () => { await result.current.reload(); });
    else await unmount();
    let outcome: SaveResult | undefined;
    await act(async () => { pending.resolve(gridReply()); outcome = await saving; });
    expect(outcome?.ok).toBe(false);
    expect(writes).toHaveLength(1);
  });
});
