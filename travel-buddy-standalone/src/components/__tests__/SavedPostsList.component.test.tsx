/**
 * Saved posts on the Saved screen.
 *
 * A post bookmark writes post_saves, and the Saved screen listed collections
 * only, so a saved post was nowhere to be found. SavedPostsList lists them.
 * Its states must be true: a failed read is an error with a retry (never
 * "No saved posts yet"), a row that cannot load says so, a post that is gone
 * says that, and a readable post opens its detail screen.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SavedPostsList } from '../SavedPostsList.tsx';

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    ...jest.requireActual('expo-router'),
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void) => { React.useEffect(() => { cb(); }, [cb]); },
  };
});
jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../services/collections', () => ({
  ...jest.requireActual('../../services/collections'),
  getMySavedPostIds: jest.fn(),
}));
jest.mock('../../services/posts', () => ({
  ...jest.requireActual('../../services/posts'),
  getPostById: jest.fn(),
}));

const collections = require('../../services/collections.ts');
const posts = require('../../services/posts.ts');

const post = (id: string, content: string, handle: string) => ({
  ok: true,
  data: { id, content, author: { id: `a-${id}`, handle, name: handle, avatarUrl: null } },
});

jest.setTimeout(20000);

describe('SavedPostsList', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('lists every saved post with a true state per row', async () => {
    collections.getMySavedPostIds.mockResolvedValue({ ok: true, postIds: ['p1', 'p2', 'p3'] });
    posts.getPostById.mockImplementation(async (id: string) => {
      if (id === 'p1') return post('p1', 'Sunset at the pier\nsecond line', 'ana');
      if (id === 'p2') return { ok: false, data: null, errorKind: 'not_found' };
      return { ok: false, data: null, errorKind: 'network_unreachable' };
    });
    const view = await render(<SavedPostsList onBack={() => {}} />);
    await view.findByText('Sunset at the pier');
    view.getByText('@ana');
    view.getByText('3 posts');
    view.getByText('Post unavailable');
    view.getByText('Couldn’t load this post');
    expect(view.queryByText('No saved posts yet')).toBeNull();
  });

  it('a failed read is an error with a retry, never "No saved posts yet"', async () => {
    collections.getMySavedPostIds
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, postIds: ['p1'] });
    posts.getPostById.mockResolvedValue(post('p1', 'Night market', 'bo'));
    const view = await render(<SavedPostsList onBack={() => {}} />);
    await view.findByText("We couldn't load your saved posts.");
    expect(view.queryByText('No saved posts yet')).toBeNull();
    await fireEvent.press(view.getByLabelText('Retry'));
    await waitFor(() => expect(collections.getMySavedPostIds).toHaveBeenCalledTimes(2));
  });

  it('a real empty list is the empty state', async () => {
    collections.getMySavedPostIds.mockResolvedValue({ ok: true, postIds: [] });
    const view = await render(<SavedPostsList onBack={() => {}} />);
    await view.findByText('No saved posts yet');
  });

  it('tapping a saved post opens it', async () => {
    collections.getMySavedPostIds.mockResolvedValue({ ok: true, postIds: ['p1'] });
    posts.getPostById.mockResolvedValue(post('p1', 'Night market', 'bo'));
    const view = await render(<SavedPostsList onBack={() => {}} />);
    const row = await view.findByTestId('saved-post-p1');
    await fireEvent.press(row);
    expect(router.push).toHaveBeenCalledWith('/post/p1');
  });
});
