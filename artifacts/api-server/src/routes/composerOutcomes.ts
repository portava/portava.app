import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireUser } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { isFlagEnabled } from '../lib/featureFlags.js';
export const composerOutcomeSchema = z.object({
    event_id: z.string().uuid(), version: z.literal(1),
    surface: z.enum(['comment_sheet', 'comment_inline', 'postcard', 'post']),
    outcome: z.enum(['left_with_unsent', 'discarded_draft', 'upload_cancelled', 'upload_failed', 'post_discarded_after_upload', 'published']),
    failure_code: z.enum(['network', 'storage', 'unsupported_media', 'rejected', 'unknown']).optional(),
}).strict().refine(event => event.failure_code === undefined || event.outcome === 'upload_failed');
const batch = z.object({ events: z.array(composerOutcomeSchema).min(1).max(50) }).strict();
/** Actor-scoped deterministic UUID: another account cannot replace/collide with
 * this event, and a lost response can retry without counting it twice. */
export function composerOutcomeRowId(actorId: string, eventId: string): string {
    const hex = createHash('sha256').update(`composer-outcome-v1:${actorId}:${eventId}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const router = Router();
router.post('/media/analytics/composer-outcomes', asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth)
        return;
    const parsed = batch.safeParse(req.body);
    // Do not echo Zod errors or untrusted input into responses/logs.
    if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
    }
    const sc = getServiceClient();
    if (!sc) {
        res.status(503).json({ error: 'unavailable' });
        return;
    }
    if (!await isFlagEnabled(sc, 'MEDIA_ANALYTICS_ENABLED')) {
        res.json({ accepted: parsed.data.events.length, disabled: true });
        return;
    }
    const rows = [...new Map(parsed.data.events.map(event => [event.event_id, {
                id: composerOutcomeRowId(auth.user.id, event.event_id), event_type: 'composer_outcome',
                // No actor/content association is stored in the payload; only actor-scoped
                // idempotency hashes link retries. This event does not feed media ranking.
                payload: { version: event.version, surface: event.surface, outcome: event.outcome,
                    ...(event.failure_code ? { failure_code: event.failure_code } : {}) },
            }])).values()];
    // Admission locks current account state through insertion; the actor is not
    // retained in the event. Missing migration/unknown receipt stays retryable.
    const { data, error } = await sc.rpc('admit_composer_outcomes', { p_actor: auth.user.id, p_rows: rows });
    if (error || typeof data !== 'boolean') {
        res.status(503).json({ error: 'unavailable' });
        return;
    }
    // Match the existing collection-disabled acknowledgement: consume queued
    // IDs on terminal refusal; disabled explicitly means no durable event.
    res.json(data ? { accepted: parsed.data.events.length } : { accepted: parsed.data.events.length, disabled: true });
}));
export default router;
