/**
 * Notifications routes
 *
 * User-facing:
 *   GET    /me/notifications                — list (paginated, filterable)
 *   GET    /me/notifications/unread-count   — badge count
 *   POST   /me/notifications/:id/read       — mark single read
 *   POST   /me/notifications/read-all       — mark all read
 *   POST   /me/notifications/:id/dismiss    — dismiss
 *   GET    /me/notification-preferences     — get prefs
 *   PUT    /me/notification-preferences     — update prefs
 *   POST   /me/devices                      — register push token
 *   DELETE /me/devices/:id                  — unregister push token
 *   GET    /me/notifications/stream         — SSE stream for realtime updates
 *
 * Internal (service-role secret header):
 *   POST   /internal/notifications           — create a notification
 *   POST   /internal/notifications/send      — create + route (push, etc.)
 *   POST   /internal/notifications/digest    — trigger digest for a user
 *   POST   /internal/activity-events         — log an activity event
 *   POST   /internal/notifications/expire    — expire old notifications
 *
 * Admin:
 *   GET    /admin/notification-templates            — list all templates
 *   POST   /admin/notifications/account-notice      — send account notice to a user
 *   GET    /admin/notification-delivery-attempts    — list delivery attempts (status can be 'pending' for retry-queued attempts)
 *   PUT    /admin/notification-defaults             — update default prefs
 *   GET    /admin/push-retry-health                 — push_retry_queue snapshot (queued/failed counts + timestamps)
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, safeSecretEquals } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationPreferenceService, isValidTimezone } from "../services/notifications/NotificationPreferenceService.js";
import { NotificationRouter as NotifRouter } from "../services/notifications/NotificationRouter.js";
import { NotificationDigestService } from "../services/notifications/NotificationDigestService.js";
import { RealtimeActivityService } from "../services/notifications/RealtimeActivityService.js";
import { TEMPLATES } from "../services/notifications/NotificationTemplateService.js";
import type { NotificationCategory } from "../services/notifications/NotificationTemplateService.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

const NOTIFICATION_CATEGORIES = [
  'plans','trips','telegraph','safe_return','location','trip_crew',
  'compass','pulse','passport','hidden_gems','trust','airport','admin',
  'rent_buddy',
] as const;

// ── Internal secret guard ─────────────────────────────────────────────────────

/**
 * Fail-closed guard for internal (service-to-service) endpoints.
 * If INTERNAL_API_SECRET is not set the route is disabled — returns 503.
 * This prevents accidental open exposure when the env var is misconfigured.
 */
function requireInternalSecret(req: any, res: any): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    res.status(503).json({
      error: 'misconfigured',
      message: 'INTERNAL_API_SECRET is not set; internal endpoints are disabled',
    });
    return false;
  }
  const provided = req.headers['x-internal-secret'];
  // Constant-time compare — a plain !== leaks how many leading characters
  // matched through response timing, which is enough to recover
  // INTERNAL_API_SECRET byte by byte, and that secret gates endpoints which
  // bypass user auth entirely. See safeSecretEquals in lib/http.ts.
  if (!safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal secret' });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER-FACING ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /me/notifications */
router.get('/me/notifications', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const svc = new NotificationService(sc);

  const limit    = Math.min(Number(req.query.limit  ?? 20), 100);
  const offset   = Number(req.query.offset ?? 0);
  const category = req.query.category as string | undefined;
  const priority = req.query.priority as string | undefined;
  const unreadOnly = req.query.unread === 'true';
  const since    = req.query.since as string | undefined;

  try {
    const result = await svc.list({ userId: user.id, category, priority, unreadOnly, limit, offset, since });
    res.json(result);
  } catch (err: any) {
    sendError(res, 'db_error', err.message);
  }
});

/** GET /me/notifications/unread-count */
router.get('/me/notifications/unread-count', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const svc = new NotificationService(sc);

  const count = await svc.getUnreadCount(user.id);
  res.json({ unreadCount: count });
});

/** POST /me/notifications/read-all  (must come before /:id/read) */
router.post('/me/notifications/read-all', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const svc = new NotificationService(sc);
  const realtimeSvc = new RealtimeActivityService(sc);

  const category = req.body?.category as string | undefined;
  const count = await svc.markAllRead(user.id, category);
  void realtimeSvc.emitUnreadUpdate(user.id);
  res.json({ marked: count });
});

