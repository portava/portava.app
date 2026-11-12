import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { isKillSwitchEngaged } from '../lib/featureFlags.js';
import { readReferenceSource, readPostReference } from '../services/postDestinations.js';

const router = Router();
const uuid = z.string().uuid();
const input = z.object({ operationId: uuid, destination: z.enum(['memory', 'highlight', 'profile']), memoryId: uuid.nullish(),
  title: z.string().trim().max(120).nullish(), note: z.string().trim().max(500).nullish(),
  visibility: z.enum(['only_me', 'friends_only', 'public', 'private']).optional() }).strict();

router.post('/posts/:postId/destinations', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const parsed = input.safeParse(req.body);
  if (!uuid.safeParse(req.params.postId).success || !parsed.success) { sendError(res, 'invalid_payload', 'Choose a valid destination.'); return; }
  const p = parsed.data;
  if ((p.destination === 'profile' && (p.title || p.memoryId || (p.visibility && !['private','public'].includes(p.visibility))))
    || (p.destination === 'highlight' && (p.memoryId || (p.visibility && !['private','public'].includes(p.visibility))))
    || (p.destination === 'memory' && p.visibility === 'private')) { sendError(res, 'invalid_payload', 'Choose a valid audience.'); return; }
  if (p.destination === 'profile' && await isKillSwitchEngaged(auth.client, 'disable_posting')) {
    sendError(res, 'feature_disabled', 'Posting is temporarily disabled'); return;
  }
  const result = p.destination === 'profile'
    ? await auth.client.rpc('share_post_to_profile', {p_actor_id: auth.user.id, p_post_id: req.params.postId,
        p_operation_id: p.operationId, p_note: p.note ?? null, p_visibility: p.visibility ?? 'public'})
    : await auth.client.rpc('share_post_to_destination', {
    p_actor_id: auth.user.id, p_post_id: req.params.postId, p_operation_id: p.operationId, p_destination: p.destination,
    p_memory_id: p.memoryId ?? null, p_title: p.title ?? null, p_note: p.note ?? null, p_visibility: p.visibility ?? null,
  });
  const { data, error } = result;
  if (error) {
    const message = String(error.message ?? '');
    if (message.includes('destination_intent_conflict')) sendError(res, 'conflict', 'This save has different details. Start a new save.');
    else if (message.includes('source_post_unavailable')) sendError(res, 'not_found', 'This post can no longer be shared.');
    else if (message.includes('destination_unavailable')) sendError(res, 'not_found', 'This destination is no longer available.');
    else if (message.includes('destination_full')) sendError(res, 'invalid_payload', 'This Memory already has 10 items. Choose another or create one.');
    else if (message.includes('invalid_destination')) sendError(res, 'invalid_payload', 'Choose a valid destination.');
    else sendError(res, 'db_error', 'Your post could not be saved. Try again.');
    return;
  }
  if (!data || !uuid.safeParse(data.referenceId).success || !(data.memoryId || data.highlightId || data.profilePostId)) {
    sendError(res, 'db_error', 'The save could not be confirmed. Try again.'); return;
  }
  res.json(data);
}));

router.get('/post-references/:referenceId', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  if (!uuid.safeParse(req.params.referenceId).success) { sendError(res, 'invalid_payload', 'Invalid saved post.'); return; }
  try {
    const view = await readPostReference(auth.client, String(req.params.referenceId), auth.user.id);
    res.setHeader('Cache-Control', 'private, no-store');
    if (!view) { sendError(res, 'not_found', 'This saved post is unavailable.'); return; }
    res.json(view);
  } catch { sendError(res, 'db_error', 'This saved post could not be checked. Try again.'); }
}));
router.get('/posts/:postId/share-preview', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!uuid.safeParse(req.params.postId).success) { sendError(res, 'invalid_payload', 'Invalid post.'); return; }
  try { res.json(await readReferenceSource(auth.client, String(req.params.postId), auth.user.id)); }
  catch { sendError(res, 'db_error', 'This shared post could not be checked. Try again.'); }
}));
export default router;
