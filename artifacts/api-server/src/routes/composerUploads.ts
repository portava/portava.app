import { runMediaVendorIngest } from '../lib/media/vendors/mediaVendorStages.js';
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { requireUser } from '../lib/http.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getServiceClient } from '../lib/supabase.js';
export const COMPOSER_OPERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Client = NonNullable<ReturnType<typeof getServiceClient>>;
export async function commitComposerPost(sc: Client, actor: string, post: Record<string, unknown>, media: Array<Record<string, unknown>>) {
    const result = await sc.rpc('commit_composer_post' as never, { p_actor: actor, p_post: post, p_media: media } as never);
    const receipt = result.data as unknown as { id?: string; repeated?: boolean } | null;
    if (result.error || !receipt?.id) return { ok: false as const, error: result.error ?? { message: 'Publication was not confirmed.' } };
    return { ok: true as const, id: receipt.id, repeated: receipt.repeated === true };
}
export async function reserveComposerUpload(sc: Client, actor: string, operation: string, path: string, bytes: Buffer) {
    const base = path.replace(/\.[^.]+$/, '');
    const result = await sc.rpc('reserve_composer_upload' as never, { p_actor: actor, p_operation: operation,
        p_paths: [path, `${base}.thumb.jpg`, `${base}.feed.jpg`], p_digest: createHash('sha256').update(bytes).digest('hex') } as never);
    return !result.error && (result.data as unknown as {
        ok?: boolean;
    })?.ok === true;
}
export async function finishComposerUpload(sc: Client, actor: string, operation: string) {
    const result = await sc.rpc('finish_composer_upload' as never, { p_actor: actor, p_operation: operation } as never);
    return !result.error && (result.data as unknown as {
        ok?: boolean;
    })?.ok === true;
}
/** Remove only a durable, owned, cancelled intent. Publication claims the same
 * row lock, so cleanup cannot delete a file already attached by this operation. */
export async function cleanComposerUpload(sc: Client, actor: string, operation: string, fallbackPaths: string[] = []): Promise<boolean> {
    const r = await sc.from('composer_upload_intents' as never).select('storage_paths,state').eq('id', operation).eq('owner_id', actor).maybeSingle();
    if (r.error)
        return false;
    if (!r.data) {
        if (fallbackPaths.some(path => !path.startsWith(`${actor}/`) || path.includes('..')))
            return false;
        return !fallbackPaths.length || !(await sc.storage.from('post-media').remove(fallbackPaths)).error;
    }
    const row = r.data as unknown as {
        state: string;
        storage_paths: string[];
    };
    if (row.state !== 'cancelled' || !Array.isArray(row.storage_paths) || row.storage_paths.some(p => !p.startsWith(`${actor}/`) || p.includes('..')))
        return false;
    const removed = await sc.storage.from('post-media').remove(row.storage_paths);
    if (removed.error)
        return false;
    // Preserve cleanup intent while a proxy request could still complete. Its
    // finalization rechecks cancellation and cleans again; retry remains safe.
    return true;
}
const router = Router();
router.delete('/media/drafts/:operation', asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth)
        return;
    const operation = req.params.operation;
    if (!COMPOSER_OPERATION_RE.test(operation)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
    }
    const sc = getServiceClient();
    if (!sc) {
        res.status(503).json({ error: 'unavailable' });
        return;
    }
    const cancelled = await sc.rpc('cancel_composer_upload' as never, { p_actor: auth.user.id, p_operation: operation } as never);
    const result = cancelled.data as unknown as {
        ok?: boolean;
        error?: string;
    };
    if (cancelled.error || !result?.ok) {
        res.status(result?.error === 'already_published' ? 409 : 503).json({ error: result?.error === 'already_published' ? 'already_published' : 'cleanup_pending' });
        return;
    }
    if (!await cleanComposerUpload(sc, auth.user.id, operation)) {
        res.status(503).json({ error: 'cleanup_pending' });
        return;
    }
    res.json({ ok: true });
}));
export default router;
export async function activatePublishedComposerMedia(sc: Client, actor: string, operation: string): Promise<void> {
    try {
        const intent = await sc.from('composer_upload_intents' as never).select('state,storage_paths').eq('id', operation).eq('owner_id', actor).maybeSingle();
        const row = intent.data as unknown as {
            state: string;
            storage_paths: string[];
        } | null;
        if (intent.error || row?.state !== 'published' || !row.storage_paths?.[0])
            return;
        const result = await sc.from('media_assets').select('id,version,media_type,duration_ms').eq('storage_bucket', 'post-media').eq('storage_path', row.storage_paths[0]).eq('owner_user_id', actor).maybeSingle();
        const asset = result.data;
        if (result.error || !asset)
            return;
        await runMediaVendorIngest(sc, { assetId: asset.id, sourceVersion: asset.version, bucket: 'post-media', path: row.storage_paths[0], mediaType: asset.media_type, durationMs: asset.duration_ms }, undefined, { skipModeration: true });
    }
    catch { /* Publication remains committed; ingest's existing retry path handles readiness. */ }
}
