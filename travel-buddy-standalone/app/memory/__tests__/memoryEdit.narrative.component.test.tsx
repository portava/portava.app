import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import EditMemoryScreen from '../edit.tsx';
import { _resetMemoryOperationIds } from '../../../src/services/memories.ts';

const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '55555555-5555-4555-8555-555555555555';
const otherId = '66666666-6666-4666-8666-666666666666';
let mockUserId: string | null = ownerId;
let mockMemoryId = memoryId;
const mockBack = jest.fn();
const mockToken = jest.fn();
const mockAuthListeners = new Set<(event: string, session: unknown) => void>();

jest.mock('expo-router', () => { return {
  router: { back: (...args: unknown[]) => mockBack(...args) },
  useLocalSearchParams: () => ({ id: mockMemoryId }), Redirect: () => null,
}; });
jest.mock('react-native-safe-area-context', () => { return {
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}; });
jest.mock('../../../src/context/SessionContext.tsx', () => { return {
  useSession: () => ({ userId: mockUserId, loading: false }),
}; });
jest.mock('../../../src/lib/supabase.ts', () => { return { supabase: { auth: {
  onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
    mockAuthListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => mockAuthListeners.delete(listener) } } };
  },
} } }; });
jest.mock('../../../src/services/apiToken.ts', () => ({
  ...jest.requireActual('../../../src/services/apiToken.ts'),
  freshToken: (...args: unknown[]) => mockToken(...args),
}));
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => { return { GlobalPlacePicker: () => null }; });

function tokenFor(userId: string, sessionId = 'editor-session', refresh = 0) {
  return `header.${Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, iat: refresh })).toString('base64')}.signature`;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}

function memory(id = memoryId, owner = ownerId) {
  return { id, ownerId: owner, title: 'Coffee', caption: 'My own words', visibility: 'only_me',
    locationCity: 'Hanoi', locationCountry: 'Vietnam', locationLat: 21.03, locationLng: 105.85,
    placeId: 'fsq:old-cafe', canonicalLocationId: null, memoryType: 'MOMENT',
    placeDisplayNameAtOccurrence: 'Old Cafe', state: 'published' };
}

