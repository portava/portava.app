/**
 * Telegraph §11.2 row 5 across an absence — census-telegraph T264.
 *
 *   "Critical plan change -> Temporary promoted change card until acknowledged."
 *
 * §45c (T264 C → W): "a moved start is detected only between two fetches while the rail stays
 * mounted (detectCriticalChanges returns nothing on a first load), so a change made while the
 * member was away is never shown." The rail now keeps what this ACCOUNT last saw in this
 * conversation on this device (railSeenStore.ts) and a first load compares against it.
 *
 * WHAT IS EXERCISED: the real SharedContextRail, the real railBehavior decisions and the real
 * railSeenStore over jest's in-memory AsyncStorage; only the network read (api.ts) is stubbed.
 * Each case unmounts and remounts the rail, which is what "came back later" is.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../../lib/supabase.ts';

let mockSessionUserId = 'acct-1';
jest.mock('../../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockSessionUserId }),
}));
jest.mock('../../../services/auth.ts', () => ({
  ...jest.requireActual('../../../services/auth.ts'), onAuthChange: () => () => {},
}));

// NOTE: intentional stub — the real api module imports lib/supabase, which builds a client at
// import time and fails outside an Expo runtime. Every rail DECISION still runs in railBehavior.
jest.mock('../sharedContext/api.ts', () => ({
  fetchSharedContext: jest.fn(),
  fetchConversationHeader: jest.fn(),
}));

// NOTE: intentional stub — AccessibilityInfo is not backed in the jest preset's native layer.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({
  useReducedMotionSetting: jest.fn(() => false),
}));

import { SharedContextRail } from '../sharedContext/SharedContextRail.tsx';
import { fetchSharedContext } from '../sharedContext/api.ts';
import { railSeenKey, clearRailSeenForUser } from '../sharedContext/railSeenStore.ts';
import { detectChangesSinceSeen, nextSeenSnapshot, seenSnapshotFrom, withCancellations } from '../sharedContext/railBehavior.ts';
import { _setTestAccountId } from '../../../services/accountId.ts';
import type { SharedContextItem, SharedContextResponse } from '../sharedContext/types.ts';

const mockedFetch = fetchSharedContext as jest.MockedFunction<typeof fetchSharedContext>;

const THREAD = 'thread-1';
const ACCT = 'acct-1';
const T1 = '2026-05-10T19:00:00.000Z';
const T2 = '2026-05-10T21:30:00.000Z';

function plan(over: Partial<SharedContextItem> = {}): SharedContextItem {
  return {
    objectType: 'MEETUP', objectId: 'p1', title: 'Dinner at Bao', relationship: 'BOTH_PARTICIPANTS',
    status: 'active', availableActions: ['JOIN_PLAN'], orderBand: 'UPCOMING', startsAt: T1, ...over,
  };
}

function served(p: SharedContextItem): SharedContextResponse {
  return {
    sharedContext: { conversationId: THREAD, generatedAt: '2026-05-10T06:00:00.000Z', now: [], upcoming: [p], unresolved: [], past: [] },
    railMode: 'COMPACT_UPCOMING', collapsedSummary: '', incomplete: false, refusedCount: 0,
  };
}

async function storeSeen(account: string, items: Record<string, { status: string | null; startsAt: string | null }>) {
  await AsyncStorage.setItem(railSeenKey(THREAD, account), JSON.stringify({ v: 1, items }));
}

async function readSeen(account = ACCT) {
  const raw = await AsyncStorage.getItem(railSeenKey(THREAD, account));
  return raw ? JSON.parse(raw).items : null;
}

/** Mount, let the load settle (the rail renders), and hand back the unmount. */
async function openConversation() {
  const r = await render(<SharedContextRail threadId={THREAD} />);
  await screen.findByTestId('telegraph-shared-context-rail');
  return r;
}

beforeEach(async () => {
  mockedFetch.mockReset();
  await AsyncStorage.clear();
  _setTestAccountId(ACCT);
  mockSessionUserId = ACCT;
});

afterAll(async () => {
  _setTestAccountId(undefined);
  await supabase.auth.stopAutoRefresh();
});