/** POST /me/notifications/:id/read */
router.post('/me/notifications/:id/read', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const svc = new NotificationService(sc);
  const realtimeSvc = new RealtimeActivityService(sc);

  const ok = await svc.markRead(user.id, req.params.id);
  if (!ok) { sendError(res, 'not_found', 'Notification not found'); return; }
  realtimeSvc.emitRead(user.id, req.params.id);
  res.json({ ok: true });
});

/** POST /me/notifications/:id/dismiss */
router.post('/me/notifications/:id/dismiss', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const svc = new NotificationService(sc);

  const ok = await svc.dismiss(user.id, req.params.id);
  if (!ok) { sendError(res, 'not_found', 'Notification not found'); return; }
  res.json({ ok: true });
});

/** GET /me/notification-preferences */
router.get('/me/notification-preferences', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const prefSvc = new NotificationPreferenceService(sc);

  const [prefs, catPrefs] = await Promise.all([
    prefSvc.getPreferences(user.id),
    prefSvc.getCategoryPreferences(user.id),
  ]);
  res.json({ preferences: prefs, categoryPreferences: catPrefs });
});

const UpdatePrefsSchema = z.object({
  pushEnabled:       z.boolean().optional(),
  emailEnabled:      z.boolean().optional(),
  inAppEnabled:      z.boolean().optional(),
  digestsEnabled:    z.boolean().optional(),
  safetyOverride:    z.boolean().optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStart:        z.string().regex(/^\d{2}:\d{2}$/).optional(),
  quietEnd:          z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone:          z.string().max(64).nullable().optional()
                       .refine((tz) => tz == null || isValidTimezone(tz), 'Invalid IANA timezone'),
  messagePreviews:   z.boolean().optional(),
  locationPreviews:  z.boolean().optional(),
  categoryPreferences: z.array(z.object({
    category:      z.enum(NOTIFICATION_CATEGORIES),
    inAppEnabled:  z.boolean().optional(),
    pushEnabled:   z.boolean().optional(),
    emailEnabled:  z.boolean().optional(),
    digestEnabled: z.boolean().optional(),
  })).optional(),
});

/** PUT /me/notification-preferences */
router.put('/me/notification-preferences', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = UpdatePrefsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const sc = getServiceClient() ?? client;
  const prefSvc = new NotificationPreferenceService(sc);

  const { categoryPreferences, ...globalPatch } = parsed.data;
  const prefs = await prefSvc.upsertPreferences(user.id, globalPatch);

  if (categoryPreferences && categoryPreferences.length > 0) {
    await Promise.all(
      categoryPreferences.map((cp) =>
        prefSvc.upsertCategoryPreferences(user.id, cp.category as NotificationCategory, cp),
      ),
    );
  }

  res.json({ ok: true, preferences: prefs });
});

const RegisterDeviceSchema = z.object({
  pushToken: z.string().min(10),
  platform:  z.enum(['expo', 'apns', 'fcm']).optional().default('expo'),
  label:     z.string().max(100).optional(),
});

