import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EditMemoryScreen from '../edit.tsx';
import { _resetMemoryOperationIds } from '../../../src/services/memories.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '55555555-5555-4555-8555-555555555555';
const otherId = '66666666-6666-4666-8666-666666666666';
const startsAt = '2026-03-02T19:00:12.123456+00:00';
const endsAt = '2026-03-02T20:30:13.654321+00:00';
let mockUserId: string | null = ownerId;
let mockMemoryId = memoryId;
const mockBack = jest.fn();
const mockToken = jest.fn();
const mockAuthListeners = new Set<(event: string, session: unknown) => void>();

jest.mock('expo-router', () => { return { router: { back: () => mockBack() },
  useLocalSearchParams: () => ({ id: mockMemoryId }), Redirect: () => null }; });
jest.mock('react-native-safe-area-context', () => { return { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }; });
jest.mock('../../../src/context/SessionContext.tsx', () => { return { useSession: () => ({ userId: mockUserId, loading: false }) }; });
jest.mock('../../../src/lib/supabase.ts', () => { return { supabase: { auth: {
  onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
    mockAuthListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => mockAuthListeners.delete(listener) } } };
  },
} } }; });
jest.mock('../../../src/services/apiToken.ts', () => ({
  ...jest.requireActual('../../../src/services/apiToken.ts'), freshToken: () => mockToken(),
}));
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => { return { GlobalPlacePicker: () => null }; });

function tokenFor(userId = ownerId, sessionId = 'time-editor-session', refresh = 0) {
  return `header.${Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, iat: refresh })).toString('base64')}.signature`;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | undefined };
let calls: Call[];
let saved: Record<string, unknown>;
let getReply: () => Promise<Response>;
let saveReply: (body: Record<string, unknown>) => Promise<Response>;
const patches = () => calls.filter(call => call.init.method === 'PATCH');
const save = () => fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
const change = (bound: 'start' | 'end', part: 'date' | 'time' | 'offset', value: string) =>
  fireEvent.changeText(screen.getByTestId(`memory-${bound}-${part}`), value);

async function openEditor() {
  const mounted = await render(<EditMemoryScreen />);
  await screen.findByDisplayValue('My own words');
  return mounted;
}

async function setTime(bound: 'start' | 'end', date: string, time: string, offset: string) {
  await change(bound, 'date', date); await change(bound, 'time', time); await change(bound, 'offset', offset);
}

async function authEvent(event: string, userId: string | null = ownerId, sessionId = 'time-editor-session') {
  await act(async () => {
    for (const listener of mockAuthListeners) listener(event, userId ? {
      user: { id: userId }, access_token: tokenFor(userId, sessionId),
    } : null);
  });
}

