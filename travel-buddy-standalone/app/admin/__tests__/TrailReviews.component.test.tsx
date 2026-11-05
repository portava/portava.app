import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import TrailReviewsScreen from '../trail-reviews.tsx';

let mockAdmin = true;
let mockEpoch = 1;
let mockFocused = true;
const mockRead = jest.fn();
const mockDecide = jest.fn();
// NOTE: The queue is tested at the admin/session and transport boundaries; native auth is not constructed.
jest.mock('../../../src/hooks/useRequireAdmin.ts', () => ({ useRequireAdmin: () => false }));
jest.mock('../../../src/context/SessionContext.tsx', () => ({ useSession: () => ({ isAuthed: true, role: mockAdmin ? 'admin' : 'user' }) }));
jest.mock('../../../src/platform/input-assistance/hooks/useInputAccountEpoch.ts', () => ({ useInputAccountEpoch: () => mockEpoch }));
jest.mock('../../../src/services/trailReviewsAdmin.ts', () => ({ getPendingTrailReviews: (...a: unknown[]) => mockRead(...a), decidePendingTrailReview: (...a: unknown[]) => mockDecide(...a) }));
jest.mock('@react-navigation/native', () => ({ ...jest.requireActual('@react-navigation/native'), useIsFocused: () => mockFocused }));
jest.mock('react-native-safe-area-context', () => ({ ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const first = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Quiet gardens', description: 'A walk through local gardens.', destination: 'Lisbon', createdAt: '2026-11-05T09:00:00Z', lifecycle: 'proposed' };
beforeEach(() => {
  mockAdmin = true; mockEpoch = 1; mockFocused = true;
  mockRead.mockReset().mockResolvedValue({ trails: [first], next: null });
  mockDecide.mockReset().mockResolvedValue({ id: first.id, reviewState: 'approved' });
});
it('does not expose or fetch the queue to a non-admin', async () => {
  mockAdmin = false;
  const ui = await render(<TrailReviewsScreen />);
  expect(mockRead).not.toHaveBeenCalled(); expect(ui.queryByText('Quiet gardens')).toBeNull();
});
it('distinguishes a failed queue from an empty queue and retries', async () => {
  mockRead.mockRejectedValueOnce(new Error('Queue unavailable')).mockResolvedValueOnce({ trails: [], next: null });
  const ui = await render(<TrailReviewsScreen />);
  expect(ui.queryByText('No pending Trails in this page.')).toBeNull();
  await fireEvent.press(await ui.findByLabelText('Try again'));
  await ui.findByText('No pending Trails in this page.');
});
it('requires an explicit confirmation and keeps the row until the decision succeeds', async () => {
  let finish!: () => void;
  mockDecide.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const ui = await render(<TrailReviewsScreen />);
  await fireEvent.press(await ui.findByLabelText('Approve Quiet gardens'));
  expect(mockDecide).not.toHaveBeenCalled();
  await fireEvent.press(ui.getByLabelText('Confirm decision'));
  expect(ui.getByText('Quiet gardens')).toBeTruthy();
  await fireEvent.press(ui.getByLabelText('Saving decision…'));
  expect(mockDecide).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  await ui.findByText('Trail approved.');
  expect(ui.queryByText('Quiet gardens')).toBeNull();
});
it('requires a rejection reason and preserves it after a failed decision', async () => {
  mockDecide.mockRejectedValueOnce(new Error('Not confirmed'));
  const ui = await render(<TrailReviewsScreen />);
  await fireEvent.press(await ui.findByLabelText('Reject Quiet gardens'));
  await fireEvent.press(ui.getByLabelText('Confirm decision'));
  expect(mockDecide).not.toHaveBeenCalled();
  await fireEvent.changeText(ui.getByLabelText('Rejection reason'), 'Please clarify the route.');
  await fireEvent.press(ui.getByLabelText('Confirm decision'));
  await ui.findByText('Not confirmed');
  expect(ui.getByLabelText('Rejection reason').props.value).toBe('Please clarify the route.');
  expect(ui.getByText('Quiet gardens')).toBeTruthy();
});
it('appends another page and does not erase existing results on a page failure', async () => {
  const next = { createdAt: first.createdAt, id: first.id };
  mockRead.mockResolvedValueOnce({ trails: [first], next }).mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ trails: [{ ...first, id: 'second', title: 'Harbor walk' }], next: null });
  const ui = await render(<TrailReviewsScreen />);
  await fireEvent.press(await ui.findByLabelText('Load more Trails'));
  await ui.findByText('Offline');
  expect(ui.getByText('Quiet gardens')).toBeTruthy();
  await fireEvent.press(ui.getByLabelText('Load more Trails'));
  await ui.findByText('Harbor walk');
  expect(ui.getByText('Quiet gardens')).toBeTruthy();
  expect(mockRead.mock.calls[1][1]).toEqual(next);
});
it('aborts old account reads and ignores their eventual result', async () => {
  let finish!: (value: unknown) => void;
  mockRead.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ trails: [], next: null });
  const ui = await render(<TrailReviewsScreen />);
  mockEpoch = 2; await ui.rerender(<TrailReviewsScreen />);
  expect(mockRead.mock.calls[0][0].aborted).toBe(true);
  await act(async () => { finish({ trails: [first], next: null }); });
  expect(ui.queryByText('Quiet gardens')).toBeNull();
});
it('aborts a pending decision on blur and never announces its stale success', async () => {
  let finish!: () => void;
  mockDecide.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const ui = await render(<TrailReviewsScreen />);
  await fireEvent.press(await ui.findByLabelText('Approve Quiet gardens'));
  await fireEvent.press(ui.getByLabelText('Confirm decision'));
  mockFocused = false; await ui.rerender(<TrailReviewsScreen />);
  expect(mockDecide.mock.calls[0][3].aborted).toBe(true);
  await act(async () => { finish(); });
  expect(ui.queryByText('Trail approved.')).toBeNull();
});
