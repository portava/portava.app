/**
 * Telegraph §2.3 / §2.2 — census T11 (re-verification R1, 2026-10-06).
 *
 * THE DEFECT. The strip takes EVERY loaded PLAN item out of the stream, but it
 * drew no DECISION or COMMITMENT itself — "the coordination panel draws them".
 * The panel read once, when the screen opened, and drew nothing at all when
 * that read failed. So a decision posted while the conversation was open left
 * the stream and was drawn NOWHERE until the person left and came back; and a
 * failed panel read hid every open decision silently.
 *
 * Pinned here, on the screen's own composition (panel + strip + stream, wired
 * the way app/messages/[id].tsx wires them):
 *   - the panel re-reads on the same key the strip and the safety bar use (the
 *     newest message id), so a live decision reaches it with its vote chips;
 *   - the panel tells the screen which decisions/commitments it is drawing, and
 *     the strip draws — as one line — any PLAN item it hides that the panel is
 *     NOT drawing: never nowhere, never twice, including in the moment between
 *     the strip's read and the panel's;
 *   - a failed panel read SAYS so, and the open decision is still drawn;
 *   - the verifier's own probe composition (the panel given no refresh key and
 *     the strip told nothing about the panel) draws the decision too.
 */
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { render, screen, waitFor, act } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: intentional stub — coordinationApi reaches lib/supabase at import time;
// the labels and affordance table are the real ones.
jest.mock('../coordination/coordinationApi.ts', () => {
  const actual = jest.requireActual('../coordination/coordinationApi.ts');
  return { ...actual, fetchCoordination: jest.fn(), postVote: jest.fn(), respondToAction: jest.fn(), acknowledgeAnnouncement: jest.fn() };
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
// NOTE: intentional stub — the maps hand-off opens a native app.
jest.mock('../../../lib/maps.ts', () => ({ openMapsNavigation: jest.fn() }));
// NOTE: intentional stub — the Safe Return sheet pulls the location stack.
jest.mock('../../../components/safeReturn/SafeReturnSetupSheet.tsx', () => ({ SafeReturnSetupSheet: () => null }));

import { CoordinationPanel } from '../coordination/CoordinationPanel.tsx';
import { SemanticLayersStrip, type LayerMessage } from '../layers/SemanticLayersStrip.tsx';
import { fetchCoordination, type CoordinationResponse, type CoordinationResult } from '../coordination/coordinationApi.ts';
import { fetchLayers, type LayerItemView, type LayersResult } from '../layers/layersApi.ts';

const mockedCoordination = fetchCoordination as jest.MockedFunction<typeof fetchCoordination>;
type Read = CoordinationResult<CoordinationResponse>;
const mockedLayers = fetchLayers as jest.MockedFunction<typeof fetchLayers>;

const coord = (decisions: unknown[]): Read => ({
  ok: true,
  data: {
    coordination: {
      threadId: 't1', generatedAt: 'x', plan: null, state: null, coordinating: false, legalNext: [], quickStates: [],
      arrivedCount: 0, onMyWayCount: 0, decisions, commitments: [], rendezvous: [],
    },
    stateProvenance: 'DERIVED_FROM_PLAN_TIMELINE',
    scanned: 1,
  },
} as unknown as Read);
const DEC = {
  decisionId: 'd1', askedBy: 'nina', question: 'Which bar?', options: [{ id: 'a', label: 'Bar A' }],
  resolutionRule: 'majority', deadlineAt: null, votes: [], tally: {}, resolved: false, result: null, reason: '',
};
const decisionItem: LayerItemView = {
  messageId: 'd1', senderId: 'nina', createdAt: 'x', layer: 'PLAN', kind: 'DECISION', title: 'Which bar?',
  openReason: 'decision_open', nowReason: null,
};
const layers = (plan: LayerItemView[]): LayersResult => ({ ok: true, data: { threadId: 't1', plan, now: [], talk: [], partitioned: true } });

const m1: LayerMessage = { id: 'm1', senderId: 'nina', msgType: 'text', body: 'hi' };
const d1: LayerMessage = { id: 'd1', senderId: 'nina', msgType: 'decision', body: 'Which bar?' };

/** app/messages/[id].tsx's composition: one refresh key for both, the panel's drawn ids handed to the strip. */
function Screen({ messages }: { messages: LayerMessage[] }) {
  const [layered, setLayered] = useState<ReadonlySet<string>>(() => new Set());
  const [panelIds, setPanelIds] = useState<ReadonlySet<string>>(() => new Set());
  const newest = messages[messages.length - 1]?.id ?? null;
  const stream = layered.size > 0 ? messages.filter((m) => !layered.has(m.id)) : messages;
  return (
    <View>
      <CoordinationPanel threadId="t1" viewerId="me" refreshKey={newest} onDrawnIdsChange={setPanelIds} />
      <SemanticLayersStrip threadId="t1" viewerId="me" messages={messages} refreshKey={newest} panelDrawnIds={panelIds} onLayeredIdsChange={setLayered} />
      {stream.map((m) => <Text key={m.id} testID={`stream-${m.id}`}>{m.body}</Text>)}
    </View>
  );
}

/** The verifier's probe composition: the panel with no refresh key, the strip told nothing about the panel. */
function ProbeScreen({ messages }: { messages: LayerMessage[] }) {
  const [layered, setLayered] = useState<ReadonlySet<string>>(() => new Set());
  const stream = layered.size > 0 ? messages.filter((m) => !layered.has(m.id)) : messages;
  return (
    <View>
      <CoordinationPanel threadId="t1" viewerId="me" />
      <SemanticLayersStrip threadId="t1" viewerId="me" messages={messages} refreshKey={messages[messages.length - 1]?.id ?? null} onLayeredIdsChange={setLayered} />
      {stream.map((m) => <Text key={m.id} testID={`stream-${m.id}`}>{m.body}</Text>)}
    </View>
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockedCoordination.mockReset();
  mockedLayers.mockReset();
  await AsyncStorage.clear();
});

describe('R1: a decision posted while the conversation is open is drawn, without re-entry', () => {
  it('the panel re-reads on the newest message and draws the decision with its vote chips — once', async () => {
    mockedCoordination.mockResolvedValueOnce(coord([]));
    mockedLayers.mockResolvedValueOnce(layers([]));
    const { rerender } = await render(<Screen messages={[m1]} />);
    await waitFor(() => expect(mockedLayers).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedCoordination).toHaveBeenCalledTimes(1));

    // Nina posts a decision; realtime appends it to the stream.
    mockedCoordination.mockResolvedValue(coord([DEC]));
    mockedLayers.mockResolvedValue(layers([decisionItem]));
    await rerender(<Screen messages={[m1, d1]} />);

    await waitFor(() => expect(mockedCoordination).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('telegraph-decision-d1')).toBeTruthy();
    expect(screen.getByTestId('telegraph-decision-option-d1-a')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('stream-d1')).toBeNull());
    // Drawn by the panel, so not by the strip: exactly one "Which bar?" on screen.
    await waitFor(() => expect(screen.queryByTestId('telegraph-layer-item-d1')).toBeNull());
    expect(screen.getAllByText(/Which bar\?/)).toHaveLength(1);
  });

  it('between the strip’s read and the panel’s, the strip draws it — never nowhere, never twice', async () => {
    mockedCoordination.mockResolvedValueOnce(coord([]));
    mockedLayers.mockResolvedValueOnce(layers([]));
    const { rerender } = await render(<Screen messages={[m1]} />);
    await waitFor(() => expect(mockedCoordination).toHaveBeenCalledTimes(1));

    let release: (r: Read) => void = () => {};
    mockedCoordination.mockImplementationOnce(() => new Promise<Read>((r) => { release = r; }));
    mockedLayers.mockResolvedValue(layers([decisionItem]));
    await rerender(<Screen messages={[m1, d1]} />);

    // The panel is still on its old answer: the strip draws the decision it hid.
    expect(await screen.findByTestId('telegraph-layer-item-d1')).toBeTruthy();
    expect(screen.queryByTestId('stream-d1')).toBeNull();
    expect(screen.getAllByText(/Which bar\?/)).toHaveLength(1);

    // The panel's answer lands: the panel draws it, the strip stops.
    await act(async () => { release(coord([DEC])); });
    expect(await screen.findByTestId('telegraph-decision-d1')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('telegraph-layer-item-d1')).toBeNull());
    expect(screen.getAllByText(/Which bar\?/)).toHaveLength(1);
  });

  it('a decision that RESOLVES leaves the panel and comes back to the stream', async () => {
    mockedCoordination.mockResolvedValueOnce(coord([DEC]));
    mockedLayers.mockResolvedValueOnce(layers([decisionItem]));
    const { rerender } = await render(<Screen messages={[m1, d1]} />);
    expect(await screen.findByTestId('telegraph-decision-d1')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('stream-d1')).toBeNull());

    const vote: LayerMessage = { id: 'v1', senderId: 'me', msgType: 'coordination', body: '{}' };
    mockedCoordination.mockResolvedValue(coord([{ ...DEC, resolved: true, result: 'a' }]));
    mockedLayers.mockResolvedValue(layers([]));
    await rerender(<Screen messages={[m1, d1, vote]} />);
    await waitFor(() => expect(screen.queryByTestId('telegraph-decision-d1')).toBeNull());
    expect(await screen.findByTestId('stream-d1')).toBeTruthy();
  });
});

