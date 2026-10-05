/**
 * Telegraph §2.3 — census T11 / T12: the PLAN and NOW layers are DRAWN above
 * the conversation, and what they draw leaves the stream.
 *
 * Pinned: the strip draws the server's partition (NOW newest, OPEN = unresolved
 * PLAN); a §6.2 typed message is drawn by the same renderer the stream uses and
 * its controls WORK here (ACTION Confirm/Decline answer it, ANNOUNCEMENT "Got it"
 * acknowledges it); a coordination proposal gets Confirm/Decline; the panel's
 * kinds (DECISION, COMMITMENT) are not drawn twice; the screen is told exactly
 * the loaded ids it drew; a failed read draws nothing and hides nothing.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — coordinationApi reaches lib/supabase at import time.
jest.mock('../coordination/coordinationApi.ts', () => {
  const actual = jest.requireActual('../coordination/coordinationApi.ts');
  return {
    ...actual,
    respondToAction: jest.fn(async () => ({ ok: true, data: { id: 'r1' } })),
    acknowledgeAnnouncement: jest.fn(async () => ({ ok: true, data: { id: 'k1' } })),
  };
});
// NOTE: intentional stub — layersApi reaches lib/supabase at import time; the
// partition helpers are the real ones.
jest.mock('../layers/layersApi.ts', () => {
  const actual = jest.requireActual('../layers/layersApi.ts');
  return { ...actual, fetchLayers: jest.fn() };
});
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ useReducedMotionSetting: jest.fn(() => false) }));
// NOTE: intentional stub — kindsApi reaches lib/supabase at import time.
jest.mock('../kinds/kindsApi.ts', () => {
  const actual = jest.requireActual('../kinds/kindsApi.ts');
  return { ...actual, sendTypedMessage: jest.fn(), fetchDrawer: jest.fn(), searchThread: jest.fn() };
});

import { SemanticLayersStrip, type LayerMessage } from '../layers/SemanticLayersStrip.tsx';
import { fetchLayers, layeredStreamIds, type LayersResponse, type LayerItemView } from '../layers/layersApi.ts';
import { acknowledgeAnnouncement, respondToAction } from '../coordination/coordinationApi.ts';

const mockedFetch = fetchLayers as jest.MockedFunction<typeof fetchLayers>;
const mockedRespond = respondToAction as jest.MockedFunction<typeof respondToAction>;
const mockedAck = acknowledgeAnnouncement as jest.MockedFunction<typeof acknowledgeAnnouncement>;

const ME = 'me';
const BOB = 'bob';
const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: '1', payload });

const messages: LayerMessage[] = [
  { id: 'safety-1', senderId: BOB, msgType: 'safety', body: env('SAFETY', { kind: 'need_help', label: 'Lost near the pier' }) },
  { id: 'action-1', senderId: BOB, msgType: 'action', body: env('ACTION', { action: 'JOIN_PLAN', title: 'Join dinner' }) },
  { id: 'ann-1', senderId: BOB, msgType: 'announcement', body: env('ANNOUNCEMENT', { title: 'Bus at 9', requiresAcknowledgement: true }) },
  { id: 'prop-1', senderId: BOB, msgType: 'action_proposal', body: '{}' },
  { id: 'dec-1', senderId: BOB, msgType: 'decision', body: '{}' },
  { id: 'q-1', senderId: BOB, msgType: 'coordination', body: '{}' },
  { id: 'talk-1', senderId: BOB, msgType: 'text', body: 'hi' },
];

const item = (over: Partial<LayerItemView> & { messageId: string }): LayerItemView => ({
  senderId: BOB, createdAt: 'x', layer: 'PLAN', kind: 'ACTION', title: null, openReason: null, nowReason: null, ...over,
});

function layers(over: Partial<LayersResponse> = {}): LayersResponse {
  return {
    threadId: 't1',
    partitioned: true,
    now: [
      item({ messageId: 'safety-1', layer: 'NOW', kind: 'SAFETY', title: 'Lost near the pier', nowReason: 'safety' }),
      item({ messageId: 'q-1', layer: 'NOW', kind: 'COORDINATION', title: null, nowReason: 'declared_status' }),
    ],
    plan: [
      item({ messageId: 'action-1', kind: 'ACTION', title: 'Join dinner', openReason: 'action_unanswered' }),
      item({ messageId: 'ann-1', kind: 'ANNOUNCEMENT', title: 'Bus at 9', openReason: 'acknowledgement_pending' }),
      item({ messageId: 'prop-1', kind: 'ACTION_PROPOSAL', title: 'Split a taxi', openReason: 'action_unanswered' }),
      item({ messageId: 'dec-1', kind: 'DECISION', title: 'Which bar?', openReason: 'decision_open' }),
      item({ messageId: 'not-loaded', kind: 'ACTION_PROPOSAL', title: 'Older proposal', openReason: 'action_unanswered' }),
    ],
    talk: ['talk-1'],
    ...over,
  };
}

beforeEach(() => jest.clearAllMocks());

describe('the layers are drawn, and what they draw leaves the stream', () => {
  it('NOW and OPEN are drawn; the typed SAFETY message by the stream’s own renderer', async () => {
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} />);
    expect(screen.getByTestId('telegraph-layer-now')).toBeTruthy();
    expect(screen.getByTestId('telegraph-layer-plan')).toBeTruthy();
    expect(screen.getByTestId('telegraph-kind-safety')).toBeTruthy();
    expect(screen.getByText('Split a taxi')).toBeTruthy();
  });

  it('the screen is told exactly the LOADED ids it drew — incl. the panel’s DECISION, never an unloaded one', async () => {
    const onIds = jest.fn();
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} onLayeredIdsChange={onIds} />);
    const ids = [...(onIds.mock.calls.at(-1)![0] as Set<string>)].sort();
    expect(ids).toEqual(['action-1', 'ann-1', 'dec-1', 'prop-1', 'q-1', 'safety-1']);
  });

  it('a DECISION is not drawn twice — the coordination panel draws it with its vote chips', async () => {
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} />);
    expect(screen.queryByTestId('telegraph-layer-item-dec-1')).toBeNull();
  });
});

describe('controls work in the layer (T11: ACTION Confirm no longer refuses)', () => {
  it('ACTION Confirm and Decline answer the action', async () => {
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} />);
    await fireEvent.press(screen.getByTestId('telegraph-kind-action-confirm'));
    expect(mockedRespond).toHaveBeenLastCalledWith('t1', 'action-1', 'CONFIRMED');
    await fireEvent.press(screen.getByTestId('telegraph-layer-decline-action-1'));
    expect(mockedRespond).toHaveBeenLastCalledWith('t1', 'action-1', 'DECLINED');
    expect(screen.queryByText('Confirmation is not available on this screen')).toBeNull();
  });

  it('a coordination proposal gets Confirm and Decline', async () => {
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} />);
    await fireEvent.press(screen.getByTestId('telegraph-layer-confirm-prop-1'));
    expect(mockedRespond).toHaveBeenLastCalledWith('t1', 'prop-1', 'CONFIRMED');
  });

  it('an ANNOUNCEMENT waiting on me is acknowledged from the layer', async () => {
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} />);
    await fireEvent.press(screen.getByTestId('telegraph-kind-announcement-ack'));
    expect(mockedAck).toHaveBeenCalledWith('t1', 'ann-1');
  });

  it('my OWN proposal offers me no Confirm', async () => {
    const own = messages.map((m) => (m.id === 'prop-1' ? { ...m, senderId: ME } : m));
    const l = layers({ plan: [item({ messageId: 'prop-1', senderId: ME, kind: 'ACTION_PROPOSAL', title: 'Split a taxi', openReason: 'action_unanswered' })] });
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={own} initialResponse={l} />);
    expect(screen.queryByTestId('telegraph-layer-confirm-prop-1')).toBeNull();
  });

  it('an answer that could not be saved SAYS so', async () => {
    mockedRespond.mockResolvedValueOnce({ ok: false, error: 'forbidden', message: 'Not allowed here.' });
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} initialResponse={layers()} />);
    await fireEvent.press(screen.getByTestId('telegraph-layer-confirm-prop-1'));
    expect(screen.getByText('Not allowed here.')).toBeTruthy();
  });
});

describe('a failed read draws nothing and hides nothing', () => {
  it('fetch failure → no strip, and the screen is told the empty set', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: false, error: '503' });
    const onIds = jest.fn();
    await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} refreshKey="m1" onLayeredIdsChange={onIds} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(screen.queryByTestId('telegraph-semantic-layers')).toBeNull();
    expect((onIds.mock.calls.at(-1)![0] as Set<string>).size).toBe(0);
  });

  it('a REFRESH that fails drops the stale partition — the stream gets everything back', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, data: layers() });
    const onIds = jest.fn();
    const { rerender } = await render(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} refreshKey="m1" onLayeredIdsChange={onIds} />);
    expect(await screen.findByTestId('telegraph-semantic-layers')).toBeTruthy();
    mockedFetch.mockResolvedValueOnce({ ok: false, error: '503' });
    await rerender(<SemanticLayersStrip threadId="t1" viewerId={ME} messages={messages} refreshKey="m2" onLayeredIdsChange={onIds} />);
    await waitFor(() => expect(screen.queryByTestId('telegraph-semantic-layers')).toBeNull());
    expect((onIds.mock.calls.at(-1)![0] as Set<string>).size).toBe(0);
  });

  it('layeredStreamIds: null layers hide nothing; unloaded ids hide nothing', () => {
    expect(layeredStreamIds(null, new Set(['a'])).size).toBe(0);
    expect([...layeredStreamIds(layers(), new Set(['safety-1']))]).toEqual(['safety-1']);
  });
});

describe('the conversation screen takes the drawn ids out of the stream', () => {
  // Source-level: app/messages/[id].tsx cannot be mounted under jest-expo (§41.7).
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const dm: string = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('the list is built from the stream minus the layered ids, and re-built when they change', () => {
    expect(dm).toContain('const stream = layeredIds.size > 0 ? messages.filter((x) => !layeredIds.has(x.id)) : messages;');
    expect(dm).toContain('for (let i = 0; i < stream.length; i++) {');
    expect(dm).toContain('}, [messages, layeredIds]);');
    expect(dm).toContain('onLayeredIdsChange={setLayeredIds}');
  });
});
