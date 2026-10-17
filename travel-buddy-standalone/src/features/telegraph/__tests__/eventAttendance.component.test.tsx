import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SharedContextRail } from '../sharedContext/SharedContextRail.tsx';
import { fetchSharedContext } from '../sharedContext/api.ts';
import type { SharedContextResponse } from '../sharedContext/types.ts';
import { railSeenKey } from '../sharedContext/railSeenStore.ts';
import { _setTestAccountId } from '../../../services/accountId.ts';
import { supabase } from '../../../lib/supabase.ts';

jest.mock('../../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: 'viewer' }),
}));
jest.mock('../../../services/auth.ts', () => ({
  ...jest.requireActual('../../../services/auth.ts'), onAuthChange: () => () => {},
}));

jest.mock('../sharedContext/api.ts', () => ({ ...jest.requireActual('../sharedContext/api.ts'), fetchSharedContext: jest.fn() }));
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ ...jest.requireActual('../../wall/hooks/useReducedMotionSetting.ts'), useReducedMotionSetting: () => false }));

beforeEach(async () => {
  await AsyncStorage.clear();
  _setTestAccountId('viewer');
  (fetchSharedContext as jest.Mock).mockReset();
});

afterAll(async () => { _setTestAccountId(undefined); await supabase.auth.stopAutoRefresh(); });

const response = (attendance: unknown): SharedContextResponse => ({
  sharedContext: {
    conversationId: 'thread', generatedAt: '2026-10-16T12:00:00Z', now: [], unresolved: [], past: [],
    upcoming: [{ objectType: 'EVENT', objectId: 'event', title: 'Rooftop music', status: 'open', relationship: 'BOTH_PARTICIPANTS', availableActions: ['MEET_HERE'], orderBand: 'UPCOMING', eventAttendance: attendance } as any],
  },
  railMode: 'COMPACT_UPCOMING', collapsedSummary: '', incomplete: false, refusedCount: 0,
});

it('renders permission-safe Going identities on the actual fetched event card and its accessible label', async () => {
  (fetchSharedContext as jest.Mock).mockResolvedValue({ ok: true, data: response([{ userId: 'viewer', label: 'You' }, { userId: 'member', label: '@member' }]) });
  await render(<SharedContextRail threadId="thread" />);
  expect(await screen.findByText('Going from this conversation: You, @member')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Upcoming: Rooftop music. Going from this conversation: You, @member' })).toBeTruthy();
});

it('distinguishes a known empty Going set from unavailable attendance', async () => {
  await render(<SharedContextRail threadId="thread" initialResponse={response([])} />);
  expect(screen.getByText('No visible Going members from this conversation')).toBeTruthy();
});

for (const attendance of [null, undefined]) {
  it(`does not invent attendance for ${String(attendance)} (including an older server)`, async () => {
    await render(<SharedContextRail threadId="thread" initialResponse={response(attendance)} />);
    expect(screen.getByText('Attendance unavailable')).toBeTruthy();
    expect(screen.queryByText('No visible Going members from this conversation')).toBeNull();
  });
}

for (const attendance of [{ label: 'Cached name' }, [{ userId: 'member', label: null }], [{ userId: '', label: 'Cached name' }]]) {
  it(`withholds malformed attendance ${JSON.stringify(attendance)}`, async () => {
    await render(<SharedContextRail threadId="thread" initialResponse={response(attendance)} />);
    expect(screen.getByText('Attendance unavailable')).toBeTruthy();
    expect(screen.queryByText(/Cached name/)).toBeNull();
  });
}

it('does not add event attendance to other object families', async () => {
  const data = response([{ userId: 'member', label: '@member' }]);
  data.sharedContext.upcoming[0].objectType = 'TRIP';
  await render(<SharedContextRail threadId="thread" initialResponse={data} />);
  expect(screen.queryByText(/Going from this conversation/)).toBeNull();
  expect(screen.queryByText('Attendance unavailable')).toBeNull();
});

for (const change of ['time', 'cancelled']) {
  it(`preserves event ${change} changes across absence, until acknowledged, without caching attendee identities`, async () => {
    const before = '2026-10-16T18:00:00Z';
    const after = change === 'time' ? '2026-10-16T20:00:00Z' : before;
    const status = change === 'cancelled' ? 'cancelled' : 'open';
    const key = railSeenKey('thread', 'viewer');
    await AsyncStorage.setItem(key, JSON.stringify({ v: 1, items: { event: { status: 'open', startsAt: before } } }));
    const data = response(change === 'cancelled' ? null : [{ userId: 'member', label: '@member' }]);
    Object.assign(data.sharedContext.upcoming[0], { startsAt: after, status });
    (fetchSharedContext as jest.Mock).mockResolvedValue({ ok: true, data });
    await render(<SharedContextRail threadId="thread" />);
    const label = change === 'time' ? 'Time changed' : 'Cancelled';
    const changeCard = await screen.findByTestId('telegraph-rail-change-card');
    expect(changeCard.props.accessibilityLabel).toBe(`${label}: Rooftop music`);
    expect(changeCard.props.accessibilityRole).toBe('alert');
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge change' }));
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
    await waitFor(async () => {
      expect(JSON.parse((await AsyncStorage.getItem(key))!)).toEqual({ v: 1, items: { event: { status, startsAt: after } } });
    });
  });
}

it('renders the server live-event band alongside attendance', async () => {
  const data = response([{ userId: 'member', label: '@member' }]);
  const event = data.sharedContext.upcoming[0];
  event.orderBand = 'HAPPENING_NOW';
  event.status = 'started';
  data.sharedContext.now = [event];
  data.sharedContext.upcoming = [];
  data.railMode = 'EXPANDED_NOW';
  await render(<SharedContextRail threadId="thread" initialResponse={data} />);
  expect(screen.getByText('Happening now')).toBeTruthy();
  expect(screen.getByText('Going from this conversation: @member')).toBeTruthy();
});