/** POST /me/devices */
router.post('/me/devices', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const parsed = RegisterDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const sc = getServiceClient() ?? client;

  // Upsert device token
  const { data, error } = await sc
    .from('notification_devices')
    .upsert({
      user_id:      user.id,
      push_token:   parsed.data.pushToken,
      platform:     parsed.data.platform,
      label:        parsed.data.label ?? null,
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'user_id,push_token' })
    .select('id')
    .single();

  if (error) { sendError(res, 'db_error', error.message); return; }

  // Remove stale tokens: delete all OTHER rows for this user+platform.
  // When the app is re-installed, a new push token is issued while the old
  // row stays in the table. The old token triggers DeviceNotRegistered on
  // the next push attempt, but proactively deleting it here keeps the table
  // bounded without waiting for a failed delivery.
  const { error: cleanupErr } = await sc
    .from('notification_devices')
    .delete()
    .eq('user_id', user.id)
    .eq('platform', parsed.data.platform)
    .neq('push_token', parsed.data.pushToken);

  if (cleanupErr) {
    (req as any).log?.warn({ err: cleanupErr, userId: user.id }, 'devices: stale-token cleanup failed — old tokens may accumulate');
  }

  // Claim this push token EXCLUSIVELY. An Expo/APNs token is tied to the device
  // + app install, not the account, so on a shared or re-logged-in device a
  // prior user's row for the SAME token survives — and a push aimed at that user
  // is then delivered to whoever holds the device now. Remove every OTHER user's
  // row for this token so a token maps to at most one user (the latest to claim).
  const { error: claimErr } = await sc
    .from('notification_devices')
    .delete()
    .eq('push_token', parsed.data.pushToken)
    .neq('user_id', user.id);
  if (claimErr) {
    (req as any).log?.warn({ err: claimErr, userId: user.id }, 'devices: exclusive-token claim failed — token may deliver to the wrong user');
  }

  // Backfill legacy expo_push_token on profiles (keep for SafeReturn compat)
  if (parsed.data.platform === 'expo') {
    // Detach this token from any OTHER account that still carries it on the
    // legacy profile / buddy fields — the same cross-user delivery hazard as
    // notification_devices, on the SafeReturn / rent-a-buddy push paths.
    await sc.from('profiles').update({ expo_push_token: null })
      .eq('expo_push_token', parsed.data.pushToken).neq('id', user.id);
    await sc.from('rent_buddy_profiles').update({ expo_push_token: null })
      .eq('expo_push_token', parsed.data.pushToken).neq('user_id', user.id);

    await sc.from('profiles').update({ expo_push_token: parsed.data.pushToken }).eq('id', user.id);
    // Also store on the buddy profile (if the user is a Buddy) so
    // rent-a-buddy request alerts can be delivered to their device.
    const { error: buddyTokenErr } = await sc
      .from('rent_buddy_profiles')
      .update({ expo_push_token: parsed.data.pushToken })
      .eq('user_id', user.id);
    if (buddyTokenErr) {
      (req as any).log?.warn({ err: buddyTokenErr, userId: user.id }, 'devices: rent_buddy_profiles token backfill failed');
    }
  }

  res.status(201).json({ ok: true, deviceId: (data as any).id });
});

/** DELETE /me/devices/:id */
router.delete('/me/devices/:id', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const { error } = await sc
    .from('notification_devices')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', user.id);

  if (error) { sendError(res, 'db_error', error.message); return; }
  res.json({ ok: true });
});

/**
 * GET /me/notifications/stream — SSE realtime stream
 * Client should reconnect on connection drop (standard SSE behaviour).
 */
router.get('/me/notifications/stream', async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const sc = getServiceClient() ?? client;
  const realtimeSvc = new RealtimeActivityService(sc);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send a heartbeat comment every 30s to keep the connection alive
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 30_000);

  const cleanup = realtimeSvc.registerSSEStream(user.id, (data) => {
    res.write(data);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const CreateNotificationSchema = z.object({
  userId:     z.string().uuid(),
  eventType:  z.string().min(1),
  params:     z.record(z.string()).optional(),
  title:      z.string().optional(),
  body:       z.string().optional(),
  category:   z.enum(NOTIFICATION_CATEGORIES).optional(),
  priority:   z.enum(['urgent','important','normal','low']).optional(),
  channels:   z.array(z.string()).optional(),
  actionUrl:  z.string().optional(),
  imageUrl:   z.string().optional(),
  sourceType: z.string().optional(),
  sourceId:   z.string().optional(),
  actorId:    z.string().uuid().optional(),
  metadata:   z.record(z.unknown()).optional(),
  expiresAt:  z.string().optional(),
  tripId:     z.string().uuid().optional(),
  senderId:   z.string().uuid().optional(),
  isLiveShare: z.boolean().optional(),
});

/** POST /internal/notifications — create a notification (store only, no routing) */
router.post('/internal/notifications', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const parsed = CreateNotificationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_payload', message: parsed.error.issues[0]?.message });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ error: 'server_not_configured' }); return; }

  const svc = new NotificationService(sc);
  const notification = await svc.create(parsed.data);

  if (!notification) {
    res.status(200).json({ ok: true, created: false, reason: 'blocked_or_deduped' });
    return;
  }

  res.status(201).json({ ok: true, created: true, notification });
});

/** POST /internal/notifications/send — create + route (push etc.) */
router.post('/internal/notifications/send', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const parsed = CreateNotificationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_payload', message: parsed.error.issues[0]?.message });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ error: 'server_not_configured' }); return; }

  const svc = new NotificationService(sc);
  const notifRouter = new NotifRouter(sc);
  const realtimeSvc = new RealtimeActivityService(sc);

  const notification = await svc.create(parsed.data);
  if (!notification) {
    res.status(200).json({ ok: true, created: false, reason: 'blocked_or_deduped' });
    return;
  }

  // Route asynchronously (push etc.) — don't block the HTTP response
  void notifRouter.route(notification).catch(() => {});
  realtimeSvc.emitCreated(notification);

  res.status(201).json({ ok: true, created: true, notification });
});

