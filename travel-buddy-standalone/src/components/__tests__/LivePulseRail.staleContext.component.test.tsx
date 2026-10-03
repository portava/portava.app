/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B39): the Live Pulse rail never states the previous
 * city's live plans after the read for the city on screen failed, collapsed or not.
 *
 * useLivePulse kept `allItems` on a failed fetch ("the previously served cards stay on screen"), whatever context they
 * were read for. Expanded, the rail draws "Couldn't load live plans." instead of them; collapsed, its header drew
 * buildSummaryText(items) — the previous city's "1 tonight" — and nothing about the failure. Now the hook clears its items
 * (and what they could not read, and their session) when a read for a new context fails, and the collapsed header says
 * "Couldn't load live plans" whenever the latest read failed.
 *
 *   LR0 CONTROL: city A answers "1 tonight"; collapse; city B answers one "Starting Soon" → "1 starting soon"
 *   LR1 city A answers; collapse; city B's read FAILS → "Couldn't load live plans", never A's "1 tonight"
 *   LR2 collapsed, a refresh of the SAME city FAILS → the header says so, never the summary alone
 *   LR3 useLivePulse: the context changes and B's read FAILS → nothing of A's is left (items, unread, session)
 *   LR4 CONTROL: a refresh of the same city that answers keeps the header's summary
 *   LR5 CONTROL useLivePulse: a refresh of the SAME context fails → its cards (and session) stay, the error is set
 */
import React from 'react';
import { render, renderHook, act, waitFor, fireEvent } from '@testing-library/react-native';

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
import type { LivePulseItem } from '../../services/livePulse.ts';
import { useLivePulse } from '../../hooks/useLivePulse.ts';

const item = (id: string, title: string, status_label = 'Tonight'): LivePulseItem => ({
  id: `event:${id}`, item_type: 'event', item_id: id, status_label, title, subtitle: null, city: null,
  starts_at: null, ends_at: null, people_count: null, user_relationship: 'host', primary_action: null, secondary_action: null,
  reason_labels: [], expires_at: null, is_joinable: false,
} as LivePulseItem);
const ok = (items: LivePulseItem[]) => ({ ok: true, status: 200, json: async () => ({ items, sessionId: 's' }) });
const fail = () => ({ ok: false, status: 503, json: async () => ({ message: 'HTTP 503' }) });

beforeAll(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test'; });
afterEach(() => { delete (globalThis as any).fetch; });

let refreshRef: (() => void) | null = null;
function Harness({ city }: { city: string }) {
  const p = useLivePulse({ context: 'currentCity', citySlug: city }); refreshRef = p.refresh;
  return <LivePulseRail pulse={p} />;
}
async function collapsedOnA(answerFor: (city: string | null, n: number) => unknown) {
  let n = 0;
  (globalThis as any).fetch = jest.fn(async (url: string) => answerFor(new URL(url).searchParams.get('citySlug'), ++n));
  const ui = await render(<Harness city="a" />);
  await waitFor(() => expect(ui.queryByText('A quiz')).not.toBeNull());
  await act(async () => { fireEvent.press(ui.getByText('Live Pulse')); });
  await waitFor(() => expect(ui.queryByText('1 tonight')).not.toBeNull());
  return ui;
}
const settle = async () => { await act(async () => {}); await act(async () => {}); };

describe('census-discovery §122 (B39): the Live Pulse rail over a failed read', () => {
  it('LR0 CONTROL: B answers → "1 starting soon"', async () => {
    const ui = await collapsedOnA((c) => (c === 'a' ? ok([item('ea', 'A quiz')]) : ok([item('eb', 'B walk', 'Starting Soon')])));
    await act(async () => { ui.rerender(<Harness city="b" />); }); await settle();
    await waitFor(() => expect(ui.queryByText('1 starting soon')).not.toBeNull());
    expect(ui.queryByText('1 tonight')).toBeNull();
  });
  it('LR1 B FAILS → "Couldn\'t load live plans", never A\'s "1 tonight"', async () => {
    const ui = await collapsedOnA((c) => (c === 'a' ? ok([item('ea', 'A quiz')]) : fail()));
    await act(async () => { ui.rerender(<Harness city="b" />); }); await settle();
    await waitFor(() => expect(ui.queryByText("Couldn't load live plans")).not.toBeNull());
    expect(ui.queryByText('1 tonight')).toBeNull();
  });
  it('LR2 collapsed, a refresh of the same city FAILS → the header says so', async () => {
    const ui = await collapsedOnA((_c, n) => (n === 1 ? ok([item('ea', 'A quiz')]) : fail()));
    await act(async () => { refreshRef?.(); }); await settle();
    await waitFor(() => expect(ui.queryByText("Couldn't load live plans")).not.toBeNull());
    expect(ui.queryByText('1 tonight')).toBeNull();
  });
  it('LR4 CONTROL: a refresh of the same city that answers keeps the summary', async () => {
    const ui = await collapsedOnA(() => ok([item('ea', 'A quiz')]));
    await act(async () => { refreshRef?.(); }); await settle();
    expect(ui.queryByText('1 tonight')).not.toBeNull();
    expect(ui.queryByText("Couldn't load live plans")).toBeNull();
  });
  it("LR3 useLivePulse: the context changes and B's read FAILS → nothing of A's is left", async () => {
    let releaseB: (v: unknown) => void = () => {};
    const aAnswer = { ok: true, status: 200, json: async () => ({ items: [item('ea', 'A quiz')], sessionId: 's1', failedSources: ['safe_return_sessions'] }) };
    (globalThis as any).fetch = jest.fn((url: string) => (new URL(url).searchParams.get('citySlug') === 'a' ? Promise.resolve(aAnswer) : new Promise((r) => { releaseB = r; })));
    const { result, rerender } = await renderHook((p: { city: string }) => useLivePulse({ context: 'currentCity', citySlug: p.city }), { initialProps: { city: 'a' } });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['event:ea']));
    expect(result.current.unread).toEqual(['safe_return_sessions']);
    await act(async () => { rerender({ city: 'b' }); }); await settle();
    await act(async () => { releaseB(fail()); }); await settle();
    expect(result.current.items).toEqual([]);
    expect(result.current.unread).toEqual([]);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).not.toBeNull();
  });
  it('LR5 CONTROL useLivePulse: a refresh of the same context fails → its cards stay, the error is set', async () => {
    let n = 0;
    (globalThis as any).fetch = jest.fn(async () => (++n === 1 ? { ok: true, status: 200, json: async () => ({ items: [item('ea', 'A quiz')], sessionId: 's1' }) } : fail()));
    const { result } = await renderHook(() => useLivePulse({ context: 'currentCity', citySlug: 'a' }));
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(['event:ea']));
    await act(async () => { result.current.refresh(); }); await settle();
    expect(result.current.error).not.toBeNull();
    expect(result.current.items.map((i) => i.id)).toEqual(['event:ea']);
    expect(result.current.sessionId).toBe('s1');
  });
});
