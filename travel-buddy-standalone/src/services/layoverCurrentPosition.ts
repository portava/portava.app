import { z } from 'zod';
import { freshToken } from './apiToken.ts';
import type { ReturnRouteOrigin } from './layover.ts';
const instant=z.string().refine(v=>Number.isFinite(Date.parse(v))),minutes=z.number().finite().min(0);
const leg=z.object({departAt:instant,arrivesAt:instant,minutes,conservativeMinutes:minutes,expiresAt:instant,confidence:z.string(),mode:z.enum(['walk','drive'])});
export const currentPositionPreviewSchema=z.object({requestId:z.string().uuid(),sessionId:z.string(),snapshotId:z.string(),candidateId:z.string(),previewOnly:z.literal(true),expiresAt:instant,hardReturnBy:instant,riskBand:z.enum(['LOW','MODERATE','HIGH']),reasonCodes:z.array(z.string()),activityCommitment:z.unknown(),window:z.object({beginsAt:instant,endsAt:instant,usableMinutes:minutes,confidence:z.string()}),outbound:leg,activityMinutes:minutes,returnRoute:leg,currentReturn:leg,disclosure:z.string()});
export type CurrentPositionPreview=z.infer<typeof currentPositionPreviewSchema>;
export async function checkLayoverCurrentPosition(sessionId:string,candidateId:string,snapshotId:string,requestId:string,origin:ReturnRouteOrigin):Promise<{ok:true;preview:CurrentPositionPreview}|{ok:false;reason:string}>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try {const token=await freshToken();const response=await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL??''}/api/airport/sessions/${encodeURIComponent(sessionId)}/current-position-check`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({candidateId,snapshotId,requestId,origin}),cache:'no-store',signal:controller.signal});const body=await response.json();if(!response.ok||body?.ok!==true)return {ok:false,reason:typeof body?.reason==='string'?body.reason:'position_check_unavailable'};
    const parsed=currentPositionPreviewSchema.safeParse(body.preview);if(!parsed.success||parsed.data.requestId!==requestId||parsed.data.sessionId!==sessionId||parsed.data.snapshotId!==snapshotId||parsed.data.candidateId!==candidateId||Date.parse(parsed.data.expiresAt)<=Date.now())return {ok:false,reason:'position_check_expired'};return {ok:true,preview:parsed.data};
  }catch{return {ok:false,reason:'position_check_unavailable'};}finally{clearTimeout(timer);}
}
