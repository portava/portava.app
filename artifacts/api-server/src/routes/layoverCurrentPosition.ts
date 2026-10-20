import { Router } from 'express';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { isFlagEnabled } from '../lib/featureFlags.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { currentPositionRequestSchema, previewCurrentPosition } from '../services/airport/LayoverCurrentPosition.js';
const router=Router();
router.post('/airport/sessions/:id/current-position-check',asyncHandler(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');const auth=await requireUser(req,res);if(!auth)return;
  const db=getServiceClient();if(!db){sendError(res,'server_not_configured');return;}
  if(!await isFlagEnabled(db,'airport_mode_enabled')){sendError(res,'feature_disabled');return;}
  const parsed=currentPositionRequestSchema.safeParse(req.body);if(!parsed.success){sendError(res,'invalid_payload','A current, accurate location and a current recommendation are required.');return;}
  const result=await previewCurrentPosition(db,auth.user.id,req.params.id,parsed.data);
  if(!result.ok){if(result.reason==='not_found'||result.reason==='feature_disabled'){sendError(res,result.reason);return;}res.status(/unreadable$/.test(result.reason)||result.reason==='position_check_unavailable'||result.reason==='PROVIDER_UNAVAILABLE'?503:409).json(result);return;}res.json(result);
}));
export default router;