describe('R1: a failed panel read says so, and hides no decision', () => {
  it('the panel says it could not load, and the strip draws the open decision it took out of the stream', async () => {
    mockedCoordination.mockResolvedValue({ ok: false, error: 'db_error' });
    mockedLayers.mockResolvedValue(layers([decisionItem]));
    await render(<Screen messages={[m1, d1]} />);
    expect(await screen.findByTestId('telegraph-coordination-failed')).toBeTruthy();
    expect(screen.queryByTestId('telegraph-coordination-panel')).toBeNull();
    expect(await screen.findByTestId('telegraph-layer-item-d1')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('stream-d1')).toBeNull());
    expect(screen.getAllByText(/Which bar\?/)).toHaveLength(1);
  });

  it('a REFRESH that fails says so too — and the decision the panel stops drawing is drawn by the strip', async () => {
    mockedCoordination.mockResolvedValueOnce(coord([DEC]));
    mockedLayers.mockResolvedValue(layers([decisionItem]));
    const { rerender } = await render(<Screen messages={[m1, d1]} />);
    expect(await screen.findByTestId('telegraph-decision-d1')).toBeTruthy();

    mockedCoordination.mockResolvedValue({ ok: false, error: 'network' });
    const later: LayerMessage = { id: 'm2', senderId: 'nina', msgType: 'text', body: 'anyone?' };
    await rerender(<Screen messages={[m1, d1, later]} />);
    expect(await screen.findByTestId('telegraph-coordination-failed')).toBeTruthy();
    expect(await screen.findByTestId('telegraph-layer-item-d1')).toBeTruthy();
    expect(screen.getAllByText(/Which bar\?/)).toHaveLength(1);
  });
});

