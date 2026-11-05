import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { MomentFeedPanel, PendingContributionsPanel } from '../SharedMomentPanels.tsx';
import { loadSharedMomentFeed, listPendingSharedMomentContributions } from '../../../services/sharedMoments.ts';
jest.mock('../../../services/sharedMoments.ts', () => ({
  ...jest.requireActual('../../../services/sharedMoments.ts'), loadSharedMomentFeed: jest.fn(), listPendingSharedMomentContributions: jest.fn(),
}));
const item = { id: 'contribution', contributorId: 'owner', postId: 'post', mediaAssetId: null, mediaUrl: 'https://example.com/original.jpg', thumbnailUrl: 'https://example.com/thumb.jpg', caption: 'Arrival', createdAt: '2026-11-01T00:00:00Z' };
beforeEach(() => {
  jest.mocked(loadSharedMomentFeed).mockResolvedValue({ ok: true, data: { items: [item], nextCursor: null } });
  jest.mocked(listPendingSharedMomentContributions).mockResolvedValue({ ok: true, data: [{ ...item, mine: true }] });
});
it.each([false, true])('approved/pending contributions open originals and close in place (%s)', async pending => {
  await render(pending ? <PendingContributionsPanel momentId="moment" canManage={false} reloadKey={0} onApproved={jest.fn()} /> : <MomentFeedPanel momentId="moment" canManage={false} reloadKey={0} />);
  await fireEvent.press(screen.getByLabelText('View photo full screen')); expect(screen.getByTestId('fullscreen-photo-canvas')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Close full-screen photo')); expect(screen.queryByTestId('fullscreen-photo-canvas')).toBeNull(); expect(screen.getByText('Arrival')).toBeTruthy();
});
it('a contribution with a withheld original keeps its preview without a fullscreen action', async () => {
  jest.mocked(loadSharedMomentFeed).mockResolvedValue({ ok: true, data: { items: [{ ...item, mediaUrl: null }], nextCursor: null } });
  await render(<MomentFeedPanel momentId="moment" canManage={false} reloadKey={0} />);
  expect(screen.queryByLabelText('View photo full screen')).toBeNull(); expect(screen.getByText('Arrival')).toBeTruthy();
});
