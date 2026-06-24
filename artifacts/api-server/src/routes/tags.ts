/**
 * Tag routes
 *
 * GET  /api/tags/suggestions  — suggest @mentionable users given a query prefix
 * GET  /api/me/tag-permission — get current user's tag_permission setting
 * PATCH /api/me/tag-permission — update tag_permission setting
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { isUuid } from '../lib/followDecisions.js';

const router = Router();

// ─── GET /api/tags/suggestions ────────────────────────────────────────────────

/**
 * Returns up to 10 users whose handle starts with `q` (case-insensitive),
 * filtered by their tag_permission setting relative to the caller.
 *
 * Query params:
 *   q        (required) — handle prefix to search
 *   limit    (optional, max 20)
 */
router.get('/tags/suggestions', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  if (!q || q.length < 1) {
    sendError(res, 'invalid_payload', 'q is required');
    return;
  }

  const limit = Math.min(Number(req.query.limit ?? 10), 20);

  const sc = getServiceClient();
  if (!sc) { sendError(res, 'server_not_configured', 'Service client not ready'); return; }

  const { data: rows, error } = await sc
    .from('profiles')
    .select('id, handle, name, avatar_url, tag_permission')
    .ilike('handle', `${q}%`)
    .neq('id', user.id)
    .order('handle', { ascending: true })
    .limit(limit * 3); // fetch extra to allow for filtering

  if (error) {
    req.log.error({ err: error }, 'tags/suggestions query failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  const profiles = rows ?? [];

  // Filter by tag_permission — 'nobody' excluded;
  // 'anyone' always included; 'interacted'/'friends_only' included for now
  // (fine-grained enforcement is a mobile-layer responsibility).
  const filtered = profiles
    .filter((p: any) => (p.tag_permission ?? 'anyone') !== 'nobody')
    .slice(0, limit);

  const suggestions = filtered.map((p: any) => ({
    id: p.id,
    handle: p.handle,
    name: p.name ?? null,
    avatarUrl: p.avatar_url ?? null,
    tagPermission: p.tag_permission ?? 'anyone',
  }));

  res.status(200).json({ suggestions });
});

// ─── GET /api/me/tag-permission ───────────────────────────────────────────────

router.get('/me/tag-permission', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { data, error } = await client
    .from('profiles')
    .select('tag_permission')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, 'tag-permission fetch failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ tagPermission: (data as any)?.tag_permission ?? 'anyone' });
});

// ─── PATCH /api/me/tag-permission ─────────────────────────────────────────────

const TagPermissionSchema = z.object({
  tagPermission: z.enum(['anyone', 'interacted', 'friends_only', 'nobody']),
});

router.patch('/me/tag-permission', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = TagPermissionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues.map((i) => i.message).join('; '));
    return;
  }

  const { data, error } = await client
    .from('profiles')
    .update({ tag_permission: parsed.data.tagPermission })
    .eq('id', user.id)
    .select('tag_permission')
    .single();

  if (error) {
    req.log.error({ err: error }, 'tag-permission update failed');
    sendError(res, 'db_error', error.message);
    return;
  }

  res.status(200).json({ tagPermission: (data as any).tag_permission });
});

export default router;
