/**
 * census-telegraph T417 (batch 2) — §30A.12 bounded acknowledgement, on the client.
 *
 * In a LARGE_GROUP the server serves `acknowledgedBy` as a SAMPLE (at most 20 names, always holding the
 * viewer's own confirmation) and the exact count as `acknowledgedCount`. The hook used to count the
 * sample, so 30 confirmations read as 20.
 *
 * Pins:
 *   - a bounded roster: the count is the server's exact count, never the sample's length;
 *   - an unbounded roster (no acknowledgedCount): the count is the list, exactly as before;
 *   - the viewer's own confirmation is read from the sample the server guarantees holds it.
 *
 * MUTANT CA1 the hook counts the sample again ..................................... red
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import { renderHook, waitFor } from '@testing-library/react-native';

jest.mock('../coordination/coordinationApi.ts', () => {
  const actual = jest.requireActual('../coordination/coordinationApi.ts');
  return { ...actual, fetchAnnouncements: jest.fn() };
});

import { fetchAnnouncements, type AnnouncementAcknowledgementView } from '../coordination/coordinationApi.ts';
import { _resetAnnouncementCache, useAnnouncementAcknowledgement } from '../kinds/useAnnouncementAcknowledgement.ts';

const mocked = fetchAnnouncements as jest.MockedFunction<typeof fetchAnnouncements>;
const T = 'thread-big';
const ANN = 'ann-1';
const ME = 'user-30';
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ userId: `user-${i + 1}`, at: '2026-05-01T00:00:00.000Z', note: null }));

function answer(row: Partial<AnnouncementAcknowledgementView>) {
  mocked.mockResolvedValue({
    ok: true,
    data: {
      threadId: T,
      derivedFrom: 'ACKNOWLEDGEMENT_MESSAGES_ONLY',
      rosterKnown: true,
      scanned: 31,
      announcements: [{ messageId: ANN, announcedBy: 'host', createdAt: '2026-05-01T00:00:00.000Z', title: 'Bus at 8', requiresAcknowledgement: true, acknowledgedBy: [], outstanding: null, complete: false, ...row }],
    },
  });
}

beforeEach(() => {
  mocked.mockReset();
  _resetAnnouncementCache();
});

describe('useAnnouncementAcknowledgement — a bounded roster (T417)', () => {
  it('the count is the server\'s exact count, not the sample', async () => {
    // The server's sample: the viewer first, then 19 others; 30 confirmed in all.
    answer({ acknowledgedBy: [{ userId: ME, at: '2026-05-01T00:39:00.000Z', note: null }, ...people(19)], acknowledgedCount: 30, outstandingCount: 30, rosterBounded: true });
    const { result } = await renderHook(() => useAnnouncementAcknowledgement({ threadId: T, messageId: ANN, viewerId: ME, enabled: true }));
    await waitFor(() => expect(result.current.acknowledgedCount).toBe(30));
    expect(result.current.acknowledged).toBe(true);
  });

  it('an unbounded roster counts its list, exactly as before', async () => {
    answer({ acknowledgedBy: people(7) });
    const { result } = await renderHook(() => useAnnouncementAcknowledgement({ threadId: T, messageId: ANN, viewerId: ME, enabled: true }));
    await waitFor(() => expect(result.current.acknowledgedCount).toBe(7));
    expect(result.current.acknowledged).toBe(false);
  });
});
