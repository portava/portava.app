import { recordNavigationContribution } from '../lib/mapNavigationContribution.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { readRouteFlowConsent } from '../lib/mapRouteFlowConsent.js';
import { PERSONAL_PROTECTED_CATEGORIES } from '../lib/mapPersonalProtection.js';
const router = Router();
const protectedPlace = z.object({ category: z.enum(PERSONAL_PROTECTED_CATEGORIES), lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180), radiusMeters: z.number().int().min(1000).max(5000).default(1500) }).strict();
const consent = z.object({ granted: z.boolean(), displayedVersion: z.string().min(1).max(64).optional() }).strict();
export function parseProtectedPlace(input: unknown) { return protectedPlace.safeParse(input); }
router.get('/map/privacy/protected-places', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const db = getServiceClient(); if (!db) return sendError(res, 'server_not_configured');
  const { data, error } = await db.from('map_personal_protected_places').select('id,category,center_lat,center_lng,radius_meters').eq('owner_user_id', auth.user.id).order('category');
  if (error || !Array.isArray(data)) return sendError(res, 'degraded_unavailable', 'Protected places could not be read.');
  res.json({ places: data.map(row => ({ id: row.id, category: row.category, lat: Number(row.center_lat), lng: Number(row.center_lng), radiusMeters: row.radius_meters })) });
}));
router.put('/map/privacy/protected-places', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const parsed = protectedPlace.safeParse(req.body); if (!parsed.success) return sendError(res, 'invalid_payload', 'Choose a home, work, or school area and a radius of at least 1 km.');
  const db = getServiceClient(); if (!db) return sendError(res, 'server_not_configured');
  const value = parsed.data;
  const { error } = await db.rpc('set_map_personal_protected_place', { p_user_id: auth.user.id, p_category: value.category, p_lat: Number(value.lat.toFixed(2)), p_lng: Number(value.lng.toFixed(2)), p_radius: value.radiusMeters });
  if (error) return sendError(res, 'degraded_unavailable', 'Protection could not be saved.');
  res.status(204).end();
}));
router.delete('/map/privacy/protected-places/:category', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const parsed = z.enum(PERSONAL_PROTECTED_CATEGORIES).safeParse(req.params.category); if (!parsed.success) return sendError(res, 'invalid_payload');
  const db = getServiceClient(); if (!db) return sendError(res, 'server_not_configured');
  const { error } = await db.from('map_personal_protected_places').delete().eq('owner_user_id', auth.user.id).eq('category', parsed.data);
  if (error) return sendError(res, 'degraded_unavailable', 'Protection could not be removed.');
  res.status(204).end();
}));
router.get('/map/privacy/route-flow', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return; const db = getServiceClient(); if (!db) return sendError(res, 'server_not_configured');
  try { res.json(await readRouteFlowConsent(db, auth.user.id)); } catch { sendError(res, 'degraded_unavailable', 'Route contribution settings could not be read.'); }
}));
router.put('/map/privacy/route-flow', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return; const parsed = consent.safeParse(req.body); if (!parsed.success) return sendError(res, 'invalid_payload');
  const db = getServiceClient(); if (!db) return sendError(res, 'server_not_configured');
  let version: string | null = null;
  if (parsed.data.granted) {
    try {
      const state = await readRouteFlowConsent(db, auth.user.id);
      if (!state.available || !state.disclosure) return sendError(res, 'feature_disabled');
      if (parsed.data.displayedVersion !== state.disclosure.version) return sendError(res, 'conflict', 'Review the current disclosure before opting in.');
      version = state.disclosure.version;
    } catch { return sendError(res, 'degraded_unavailable', 'Consent could not be checked.'); }
  }
  const { error } = await db.rpc('set_map_route_flow_consent', { p_user_id: auth.user.id, p_enabled: parsed.data.granted, p_version: version });
  if (error) return sendError(res, 'degraded_unavailable', 'Your change could not be confirmed.');
  res.status(204).end();
}));
const coordinate = z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict();
const navigation = z.object({ origin: coordinate, destination: coordinate, observedAt: z.number().int().nonnegative(), displayedVersion: z.string().min(1).max(64) }).strict();
router.post('/map/privacy/navigation', asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res); if (!auth) return;
  const parsed = navigation.safeParse(req.body); if (!parsed.success) return sendError(res, 'invalid_payload');
  if (!checkRateLimit('map_navigation_contribution', auth.user.id, 6, 60000).allowed) return sendError(res, 'rate_limited');
  const db = getServiceClient(); if (!db) return sendError(res, 'server_not_configured');
  try { res.json(await recordNavigationContribution(db, auth.user.id, parsed.data)); }
  catch { sendError(res, 'degraded_unavailable', 'This route could not contribute to area trends. Navigation is unaffected.'); }
}));
export default router;