describe('T264 — a plan changed while the member was away is promoted when they come back', () => {
  it('a FIRST visit promotes nothing (nothing was seen) and records what was shown', async () => {
    mockedFetch.mockResolvedValue({ ok: true, data: served(plan()) });
    await openConversation();
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
    await waitFor(async () => expect(await readSeen()).toEqual({ p1: { status: 'active', startsAt: T1 } }));
  });

  it('a start moved while away: the change card is up on the FIRST load after return', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: served(plan({ startsAt: T2 })) });
    await openConversation();
    const card = await screen.findByTestId('telegraph-rail-change-card');
    expect(card.props.accessibilityLabel).toContain('Dinner at Bao');
  });

  it('a plan called off while away is promoted the same way', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: served(plan({ status: 'cancelled' })) });
    await openConversation();
    expect(await screen.findByTestId('telegraph-rail-change-card')).toBeTruthy();
  });

  it('until ACKNOWLEDGED the change survives another absence; once acknowledged it is not promoted again', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: served(plan({ startsAt: T2 })) });

    const first = await openConversation();
    await screen.findByTestId('telegraph-rail-change-card');
    await waitFor(async () => expect(await readSeen()).toEqual({ p1: { status: 'active', startsAt: T1 } }));
    await first.unmount();

    const second = await openConversation(); // came back again without dismissing it
    await screen.findByTestId('telegraph-rail-change-card');
    await fireEvent.press(screen.getByLabelText('Acknowledge change'));
    await waitFor(async () => expect(await readSeen()).toEqual({ p1: { status: 'active', startsAt: T2 } }));
    await second.unmount();

    await openConversation();
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  });

  it('an UNREADABLE record promotes nothing and is not written over (it is not "never seen")', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    // jest maps AsyncStorage to its in-memory mock; its functions are jest.fn()s, so one read is made to fail
    // with a one-shot implementation and the writes are counted, rather than re-spied (a restored spy on a
    // jest.fn would strip the mock's own implementation for every later case).
    const getItem = AsyncStorage.getItem as unknown as jest.Mock;
    const setItem = AsyncStorage.setItem as unknown as jest.Mock;
    getItem.mockImplementationOnce(() => Promise.reject(new Error('storage unavailable')));
    const writesBefore = setItem.mock.calls.length;
    mockedFetch.mockResolvedValue({ ok: true, data: served(plan({ startsAt: T2 })) });
    await openConversation();
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
    expect(setItem.mock.calls.length).toBe(writesBefore);
    expect(await readSeen()).toEqual({ p1: { status: 'active', startsAt: T1 } });
  });

  it('another account on the same device reads nothing of the first one', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    _setTestAccountId('acct-2');
    mockSessionUserId = 'acct-2';
    mockedFetch.mockResolvedValue({ ok: true, data: served(plan({ startsAt: T2 })) });
    await openConversation();
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  });

  it('sign-out removes every rail record of that account, and only that account', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    await storeSeen('acct-2', { p1: { status: 'active', startsAt: T1 } });
    await clearRailSeenForUser(ACCT);
    expect(await readSeen(ACCT)).toBeNull();
    expect(await readSeen('acct-2')).not.toBeNull();
  });

  it('the session sign-out runs that sweep for the outgoing account (source level: SessionContext is not mounted here)', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const src: string = readFileSync(join(__dirname, '../../../context/SessionContext.tsx'), 'utf8');
    const signOut = src.slice(src.indexOf('const signOut = useCallback(async () => {'));
    expect(signOut.slice(0, 1200)).toContain('void clearRailSeenForUser(userId).catch(() => {});');
  });
});

describe('T264 — the decisions, pure', () => {
  const current = served(plan({ startsAt: T2 })).sharedContext;

  it('detectChangesSinceSeen: none without a record; a moved start against one', () => {
    expect(detectChangesSinceSeen(null, current)).toEqual([]);
    const found = detectChangesSinceSeen({ p1: { status: 'active', startsAt: T1 } }, current);
    expect(found.map((c) => [c.objectId, c.reason])).toEqual([['p1', 'TIME_CHANGED']]);
  });

  it('nextSeenSnapshot keeps the old value of a pending change and takes the new one once acknowledged', () => {
    const seen = { p1: { status: 'active', startsAt: T1 }, gone: { status: 'active', startsAt: T1 } };
    const found = detectChangesSinceSeen(seen, current);
    expect(nextSeenSnapshot(seen, current, found, [])).toEqual({ p1: { status: 'active', startsAt: T1 } });
    expect(nextSeenSnapshot(seen, current, found, [found[0]!.changeKey])).toEqual(seenSnapshotFrom(current));
  });
});

