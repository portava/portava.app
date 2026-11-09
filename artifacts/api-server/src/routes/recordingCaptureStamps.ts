import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { isUuid } from '../lib/followDecisions.js';
import { requireUser, sendError, isAcceptedTripMember } from '../lib/http.js';
import { canReadPost, needsFollowerCheck, needsTripMembershipCheck } from '../lib/postVisibility.js';
import { excludePrivateAuthorPosts } from '../lib/privacyFilter.js';
import { readPairDirections } from '../lib/exclusionSet.js';
import { resolveAccountRestriction } from '../lib/accountStateGate.js';
import { authorizeMediaAccess } from '../lib/mediaAccess.js';
import { checkStoryAccess, STORY_COLS } from './stories.js';
import { issueRecordingStamp, openRecordingCapture, recordingStampDescriptor, type RecordingTarget } from '../services/stamps/recordingCapture.js';

const router = Router();
const issueBody = z.object({captureToken:z.string().min(1).max(96), targetType:z.enum(['story','post']), targetId:z.string().uuid()}).strict();
function refusal(res: Response, err: unknown) {
  const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : '';
  if (message.includes('capture_rate_limit')) return sendError(res,'rate_limited','Please wait before starting another recording stamp.');
  if (message.includes('capture_refused')) return sendError(res,'conflict','This recording cannot be stamped for this publication.');
  return sendError(res,'degraded_unavailable','Recording stamps are temporarily unavailable.');
}
async function publicationReadable(sc: any, viewer: string, type: RecordingTarget, id: string) {
  if (type === 'story') {
    const read = await sc.from('stories').select(STORY_COLS).eq('id',id).maybeSingle();
    if (read.error) throw read.error;
    if (!read.data || read.data.state !== 'active' || !(Date.parse(read.data.expires_at)>Date.now())) return false;
    const access = await checkStoryAccess(sc, read.data, viewer);
    if (!access.allowed && access.reason === 'undecidable') throw new Error('story_audience_unavailable');
    return access.allowed;
  }
  const read = await sc.from('posts').select('id,author_id,status,post_status,deleted_at,visibility,trip_id').eq('id',id).maybeSingle();
  if (read.error) throw read.error;
  const post=read.data;
  if (!post || post.status!=='active' || post.deleted_at || post.post_status!=='published') return false;
  if (post.author_id!==viewer) {
    const blocks=await readPairDirections(sc,viewer,post.author_id);
    if (!blocks.ok) throw new Error('audience_unavailable');
    if (blocks.aBlockedB || blocks.bBlockedA) return false;
  }
  const author=await resolveAccountRestriction(sc,post.author_id);
  if (author.state!=='ok') throw new Error('author_unavailable');
  if (author.accountStatus!=='active' || author.restriction.kind!=='none') return false;
  const member=needsTripMembershipCheck(post,viewer) && await isAcceptedTripMember(sc,post.trip_id,viewer);
  let follows=false;
  if (needsFollowerCheck(post,viewer)) {
    const readFollow=await sc.from('user_follows').select('following_id').eq('following_id',post.author_id).eq('follower_id',viewer).maybeSingle();
    if (readFollow.error) throw readFollow.error;
    follows=Boolean(readFollow.data);
  }
  return canReadPost(post,viewer,member,follows) && (await excludePrivateAuthorPosts([post],viewer,sc)).length===1;
}
async function visibleStamp(sc: any, viewer: string, type: RecordingTarget, id: string) {
  const read = await sc.rpc('read_recording_capture',{p_type:type,p_target:id});
  if (read.error || !Array.isArray(read.data)) throw read.error ?? new Error('stamp_read_failed');
  const row=read.data[0];
  if (!row || !await publicationReadable(sc,viewer,type,id) || !await authorizeMediaAccess(sc,viewer,'post-media',row.storage_path)) return null;
  return recordingStampDescriptor(row,type,id);
}
router.post('/capture-stamps/sessions',asyncHandler(async(req,res)=>{
  const auth=await requireUser(req,res); if (!auth) return;
  try {res.status(201).set('Cache-Control','no-store').json(await openRecordingCapture(auth.client,auth.user.id));}
  catch (err) {refusal(res,err);}
}));
router.post('/capture-stamps/issue',asyncHandler(async(req,res)=>{
  const auth=await requireUser(req,res); if (!auth) return;
  const parsed=issueBody.safeParse(req.body);
  if (!parsed.success) {sendError(res,'invalid_payload','Invalid recording stamp request.');return;}
  const {captureToken,targetType,targetId}=parsed.data;
  try {
    const issued=await issueRecordingStamp(auth.client,auth.user.id,captureToken,targetType,targetId);
    const stamp=await visibleStamp(auth.client,auth.user.id,targetType,targetId);
    if (!stamp || stamp.id!==issued) {refusal(res,new Error('capture_refused'));return;}
    res.status(200).set('Cache-Control','no-store').json({stamp});
  } catch (err) {refusal(res,err);}
}));
router.get('/capture-stamps/:type/:id',asyncHandler(async(req,res)=>{
  const auth=await requireUser(req,res); if (!auth) return;
  const type=req.params.type, id=req.params.id;
  if ((type!=='post' && type!=='story') || !isUuid(id)) {sendError(res,'invalid_payload','Invalid recording stamp target.');return;}
  try {res.set('Cache-Control','private, no-store').json({stamp:await visibleStamp(auth.client,auth.user.id,type,id)});}
  catch (err) {refusal(res,err);}
}));
export default router;
