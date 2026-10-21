/** L144 booked Buddy disclosure: literal per-abort consent plus current sharing,
 * owned 3894 binding, accepted booking and both-way blocks. Booking alone never
 * authorizes disclosure. Only generic in-app text; no traveler identity/location. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../../lib/featureFlags.js';
import { logger } from '../../lib/logger.js';
import { readBlockExclusions } from '../../lib/exclusionSet.js';
import { wallTimeToUtc } from '../airport/AirportTime.js';
import { evaluateSharingGate, discloseSharingGate, publishableUserIds } from '../airport/LayoverPrivacyGuard.js';
import { NotificationService } from '../notifications/NotificationService.js';
import { NotificationRouter } from '../notifications/NotificationRouter.js';

export type BuddyAbortNoticeRequest = { requested: boolean; enabled: boolean };
export type BuddyAbortNoticeReason = 'buddy_notify_not_enabled'|'not_requested'|'booking_unavailable'|'no_buddy_to_tell'|'blocks_unreadable'|'sharing_preferences_unreadable'|'sharing_not_allowed'|'notify_failed'|'notify_partially_failed'|'notify_timed_out';
export type BuddyAbortNoticeOutcome = { notifiedCount:number; reason:BuddyAbortNoticeReason|null };
export const BUDDY_ABORT_NOTICE_OFF: BuddyAbortNoticeRequest = { requested:false,enabled:false };
const EVENT='layover.buddy.traveler_heading_back', SOURCE='layover_buddy_abort';
const untold=(reason:BuddyAbortNoticeReason):BuddyAbortNoticeOutcome=>({notifiedCount:0,reason});
async function enabled(db:SupabaseClient):Promise<boolean>{return await isFlagEnabled(db,'layover_crew_abort_notify_enabled') && await isFlagEnabled(db,'layover_buddy_specialist_enabled') && await isFlagEnabled(db,'rent_buddy_enabled');}
export async function buddyAbortNoticeRequest(db:SupabaseClient,body:unknown):Promise<BuddyAbortNoticeRequest>{return {requested:typeof body==='object'&&body!==null&&(body as {tellBuddy?:unknown}).tellBuddy===true,enabled:await enabled(db)};}
type Recipient={bookingId:string;userId:string};
type Recipients={ok:true;value:Recipient[]}|{ok:false;reason:BuddyAbortNoticeReason};
async function recipients(db:SupabaseClient,userId:string,sessionId:string,nowMs:number):Promise<Recipients>{
 const fail=(reason:BuddyAbortNoticeReason):Recipients=>({ok:false,reason});
 const session=await db.from('layover_sessions').select('id,user_id,status,trip_id,departure_time').eq('id',sessionId).eq('user_id',userId).maybeSingle();
 if(session.error||!session.data||!['active','returning'].includes(session.data.status)||!(Date.parse(session.data.departure_time)>nowMs))return fail('booking_unavailable');
 const sharing=discloseSharingGate(await evaluateSharingGate(db,{userId,tripId:session.data.trip_id??null}));
 if(sharing.degraded)return fail('sharing_preferences_unreadable');if(!sharing.allowed)return fail('sharing_not_allowed');
 const links=await db.from('layover_buddy_booking_links').select('booking_id,user_id,timezone,certified_end_by').eq('layover_session_id',sessionId).eq('user_id',userId).limit(11);
 if(links.error||!Array.isArray(links.data)||links.data.length>10)return fail('booking_unavailable');
 if(!links.data.length)return {ok:true,value:[]};
 const bookings=await db.from('rent_buddy_bookings').select('id,buddy_id,traveler_id,category,status,booking_date,start_time,duration_h').in('id',links.data.map(l=>l.booking_id)).eq('traveler_id',userId).eq('category','layover').in('status',['confirmed','scheduled','in_progress']);
 if(bookings.error||!Array.isArray(bookings.data))return fail('booking_unavailable');
 const current=bookings.data.filter(b=>{const link=links.data.find(l=>l.booking_id===b.id);if(!link)return false;const start=wallTimeToUtc(link.timezone,`${b.booking_date}T${b.start_time}`);return start!==null&&Number(b.duration_h)>0&&start.getTime()+Number(b.duration_h)*3600000>nowMs&&Date.parse(link.certified_end_by)>nowMs;});
 if(!current.length)return {ok:true,value:[]};
 const buddies=await db.from('rent_buddy_profiles').select('id,user_id').in('id',current.map(b=>b.buddy_id));if(buddies.error||!Array.isArray(buddies.data))return fail('booking_unavailable');
 const candidates=current.flatMap(b=>{const buddy=buddies.data.find(p=>p.id===b.buddy_id);return buddy&&buddy.user_id!==userId?[{bookingId:b.id,userId:buddy.user_id}]:[];});
 const ids=[...new Set(candidates.map(c=>c.userId))];if(!ids.length)return {ok:true,value:[]};
 const blocks=await readBlockExclusions(db,userId,{among:ids});if(!blocks.ok)return fail('blocks_unreadable');
 const published=await publishableUserIds(db,ids);if(published.kind==='degraded')return fail('sharing_preferences_unreadable');
 return {ok:true,value:candidates.filter(c=>!blocks.ids.has(c.userId)&&published.value.allowed.includes(c.userId))};
}
export async function buddyAbortNoticeCapability(db:SupabaseClient,userId:string,sessionId:string,nowMs:number):Promise<{available:boolean;reason:BuddyAbortNoticeReason|null}>{
 try{if(!await enabled(db))return {available:false,reason:'buddy_notify_not_enabled'};const r=await recipients(db,userId,sessionId,nowMs);return r.ok?{available:r.value.length>0,reason:r.value.length?null:'no_buddy_to_tell'}:{available:false,reason:r.reason};}catch(err){logger.warn({err},'Buddy abort capability unavailable');return {available:false,reason:'booking_unavailable'};}
}
/** Opaque UUID v8 identity. PK prevents duplicates across workers, retries and the general dedup window. */
export function buddyAbortNoticeId(sessionId:string,bookingId:string,recipientId:string):string{const h=createHash('sha256').update(`layover-buddy-abort:v1:${sessionId}:${bookingId}:${recipientId}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
async function prior(db:SupabaseClient,id:string,recipient:Recipient):Promise<'present'|'absent'|'unreadable'>{
 const r=await db.from('notifications').select('id,user_id,event_type,source_type,source_id,actor_id,action_url,title,body,metadata,category,priority,image_url').eq('id',id).maybeSingle();if(r.error)return 'unreadable';if(!r.data)return 'absent';
 return r.data.user_id===recipient.userId&&r.data.event_type===EVENT&&r.data.source_type===SOURCE&&r.data.source_id===id&&r.data.actor_id===null&&r.data.image_url===null&&r.data.category==='airport'&&r.data.priority==='normal'&&r.data.metadata!==null&&typeof r.data.metadata==='object'&&Object.keys(r.data.metadata).length===0&&r.data.action_url===`/booking/${recipient.bookingId}`&&r.data.title==='Your booked traveler'&&r.data.body==='Your booked traveler is heading back to the airport.'?'present':'unreadable';
}
export async function tellBuddyOfAbort(db:SupabaseClient,input:{userId:string;sessionId:string;nowMs:number;request:BuddyAbortNoticeRequest;cancelled?:()=>boolean}):Promise<BuddyAbortNoticeOutcome>{
 if(!input.request.enabled)return untold('buddy_notify_not_enabled');if(!input.request.requested)return untold('not_requested');
 try{
  if(!await enabled(db))return untold('buddy_notify_not_enabled');
  const targets=await recipients(db,input.userId,input.sessionId,input.nowMs);if(!targets.ok)return untold(targets.reason);if(!targets.value.length)return untold('no_buddy_to_tell');
  const outcomes=await Promise.all(targets.value.map(async recipient=>{
   const id=buddyAbortNoticeId(input.sessionId,recipient.bookingId,recipient.userId),existing=await prior(db,id,recipient);
   if(existing==='present')return true;if(existing==='unreadable'||input.cancelled?.())return false;
   const result=await new NotificationService(db).createDetailed({idempotentId:id,userId:recipient.userId,eventType:EVENT,sourceType:SOURCE,sourceId:id,actionUrl:`/booking/${recipient.bookingId}`});
   if(result.row){void new NotificationRouter(db).route(result.row).catch(err=>logger.warn({err},'Buddy abort routing failed'));return true;}
   // A losing concurrent insert is success only if its exact winner is readable.
   return await prior(db,id,recipient)==='present';
  }));
  const count=outcomes.filter(Boolean).length;return {notifiedCount:count,reason:count===outcomes.length?null:input.cancelled?.()?'notify_timed_out':count?'notify_partially_failed':'notify_failed'};
 }catch(err){logger.warn({err},'Buddy abort notice unavailable');return untold('notify_failed');}
}
export async function tellBuddyOfAbortWithin(db:SupabaseClient,input:Parameters<typeof tellBuddyOfAbort>[1],deadlineMs=2500):Promise<BuddyAbortNoticeOutcome>{
 if(!input.request.enabled||!input.request.requested)return tellBuddyOfAbort(db,input);
 let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([tellBuddyOfAbort(db,{...input,cancelled:()=>cancelled}),new Promise<BuddyAbortNoticeOutcome>(resolve=>{timer=setTimeout(()=>{cancelled=true;resolve(untold('notify_timed_out'));},deadlineMs);})]);}finally{if(timer)clearTimeout(timer);}
}
