/**
 * MD385 — the "Save to a Memory" sheet on one's own post.
 *
 * Pins: the person's own Memories are offered and a new private one can be
 * made from the post; a list that could not load says so with Try again; a
 * refusal is said in words with no retry; a retryable failure says nothing was
 * saved and offers Try again; a copy that stopped part-way says how many made
 * it. And the offer itself: only on one's own post with media.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const react = jest.requireActual('react');
  const modal = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (visible ? react.createElement(actual.View, null, children) : null);
  return new Proxy(actual, { get(target, property, receiver) { return property === 'Modal' ? modal : Reflect.get(target, property, receiver); } });
});
const mockUserMemories = jest.fn();
const mockCreate = jest.fn();
jest.mock('../../../services/memories.ts', () => ({
  ...jest.requireActual('../../../services/memories.ts'),
  getUserMemories: (...a: unknown[]) => mockUserMemories(...a),
  createMemory: (...a: unknown[]) => mockCreate(...a),
}));
const mockSave = jest.fn();
jest.mock('../../../services/memoryFromPost.ts', () => ({
  ...jest.requireActual('../../../services/memoryFromPost.ts'),
  saveOwnPostToMemory: (...a: unknown[]) => mockSave(...a),
}));

import { SaveOwnPostToMemorySheet, canOfferSaveToMemory, titleFromPost } from '../SaveOwnPostToMemorySheet.tsx';

const ME = 'me';
const POST = { id: 'post-1', authorId: ME, author: { id: ME }, mediaUrls: ['a', 'b', 'c'], content: 'Sunset at the river\nsecond line' };
const memory = (id: string, title: string | null, ownerId = ME) => ({ id, title, ownerId }) as any;

beforeEach(() => {
  for (const m of [mockUserMemories, mockCreate, mockSave]) m.mockReset();
  mockUserMemories.mockResolvedValue({ ok: true, memories: [memory('m1', 'Lisbon'), memory('m2', null), memory('x', 'Someone else', 'other')], nextCursor: null });
});

const open = async () => {
  await render(<SaveOwnPostToMemorySheet visible post={POST} viewerId={ME} onClose={() => {}} />);
  await act(async () => {});
};
const press = async (id: string) => { await act(async () => { fireEvent.press(screen.getByTestId(id)); }); };

describe('canOfferSaveToMemory — only one\'s own post, only with media', () => {
  it('own post with media: offered; someone else\'s post, no media, signed out: not', () => {
    expect(canOfferSaveToMemory(POST, ME)).toBe(true);
    expect(canOfferSaveToMemory({ ...POST, author: { id: 'other' }, authorId: 'other' }, ME)).toBe(false);
    expect(canOfferSaveToMemory({ ...POST, mediaUrls: [] }, ME)).toBe(false);
    expect(canOfferSaveToMemory(POST, null)).toBe(false);
  });
  it('a new Memory is titled by the post\'s first line, capped', () => {
    expect(titleFromPost(POST.content)).toBe('Sunset at the river');
    expect(titleFromPost('   ')).toBeNull();
    expect(titleFromPost('x'.repeat(200))!.length).toBe(80);
  });
});

describe('SaveOwnPostToMemorySheet', () => {
  it('offers only my own Memories, plus a new private one', async () => {
    await open();
    expect(screen.getByTestId('save-to-memory-new')).toBeTruthy();
    expect(screen.getByTestId('save-to-memory-pick-m1')).toBeTruthy();
    expect(screen.getByText('Untitled Memory')).toBeTruthy();
    expect(screen.queryByTestId('save-to-memory-pick-x')).toBeNull();
  });

  it('picking a Memory copies every photo of the post into it and says where', async () => {
    mockSave.mockResolvedValueOnce({ saved: 3, alreadyThere: 0, total: 3, refusal: null });
    await open();
    await press('save-to-memory-pick-m1');
    expect(mockSave).toHaveBeenCalledWith({ memoryId: 'm1', postId: 'post-1', mediaCount: 3 });
    expect(screen.getByTestId('save-to-memory-message').props.children).toBe('All 3 saved to “Lisbon”.');
    expect(screen.queryByTestId('save-to-memory-retry')).toBeNull();
  });

  it('a new private Memory is made from the post, then the photos are copied into it', async () => {
    mockCreate.mockResolvedValueOnce({ ok: true, memory: memory('new-1', 'Sunset at the river') });
    mockSave.mockResolvedValueOnce({ saved: 3, alreadyThere: 0, total: 3, refusal: null });
    await open();
    await press('save-to-memory-new');
    expect(mockCreate).toHaveBeenCalledWith({ title: 'Sunset at the river', visibility: 'only_me' });
    expect(mockSave).toHaveBeenCalledWith({ memoryId: 'new-1', postId: 'post-1', mediaCount: 3 });
    expect(screen.getByTestId('save-to-memory-message').props.children).toBe('All 3 saved to “Sunset at the river”.');
  });

  it('a list that could not load says so, with Try again — and the new-Memory path still works', async () => {
    mockUserMemories.mockReset().mockResolvedValueOnce({ ok: false, message: 'HTTP 500' })
      .mockResolvedValueOnce({ ok: true, memories: [memory('m1', 'Lisbon')], nextCursor: null });
    await open();
    expect(screen.getByTestId('save-to-memory-list-error')).toBeTruthy();
    expect(screen.getByTestId('save-to-memory-new')).toBeTruthy();
    await press('save-to-memory-list-retry');
    expect(screen.getByTestId('save-to-memory-pick-m1')).toBeTruthy();
  });

  it('a refusal (switched off) is said in words, with no Try again', async () => {
    mockSave.mockResolvedValueOnce({ saved: 0, alreadyThere: 0, total: 3, refusal: 'disabled' });
    await open();
    await press('save-to-memory-pick-m1');
    expect(screen.getByTestId('save-to-memory-message').props.children).toMatch(/turned off/);
    expect(screen.queryByTestId('save-to-memory-retry')).toBeNull();
  });

  it('a retryable failure says nothing was saved and offers Try again, which tries the same Memory', async () => {
    mockSave.mockResolvedValueOnce({ saved: 0, alreadyThere: 0, total: 3, refusal: 'unavailable' })
      .mockResolvedValueOnce({ saved: 3, alreadyThere: 0, total: 3, refusal: null });
    await open();
    await press('save-to-memory-pick-m1');
    expect(screen.getByTestId('save-to-memory-message').props.children).toMatch(/Nothing was saved/);
    await press('save-to-memory-retry');
    expect(mockSave).toHaveBeenLastCalledWith({ memoryId: 'm1', postId: 'post-1', mediaCount: 3 });
    expect(screen.getByTestId('save-to-memory-message').props.children).toBe('All 3 saved to “Lisbon”.');
  });

  it('a copy that stopped part-way says how many made it', async () => {
    mockSave.mockResolvedValueOnce({ saved: 2, alreadyThere: 0, total: 3, refusal: 'network' });
    await open();
    await press('save-to-memory-pick-m1');
    expect(screen.getByTestId('save-to-memory-message').props.children).toBe('2 of 3 saved to “Lisbon”. The rest weren’t — try again.');
    expect(screen.getByTestId('save-to-memory-retry')).toBeTruthy();
  });

  it('a new Memory that could not be made is not reported as saved', async () => {
    mockCreate.mockResolvedValueOnce({ ok: false, kind: 'degraded_unavailable', message: 'x', operationId: 'o' });
    await open();
    await press('save-to-memory-new');
    expect(mockSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('save-to-memory-message').props.children).toMatch(/Nothing was saved/);
    expect(screen.getByTestId('save-to-memory-retry')).toBeTruthy();
  });
});
