/**
 * census G303 on the client — a `share_entity` candidate ("Share Event: …") in
 * the Telegraph composer's action bar. Through the REAL bar, hook, parser and
 * `requestSuggestions`; only `fetch` and the confirm dialog are faked.
 *
 *   - the composer declares `share_entity` in its §48 handshake;
 *   - the chip is shown only when the screen can share (a target exists);
 *   - a tap asks the sender to confirm; only "Share" sends, through the §5
 *     share route with the event's id — nothing else is sent.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { MeetAtActionBar } from '../MeetAtActionBar.tsx';
import { confirmShareObject, sharedObjectName } from '../confirmShareObject.ts';
import { TELEGRAPH_COMPOSER_CAPABILITIES, parseMeetAtCandidates } from '../telegraphMeetAt.ts';

// NOTE: exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

const EVENT_ROW = {
  id: 'telegraph-action:share_event:0', type: 'action', context: 'telegraph_message', label: 'Share Event: Lantern Festival',
  source: 'canonical', policyVersion: 'v',
  action: { type: 'share_entity', entityType: 'event', entityId: 'ev-lantern' },
  structuredValue: { telegraphShare: 'event', kind: 'PORTAVA_OBJECT', objectType: 'EVENT', eligible: true, ineligibleReason: null, requires: null, draft: null },
};

let bodies: any[];
beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://portava.test';
  bodies = [];
  (global as any).fetch = jest.fn(async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ requestId: 'r', policyVersion: 'v', suggestions: [EVENT_ROW] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

test('SE1. the composer declares share_entity, and a share_entity row parses to an EVENT object (nothing else does)', () => {
  expect(TELEGRAPH_COMPOSER_CAPABILITIES.actionTypes).toContain('share_entity');
  const [c] = parseMeetAtCandidates([EVENT_ROW as any]);
  expect(c!.object).toEqual({ objectType: 'EVENT', objectId: 'ev-lantern' });
  // MUTATION: accept any entityType → a place share parses → RED.
  expect(parseMeetAtCandidates([{ ...EVENT_ROW, action: { type: 'share_entity', entityType: 'place', entityId: 'p' } } as any])).toEqual([]);
});

test('SE2. tapping "Share Event" hands the event to the screen; the request carried only the fragment', async () => {
  const onShareObject = jest.fn();
  await render(<MeetAtActionBar draft="see you, meet at the Lantern Festival" onPick={jest.fn()} onShareObject={onShareObject} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-telegraph-action:share_event:0')).toBeTruthy());
  expect(bodies[0].body.text).toBe('meet at the Lantern Festival');
  expect(bodies[0].body.client.actionTypes).toContain('share_entity');
  await fireEvent.press(screen.getByTestId('meet-at-telegraph-action:share_event:0'));
  expect(onShareObject).toHaveBeenCalledWith({ objectType: 'EVENT', objectId: 'ev-lantern' }, 'Share Event: Lantern Festival');
});

test('SE3. no share target on the screen → no event chip (never a dead chip)', async () => {
  await render(<MeetAtActionBar draft="meet at the Lantern Festival" onPick={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('meet-at-bar')).toBeTruthy());
  await new Promise((r) => setTimeout(r, 400));
  expect(screen.queryByTestId('meet-at-telegraph-action:share_event:0')).toBeNull();
});

test('SE4. the confirm: Cancel sends nothing; Share sends the event through the §5 route; a failure is said', async () => {
  const alert = jest.fn();
  const share = jest.fn(async () => ({ ok: true as const, data: { id: 'm', msgType: 'portava_object', subtype: 'EVENT' } }));
  confirmShareObject('thread-1', { objectType: 'EVENT', objectId: 'ev-lantern' }, 'Share Event: Lantern Festival', { alert, share } as any);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0][1]).toContain('Lantern Festival');
  const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
  expect(share).not.toHaveBeenCalled();
  // MUTATION: send before the confirm → `share` is called above → RED.
  buttons.find((b) => b.text === 'Share')!.onPress!();
  expect(share).toHaveBeenCalledWith('thread-1', 'EVENT', 'ev-lantern', null);
  const failing = jest.fn(async () => ({ ok: false as const, error: 'forbidden' }));
  const alert2 = jest.fn();
  confirmShareObject('thread-1', { objectType: 'EVENT', objectId: 'ev-lantern' }, 'Share Event: Lantern Festival', { alert: alert2, share: failing } as any);
  (alert2.mock.calls[0][2] as any[]).find((b) => b.text === 'Share').onPress();
  await new Promise((r) => setTimeout(r, 0));
  expect(alert2).toHaveBeenLastCalledWith('Couldn’t share', expect.any(String));
  expect(sharedObjectName('Share Event: Lantern Festival')).toBe('Lantern Festival');
});
