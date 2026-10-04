/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B19): the co-host picker never says a
 * failed read of who is going as "nobody else is going yet".
 *
 * The picker draws its candidates from the event's `goingAttendees`. GET /events/:id names a failed going/maybe read
 * (`event_rsvps`) or profiles read (`profiles`) in `failedSources` beside an empty list.
 *
 *   CH1  the host, nobody listed, `failedSources: ["event_rsvps"]` → "Couldn't load who's going, so no one can be added
 *        right now."
 *   CH2  the same with `profiles` named → the same
 *   CH0  CONTROL: the host, nobody listed, every read whole → "Everyone going is already a co-host, or nobody else is going yet."
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

jest.mock('../../../services/events.ts', () => ({
  ...jest.requireActual('../../../services/events.ts'),
  getEventCohosts: jest.fn(async () => ({ ok: true, data: { cohosts: [] } })),
  addEventCohost: jest.fn(),
  removeEventCohost: jest.fn(),
}));

import { EventCohostsPanel } from '../EventCohostsPanel.tsx';

const UNREAD = "Couldn't load who's going, so no one can be added right now.";
const NOBODY = 'Everyone going is already a co-host, or nobody else is going yet.';
const ev = (failedSources?: string[]) => ({ id: 'e1', hostId: 'h1', isHost: true, myRole: 'host', goingAttendees: [], ...(failedSources ? { failedSources } : {}) }) as any;

async function shown(failedSources?: string[]) {
  const r = await render(<EventCohostsPanel event={ev(failedSources)} />);
  await waitFor(() => expect(r.queryByTestId('cohosts-list')).not.toBeNull());
  return r;
}

describe('census-discovery §117 (B19): the co-host picker over a failed going read', () => {
  it('CH1 event_rsvps named → "Couldn\'t load who\'s going…"', async () => {
    const r = await shown(['event_rsvps']);
    expect(r.getByText(UNREAD)).toBeTruthy();
    expect(r.queryByText(NOBODY)).toBeNull();
  });
  it('CH2 profiles named → the same', async () => {
    const r = await shown(['profiles']);
    expect(r.getByText(UNREAD)).toBeTruthy();
  });
  it('CH0 CONTROL: every read whole → "Everyone going is already a co-host…"', async () => {
    const r = await shown();
    expect(r.getByText(NOBODY)).toBeTruthy();
    expect(r.queryByText(UNREAD)).toBeNull();
  });
});
