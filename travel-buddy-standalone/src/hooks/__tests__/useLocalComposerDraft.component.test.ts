import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalComposerDraft } from '../useLocalComposerDraft.ts';
import { composerDraftKey, isCommentDraft, type CommentDraft } from '../../services/localComposerDraft.ts';
const empty: CommentDraft = { text: '', replyingTo: null };
const nonempty = (draft: CommentDraft) => !!draft.text.trim();
const stored = new Map<string, string>();
const left = jest.fn();
const useDraftFixture = (owner = 'a', composer = 'comment:post-a', active = true) => useLocalComposerDraft({ accountId: owner, composer, initial: empty, validate: isCommentDraft, nonempty, active, onLeave: left });
beforeEach(() => {
    jest.useFakeTimers();
    stored.clear();
    left.mockReset();
    jest.spyOn(AsyncStorage, 'getItem').mockImplementation(async (key) => stored.get(key) ?? null);
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => { stored.set(key, value); });
    jest.spyOn(AsyncStorage, 'removeItem').mockImplementation(async (key) => { stored.delete(key); });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
it('recovers text and reply target after restart, isolated by account and composer', async () => {
    const first = await renderHook(() => useDraftFixture());
    await act(async () => first.result.current.setValue({ text: 'private words', replyingTo: { id: 'reply-a', authorName: 'Author' } }));
    await first.unmount();
    const restored = await renderHook(() => useDraftFixture());
    expect(restored.result.current.value.text).toBe('private words');
    expect(restored.result.current.value.replyingTo?.id).toBe('reply-a');
    const other = await renderHook(() => useDraftFixture('b'));
    expect(other.result.current.value).toEqual(empty);
    const another = await renderHook(() => useDraftFixture('a', 'comment:post-b'));
    expect(another.result.current.value).toEqual(empty);
});
it('explicit discard is durable and never counted as a later abandoned draft', async () => {
    const h = await renderHook(() => useDraftFixture());
    await act(async () => h.result.current.setValue({ ...empty, text: 'private draft' }));
    await act(async () => { expect(await h.result.current.clear(empty, h.result.current.value)).toBe(true); });
    await h.unmount();
    expect(left).not.toHaveBeenCalled();
    expect(stored.has(composerDraftKey('a', 'comment:post-a'))).toBe(false);
    const restart = await renderHook(() => useDraftFixture());
    expect(restart.result.current.value).toEqual(empty);
});
it('failed submissions preserve drafts, and old success cannot erase newer input', async () => {
    const h = await renderHook(() => useDraftFixture());
    await act(async () => h.result.current.setValue({ ...empty, text: 'first' }));
    const sent = h.result.current.value;
    await act(async () => h.result.current.setValue({ ...empty, text: 'newer' }));
    await act(async () => { expect(await h.result.current.clear(empty, sent)).toBe(false); await h.result.current.persist(); });
    expect(h.result.current.value.text).toBe('newer');
    expect(JSON.parse(stored.get(composerDraftKey('a', 'comment:post-a'))!).text).toBe('newer');
});
it('late hydration never replaces text typed while storage was loading', async () => {
    let resolve!: (value: string | null) => void;
    jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const h = await renderHook(() => useDraftFixture());
    await act(async () => h.result.current.setValue({ ...empty, text: 'new' }));
    await act(async () => { resolve(JSON.stringify({ ...empty, text: 'old' })); });
    expect(h.result.current.value.text).toBe('new');
    expect(JSON.parse(stored.get(composerDraftKey('a', 'comment:post-a'))!).text).toBe('new');
});
it('read failure keeps the saved copy and reports a local recovery error', async () => {
    stored.set(composerDraftKey('a', 'comment:post-a'), 'unreadable');
    const h = await renderHook(() => useDraftFixture());
    await act(async () => { h.result.current.setValue({ ...empty, text: 'new' }); await h.result.current.persist(); });
    expect(h.result.current.error).toMatch(/saved copy has been kept/);
    expect(stored.get(composerDraftKey('a', 'comment:post-a'))).toBe('unreadable');
});
it('leave is one structured callback per nonempty visit and has no input arguments', async () => {
    const h = await renderHook<ReturnType<typeof useDraftFixture>, { active: boolean }>(({ active }) => useDraftFixture('a', 'comment:post-a', active), { initialProps: { active: true } });
    await act(async () => h.result.current.setValue({ ...empty, text: 'private' }));
    await h.rerender({ active: false });
    await h.unmount();
    expect(left.mock.calls).toEqual([[]]);
});
it('keeps the newer input autosave scheduled when an older submit finishes', async () => {
    const h = await renderHook(() => useDraftFixture());
    await act(async () => h.result.current.setValue({ ...empty, text: 'old' }));
    const sent = h.result.current.value;
    await act(async () => h.result.current.setValue({ ...empty, text: 'new' }));
    await act(async () => { expect(await h.result.current.clear(empty, sent)).toBe(false); });
    await act(async () => { await jest.advanceTimersByTimeAsync(251); });
    expect(JSON.parse(stored.get(composerDraftKey('a', 'comment:post-a'))!).text).toBe('new');
});
it('a prefilled unsent draft is saved even before the user edits it', async () => {
    const prefilled = { ...empty, text: 'shared prefill' };
    const h = await renderHook(() => useLocalComposerDraft({ accountId: 'a', composer: 'post', initial: prefilled, validate: isCommentDraft, nonempty }));
    await h.unmount();
    expect(JSON.parse(stored.get(composerDraftKey('a', 'post'))!).text).toBe('shared prefill');
});