// ── census-telegraph T264: a shared EVENT called off while the member was away ─────────────────
//
// The server withholds a cancelled event from everyone but its host, so the rail no longer HOLDS it
// and there is no item whose status can change. What reaches an attendee instead is a notice beside
// the projection — `cancellations: [{ objectType: 'EVENT', objectId, status: 'cancelled' }]` — and
// the rail promotes it against what this account last saw. The device record keeps no title (by
// design: railSeenStore stores status and start only), and the notice carries none, so the change
// is named as the member saw it in this mount, or as "A shared event you were going to".
describe('T264 — an event called off while away is promoted from its cancellation notice', () => {
  const NOTICE = { objectType: 'EVENT', objectId: 'e1', status: 'cancelled' };
  const withNotices = (cancellations: unknown): SharedContextResponse =>
    ({ ...served(plan()), cancellations } as unknown as SharedContextResponse);

  it('promoted on the FIRST load back, with no title the device or the notice never held', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 }, e1: { status: 'open', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: withNotices([NOTICE]) });
    await openConversation();
    const card = await screen.findByTestId('telegraph-rail-change-card');
    expect(card.props.accessibilityLabel).toBe('Cancelled: A shared event you were going to');
  });

  it('until ACKNOWLEDGED it survives another absence; acknowledged, the record lets the event go and it is not promoted again', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 }, e1: { status: 'open', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: withNotices([NOTICE]) });

    const first = await openConversation();
    await screen.findByTestId('telegraph-rail-change-card');
    await waitFor(async () => expect(await readSeen()).toEqual({ p1: { status: 'active', startsAt: T1 }, e1: { status: 'open', startsAt: T1 } }));
    await first.unmount();

    const second = await openConversation();
    await screen.findByTestId('telegraph-rail-change-card');
    await fireEvent.press(screen.getByLabelText('Acknowledge change'));
    await waitFor(async () => expect(await readSeen()).toEqual({ p1: { status: 'active', startsAt: T1 } }));
    await second.unmount();

    await openConversation(); // the notice still arrives; the member has seen it
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  });

  it('a notice about something this member never saw here promotes nothing', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: withNotices([NOTICE]) });
    await openConversation();
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  });

  it('a malformed or non-cancellation notice is not a change', async () => {
    await storeSeen(ACCT, { p1: { status: 'active', startsAt: T1 }, e1: { status: 'open', startsAt: T1 } });
    mockedFetch.mockResolvedValue({ ok: true, data: withNotices([{ objectType: 'EVENT', objectId: 'e1', status: 'deleted' }, 'e1', null, { objectId: 7, status: 'cancelled' }]) });
    await openConversation();
    expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  });
});

describe('T264 — withCancellations, pure', () => {
  const current = served(plan()).sharedContext;
  const NOTICE = { objectType: 'EVENT', objectId: 'e1', status: 'cancelled' };

  it('against the device record: a CANCELLED change for a seen, live object; nothing for an unseen or already-cancelled one', () => {
    const found = withCancellations([], { e1: { status: 'open', startsAt: T1 } }, null, [NOTICE]);
    expect(found).toEqual([{ objectId: 'e1', title: 'A shared event you were going to', changeKey: 'e1:status:cancelled', reason: 'CANCELLED', startsAt: T1 }]);
    expect(withCancellations([], { p1: { status: 'active', startsAt: T1 } }, null, [NOTICE])).toEqual([]);
    expect(withCancellations([], { e1: { status: 'cancelled', startsAt: T1 } }, null, [NOTICE])).toEqual([]);
  });

  it('within one mount (no record): named by the title this mount showed', () => {
    const shown = { ...current, upcoming: [plan({ objectType: 'EVENT', objectId: 'e1', title: 'Rooftop music', status: 'open' })] };
    const found = withCancellations([], null, shown, [NOTICE]);
    expect(found.map((c) => [c.objectId, c.title, c.reason])).toEqual([['e1', 'Rooftop music', 'CANCELLED']]);
  });

  it('keeps what was already found, and does not add a second card for the same change', () => {
    const already = detectChangesSinceSeen({ p1: { status: 'active', startsAt: T1 } }, served(plan({ startsAt: T2 })).sharedContext);
    const found = withCancellations(already, { p1: { status: 'active', startsAt: T1 }, e1: { status: 'open', startsAt: null } }, null, [NOTICE, NOTICE]);
    expect(found.map((c) => c.changeKey)).toEqual([already[0]!.changeKey, 'e1:status:cancelled']);
  });

  it('no notices, or not an array: exactly what was found', () => {
    const already = detectChangesSinceSeen({ p1: { status: 'active', startsAt: T1 } }, served(plan({ startsAt: T2 })).sharedContext);
    expect(withCancellations(already, { e1: { status: 'open', startsAt: T1 } }, null, undefined)).toBe(already);
    expect(withCancellations(already, { e1: { status: 'open', startsAt: T1 } }, null, { e1: 'cancelled' })).toBe(already);
  });
});
