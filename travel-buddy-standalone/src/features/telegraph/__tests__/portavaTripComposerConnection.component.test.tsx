import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { ComposerPlusMenu } from '../composer/ComposerPlusMenu.tsx';
import { PortavaTripShareSheet, usePortavaTripComposer } from '../composer/PortavaTripShareSheet.tsx';
import { captureMessagingOwnerRequest, messagingOwnerToken } from '../../../services/messagingOwnerRequest.ts';
import type { ConversationProjectionState } from '../conversation/conversationProjection.ts';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, { get(target, prop, receiver) {
    if (prop === 'Modal') {
      const React = require('react');
      return ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? React.createElement(target.View, null, children) : null;
    }
    return Reflect.get(target, prop, receiver);
  } });
});
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../../../lib/supabase.ts', () => {
  return { isSupabaseConfigured: true };
});
jest.mock('../../../services/messagingOwnerRequest.ts', () => {
  return { captureMessagingOwnerRequest: jest.fn(), messagingOwnerToken: jest.fn() };
});

const OWNER = '10000000-0000-4000-8000-000000000001';
const THREAD = '20000000-0000-4000-8000-000000000001';
const TRIP = '30000000-0000-4000-8000-000000000001';
const MESSAGE = '40000000-0000-4000-8000-000000000001';
const healthy: ConversationProjectionState = { status: 'ready', canSendMessage: true, isE2ee: false, degraded: false, memberCount: 2 };
const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const reloaded = jest.fn();
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

function ConnectedComposer({ projection = healthy }: { projection?: ConversationProjectionState }) {
  const [visible, setVisible] = useState(false);
  const picker = usePortavaTripComposer(THREAD, OWNER, projection, reloaded);
  return <>
    <Pressable onPress={() => setVisible(true)}><Text>Add to message</Text></Pressable>
    <ComposerPlusMenu visible={visible} onClose={() => setVisible(false)} onSelect={() => {}}
      portavaTrips={{ available: picker.available, onSelect: () => { setVisible(false); picker.open(); } }} />
    {picker.intent ? <PortavaTripShareSheet key={picker.intent.generation} intent={picker.intent} onClose={picker.close} onSent={picker.sent} /> : null}
  </>;
}

beforeEach(() => {
  reloaded.mockReset();
  jest.mocked(captureMessagingOwnerRequest).mockImplementation(() => {
    let valid = true;
    return { ownerId: OWNER, sessionId: 'session-one', isCurrent: () => valid, invalidate: () => { valid = false; } };
  });
  jest.mocked(messagingOwnerToken).mockResolvedValue('dummy-owner-token');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.invalid';
  global.fetch = fetchMock;
  fetchMock.mockReset().mockImplementation(async (_url, init) => init?.method === 'POST'
    ? response({ id: MESSAGE, threadId: THREAD, senderId: OWNER, msgType: 'portava_object', subtype: 'trip',
      share: { kind: 'PORTAVA_OBJECT', objectType: 'TRIP', objectId: TRIP, caption: null, shareProjectionVersion: '1' } }, 201)
    : response({ trips: [{ id: TRIP, ownerId: OWNER, title: 'Private journey', tripNotes: 'Secret note', destinationLat: 10 }] }));
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

it('connects the actual thread host to the scoped Portava trip picker', () => {
  const source = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  expect(source).toContain('usePortavaTripComposer(');
  expect(source).toContain('portavaTrips={{');
  expect(source).toContain('<PortavaTripShareSheet');
  expect(source).toContain('available: tripComposer.available');
  expect(source).toContain('tripComposer.open()');
  expect(source).toContain('onClose={tripComposer.close} onSent={tripComposer.sent}');
  expect(source).toContain('useFocusEffect(useCallback(() => tripComposer.close, [tripComposer.close]))');
  expect(source).toContain('conversationProjection, () => { void reload(); }');
});

it('connects the actual menu, lifecycle hook, picker and HTTP adapter to explicit reference sharing', async () => {
  const view = await render(<ConnectedComposer />);
  expect(fetchMock).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('Add to message'));
  await fireEvent.press(view.getByTestId('telegraph-composer-entry-PORTAVA'));
  await view.findByText('Private journey');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  await waitFor(() => expect(reloaded).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe(`https://api.example.invalid/api/threads/${THREAD}/share`);
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ objectType: 'TRIP', objectId: TRIP, caption: null });
  expect(view.queryByTestId('portava-trip-picker')).toBeNull();
});

it('preserves the server refusal in the connected flow, without success or retry', async () => {
  fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? response({ error: 'forbidden', message: 'You cannot share this object' }, 403)
    : response({ trips: [{ id: TRIP, ownerId: OWNER, title: 'Private journey' }] }));
  const view = await render(<ConnectedComposer />);
  await fireEvent.press(view.getByText('Add to message'));
  await fireEvent.press(view.getByTestId('telegraph-composer-entry-PORTAVA'));
  await view.findByText('Private journey');
  await fireEvent.press(view.getByTestId(`portava-trip-choice-${TRIP}`));
  await fireEvent.press(view.getByTestId('portava-trip-confirm'));
  await view.findByText('You cannot share this object');
  expect(reloaded).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each<ConversationProjectionState>([{ status: 'loading' }, { ...healthy, isE2ee: true }, { ...healthy, isE2ee: null }, { ...healthy, degraded: true }])('connected menu stays disabled when capabilities are %p', async projection => {
  const view = await render(<ConnectedComposer projection={projection} />);
  await fireEvent.press(view.getByText('Add to message'));
  await fireEvent.press(view.getByTestId('telegraph-composer-entry-PORTAVA'));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(view.queryByTestId('portava-trip-picker')).toBeNull();
  expect(view.getByTestId('telegraph-composer-reason-PORTAVA')).toBeTruthy();
});
