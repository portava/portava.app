/**
 * Telegraph §2.3 NOW / §15.2 — census T12 (re-verification R2, 2026-10-06).
 *
 * THE DEFECT. A current SAFETY message leaves the stream for the NOW strip.
 * The stream is where a group conversation says who sent a message; the strip
 * carried no sender at all, and the safety bar's title said "Someone asked for
 * help". In a group, for as long as the message is NOW (up to an hour), nobody
 * on the screen could see WHO asked for help.
 *
 * Pinned here: the strip names the sender of a safety item with what the
 * stream already carries for that sender (their name and handle, or "You" for
 * the viewer's own) — nothing is looked up; the bar names who raised the mode
 * the same way; where the screen has no name for that person, both say
 * "Someone" rather than inventing one; and the screen wires both.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: intentional stub — coordinationApi reaches lib/supabase at import time.
jest.mock('../coordination/coordinationApi.ts', () => ({
  ...jest.requireActual('../coordination/coordinationApi.ts'),
  respondToAction: jest.fn(),
  acknowledgeAnnouncement: jest.fn(),
}));
// NOTE: intentional stub — layersApi reaches lib/supabase at import time; the
// partition helpers are the real ones.
jest.mock('../layers/layersApi.ts', () => ({ ...jest.requireActual('../layers/layersApi.ts'), fetchLayers: jest.fn() }));
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ useReducedMotionSetting: jest.fn(() => false) }));
// NOTE: intentional stub — kindsApi reaches lib/supabase at import time.
jest.mock('../kinds/kindsApi.ts', () => ({
  ...jest.requireActual('../kinds/kindsApi.ts'),
  sendTypedMessage: jest.fn(),
  fetchDrawer: jest.fn(),
  searchThread: jest.fn(),
}));
// NOTE: intentional stub — safetyModeApi reaches lib/supabase at import time;
// the mode predicates are the real ones.
jest.mock('../safety/safetyModeApi.ts', () => ({ ...jest.requireActual('../safety/safetyModeApi.ts'), fetchSafetyMode: jest.fn() }));
// NOTE: intentional stub — both sheets reach services that build a Supabase
// client at import time.
jest.mock('../../../components/safeReturn/EmergencyHelpSheet.tsx', () => ({ EmergencyHelpSheet: () => null }));
jest.mock('../../../components/safeReturn/SafeReturnSetupSheet.tsx', () => ({ SafeReturnSetupSheet: () => null }));

import { SemanticLayersStrip, senderLabelFor, type LayerMessage } from '../layers/SemanticLayersStrip.tsx';
import { SafetyModeBar } from '../safety/SafetyModeBar.tsx';
import type { LayersResponse } from '../layers/layersApi.ts';
import type { SafetyModeResponse } from '../safety/safetyModeApi.ts';

const helpBody = JSON.stringify({ kind: 'SAFETY', envelopeVersion: '1', payload: { kind: 'need_help', label: 'I need help' } });
const nina: LayerMessage = { id: 's1', senderId: 'nina-uuid', senderName: 'Nina', senderHandle: 'nina', msgType: 'safety', body: helpBody };

function nowLayer(senderId: string): LayersResponse {
  return {
    threadId: 't1', plan: [], talk: [], partitioned: true,
    now: [{ messageId: 's1', senderId, createdAt: 'x', layer: 'NOW', kind: 'SAFETY', title: 'I need help', openReason: null, nowReason: 'safety' }],
  };
}

function mode(over: Partial<SafetyModeResponse> = {}): SafetyModeResponse {
  return {
    threadId: 't1', generatedAt: 'x', mode: 'SAFETY_EVENT', since: 'x', raisedBy: 'nina-uuid', clearedAt: null,
    reason: 'Somebody in this conversation asked for help and no ALL CLEAR has been posted.',
    affordances: { promoted: ['CURRENT_STATUS'], deprioritized: ['ENTERTAINMENT'] },
    derivedFrom: 'THREAD_SAFETY_SIGNALS_ONLY',
    ...over,
  };
}

describe('R2: the NOW strip says WHO asked for help', () => {
  it('the verifier’s probe: the safety message leaves the stream, and the strip names its sender', async () => {
    const ids: string[][] = [];
    await render(
      <SemanticLayersStrip threadId="t1" viewerId="me" messages={[nina]} onLayeredIdsChange={(s) => ids.push([...s])} initialResponse={nowLayer('nina-uuid')} />,
    );
    expect(ids[ids.length - 1]).toEqual(['s1']);
    expect(screen.getByTestId('telegraph-layer-sender-s1')).toBeTruthy();
    expect(screen.getByText('Nina @nina')).toBeTruthy();
  });

  it('the viewer’s own call for help reads "You"', async () => {
    const mine = { ...nina, senderId: 'me', senderName: 'Me Myself', senderHandle: 'me' };
    await render(<SemanticLayersStrip threadId="t1" viewerId="me" messages={[mine]} initialResponse={nowLayer('me')} />);
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByText(/Me Myself/)).toBeNull();
  });

  it('a sender the screen has no name for is "Someone" — nothing is invented or looked up', async () => {
    const nameless = { ...nina, senderName: null, senderHandle: null };
    await render(<SemanticLayersStrip threadId="t1" viewerId="me" messages={[nameless]} initialResponse={nowLayer('nina-uuid')} />);
    expect(screen.getByText('Someone')).toBeTruthy();
    expect(screen.queryByText(/nina-uuid/)).toBeNull();
  });

  it('senderLabelFor: the stream’s own name and handle, "You" for the viewer, null when unknown', () => {
    const plain: LayerMessage = { id: 'x', senderId: 'bob', senderName: 'Bob', senderHandle: null };
    expect(senderLabelFor([nina, plain], 'nina-uuid', 'me')).toBe('Nina @nina');
    expect(senderLabelFor([nina, plain], 'bob', 'me')).toBe('Bob');
    expect(senderLabelFor([nina], 'me', 'me')).toBe('You');
    expect(senderLabelFor([nina], 'carol', 'me')).toBeNull();
    expect(senderLabelFor([nina], null, 'me')).toBeNull();
  });
});

describe('R2: the safety bar names who raised the mode', () => {
  it('"Nina @nina asked for help" — from the label the screen resolves for raisedBy', async () => {
    const label = jest.fn((uid: string) => (uid === 'nina-uuid' ? 'Nina @nina' : null));
    await render(<SafetyModeBar threadId="t1" initialResponse={mode()} senderLabel={label} />);
    expect(screen.getByText('Nina @nina asked for help')).toBeTruthy();
    expect(label).toHaveBeenCalledWith('nina-uuid');
  });

  it('a heads-up names who raised it too', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={mode({ mode: 'SAFETY_ATTENTION' })} senderLabel={() => 'Nina @nina'} />);
    expect(screen.getByText('Safety heads-up from Nina @nina')).toBeTruthy();
  });

  it('the viewer’s own: "You asked for help"', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={mode({ raisedBy: 'me' })} senderLabel={(uid) => (uid === 'me' ? 'You' : null)} />);
    expect(screen.getByText('You asked for help')).toBeTruthy();
  });

  it('no name on this screen for the raiser: "Someone asked for help", as before', async () => {
    await render(<SafetyModeBar threadId="t1" initialResponse={mode()} senderLabel={() => null} />);
    expect(screen.getByText('Someone asked for help')).toBeTruthy();
  });
});

describe('the conversation screen hands both the stream’s sender names', () => {
  // Source-level: app/messages/[id].tsx cannot be mounted under jest-expo (§41.7).
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const dm: string = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  const bar = dm.split('\n').find((l) => l.includes('<SafetyModeBar ')) ?? '';
  const strip = dm.split('\n').find((l) => l.includes('<SemanticLayersStrip ')) ?? '';
  it('the bar resolves raisedBy against the loaded messages; the strip is handed the loaded messages', () => {
    expect(bar).toContain('senderLabel={(uid) => senderLabelFor(messages, uid, userId ?? null)}');
    expect(strip).toMatch(/<SemanticLayersStrip [^>]*messages=\{messages\}/);
  });
});