describe('Memory owner editor — explicit time correction through real transport', () => {
  const originalFetch = global.fetch;
  const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  beforeEach(() => {
    mockUserId = ownerId; mockMemoryId = memoryId; mockBack.mockClear(); mockAuthListeners.clear();
    mockToken.mockReset().mockResolvedValue(tokenFor()); _resetMemoryOperationIds(); calls = [];
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
    saved = { id: memoryId, ownerId, title: 'Coffee', caption: 'My own words', visibility: 'only_me',
      locationCity: null, locationCountry: null, placeId: null, state: 'published', startsAt, endsAt };
    getReply = async () => reply({ memory: { ...saved, id: mockMemoryId, ownerId: mockUserId } });
    saveReply = async body => { Object.assign(saved, body); return reply({ memory: saved }); };
    global.fetch = jest.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, init, body });
      if (url.endsWith('/memory-types')) return reply({ enabled: false, types: [] });
      if (url.endsWith('/narrative')) return reply({ narrative: { memory_id: memoryId, renderer: 'deterministic@1',
        summary: 'Draft from saved time', editable: true, stored: false } });
      if (!url.endsWith(`/memories/${mockMemoryId}`)) throw new Error(`Unexpected transport: ${url}`);
      return init.method === 'PATCH' ? saveReply(body) : getReply();
    }) as typeof fetch;
  });
  afterEach(() => { global.fetch = originalFetch; process.env.EXPO_PUBLIC_API_BASE_URL = originalBase; });

  it('keeps unrelated saves free of time fields and leaves stored precision unchanged', async () => {
    await openEditor(); await fireEvent.changeText(screen.getByPlaceholderText('Give this memory a name…'), 'New title');
    await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).not.toHaveProperty('startsAt'); expect(patches()[0].body).not.toHaveProperty('endsAt');
    expect(saved).toMatchObject({ startsAt, endsAt, title: 'New title' });
  });

  it('closing without Save sends no write', async () => {
    await openEditor(); await fireEvent.press(screen.getByLabelText('Close editor'));
    expect(patches()).toHaveLength(0); expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('shows saved date, full time precision and explicit offset without guessing an occurrence zone', async () => {
    await openEditor();
    expect(screen.getByTestId('memory-start-date').props.value).toBe('2026-03-02');
    expect(screen.getByTestId('memory-start-time').props.value).toBe('19:00:12.123456');
    expect(screen.getByTestId('memory-start-offset').props.value).toBe('+00:00');
    expect(screen.getByText(/An offset is not a place or time zone/)).toBeTruthy();
    expect(patches()).toHaveLength(0);
  });

  it.each(['start', 'end'] as const)('edits %s only on Save and reopens the confirmed saved value', async bound => {
    const mounted = await openEditor();
    const time = bound === 'start' ? '18:15:02.123456' : '21:15:02.654321';
    await change(bound, 'time', time); expect(patches()).toHaveLength(0);
    await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    const field = bound === 'start' ? 'startsAt' : 'endsAt';
    expect(patches()[0].body?.[field]).toBe(`2026-03-02T${time}+00:00`);
    expect(patches()[0].body).not.toHaveProperty(bound === 'start' ? 'endsAt' : 'startsAt');
    expect(patches()[0].url).toBe(`http://127.0.0.1:9/api/memories/${memoryId}`);
    expect(patches()[0].init.headers).toMatchObject({ Authorization: `Bearer ${tokenFor()}` });
    await mounted.unmount(); await openEditor();
    expect(screen.getByTestId(`memory-${bound}-time`).props.value).toBe(time);
  });

  it.each(['start', 'end'] as const)('explicitly clears %s without clearing the other bound', async bound => {
    await openEditor(); await fireEvent.press(screen.getByLabelText(`Clear ${bound}`));
    expect(patches()).toHaveLength(0); expect(screen.getByText(`${bound === 'start' ? 'Start' : 'End'} not set`)).toBeTruthy();
    await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body?.[bound === 'start' ? 'startsAt' : 'endsAt']).toBeNull();
    expect(patches()[0].body).not.toHaveProperty(bound === 'start' ? 'endsAt' : 'startsAt');
  });

  it('leaves unknown times blank and requires an explicit date, time and offset', async () => {
    saved.startsAt = null; saved.endsAt = null;
    await openEditor();
    for (const part of ['date', 'time', 'offset']) expect(screen.getByTestId(`memory-start-${part}`).props.value).toBe('');
    await change('start', 'date', '2026-10-16'); await save();
    expect(patches()).toHaveLength(0); expect(screen.getByText(/Enter a complete start date/)).toBeTruthy();
    await change('start', 'time', '10:15:00'); await change('start', 'offset', '+05:45'); await save();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).toMatchObject({ startsAt: '2026-10-16T10:15:00+05:45' });
    expect(patches()[0].body).not.toHaveProperty('endsAt');
  });

  it.each([
    ['date', '2026-02-30'], ['date', '2026-13-01'], ['date', '2026-3-2'],
    ['time', '25:00:00'], ['time', '19:60:00'], ['time', '19:00:60'], ['time', '19:00'],
    ['offset', ''], ['offset', '99:00'], ['offset', '+24:00'], ['offset', 'America/New_York'], ['offset', ' Z '],
  ] as const)('refuses malformed %s=%s without transport or loss of user text', async (part, value) => {
    await openEditor(); await change('start', part, value); await save();
    expect(patches()).toHaveLength(0); expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a complete start date/)).toBeTruthy();
    expect(screen.getByTestId(`memory-start-${part}`).props.value).toBe(value);
  });

  it('does not interpret emptied inputs as an explicit clear', async () => {
    await openEditor(); await setTime('start', '', '', ''); await save();
    expect(patches()).toHaveLength(0); expect(screen.getByText(/choose Clear start/)).toBeTruthy();
  });

  it.each([
    ['2026-11-01', '01:30:00', '-04:00', '2026-11-01', '01:30:00', '-05:00'],
    ['2026-10-17', '00:30:00', '+14:00', '2026-10-16', '01:30:00', '-12:00'],
    ['2026-03-02', '19:00:12.123456', 'Z', '2026-03-02', '20:30:13.654321', '+00:00'],
  ])('preserves explicit offset instants across DST/date-line representations %s %s %s', async (...parts) => {
    await openEditor(); await setTime('start', parts[0], parts[1], parts[2]);
    await setTime('end', parts[3], parts[4], parts[5]); await save();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    const nextStart = `${parts[0]}T${parts[1]}${parts[2]}`;
    const nextEnd = `${parts[3]}T${parts[4]}${parts[5]}`;
    expect(saved).toMatchObject({ startsAt: nextStart, endsAt: nextEnd });
    if (nextStart !== startsAt) expect(patches()[0].body?.startsAt).toBe(nextStart);
    else expect(patches()[0].body).not.toHaveProperty('startsAt');
    if (nextEnd !== endsAt) expect(patches()[0].body?.endsAt).toBe(nextEnd);
    else expect(patches()[0].body).not.toHaveProperty('endsAt');
  });

  it('refuses an obviously inverted newly edited interval without autofixing either time', async () => {
    await openEditor(); await change('start', 'time', '23:00:00'); await save();
    expect(screen.getByText('End must not be before start. Change or clear a time.')).toBeTruthy();
    expect(patches()).toHaveLength(0); expect(screen.getByTestId('memory-start-time').props.value).toBe('23:00:00');
    expect(screen.getByTestId('memory-end-time').props.value).toBe('20:30:13.654321');
    await fireEvent.press(screen.getByLabelText('Clear end')); await save();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });

  it('does not repair or reject old inverted times on an unrelated save', async () => {
    saved.startsAt = endsAt; saved.endsAt = startsAt;
    await openEditor(); await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(saved).toMatchObject({ startsAt: endsAt, endsAt: startsAt });
    expect(patches()[0].body).not.toHaveProperty('startsAt');
  });

  it.each([
    ['start', '123455', '123456', '123457'],
    ['end', '123456', '123457', '123455'],
    ['start', '123456788', '123456789', '123456790'],
    ['end', '123456789', '123456790', '123456788'],
    ['start', '123456789123456788', '123456789123456789', '123456789123456790'],
    ['end', '123456789123456789', '123456789123456790', '123456789123456788'],
  ] as const)('rejects a %s inversion at fractional precision %s without mutating either bound', async (bound, startFraction, endFraction, editedFraction) => {
    const originalStart = `2026-03-02T19:00:12.${startFraction}Z`;
    const originalEnd = `2026-03-02T19:00:12.${endFraction}Z`;
    saved.startsAt = originalStart; saved.endsAt = originalEnd;
    await openEditor(); await change(bound, 'time', `19:00:12.${editedFraction}`); await save();
    expect(patches()).toHaveLength(0); expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByText('End must not be before start. Change or clear a time.')).toBeTruthy();
    expect(screen.getByTestId(`memory-${bound}-time`).props.value).toBe(`19:00:12.${editedFraction}`);
    expect(saved).toMatchObject({ startsAt: originalStart, endsAt: originalEnd });
  });

  it.each([
    ['microsecond order', '2026-03-02', '19:00:12.123455', 'Z', '2026-03-02', '19:00:12.123456', 'Z'],
    ['nanosecond order', '2026-03-02', '19:00:12.123456788', 'Z', '2026-03-02', '19:00:12.123456789', 'Z'],
    ['long fraction order', '2026-03-02', '19:00:12.123456789123456788', 'Z', '2026-03-02', '19:00:12.123456789123456789', 'Z'],
    ['trailing-zero equality', '2026-03-02', '19:00:12.123456789000', 'Z', '2026-03-02', '19:00:12.123456789', 'Z'],
    ['positive offset equality', '2026-03-03', '00:45:12.123456789', '+0545', '2026-03-02', '19:00:12.1234567890', 'Z'],
    ['negative offset equality', '2026-03-02', '15:00:12.123456789', '-04:00', '2026-03-02', '19:00:12.123456789', '+00:00'],
    ['whole-second equality', '1969-12-31', '23:59:59', '-00:00', '1969-12-31', '23:59:59.000000000', 'Z'],
    ['negative epoch order', '1969-12-31', '23:59:59.999999998', 'Z', '1969-12-31', '23:59:59.999999999', 'Z'],
    ['negative epoch offset equality', '1970-01-01', '00:00:00.000000001', '+00:01', '1969-12-31', '23:59:00.000000001', 'Z'],
    ['epoch crossing', '1969-12-31', '23:59:59.999999999', 'Z', '1970-01-01', '00:00:00.000000001', 'Z'],
  ])('preserves exact payload strings for %s', async (_label, startDate, startTime, startOffset, endDate, endTime, endOffset) => {
    await openEditor(); await setTime('start', startDate, startTime, startOffset);
    await setTime('end', endDate, endTime, endOffset); await save();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    const expected = { startsAt: `${startDate}T${startTime}${startOffset}`, endsAt: `${endDate}T${endTime}${endOffset}` };
    expect(patches()).toHaveLength(1); expect(patches()[0].body).toMatchObject(expected);
    expect(saved).toMatchObject(expected);
  });

  it.each([
    ['offset microseconds', '2026-03-03', '00:45:12.123457', '+05:45', '2026-03-02', '19:00:12.123456', 'Z'],
    ['negative epoch nanoseconds', '1969-12-31', '23:59:59.999999999', 'Z', '1969-12-31', '23:59:59.999999998', 'Z'],
    ['negative epoch offset nanoseconds', '1970-01-01', '00:00:00.000000002', '+0001', '1969-12-31', '23:59:00.000000001', 'Z'],
  ])('rejects %s inversion using the explicit instant, not display text or truncated milliseconds', async (_label, startDate, startTime, startOffset, endDate, endTime, endOffset) => {
    await openEditor(); await setTime('start', startDate, startTime, startOffset);
    await setTime('end', endDate, endTime, endOffset); await save();
    expect(patches()).toHaveLength(0); expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByText('End must not be before start. Change or clear a time.')).toBeTruthy();
    expect(screen.getByTestId('memory-start-time').props.value).toBe(startTime);
    expect(screen.getByTestId('memory-end-time').props.value).toBe(endTime);
  });

  it('leaves a legacy sub-millisecond inversion untouched on an unrelated Save', async () => {
    saved.startsAt = '2026-03-02T19:00:12.123456789Z';
    saved.endsAt = '2026-03-02T19:00:12.123456788Z';
    await openEditor(); await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).not.toHaveProperty('startsAt'); expect(patches()[0].body).not.toHaveProperty('endsAt');
    expect(saved).toMatchObject({ startsAt: '2026-03-02T19:00:12.123456789Z', endsAt: '2026-03-02T19:00:12.123456788Z' });
  });

  it.each(['start', 'end'] as const)('restores saved %s without resending or rounding it', async bound => {
    await openEditor(); await fireEvent.press(screen.getByLabelText(`Clear ${bound}`));
    await fireEvent.press(screen.getByLabelText(`Restore saved ${bound}`));
    await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).not.toHaveProperty('startsAt'); expect(patches()[0].body).not.toHaveProperty('endsAt');
    expect(saved).toMatchObject({ startsAt, endsAt });
  });

  it('does not coerce a legacy unreadable timestamp on an unrelated Save', async () => {
    saved.startsAt = 'legacy unknown time';
    await openEditor(); expect(screen.getByText('Saved start: legacy unknown time')).toBeTruthy();
    await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).not.toHaveProperty('startsAt'); expect(saved.startsAt).toBe('legacy unknown time');
  });

  it('requires a complete replacement after clearing instead of reusing hidden saved components', async () => {
    await openEditor(); await fireEvent.press(screen.getByLabelText('Clear start'));
    await change('start', 'date', '2026-03-02'); await save();
    expect(patches()).toHaveLength(0); expect(screen.getByText(/Enter a complete start date/)).toBeTruthy();
    expect(screen.getByTestId('memory-start-time').props.value).toBe('');
    expect(screen.getByTestId('memory-start-offset').props.value).toBe('');
  });

  it('keeps Preview and Use draft read-only and independent from unsaved time changes', async () => {
    await openEditor(); await change('start', 'time', '18:00:00');
    await fireEvent.press(screen.getByText('Preview draft')); await screen.findByText('Draft from saved time');
    await fireEvent.press(screen.getByText('Use draft'));
    expect(patches()).toHaveLength(0); expect(screen.getByTestId('memory-start-time').props.value).toBe('18:00:00');
    await save(); await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).toMatchObject({ startsAt: '2026-03-02T18:00:00+00:00', caption: 'Draft from saved time' });
  });

  it.each([400, 409, 503, 'throw'] as const)('retains the time draft after %s and retries the same intent with the same operation key', async status => {
    saveReply = async () => { if (status === 'throw') throw new Error('Offline'); return reply({ message: 'Save refused' }, status); };
    await openEditor(); await change('start', 'time', '18:00:00'); await save();
    await screen.findByText(status === 'throw' ? 'Offline' : 'Save refused');
    expect(mockBack).not.toHaveBeenCalled(); expect(screen.getByTestId('memory-start-time').props.value).toBe('18:00:00');
    await save(); await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].init.headers).toEqual(patches()[0].init.headers);
    await change('start', 'time', '18:01:00'); await save(); await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches()[2].init.headers).not.toEqual(patches()[1].init.headers);
  });

  it('sends one time save while the first response is unresolved', async () => {
    const pending = deferred<Response>(); saveReply = () => pending.promise;
    await openEditor(); await change('start', 'time', '18:00:00');
    await save(); await save(); await waitFor(() => expect(patches()).toHaveLength(1));
    expect(screen.getByTestId('memory-start-time').props.editable).toBe(false);
    await act(async () => { pending.resolve(reply({ memory: saved })); });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGNED_IN', 'TOKEN_REFRESHED'])('preserves edits on same-session %s', async event => {
    await openEditor(); await change('start', 'time', '18:00:00'); await authEvent(event);
    mockToken.mockResolvedValue(tokenFor(ownerId, 'time-editor-session', 2)); await save();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body?.startsAt).toBe('2026-03-02T18:00:00+00:00');
  });

  it.each(['new-session', 'sign-out', 'account', 'memory', 'close', 'unmount'] as const)('fences a pending time save after %s', async boundary => {
    const pending = deferred<string | null>(); const mounted = await openEditor();
    await change('start', 'time', '18:00:00'); mockToken.mockImplementation(() => pending.promise); await save();
    if (boundary === 'new-session') await authEvent('SIGNED_IN', ownerId, 'new-session');
    if (boundary === 'sign-out') await authEvent('SIGNED_OUT', null);
    if (boundary === 'account') { mockUserId = otherId; await mounted.rerender(<EditMemoryScreen />); }
    if (boundary === 'memory') { mockMemoryId = otherId; await mounted.rerender(<EditMemoryScreen />); }
    if (boundary === 'close') await fireEvent.press(screen.getByLabelText('Close editor'));
    if (boundary === 'unmount') await mounted.unmount();
    await act(async () => { pending.resolve(tokenFor()); });
    expect(patches()).toHaveLength(0); expect(mockBack).toHaveBeenCalledTimes(boundary === 'close' ? 1 : 0);
  });

  it.each(['new-session', 'close', 'unmount'] as const)('ignores late save completion after %s without claiming to undo a server write', async boundary => {
    const pending = deferred<Response>(); saveReply = () => pending.promise;
    const mounted = await openEditor(); await change('start', 'time', '18:00:00'); await save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    if (boundary === 'new-session') await authEvent('SIGNED_IN', ownerId, 'new-session');
    if (boundary === 'close') await fireEvent.press(screen.getByLabelText('Close editor'));
    if (boundary === 'unmount') await mounted.unmount();
    await act(async () => { pending.resolve(reply({ memory: { ...saved, startsAt: '2026-03-02T18:00:00+00:00' } })); });
    expect(mockBack).toHaveBeenCalledTimes(boundary === 'close' ? 1 : 0);
    expect(patches()).toHaveLength(1);
  });
});
