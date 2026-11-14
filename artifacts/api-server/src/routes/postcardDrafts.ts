import { Router, type Request } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireUser } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { isKillSwitchEngaged } from '../lib/featureFlags.js';
import { processTagging } from '../services/tagging/TaggingService.js';
type Client = NonNullable<ReturnType<typeof getServiceClient>>;
export async function publishPostcardDraft(sc: Client, actor: string, postId: string): Promise<{
    ok: boolean;
    error?: string;
}> {
    const { data, error } = await sc.rpc('publish_postcard_draft' as never, { p_actor: actor, p_post: postId } as never);
    if (error)
        return { ok: false, error: 'unavailable' };
    const result = data as unknown as {
        ok?: boolean;
        error?: string;
    } | null;
    if (!result?.ok)
        return { ok: false, error: result?.error ?? 'unavailable' };
    const { data: post } = await sc.from('posts').select('content').eq('id', postId).eq('author_id', actor).maybeSingle();
    if (post?.content)
        void processTagging({ content: post.content, sourceType: 'post', sourceId: postId, authorId: actor, db: sc }).catch(() => { });
    return { ok: true };
}
export function postcardDraftRouter(onPublished: (sc: Client, postId: string, user: {
    id: string;
}, req: Request) => Promise<unknown>) {
    const router = Router();
    router.post('/postcards/:id/publish', asyncHandler(async (req, res) => {
        const auth = await requireUser(req, res);
        if (!auth)
            return;
        if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        const sc = getServiceClient();
        if (!sc) {
            res.status(503).json({ error: 'unavailable' });
            return;
        }
        if (await isKillSwitchEngaged(sc, 'disable_posting')) {
            res.status(503).json({ error: 'feature_disabled' });
            return;
        }
        const result = await publishPostcardDraft(sc, auth.user.id, req.params.id);
        if (!result.ok) {
            res.status(result.error === 'unavailable' ? 503 : 409).json(result);
            return;
        }
        await onPublished(sc, req.params.id, auth.user, req);
        res.json({ ok: true });
    }));
    router.delete('/postcards/:id/draft', asyncHandler(async (req, res) => {
        const auth = await requireUser(req, res);
        if (!auth)
            return;
        if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
            res.status(400).json({ error: 'invalid_payload' });
            return;
        }
        const sc = getServiceClient();
        if (!sc) {
            res.status(503).json({ error: 'unavailable' });
            return;
        }
        const { data, error } = await sc.rpc('cancel_postcard_draft' as never, { p_actor: auth.user.id, p_post: req.params.id } as never);
        const result = data as unknown as {
            ok?: boolean;
            absent?: boolean;
        } | null;
        if (error || !result?.ok) {
            res.status(503).json({ error: 'cleanup_pending' });
            return;
        }
        if (result.absent) {
            res.json({ ok: true });
            return;
        }
        const media = await sc.from('post_media').select('storage_path,thumbnail_storage_path,feed_storage_path').eq('post_id', req.params.id).eq('user_id', auth.user.id);
        if (media.error) {
            res.status(503).json({ error: 'cleanup_pending' });
            return;
        }
        const candidates = (media.data ?? []).flatMap(row => [row.storage_path, row.thumbnail_storage_path, row.feed_storage_path]).filter((path): path is string => typeof path === 'string' && !!path);
        if (candidates.some(path => !path.startsWith(`${auth.user.id}/`) || path.includes('..'))) {
            res.status(503).json({ error: 'cleanup_pending' });
            return;
        }
        const paths = [...new Set(candidates)];
        if (paths.length && (await sc.storage.from('post-media').remove(paths)).error) {
            res.status(503).json({ error: 'cleanup_pending' });
            return;
        }
        // Keep private tombstones/slot keys so a late signed PUT can be cleaned by
        // the same idempotent request; never resurrect or republish the row.
        res.json({ ok: true, cleanup_pending: (media.data?.length ?? 0) > 0 });
    }));
    return router;
}