/** POST /internal/notifications/digest — trigger daily digest for a user */
router.post('/internal/notifications/digest', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const { userId } = req.body ?? {};
  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ error: 'server_not_configured' }); return; }

  const digestSvc = new NotificationDigestService(sc);

  if (userId) {
    await digestSvc.sendDailyDigest(userId as string);
    res.json({ ok: true, mode: 'single', userId });
  } else {
    const { usersProcessed } = await digestSvc.runForAllUsers();
    res.json({ ok: true, mode: 'all', usersProcessed });
  }
});

/** POST /internal/activity-events — log a raw activity event */
router.post('/internal/activity-events', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const schema = z.object({
    userId:    z.string().uuid(),
    eventType: z.string().min(1),
    category:  z.string().min(1),
    actorId:   z.string().uuid().optional(),
    sourceType: z.string().optional(),
    sourceId:  z.string().optional(),
    metadata:  z.record(z.unknown()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_payload', message: parsed.error.issues[0]?.message });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ error: 'server_not_configured' }); return; }

  const { error } = await sc.from('activity_events').insert({
    user_id:    parsed.data.userId,
    event_type: parsed.data.eventType,
    category:   parsed.data.category,
    actor_id:   parsed.data.actorId ?? null,
    source_type: parsed.data.sourceType ?? null,
    source_id:  parsed.data.sourceId ?? null,
    metadata:   parsed.data.metadata ?? {},
  });

  if (error) { req.log.error({ err: error }, 'internal activity-event insert failed'); sendError(res, 'db_error', error.message); return; }
  res.status(201).json({ ok: true });
});

/** POST /internal/notifications/expire — hard-delete expired rows */
router.post('/internal/notifications/expire', async (req, res) => {
  if (!requireInternalSecret(req, res)) return;

  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ error: 'server_not_configured' }); return; }

  const svc = new NotificationService(sc);
  const deleted = await svc.expireOldNotifications();
  res.json({ ok: true, deleted });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /admin/notification-templates */
router.get('/admin/notification-templates', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const templates = TEMPLATES.map((t) => ({
    eventType:       t.eventType,
    category:        t.category,
    defaultPriority: t.defaultPriority,
    defaultChannels: t.defaultChannels,
  }));
  res.json({ templates, total: templates.length });
});

/** POST /admin/notifications/account-notice */
router.post('/admin/notifications/account-notice', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const schema = z.object({
    userId:  z.string().uuid(),
    subject: z.string().min(1).max(200),
    body:    z.string().min(1).max(2000),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const svc = new NotificationService(admin.sc);
  const notifRouter = new NotifRouter(admin.sc);

  const notification = await svc.create({
    userId:    parsed.data.userId,
    eventType: 'admin.account_notice',
    params:    { subject: parsed.data.subject, body: parsed.data.body },
    priority:  'urgent',
    metadata:  { sentBy: admin.userId },
    sourceType: 'admin',
    sourceId:  admin.userId,
  });

  if (!notification) {
    res.json({ ok: false, reason: 'blocked_or_deduped' });
    return;
  }

  void notifRouter.route(notification).catch(() => {});
  res.status(201).json({ ok: true, notification });
});

/**
 * GET /admin/push-retry-health
 *
 * Returns a snapshot of push_retry_queue health:
 *   queued_count      — rows still awaiting retry (non-zero means retries are pending)
 *   failed_count      — rows that exhausted all attempts (non-zero signals delivery loss)
 *   oldest_queued_at  — created_at of the oldest queued row; null if the queue is empty
 *   last_succeeded_at — updated_at of the most recently sent row; null if none yet
 *
 * A stale oldest_queued_at (e.g. > 2 minutes old with queued_count > 0) may indicate
 * the push retry worker has stalled.
 */
router.get('/admin/push-retry-health', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const [
    { count: queuedCount, error: e1 },
    { count: failedCount, error: e2 },
    { data: oldestRows,   error: e3 },
    { data: lastSentRows, error: e4 },
  ] = await Promise.all([
    admin.sc.from('push_retry_queue').select('*', { count: 'exact', head: true }).eq('status', 'queued') as any,
    admin.sc.from('push_retry_queue').select('*', { count: 'exact', head: true }).eq('status', 'failed') as any,
    admin.sc.from('push_retry_queue').select('created_at').eq('status', 'queued').order('created_at', { ascending: true }).limit(1) as any,
    admin.sc.from('push_retry_queue').select('updated_at').eq('status', 'sent').order('updated_at', { ascending: false }).limit(1) as any,
  ]);

  const firstError = e1 ?? e2 ?? e3 ?? e4;
  if (firstError) { sendError(res, 'db_error', firstError.message); return; }

  res.json({
    queued_count:      queuedCount ?? 0,
    failed_count:      failedCount ?? 0,
    oldest_queued_at:  (oldestRows  as any[])?.[0]?.created_at  ?? null,
    last_succeeded_at: (lastSentRows as any[])?.[0]?.updated_at ?? null,
  });
});

