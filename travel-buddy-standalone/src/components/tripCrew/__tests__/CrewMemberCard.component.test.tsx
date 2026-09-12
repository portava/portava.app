/**
 * CrewMemberCard — the freshness the server sends is what the row says
 * (Trips spec §10.2; census-trips TR166).
 *
 * Before §58 the badge read "Live" from `statusLabel === 'live_sharing_active'`
 * — the grant — so a member sharing over a three-hour-old fix was labelled
 * exactly like one whose fix was a minute old. The row now takes the server's
 * `freshnessClass`: "Live" only when it is LIVE / RECENT, "Sharing · last
 * known" otherwise, with the class and its age on a presence line and in the
 * accessibility label.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { CrewMemberCard } from '../CrewMemberCard.tsx';
import type { CrewMemberCard as Card } from '../../../services/tripCrewLocation.ts';

// NOTE: intentional stubs — the identity link and the overflow menu reach the
// auth client and the block service; neither is what this file tests.
jest.mock('../../interaction/UserIdentityLink.tsx', () => {
  const RN = jest.requireActual('react-native');
  return { UserIdentityLink: ({ children, style }: { children?: React.ReactNode; style?: unknown }) => <RN.View style={style}>{children}</RN.View> };
});
// NOTE: intentional stub — the overflow menu opens the block / report flow
// through the auth client; it renders nothing here so the card's own text is
// all the tree contains. It is the only export this test file touches.
jest.mock('../../interaction/UserOverflowMenu.tsx', () => ({ UserOverflowMenu: () => null }));
jest.mock('../../ui/Avatar.tsx', () => {
  const RN = jest.requireActual('react-native');
  return { Avatar: () => <RN.View testID="avatar" /> };
});

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function card(over: Partial<Card> = {}): Card {
  return {
    userId: 'u1', name: 'Mai', handle: 'mai', avatarUrl: null,
    statusLabel: 'live_sharing_active', areaLabel: 'Alfama, Lisbon',
    planCheckInStatus: null, safeReturnActive: false,
    liveShareActive: true, liveShareExpiresAt: null, ghostMode: false,
    updatedAt: ago(60_000),
    ...over,
  };
}

describe('CrewMemberCard says what the server said about the position', () => {
  it('a live share over a LIVE position: "Live sharing", the live dot, and the presence line with its age', async () => {
    await render(<CrewMemberCard member={card({ freshnessClass: 'LIVE', observedAt: ago(2 * 60_000) })} />);
    expect(screen.getByText('Live sharing')).toBeTruthy();
    expect(screen.getByTestId('crew-member-live-dot')).toBeTruthy();
    expect(screen.getByTestId('crew-member-presence-line').props.children).toBe('Live · 2m ago');
    expect(screen.getByLabelText('Mai, Live · 2m ago, Live sharing')).toBeTruthy();
  });

  it('the same share over a LAST_KNOWN position is NOT "Live": "Sharing · last known", no live dot, the age said', async () => {
    await render(<CrewMemberCard member={card({ freshnessClass: 'LAST_KNOWN', observedAt: ago(3 * 3600_000) })} />);
    expect(screen.getByText('Sharing · last known')).toBeTruthy();
    expect(screen.queryByText(/^Live/)).toBeNull();
    expect(screen.queryByTestId('crew-member-live-dot')).toBeNull();
    expect(screen.getByTestId('crew-member-presence-line').props.children).toBe('Last known · 3h ago');
    expect(screen.getByLabelText('Mai, Last known · 3h ago, Sharing · last known')).toBeTruthy();
    // §10.4: kept, with its area — a stale row is shown, not hidden.
    expect(screen.getByText('Alfama, Lisbon')).toBeTruthy();
  });

  it('a share with no class from the server is not called live either (fail closed)', async () => {
    await render(<CrewMemberCard member={card()} />);
    expect(screen.getByText('Sharing · last known')).toBeTruthy();
    expect(screen.queryByTestId('crew-member-live-dot')).toBeNull();
    expect(screen.queryByTestId('crew-member-presence-line')).toBeNull();
    expect(screen.getByLabelText('Mai, sharing location, position age unknown, Sharing · last known')).toBeTruthy();
  });

  it('a member who shares nothing has no presence line and no position claim', async () => {
    await render(<CrewMemberCard member={card({ statusLabel: 'not_shared', liveShareActive: false, areaLabel: null, freshnessClass: 'LIVE', observedAt: ago(1000) })} />);
    expect(screen.getByText('Not sharing')).toBeTruthy();
    expect(screen.queryByTestId('crew-member-presence-line')).toBeNull();
    expect(screen.getByLabelText('Mai, Not sharing')).toBeTruthy();
  });

  it('a blocked member is withheld whatever the server sent', async () => {
    await render(<CrewMemberCard member={card({ freshnessClass: 'LIVE', observedAt: ago(1000) })} isBlockedByViewer />);
    expect(screen.getByText('Location hidden')).toBeTruthy();
    expect(screen.queryByTestId('crew-member-presence-line')).toBeNull();
    expect(screen.queryByTestId('crew-member-live-dot')).toBeNull();
  });
});
