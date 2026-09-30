/**
 * census-discovery §113 (DV-83 round 16 sweep, D-W11X2-137): the hashtag preview sheet never shows a failed follow
 * read as "Follow". GET /hashtags/:slug answers `isFollowing: null` over a failed read.
 *
 *   TP1  isFollowing null → "Can't check follow", never "Follow"
 *   TPc  CONTROL: false → "Follow"
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const mockGetHashtag = jest.fn();
jest.mock('../../services/hashtag.ts', () => ({
  ...jest.requireActual('../../services/hashtag.ts'),
  getHashtag: (...a: unknown[]) => mockGetHashtag(...(a as [])),
}));

import { TagPreviewSheet } from '../TagPreviewSheet.tsx';

const META = { id: 'ht-1', slug: 'romejazz', name: 'romejazz', usageCount: 3, isFollowing: false, topCity: null, createdAt: '2026-09-01T00:00:00Z' };
const sheet = () => <TagPreviewSheet visible type={'hashtag' as never} id="romejazz" onClose={() => {}} onNavigate={() => {}} />;

describe('TagPreviewSheet — the follow state over a failed read (§113, D-W11X2-137)', () => {
  it("TP1 isFollowing null → \"Can't check follow\", never \"Follow\"", async () => {
    mockGetHashtag.mockResolvedValue({ ok: true, data: { ...META, isFollowing: null } });
    const view = await render(sheet());
    await waitFor(() => expect(view.queryByText("Can't check follow")).not.toBeNull());
    expect(view.queryByText('Follow')).toBeNull();
  });
  it('TPc CONTROL: false → "Follow"', async () => {
    mockGetHashtag.mockResolvedValue({ ok: true, data: META });
    const view = await render(sheet());
    await waitFor(() => expect(view.queryByText('Follow')).not.toBeNull());
  });
});
