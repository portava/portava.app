import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { checkRateLimit } from '../lib/rateLimit.js';
const router = Router();
const uuid = z.string().uuid();
const start = z.object({ sessionId: uuid, consentVersion: z.literal('trip-nearby-v1'), durationMinutes: z.number().int().min(1).max(15) }).strict();
const observation = z.object({ sessionId: uuid, token: z.string().regex(/^[a-f0-9]{64}$/), proximity: z.enum(['very_close','nearby','within_area','weak']), observedAt: z.string().datetime() }).strict();
const session = z.object({ sessionId: uuid }).strict();
export const nearbySchemas = { start, observation, session };
router.get('/trips/:tripId/nearby', asyncHandler(async (req, res) => {
 const auth = await requireUser(req,res); if(!auth)return;
 if(!uuid.safeParse(req.params.tripId).success)return sendError(res,'invalid_payload');
 const db=getServiceClient();if(!db)return sendError(res,'server_not_configured');
 const [flag,member]=await Promise.all([
  db.from('feature_flags').select('enabled').eq('flag','trip_nearby_checkpoints_enabled').maybeSingle(),
  db.rpc('trip_nearby_member_eligible',{p_actor:auth.user.id,p_trip:req.params.tripId}),
 ]);
 if(flag.error||member.error)return sendError(res,'degraded_unavailable','Nearby checkpoints could not be checked.');
 res.setHeader('Cache-Control','no-store');res.json({available:flag.data?.enabled===true&&member.data===true,consentVersion:'trip-nearby-v1'});
}));
for(const action of ['start','renew','read','observe','stop'] as const){
 router.post(`/trips/:tripId/nearby/${action}`,asyncHandler(async(req,res)=>{
  const auth=await requireUser(req,res);if(!auth)return;
  const parsed=(action==='start'?start:action==='observe'?observation:session).safeParse(req.body);
  if(!uuid.safeParse(req.params.tripId).success||!parsed.success)return sendError(res,'invalid_payload','Invalid nearby checkpoint request.');
  // Stop is always allowed, including when collection/permissions are revoked.
  if(action!=='stop'&&!checkRateLimit('trip_nearby_'+action,auth.user.id,action==='observe'?60:action==='start'?6:30,60000).allowed)return sendError(res,'rate_limited');
  const db=getServiceClient();if(!db)return sendError(res,'server_not_configured');
  const {sessionId,...payload}=parsed.data;
  const r=await db.rpc('trip_nearby_command',{p_actor:auth.user.id,p_trip:req.params.tripId,p_action:action,p_session:sessionId,p_payload:payload});
  if(r.error||!r.data||typeof r.data!=='object')return sendError(res,'degraded_unavailable','Nearby checkpoints could not be confirmed.');
  res.setHeader('Cache-Control','no-store');res.json(r.data);
 }));
}
export default router;
