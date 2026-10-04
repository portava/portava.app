/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B46, probe RP1): the collapsed Live
 * Pulse rail never states a partial read as the whole.
 *
 * GET /api/pulse/live names every read it could not make (`failedSources`, the hook's `unread`). Expanded, the rail
 * says "Some live plans couldn't be loaded." beside the cards it could draw (§118, SW20). COLLAPSED, the header drew
 * only the count summary of those cards ("1 tonight"): the viewer's live plans, stated whole, over a read the server
 * said was not whole. With no cards and an unread read, the collapsed header said nothing. The header now says both.
 *
 *   RP1  collapsed, cards and `trip_members` unread → "1 tonight · some couldn't be loaded", never "1 tonight" alone
 *   RP2  collapsed, no cards and `blocks` unread → "Couldn't load live plans"
 *   RP0  CONTROL: collapsed, cards and nothing unread → "1 tonight" alone
 *   RP3  CONTROL: expanded, cards and an unread read → the cards and the expanded note; no collapsed line is drawn
 */
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';

// NOTE: intentional stub — the card's own actions are not under test here; the rail's statements are.
jest.mock('../LivePulseCard.tsx', () => ({
  LivePulseCard: ({ item }: { item: { title: string } }) => {
    const { Text } = require('react-native');
    return <Text>{item.title}</Text>;
  },
}));

import { LivePulseRail } from '../LivePulseRail.tsx';
import type { LivePulseItem } from '../../services/livePulse.ts';
import type { UseLivePulseResult } from '../../hooks/useLivePulse.ts';

const item = (id: string, title: string): LivePulseItem => ({
  id: `event:${id}`, item_type: 'event', item_id: id, status_label: 'Tonight', title, subtitle: null, city: null,
  starts_at: null, ends_at: null, people_count: null, user_relationship: 'host', primary_action: null, secondary_action: null,
  reason_labels: [], expires_at: null, is_joinable: false,
});
const pulse = (over: Partial<UseLivePulseResult>): UseLivePulseResult => ({
  items: [], loading: false, error: null, sessionId: null, refresh: jest.fn(), dismiss: jest.fn(), changeContext: jest.fn(), unread: [], ...over,
});
async function collapsed(over: Partial<UseLivePulseResult>) {
  const ui = await render(<LivePulseRail pulse={pulse(over)} />);
  await act(async () => { fireEvent.press(ui.getByText('Live Pulse')); });
  return ui;
}

describe('census-discovery §123 (B46): the collapsed Live Pulse rail over a partial read', () => {
  it('RP1 cards and an unread read → the summary says some could not be loaded', async () => {
    const ui = await collapsed({ items: [item('e1', 'Rooftop quiz')], unread: ['trip_members'] });
    expect(ui.queryByText("1 tonight · some couldn't be loaded")).not.toBeNull();
    expect(ui.queryByText('1 tonight')).toBeNull();
  });
  it('RP2 no cards and an unread read → "Couldn\'t load live plans"', async () => {
    const ui = await collapsed({ unread: ['blocks'] });
    expect(ui.queryByText("Couldn't load live plans")).not.toBeNull();
  });
  it('RP0 CONTROL: cards and nothing unread → the summary alone', async () => {
    const ui = await collapsed({ items: [item('e1', 'Rooftop quiz')] });
    expect(ui.queryByText('1 tonight')).not.toBeNull();
    expect(ui.queryByTestId('live-pulse-collapsed-summary')).not.toBeNull();
  });
  it('RP3 CONTROL: expanded → the cards and the expanded note, no collapsed line', async () => {
    const ui = await render(<LivePulseRail pulse={pulse({ items: [item('e1', 'Rooftop quiz')], unread: ['trip_members'] })} />);
    expect(ui.queryByText('Rooftop quiz')).not.toBeNull();
    expect(ui.queryByTestId('live-pulse-unread')).not.toBeNull();
    expect(ui.queryByTestId('live-pulse-collapsed-summary')).toBeNull();
  });
});
