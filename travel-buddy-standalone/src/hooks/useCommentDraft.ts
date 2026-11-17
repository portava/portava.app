import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { useCallback, useState, useRef } from 'react';
import { useSession } from '../context/SessionContext.tsx';
import { useLocalComposerDraft } from './useLocalComposerDraft.ts';
import { useComposerOutcome } from './useComposerOutcome.ts';
import { isCommentDraft, type CommentDraft } from '../services/localComposerDraft.ts';
const EMPTY: CommentDraft = { text: '', replyingTo: null };
const nonempty = (draft: CommentDraft) => !!draft.text.trim();
export function useCommentDraft(postId: string, active: boolean, surface: 'comment_sheet' | 'comment_inline') {
    const { userId } = useSession();
    const [owner] = useState(captureMessagingOwnerRequest);
    const record = useComposerOutcome(surface);
    const draft = useLocalComposerDraft({ accountId: owner?.ownerId === userId ? userId : null, composer: `${surface}:${postId}`, initial: EMPTY,
        validate: isCommentDraft, nonempty, active, onLeave: () => record('left_with_unsent') });
    const { setValue, clear, value } = draft;
    const setText = useCallback((text: string) => setValue(previous => ({ ...previous, text })), [setValue]);
    const setReplyingTo = useCallback((replyingTo: CommentDraft['replyingTo']) => setValue(previous => ({ ...previous, replyingTo })), [setValue]);
    const finishSubmission = useCallback((submitted: CommentDraft) => {
        record('published');
        void clear(EMPTY, submitted);
    }, [record, clear]);
    const discarding = useRef(false);
    const discard = useCallback(async () => {
        if (discarding.current)
            return;
        discarding.current = true;
        try {
            if (await clear(EMPTY, value))
                record('discarded_draft');
        }
        finally {
            discarding.current = false;
        }
    }, [clear, value, record]);
    return { ...draft.value, setText, setReplyingTo, finishSubmission, discard, draftError: draft.error, draftReady: draft.ready && owner?.ownerId === userId && owner.isCurrent() };
}