/** GET /admin/notification-delivery-attempts
 *
 * Lists delivery attempt records (paginated, filterable by status and channel).
 * Attempts created by the push retry queue have status='pending' until the queue
 * worker resolves them to 'sent' or 'failed'.
 */
router.get('/admin/notification-delivery-attempts', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const limit  = Math.min(Number(req.query.limit ?? 50), 200);
  const offset = Number(req.query.offset ?? 0);
  const status = req.query.status as string | undefined;
  const channel = req.query.channel as string | undefined;

  let query = admin.sc
    .from('notification_delivery_attempts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status)  query = (query as any).eq('status', status);
  if (channel) query = (query as any).eq('channel', channel);

  const { data, error, count } = await (query as any);
  if (error) { sendError(res, 'db_error', error.message); return; }
  res.json({ attempts: data ?? [], total: count ?? 0 });
});

/**
 * PUT /admin/notification-defaults — toggle the notification feature flags.
 *
 * ONLY pushNotificationsEnabled REMAINS, AND THAT IS THE WHOLE POINT.
 * ==================================================================
 *
 * This handler used to accept five fields and write five flag rows. Four of
 * those rows were read by nothing: `notifications_enabled` (described in 0062
 * as the "Master switch for the in-app notification system"),
 * `notification_digests_enabled`, `realtime_activity_enabled` and
 * `safety_notifications_enabled`. An admin could set any of them, receive
 * `ok: true`, and change no code path — the surface each one named ran exactly
 * as before, in either position. They were retired on 2026-08-12 by
 * 2080_retire_inert_seeded_flags.sql after a wire-or-drop pass found no live
 * reader for any of them.
 *
 * `push_notifications_enabled` is genuinely wired and stays: it is read in
 * lib/pushWithRetry.ts, lib/pushRetryQueue.ts,
 * services/notifications/NotificationRouter.ts and
 * services/passport/StampAwardEngine.ts. So push delivery keeps a working
 * operator kill switch, which is the capability the four removed fields
 * appeared to offer and did not.
 *
 * The four fields are now rejected rather than silently ignored. Zod's default
 * strip behaviour would accept and discard them, which would preserve the exact
 * defect being removed: a caller sending `safetyNotificationsEnabled: false`
 * would still get `ok: true` back and still change nothing. `.strict()` makes
 * that a 400 naming the field.
 */
router.put('/admin/notification-defaults', async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const schema = z.object({
    pushNotificationsEnabled: z.boolean().optional(),
  }).strict();

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 'invalid_payload', parsed.error.issues[0]?.message ?? 'Invalid body');
    return;
  }

  const flagMap: Record<string, string> = {
    pushNotificationsEnabled: 'push_notifications_enabled',
  };

  const updated: Record<string, boolean> = {};
  for (const [key, flagName] of Object.entries(flagMap)) {
    const val = (parsed.data as any)[key];
    if (val !== undefined) {
      await admin.sc.from('feature_flags').update({ enabled: val, updated_at: new Date().toISOString() }).eq('flag', flagName);
      updated[key] = val;
    }
  }

  res.json({ ok: true, updated });
});

export default router;