function reply(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const draft = '“Coffee” in Hanoi, Vietnam. You wrote: “My own words”';
function narrative(changes: Record<string, unknown> = {}) {
  return { narrative: { memory_id: memoryId, renderer: 'deterministic@1', summary: draft,
    editable: true, stored: false, ...changes }, ai: { available: true } };
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | undefined };
let calls: Call[];
let getReply: () => Promise<Response>;
let draftReply: () => Promise<Response>;
let saveReply: () => Promise<Response>;
const patches = () => calls.filter(call => call.init.method === 'PATCH');
const previews = () => calls.filter(call => call.url.endsWith('/narrative'));

async function openEditor() {
  const mounted = await render(<EditMemoryScreen />);
  await screen.findByDisplayValue('My own words');
  return mounted;
}

async function preview() {
  await fireEvent.press(screen.getByText('Preview draft'));
  await screen.findByText(draft);
}

async function authEvent(event: string, userId: string | null) {
  await act(async () => {
    for (const listener of mockAuthListeners) listener(event, userId ? {
      user: { id: userId }, access_token: tokenFor(userId, event === 'SIGNED_IN' ? 'new-login' : 'editor-session'),
    } : null);
  });
}

describe('Memory owner editor — deterministic draft adoption', () => {
  const originalFetch = global.fetch;
  const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  beforeEach(() => {
    mockUserId = ownerId; mockMemoryId = memoryId; mockBack.mockClear(); mockAuthListeners.clear();
    mockToken.mockReset().mockResolvedValue(tokenFor(ownerId)); _resetMemoryOperationIds();
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
    calls = [];
    getReply = async () => reply({ memory: memory(mockMemoryId, mockUserId ?? ownerId) });
    draftReply = async () => reply(narrative());
    saveReply = async () => reply({ memory: memory(mockMemoryId, mockUserId ?? ownerId) });
    global.fetch = jest.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/memory-types')) return reply({ enabled: false, types: [] });
      if (url.endsWith('/narrative')) return draftReply();
      return init.method === 'PATCH' ? saveReply() : getReply();
    }) as typeof fetch;
  });
  afterEach(() => { global.fetch = originalFetch; process.env.EXPO_PUBLIC_API_BASE_URL = originalBase; });

  it('previews only on request, explicitly adopts, edits, then uses the existing Save with all existing fields', async () => {
    await openEditor();
    expect(previews()).toHaveLength(0); expect(patches()).toHaveLength(0);
    await preview();
    expect(screen.getByDisplayValue('My own words')).toBeTruthy();
    expect(patches()).toHaveLength(0);
    expect(screen.getByText('Draft from saved details')).toBeTruthy();
    expect(screen.queryByText(/AI draft|verified facts/i)).toBeNull();
    await fireEvent.press(screen.getByText('Use draft'));
    expect(screen.getByDisplayValue(draft)).toBeTruthy(); expect(patches()).toHaveLength(0);
    await fireEvent.changeText(screen.getByPlaceholderText('What made this moment special?'), 'Edited by me');
    await fireEvent.changeText(screen.getByPlaceholderText('Give this memory a name…'), 'New title');
    await fireEvent.press(screen.getByText('Friends'));
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(1);
    expect(patches()[0].body).toMatchObject({ title: 'New title', caption: 'Edited by me', visibility: 'friends_only',
      placeId: 'fsq:old-cafe', locationCity: 'Hanoi', locationCountry: 'Vietnam', locationLat: 21.03, locationLng: 105.85 });
    expect(patches()[0].body).not.toHaveProperty('memoryType');
    expect(patches()[0].body).not.toHaveProperty('placeDisplayNameAtOccurrence');
    expect(calls.every(call => !call.url.includes('/ai') && !call.url.includes('consent'))).toBe(true);
  });

  it('cancel keeps the caption, ignores a late preview, and allows another request', async () => {
    const pending = deferred<Response>(); draftReply = () => pending.promise;
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await waitFor(() => expect(previews()).toHaveLength(1));
    await fireEvent.press(screen.getByText('Cancel preview'));
    expect(previews()[0].init.signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(reply(narrative())); });
    expect(screen.queryByText('Use draft')).toBeNull();
    expect(screen.getByDisplayValue('My own words')).toBeTruthy(); expect(patches()).toHaveLength(0);
    draftReply = async () => reply(narrative()); await preview();
  });

  it('a late preview never replaces text typed while it was loading', async () => {
    const pending = deferred<Response>(); draftReply = () => pending.promise;
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await fireEvent.changeText(screen.getByPlaceholderText('What made this moment special?'), 'Still my words');
    await act(async () => { pending.resolve(reply(narrative())); });
    expect(await screen.findByText(draft)).toBeTruthy();
    expect(screen.getByDisplayValue('Still my words')).toBeTruthy(); expect(patches()).toHaveLength(0);
    await fireEvent.press(screen.getByText('Cancel preview'));
    expect(screen.getByDisplayValue('Still my words')).toBeTruthy();
  });

  it.each([401, 403, 404, 503])('a %s preview fails closed and can be retried without changing the caption', async status => {
    draftReply = async () => reply({ message: 'untrusted details' }, status);
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await screen.findByText('Could not load a draft. Your caption has not changed.');
    expect(screen.queryByText('Use draft')).toBeNull(); expect(screen.queryByText('untrusted details')).toBeNull();
    expect(screen.getByDisplayValue('My own words')).toBeTruthy(); expect(patches()).toHaveLength(0);
    draftReply = async () => reply(narrative()); await preview();
  });

  it.each([
    { summary: null }, { summary: '   ' }, { memory_id: otherId }, { renderer: 'ai:model@1' },
    { editable: false }, { stored: true },
  ])('refuses malformed/wrong-source preview %j', async changes => {
    draftReply = async () => reply(narrative(changes));
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await screen.findByText('Could not load a draft. Your caption has not changed.');
    expect(screen.queryByText('Use draft')).toBeNull(); expect(screen.getByDisplayValue('My own words')).toBeTruthy();
    expect(patches()).toHaveLength(0);
  });

  it('does not truncate or adopt a draft over the existing caption limit', async () => {
    draftReply = async () => reply(narrative({ summary: 'long '.repeat(401) }));
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await screen.findByText('This draft is too long for a caption. Keep editing your caption instead.');
    expect(screen.queryByText('Use draft')).toBeNull(); expect(screen.getByDisplayValue('My own words')).toBeTruthy();
  });

  it('retries an unconfirmed Save with the same operation key, including beyond the service reuse window', async () => {
    await openEditor(); await preview(); await fireEvent.press(screen.getByText('Use draft'));
    saveReply = async () => { throw new TypeError('Offline'); };
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await screen.findByText('Offline');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
    try {
      saveReply = async () => reply({ memory: memory() });
      await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
      await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
      expect(patches()).toHaveLength(2);
      expect(patches()[1].init.headers).toEqual(patches()[0].init.headers);
      expect(patches()[1].body).toEqual(patches()[0].body);
    } finally { clock.mockRestore(); }
  });

  it('preserves existing location clearing and a manual save without requesting a draft', async () => {
    await openEditor();
    await fireEvent.press(screen.getByTestId('memory-edit-location-clear'), { stopPropagation: jest.fn() });
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body).toMatchObject({ caption: 'My own words', visibility: 'only_me',
      locationCity: null, locationCountry: null, locationLat: null, locationLng: null, placeId: null, canonicalLocationId: null });
    expect(previews()).toHaveLength(0);
  });

  it.each(['SIGNED_OUT', 'SIGNED_IN'])('discards a late preview and all private form state on %s (even the same owner)', async event => {
    const pending = deferred<Response>(); draftReply = () => pending.promise;
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await authEvent(event, event === 'SIGNED_OUT' ? null : ownerId);
    await act(async () => { pending.resolve(reply(narrative())); });
    expect(screen.queryByText('Use draft')).toBeNull(); expect(screen.queryByDisplayValue('My own words')).toBeNull();
    expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull(); expect(mockBack).not.toHaveBeenCalled();
  });

  it.each(['load', 'preview', 'save'])('does not send %s after the account changes during token acquisition', async phase => {
    const pending = deferred<string | null>();
    if (phase === 'load') {
      mockToken.mockImplementation(() => pending.promise); await render(<EditMemoryScreen />);
    } else {
      await openEditor(); mockToken.mockImplementation(() => pending.promise);
      await fireEvent.press(screen.getByText(phase === 'save' ? 'Save' : 'Preview draft'));
    }
    const count = calls.length;
    await authEvent('SIGNED_IN', otherId);
    await act(async () => { pending.resolve(tokenFor(otherId)); });
    expect(calls).toHaveLength(count); expect(mockBack).not.toHaveBeenCalled();
    expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull();
  });

  it('refuses a token for another owner even before an auth event arrives', async () => {
    await openEditor(); mockToken.mockResolvedValue(tokenFor(otherId));
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await screen.findByText('This editing session changed. Reopen the Memory.');
    expect(patches()).toHaveLength(0); expect(mockBack).not.toHaveBeenCalled();
  });

  it('ignores a late save after a same-account relogin', async () => {
    const pending = deferred<Response>(); saveReply = () => pending.promise;
    await openEditor(); await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await authEvent('SIGNED_OUT', null); await authEvent('SIGNED_IN', ownerId);
    await act(async () => { pending.resolve(reply({ memory: memory() })); });
    expect(mockBack).not.toHaveBeenCalled(); expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull();
  });

  it.each(['load', 'preview', 'save'])('ignores late %s after switching the Memory route', async phase => {
    const pending = deferred<Response>();
    let mounted;
    if (phase === 'load') { getReply = () => pending.promise; mounted = await render(<EditMemoryScreen />); }
    else {
      mounted = await openEditor();
      if (phase === 'preview') draftReply = () => pending.promise;
      else saveReply = () => pending.promise;
      await fireEvent.press(screen.getByText(phase === 'save' ? 'Save' : 'Preview draft'));
    }
    getReply = async () => reply({ memory: { ...memory(otherId), caption: 'Second Memory' } });
    mockMemoryId = otherId; await mounted.rerender(<EditMemoryScreen />);
    await screen.findByDisplayValue('Second Memory');
    await act(async () => { pending.resolve(reply(phase === 'preview' ? narrative() : { memory: memory() })); });
    expect(screen.getByDisplayValue('Second Memory')).toBeTruthy(); expect(screen.queryByText('Use draft')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('ignores late completion and unsubscribes after unmount', async () => {
    const pending = deferred<Response>(); saveReply = () => pending.promise;
    const mounted = await openEditor(); await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches()).toHaveLength(1)); await mounted.unmount();
    await act(async () => { pending.resolve(reply({ memory: memory() })); });
    expect(mockBack).not.toHaveBeenCalled(); expect(mockAuthListeners.size).toBe(0);
    expect(patches()[0].init.signal?.aborted).toBe(true);
  });

  it.each([{ ownerId: otherId }, { id: otherId }])('does not open an editor for the wrong loaded identity %j', async changes => {
    getReply = async () => reply({ memory: { ...memory(), ...changes } });
    await render(<EditMemoryScreen />);
    await screen.findByText('This Memory is not available to edit.');
    expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull(); expect(previews()).toHaveLength(0);
  });

  it('ordinary same-owner token refresh keeps an in-flight preview usable', async () => {
    const pending = deferred<Response>(); draftReply = () => pending.promise;
    await openEditor(); await fireEvent.press(screen.getByText('Preview draft'));
    await authEvent('TOKEN_REFRESHED', ownerId);
    await act(async () => { pending.resolve(reply(narrative())); });
    await fireEvent.press(await screen.findByText('Use draft'));
    expect(screen.getByDisplayValue(draft)).toBeTruthy(); expect(patches()).toHaveLength(0);
  });

  it.each(['preview', 'save'])('closing cancels %s before its token resolves, without a write or second navigation', async phase => {
    const pending = deferred<string | null>();
    await openEditor(); mockToken.mockImplementation(() => pending.promise);
    await fireEvent.press(screen.getByText(phase === 'save' ? 'Save' : 'Preview draft'));
    await fireEvent.press(screen.getByLabelText('Close editor'));
    await act(async () => { pending.resolve(tokenFor(ownerId)); });
    expect(previews()).toHaveLength(0); expect(patches()).toHaveLength(0);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it.each(['load', 'preview', 'save'])('ignores %s JSON that finishes after a session change', async phase => {
    const body = deferred<unknown>();
    const parsing = jest.fn(() => body.promise);
    const delayed = async () => ({ ...reply(null), json: parsing });
    if (phase === 'load') { getReply = delayed; await render(<EditMemoryScreen />); }
    else {
      await openEditor();
      if (phase === 'preview') draftReply = delayed;
      else saveReply = delayed;
      await fireEvent.press(screen.getByText(phase === 'save' ? 'Save' : 'Preview draft'));
    }
    await waitFor(() => expect(parsing).toHaveBeenCalled());
    await authEvent('SIGNED_IN', otherId);
    await act(async () => { body.resolve(phase === 'preview' ? narrative() : { memory: memory() }); });
    expect(screen.queryByDisplayValue('My own words')).toBeNull(); expect(screen.queryByText('Use draft')).toBeNull();
    expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull(); expect(mockBack).not.toHaveBeenCalled();
  });

  it.each(['load', 'preview', 'save'])('a context-only account switch hides old %s and cannot apply its completion', async phase => {
    const pending = deferred<Response>();
    let mounted;
    if (phase === 'load') { getReply = () => pending.promise; mounted = await render(<EditMemoryScreen />); }
    else {
      mounted = await openEditor();
      if (phase === 'preview') draftReply = () => pending.promise;
      else saveReply = () => pending.promise;
      await fireEvent.press(screen.getByText(phase === 'save' ? 'Save' : 'Preview draft'));
    }
    mockUserId = otherId; mockToken.mockResolvedValue(tokenFor(otherId));
    getReply = async () => reply({ memory: { ...memory(memoryId, otherId), caption: 'Other owner caption' } });
    await mounted.rerender(<EditMemoryScreen />); await screen.findByDisplayValue('Other owner caption');
    await act(async () => { pending.resolve(reply(phase === 'preview' ? narrative() : { memory: memory() })); });
    expect(screen.getByDisplayValue('Other owner caption')).toBeTruthy();
    expect(screen.queryByDisplayValue('My own words')).toBeNull(); expect(screen.queryByText('Use draft')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it.each([null, { memory: { ...memory(), id: otherId } }, { memory: { ...memory(), ownerId: otherId } }])(
    'does not navigate on a malformed or wrong-subject Save result %j', async body => {
      saveReply = async () => reply(body);
      await openEditor(); await fireEvent.press(screen.getByText('Save'));
      await screen.findByText('This Memory is not available to edit.');
      expect(mockBack).not.toHaveBeenCalled(); expect(screen.getByDisplayValue('My own words')).toBeTruthy();
    },
  );

  it('keeps the owner text and existing conflict response when Save is refused', async () => {
    saveReply = async () => reply({ error: 'conflict', message: 'This Memory changed. Reload it and try again.' }, 409);
    await openEditor(); await preview(); await fireEvent.press(screen.getByText('Use draft'));
    await fireEvent.press(screen.getByText('Save'));
    await screen.findByText('This Memory changed. Reload it and try again.');
    expect(screen.getByDisplayValue(draft)).toBeTruthy(); expect(mockBack).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(1);
  });

  it('does not issue duplicate Saves while one is unresolved', async () => {
    const pending = deferred<Response>(); saveReply = () => pending.promise;
    await openEditor();
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await fireEvent.press(screen.getByTestId('memory-edit-save-btn'));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await act(async () => { pending.resolve(reply({ memory: memory() })); });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('never sends an anonymous save when the token is unavailable', async () => {
    await openEditor(); mockToken.mockResolvedValue(null);
    await fireEvent.press(screen.getByText('Save'));
    await screen.findByText('This editing session changed. Reopen the Memory.');
    expect(patches()).toHaveLength(0); expect(mockBack).not.toHaveBeenCalled();
  });

  it('does not open or fetch an owner editor when signed out', async () => {
    mockUserId = null; await render(<EditMemoryScreen />);
    await screen.findByText('Sign in to edit this Memory.');
    expect(calls).toHaveLength(0); expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull();
  });

  it('same-session SIGNED_IN re-confirmation preserves edits and a refreshed token can Save', async () => {
    await openEditor();
    await fireEvent.changeText(screen.getByPlaceholderText('What made this moment special?'), 'Keep my edits');
    const refreshed = tokenFor(ownerId, 'editor-session', 1);
    await act(async () => {
      for (const listener of mockAuthListeners) listener('SIGNED_IN', { user: { id: ownerId }, access_token: refreshed });
    });
    expect(screen.getByDisplayValue('Keep my edits')).toBeTruthy();
    mockToken.mockResolvedValue(refreshed);
    await fireEvent.press(screen.getByText('Save'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(patches()[0].body?.caption).toBe('Keep my edits');
  });

  it.each(['preview', 'save'])('a new same-owner token session cannot send %s even before its auth event', async phase => {
    await openEditor(); mockToken.mockResolvedValue(tokenFor(ownerId, 'new-login'));
    await fireEvent.press(screen.getByText(phase === 'save' ? 'Save' : 'Preview draft'));
    await screen.findByText('This editing session changed. Reopen the Memory.');
    expect(previews()).toHaveLength(0); expect(patches()).toHaveLength(0);
    expect(screen.queryByTestId('memory-edit-save-btn')).toBeNull();
    expect(screen.queryByDisplayValue('My own words')).toBeNull();
  });
});
