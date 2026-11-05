import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAdmin } from '../lib/requireAdmin.js';
import { sendError } from '../lib/http.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { invalidate as invalidateCompassCache } from '../compass/CompassCacheEngine.js';
import { syncPostcardAfterMediaChange } from './postcards.js';
import { decideEventTransition } from '../lib/eventLifecycle.js';

const router = Router();
const id = z.string().uuid().transform(value => value.toLowerCase());
const token = z.string().regex(/^[0-9a-f]{64}$/);
const kind = z.enum(['post', 'comment', 'message', 'buddy_listing', 'media', 'event']);
const target = z.object({ type: kind, id, reportId: id });
const effect = z.enum(['remove_content', 'suspend_listing']);
const contextSchema = z.object({ contractVersion: z.literal(1), subjectType: kind, subjectId: id, reportId: id,
  reportStatus: z.enum(['open', 'reviewing']), preview: z.string().nullable(), effect,
  contentToken: token, reportToken: token });
const bodySchema = z.object({ reason: z.string().trim().refine(value => Array.from(value).length > 0 && Array.from(value).length <= 1000),
  expected_content_token: token, expected_report_token: token }).strict();
const receiptSchema = z.object({ ok: z.literal(true), contractVersion: z.literal(1), operationId: id,
  subjectType: kind, subjectId: id, reportId: id, auditId: id, replayed: z.boolean(), effect, ownerId: id,
  committedAt: z.string().refine(value => Number.isFinite(Date.parse(value))) });

function refusal(res: Parameters<typeof sendError>[0], code?: string) {
  if (code === 'PT400') sendError(res, 'invalid_payload', 'A complete removal confirmation and reason are required');
  else if (code === 'PT403') sendError(res, 'forbidden', 'Admin role required');
  else if (code === 'PT404') sendError(res, 'not_found', 'Reported content is no longer available');
  else if (code === 'PT409') sendError(res, 'conflict', 'Content or report changed. Reload before confirming a new removal.');
  else sendError(res, 'degraded_unavailable', 'Audited removal unavailable. A sent request may have committed; retry the same operation to recover its result.');
}

const path = '/admin/moderation/reports/:reportId/content/:type/:id/removal';
router.get(path, asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = target.safeParse(req.params);
  if (!parsed.success) { refusal(res, 'PT400'); return; }
  if (!checkRateLimit('reported-content-context', admin.userId, 60, 60000).allowed) {
    sendError(res, 'rate_limited', 'Too many moderation requests'); return;
  }
  const input = parsed.data;
  try {
    const { data, error } = await admin.sc.rpc('get_reported_content_removal_context', {
      p_admin_id: admin.userId, p_type: input.type, p_id: input.id, p_report_id: input.reportId,
    }).abortSignal(AbortSignal.timeout(6000));
    if (error) { refusal(res, error.code); return; }
    const result = contextSchema.safeParse(data);
    if (!result.success || result.data.subjectId !== input.id || result.data.reportId !== input.reportId
      || result.data.subjectType !== input.type || result.data.effect !== (input.type === 'buddy_listing' ? 'suspend_listing' : 'remove_content')) { refusal(res); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json(result.data);
  } catch { refusal(res); }
}));

router.post(path, asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = target.safeParse(req.params);
  const body = bodySchema.safeParse(req.body);
  const operation = id.safeParse(req.headers['idempotency-key']);
  const rawHeaders = z.array(z.string()).optional().safeParse(req.rawHeaders);
  const ambiguous = !rawHeaders.success || (rawHeaders.data !== undefined
    && rawHeaders.data.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length !== 1);
  if (!parsed.success || !body.success || !operation.success || ambiguous) { refusal(res, 'PT400'); return; }
  if (!checkRateLimit('reported-content-removal', admin.userId, 60, 60000).allowed) {
    sendError(res, 'rate_limited', 'Too many moderation requests'); return;
  }
  const input = parsed.data;
  try {
    if (input.type === 'event') {
      const before = await admin.sc.rpc('get_reported_content_removal_context', {
        p_admin_id: admin.userId, p_type: input.type, p_id: input.id, p_report_id: input.reportId,
      }).abortSignal(AbortSignal.timeout(6000));
      if (!before.error && !decideEventTransition(before.data?.eventState, 'archived').allowed) { refusal(res, 'PT409'); return; }
      // A prior commit is now archived or its report may have closed: the atomic
      // command must still recover its exact receipt. Other failures stop here.
      if (before.error && !['PT404', 'PT409'].includes(before.error.code)) { refusal(res, before.error.code); return; }
    }
    const { data, error } = await admin.sc.rpc('remove_reported_content', {
      p_admin_id: admin.userId, p_type: input.type, p_id: input.id, p_report_id: input.reportId,
      p_operation_id: operation.data, p_reason: body.data.reason,
      p_expected_content_token: body.data.expected_content_token, p_expected_report_token: body.data.expected_report_token,
    }).abortSignal(AbortSignal.timeout(6000));
    if (error) { refusal(res, error.code); return; }
    const result = receiptSchema.safeParse(data);
    if (!result.success || result.data.subjectId !== input.id || result.data.reportId !== input.reportId
      || result.data.subjectType !== input.type || result.data.operationId !== operation.data
      || result.data.effect !== (input.type === 'buddy_listing' ? 'suspend_listing' : 'remove_content')) { refusal(res); return; }
    const { ownerId, ...receipt } = result.data;
    if (input.type === 'media') {
      // Retry replays the committed receipt, then re-drives derived cover/count
      // reconciliation. Never claim completion while a removed file is a cover.
      const asset = await admin.sc.rpc('read_reported_content_target', { p_type: 'media', p_id: input.id }).abortSignal(AbortSignal.timeout(6000));
      if (asset.error || !asset.data) { refusal(res); return; }
      const media = await admin.sc.from('post_media').select('post_id')
        .eq('storage_bucket', asset.data.storage_bucket).eq('storage_path', asset.data.storage_path).abortSignal(AbortSignal.timeout(6000));
      if (media.error || !Array.isArray(media.data)) { refusal(res); return; }
      for (const postId of new Set(media.data.map((row: any) => row.post_id).filter(Boolean))) {
        const post = await admin.sc.from('posts').select('author_id').eq('id', postId).maybeSingle().abortSignal(AbortSignal.timeout(6000));
        if (post.error || !post.data?.author_id) { refusal(res); return; }
        const sync = await syncPostcardAfterMediaChange(admin.sc, String(postId), { id: post.data.author_id }, req);
        if (sync.unread || sync.cover === 'failed') { refusal(res); return; }
      }
    }
    if (input.type === 'post' || input.type === 'buddy_listing' || input.type === 'event' || input.type === 'media') {
      await invalidateCompassCache(admin.sc, ownerId, 'reported_content_removal');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(receipt);
  } catch { refusal(res); }
}));

export default router;
