/** Local feature data only. Never send drafts to analytics, diagnostics or ranking. */
export interface DraftStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}
const writes = new Map<string, Promise<unknown>>();
export function composerDraftKey(accountId: string, composer: string): string {
    return `rumazi.composer-draft.v1:${encodeURIComponent(accountId)}:${encodeURIComponent(composer)}`;
}
function serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const work = (writes.get(key) ?? Promise.resolve()).catch(() => { }).then(operation);
    writes.set(key, work);
    void work.finally(() => { if (writes.get(key) === work)
        writes.delete(key); }).catch(() => { });
    return work;
}
export function readComposerDraft<T>(storage: DraftStorage, key: string, validate: (value: unknown) => value is T): Promise<T | null> {
    return serial(key, async () => {
        const raw = await storage.getItem(key);
        if (raw === null)
            return null;
        const value: unknown = JSON.parse(raw);
        // Invalid/unreadable storage is not an empty draft; never overwrite it on mount.
        if (!validate(value))
            throw new Error('Draft could not be restored on this device.');
        return value;
    });
}
export function writeComposerDraft<T>(storage: DraftStorage, key: string, value: T): Promise<void> {
    const encoded = JSON.stringify(value);
    return serial(key, () => storage.setItem(key, encoded));
}
export function deleteComposerDraft(storage: DraftStorage, key: string): Promise<void> {
    return serial(key, () => storage.removeItem(key));
}
export interface CommentDraft {
    text: string;
    replyingTo: {
        id: string;
        authorName: string;
    } | null;
}
export function isCommentDraft(value: unknown): value is CommentDraft {
    if (!value || typeof value !== 'object')
        return false;
    const draft = value as CommentDraft;
    return typeof draft.text === 'string' && draft.text.length <= 1000 &&
        (draft.replyingTo === null || !!draft.replyingTo && typeof draft.replyingTo.id === 'string' &&
            draft.replyingTo.id.length <= 128 && typeof draft.replyingTo.authorName === 'string' && draft.replyingTo.authorName.length <= 200);
}