describe('R1: the verifier’s probe composition', () => {
  it('a DECISION posted after the screen opened is visible somewhere (panel, strip or stream)', async () => {
    mockedCoordination.mockResolvedValueOnce(coord([]));
    mockedLayers.mockResolvedValueOnce(layers([]));
    const { rerender } = await render(<ProbeScreen messages={[m1]} />);
    await waitFor(() => expect(mockedLayers).toHaveBeenCalledTimes(1));
    mockedCoordination.mockResolvedValue(coord([DEC]));
    mockedLayers.mockResolvedValueOnce(layers([decisionItem]));
    await rerender(<ProbeScreen messages={[m1, d1]} />);
    await waitFor(() => expect(mockedLayers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('stream-d1')).toBeNull());
    expect(screen.queryByText(/Which bar\?/)).toBeTruthy();
  });

  it('the coordination read FAILS while the layers read succeeds: the open decision is visible somewhere', async () => {
    mockedCoordination.mockResolvedValue({ ok: false, error: 'db_error' });
    mockedLayers.mockResolvedValue(layers([decisionItem]));
    await render(<ProbeScreen messages={[d1]} />);
    await waitFor(() => expect(mockedLayers).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('stream-d1')).toBeNull());
    expect(screen.queryByText(/Which bar\?/)).toBeTruthy();
  });
});

describe('the conversation screen wires the panel and the strip together', () => {
  // Source-level: app/messages/[id].tsx cannot be mounted under jest-expo (§41.7).
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const dm: string = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  /** One JSX element's attributes: from `<Name ` to its self-closing `/>` (arrow bodies hold `>`, never `/>`). */
  const element = (name: string): string => {
    const line = dm.split('\n').find((l) => l.includes(`<${name} `)) ?? '';
    const at = line.indexOf(`<${name} `);
    return at < 0 ? '' : line.slice(at, line.indexOf('/>', at));
  };
  it('the panel re-reads on the newest message id and tells the screen what it draws; the strip is told', () => {
    const panel = element('CoordinationPanel');
    const strip = element('SemanticLayersStrip');
    expect(panel).toContain('refreshKey={messages[messages.length - 1]?.id ?? null}');
    expect(panel).toContain('onDrawnIdsChange={setPanelDrawnIds}');
    expect(strip).toContain('panelDrawnIds={panelDrawnIds}');
    expect(dm).toContain('const [panelDrawnIds, setPanelDrawnIds] = useState<ReadonlySet<string>>(() => new Set());');
  });
});
