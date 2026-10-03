/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; sweep SW20, the client half): the Live Pulse rail says a section
 * the server could not read, and draws only the answer to the context on screen.
 *
 * GET /api/pulse/live now names every read it could not make in `failedSources` (an unread block state empties the rail,
 * fail-closed, and names `blocks`). The client dropped the field, so an empty rail over a failed read said "No live
 * plans right now", and a rail missing a section said nothing. `getLivePulseItems` now returns `failedSources`,
 * `useLivePulse` exposes it as `unread`, and the rail says "Couldn't load live plans." over an empty rail with an unread
 * read and "Some live plans couldn't be loaded." beside the cards it could draw. `useLivePulse` also kept no request
 * token, so an answer for the previous context that landed last was drawn under the new one.
 *
 *   LV0  CONTROL: cards and no unread read → the cards, no note
 *   LV1  no cards, `blocks` unread → "Couldn't load live plans.", never "No live plans right now"
 *   LV2  cards, `trip_members` unread → the cards and "Some live plans couldn't be loaded."
 *   LV3  getLivePulseItems carries `failedSources` through; a healthy body has none
 *   LV4  useLivePulse exposes the server's unread reads
 *   LV5  useLivePulse: the previous context's answer lands after the new one's → the new context's cards stay
 */
import React from 'react';
import { render, renderHook, act, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — the card's own actions are not under test here; the rail's statements are.
jest.mock('../LivePulseCard.tsx', () => ({
  LivePulseCard: ({ item }: { item: { title: string } }) => {
    const { Text } = require('react-native');
    return <Text>{item.title}</Text>;
  },
}));

// NOTE: intentionally exhaustive — apiToken exposes a single async helper; a stable token reaches fetch.
jest.mock('../../services/apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'tok'),
}));

import { LivePulseRail } from '../LivePulseRail.tsx';
import { getLivePulseItems, type LivePulseItem } from '../../services/livePulse.ts';
import { useLivePulse, type UseLivePulseResult } from '../../hooks/useLivePulse.ts';

const item = (id: string, title: string): LivePulseItem => ({
  id: `event:${id}`, item_type: 'event', item_id: id, status_label: 'Tonight', title, subtitle: null, city: null,
  starts_at: null, ends_at: null, people_count: null, user_relationship: 'host', primary_action: null, secondary_action: null,
  reason_labels: [], expires_at: null, is_joinable: false,
});
const pulse = (over: Partial<UseLivePulseResult>): UseLivePulseResult => ({
  items: [], loading: false, error: null, sessionId: null, refresh: jest.fn(), dismiss: jest.fn(), changeContext: jest.fn(), unread: [], ...over,
});

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterEach(() => { delete (globalThis as any).fetch; });

describe('census-discovery §118 (SW20): the Live Pulse rail says what the server could not read', () => {
  it('LV0 CONTROL: cards and nothing unread → the cards, no note', async () => {
    const ui = await render(<LivePulseRail pulse={pulse({ items: [item('e1', 'Rooftop quiz')] })} />);
    expect(ui.queryByText('Rooftop quiz')).not.toBeNull();
    expect(ui.queryByTestId('live-pulse-unread')).toBeNull();
  });
  it('LV1 no cards, blocks unread → "Couldn\'t load live plans.", never "No live plans right now"', async () => {
    const ui = await render(<LivePulseRail pulse={pulse({ unread: ['blocks'] })} />);
    expect(ui.queryByText('No live plans right now')).toBeNull();
    expect(ui.queryByText("Couldn't load live plans.")).not.toBeNull();
  });
  it('LV2 cards, trip_members unread → the cards and a note', async () => {
    const ui = await render(<LivePulseRail pulse={pulse({ items: [item('e1', 'Rooftop quiz')], unread: ['trip_members'] })} />);
    expect(ui.queryByText('Rooftop quiz')).not.toBeNull();
    expect(ui.queryByTestId('live-pulse-unread')).not.toBeNull();
  });
  it('LV3 getLivePulseItems carries failedSources through; a healthy body has none', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], sessionId: 's1', failedSources: ['blocks'] }) }));
    const bad = await getLivePulseItems({});
    expect(bad).toEqual({ ok: true, items: [], sessionId: 's1', failedSources: ['blocks'] });
    (globalThis as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [], sessionId: 's1' }) }));
    expect(await getLivePulseItems({})).toEqual({ ok: true, items: [], sessionId: 's1', failedSources: [] });
  });
  it('LV4 useLivePulse exposes the unread reads', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [item('e1', 'Rooftop quiz')], failedSources: ['events'] }) }));
    const { result } = await renderHook(() => useLivePulse({ context: 'myPlans' }));
    await waitFor(() => expect(result.current.items.length).toBe(1));
    expect(result.current.unread).toEqual(['events']);
  });
  it('LV5 the previous context\'s answer lands after the new one\'s → the new context\'s cards stay', async () => {
    const held: Array<{ ctx: string | null; release: () => void }> = [];
    (globalThis as any).fetch = jest.fn((url: string) => new Promise((res) => {
      const ctx = new URL(url).searchParams.get('context');
      held.push({ ctx, release: () => res({ ok: true, status: 200, json: async () => ({ items: [item(`e-${ctx}`, `card for ${ctx}`)] }) }) });
    }));
    const { result, rerender } = await renderHook((p: { context: 'myPlans' | 'currentCity' }) => useLivePulse({ context: p.context }), { initialProps: { context: 'myPlans' } });
    await waitFor(() => expect(held.length).toBe(1));
    await act(async () => { await rerender({ context: 'currentCity' }); });
    await waitFor(() => expect(held.length).toBe(2));
    await act(async () => { held.find((h) => h.ctx === 'currentCity')!.release(); });
    await act(async () => { held.find((h) => h.ctx === 'myPlans')!.release(); });
    await act(async () => {});
    expect(result.current.items.map((i) => i.title)).toEqual(['card for currentCity']);
  });
});
