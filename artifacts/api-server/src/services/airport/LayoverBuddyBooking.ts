/** L273: one server-owned context for a layover specialist booking. No passport or flight data is sent to the buddy. */
import type {SupabaseClient} from '@supabase/supabase-js';
import {isFlagEnabled} from '../../lib/featureFlags.js';
import {isBlockedBetween} from '../../lib/blockGuard.js';
import {readCurrentIdentityVerification} from '../identityVerification/currentVerification.js';
import {readBuddyPaymentReadiness} from '../payments/bookingPayments/recipientReadiness.js';
import {getRestrictionState} from '../trust/TrustRestrictionService.js';
import {getSession} from './LayoverSessionService.js';
import {consumerLayoverRecord,resolveSessionAirport} from './LayoverSnapshot.js';
import {certifySessionFeasibility,certificationHeader,type LayoverFeasibilityRecord} from './LayoverFeasibility.js';
import {resolveLayoverEntry,layoverAirportCountry} from './layoverEntryGate.js';
import {resolveLayoverLiveConditions} from './layoverLiveSignals.js';
import {layoverBuddyDecision,isLayoverCompatibleBuddy} from './LayoverBuddyGate.js';
import {isValidTimezone,wallTimeToUtc,localDayString,localHourMinute} from './AirportTime.js'; import {logger as rootLogger} from '../../lib/logger.js'; const logger=rootLogger.child({service:'LayoverBuddyBooking'});

export const LAYOVER_SPECIALIST_FLAG='layover_buddy_specialist_enabled';
type Refusal={ok:false;status:400|403|404|409|503;reason:string};
export type LayoverBuddyBookingContext={ok:true;sessionId:string;userId:string;timezone:string;startsAt:string;earliestStartsAt:string;endsAt:string;endsBy:string;certification:ReturnType<typeof certificationHeader>};
const refuse=(status:Refusal['status'],reason:string):Refusal=>({ok:false,status,reason});

export async function liveLayoverIdentity(db:SupabaseClient,userId:string):Promise<{ok:true}|Refusal>{
 const identity=await readCurrentIdentityVerification(db,userId);
 if(identity.state==='unreadable')return refuse(503,'identity_verification_unavailable');
 return identity.state==='verified'&&identity.providerMode==='live'&&identity.adult?{ok:true}:refuse(403,'layover_identity_verification_required');
}
export async function requireLayoverSpecialistDeclaration(db:SupabaseClient,res:{status:(n:number)=>{json:(b:unknown)=>unknown}},userId:string,categories:unknown):Promise<boolean>{
 if(!Array.isArray(categories)||!categories.includes('layover'))return true;
 const result=await isFlagEnabled(db,LAYOVER_SPECIALIST_FLAG)?await layoverSpecialistEligibility(db,userId):refuse(403,'layover_specialist_disabled');
 if(!result.ok){res.status(result.status).json({error:result.reason,message:result.reason==='layover_identity_verification_required'?'Complete live identity verification before offering layover services.':result.status===503?'We could not check your eligibility. Please try again.':'Layover services require an enabled rollout, an eligible account and verified payout setup.'});return false;}return true;
}
export async function verifiedLayoverSpecialists<T extends {user_id:string;categories?:unknown}>(db:SupabaseClient,rows:T[]):Promise<{rows:T[];unavailable:boolean}>{
 const eligible=rows.filter(isLayoverCompatibleBuddy),out:T[]=[];let unavailable=false;
 for(const row of eligible){const verified=await layoverSpecialistEligibility(db,row.user_id);if(verified.ok)out.push(row);else if(verified.status===503)unavailable=true;}
 return {rows:out,unavailable};
}

async function layoverSpecialistEligibility(db:SupabaseClient,userId:string):Promise<{ok:true}|Refusal>{
 const identity=await liveLayoverIdentity(db,userId);if(!identity.ok)return identity;
 const [payment,restrictions]=await Promise.all([layoverBuddyPaymentReadiness(db,userId),getRestrictionState(db,userId)]);
 if(payment.state==='unreadable'||restrictions.degradedReason==='fail_closed')return refuse(503,'layover_specialist_checks_unavailable');
 if(payment.state!=='ready'||!restrictions.canHost)return refuse(403,'layover_specialist_unavailable');return {ok:true};
}

export async function createLayoverBuddyBooking(db:SupabaseClient,context:LayoverBuddyBookingContext,booking:Record<string,unknown>){
 return db.rpc('layover_buddy_create_booking',{p_booking:booking,p_session_id:context.sessionId,p_user_id:context.userId,p_earliest_start:context.earliestStartsAt,p_end_by:context.endsBy,p_timezone:context.timezone,p_certification:context.certification});
}

/** Validate airport-local civil times by round-trip, including nonexistent DST times. */
function bookingInstant(timezone:string,date:unknown,time:unknown):Date|null{
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||typeof time!=='string'||!/^\d{2}:\d{2}(?::00)?$/.test(time)||!isValidTimezone(timezone))return null;
 const instant=wallTimeToUtc(timezone,`${date}T${time}`);if(!instant)return null;
 const hm=localHourMinute(timezone,instant);return localDayString(timezone,instant)===date&&hm.hour===Number(time.slice(0,2))&&hm.minute===Number(time.slice(3,5))?instant:null;
}
export async function prepareLayoverBuddyBooking(db:SupabaseClient,input:{userId:string;sessionId:unknown;buddy:{id:string;user_id:string;city?:string;categories?:unknown;verified?:unknown;buddy_level?:unknown};bookingDate:unknown;startTime:unknown;durationH:unknown;ignoreBookingId?:string}):Promise<LayoverBuddyBookingContext|Refusal>{
 if(!await isFlagEnabled(db,LAYOVER_SPECIALIST_FLAG)||!await isFlagEnabled(db,'airport_mode_enabled'))return refuse(403,'layover_specialist_disabled');
 if(typeof input.sessionId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.sessionId))return refuse(400,'layover_session_required');
 if(!isLayoverCompatibleBuddy(input.buddy))return refuse(403,'layover_specialist_required');
 const eligible=await layoverSpecialistEligibility(db,input.buddy.user_id);if(!eligible.ok)return eligible;
 if(await isBlockedBetween(db,input.userId,input.buddy.user_id))return refuse(403,'blocked');
 for(const id of [input.userId,input.buddy.user_id]){const verified=await liveLayoverIdentity(db,id);if(!verified.ok)return verified;}
 try{
  const read=await getSession(db,input.sessionId,input.userId);if(!read.ok)return refuse(503,'layover_unavailable');if(!read.session)return refuse(404,'layover_not_found');const session=read.session;
  if(session.status!=='active')return refuse(409,'layover_not_exploring');
  const resolved=await resolveSessionAirport(db,session);if(!resolved.ok)return refuse(503,'airport_unavailable');const airport=resolved.airport;
  if(!airport.city||airport.city.toLowerCase()!==input.buddy.city?.toLowerCase())return refuse(409,'buddy_outside_layover_city');
  const nowMs=Date.now();const record=await consumerLayoverRecord(db,airport,session,nowMs)??certifySessionFeasibility(airport,session,{nowMs,entry:await resolveLayoverEntry(db,input.userId,layoverAirportCountry(airport)),liveConditions:await resolveLayoverLiveConditions(db,airport,session,nowMs)});
  const decision=layoverBuddyDecision(airport,session,nowMs,null,record);if(!decision.safetyGate.passed)return refuse(409,'layover_safety_gate_not_passed');
  if(decision.trustRequirement.applied&&(input.buddy.verified!==true||typeof input.buddy.buddy_level!=='string'||input.buddy.buddy_level==='new'))return refuse(403,'layover_buddy_trust_required');
  const start=bookingInstant(airport.timezone,input.bookingDate,input.startTime),duration=Number(input.durationH);
  if(!start||!Number.isFinite(duration)||duration<=0||duration>24)return refuse(400,'layover_booking_time_invalid');
  const ends=start.getTime()+duration*3600000,from=Math.max(input.ignoreBookingId?0:nowMs,record.envelope.earliestOutTime.getTime()),until=record.deadline.hardReturnTime.getTime();
  if(start.getTime()<from||ends>=until||ends<=nowMs)return refuse(409,'layover_booking_crosses_deadline');
  const availability=await specialistAvailable(db,input.buddy.id,airport.timezone,start,ends,input.ignoreBookingId);if(!availability.ok)return availability;
  return {ok:true,sessionId:session.id,userId:input.userId,timezone:airport.timezone,startsAt:start.toISOString(),earliestStartsAt:new Date(from).toISOString(),endsAt:new Date(ends).toISOString(),endsBy:new Date(until).toISOString(),certification:certificationHeader(record)};
 }catch{return refuse(503,'layover_booking_unavailable');}
}

async function specialistAvailable(db:SupabaseClient,buddyId:string,timezone:string,start:Date,ends:number,ignoreBookingId?:string):Promise<{ok:true}|Refusal>{
 const day=localDayString(timezone,start);if(localDayString(timezone,new Date(ends-1))!==day)return refuse(409,'layover_buddy_availability_unconfirmed');
 const {data,error}=await db.from('rent_buddy_availability').select('is_available,time_slots').eq('buddy_id',buddyId).eq('date',day).maybeSingle();
 if(error){logger.warn({err:error,buddyId,day},'layover specialist availability unreadable');return refuse(503,'layover_buddy_availability_unavailable');}if(!data?.is_available||!Array.isArray(data.time_slots))return refuse(409,'layover_buddy_availability_unconfirmed');
 for(let instant=start.getTime();instant<ends;instant+=60000){const h=localHourMinute(timezone,new Date(instant)).hour;const slot=h>=6&&h<12?'morning':h>=12&&h<18?'afternoon':h>=18&&h<22?'evening':h>=22||h<2?'latenight':null;if(!slot||!data.time_slots.includes(slot))return refuse(409,'layover_buddy_availability_unconfirmed');}
 let occupiedQuery=db.from('rent_buddy_bookings').select('start_time,duration_h').eq('buddy_id',buddyId).eq('booking_date',day).in('status',['pending','requested','confirmed','scheduled','in_progress']);if(ignoreBookingId)occupiedQuery=occupiedQuery.neq('id',ignoreBookingId);const {data:bookings,error:busyError}=await occupiedQuery;
 if(busyError){logger.warn({err:busyError,buddyId,day},'layover specialist bookings unreadable');return refuse(503,'layover_buddy_availability_unavailable');}
 for(const row of bookings??[]){const occupied=bookingInstant(timezone,day,row.start_time);if(!occupied)return refuse(409,'layover_buddy_availability_unconfirmed');if(start.getTime()<occupied.getTime()+Number(row.duration_h)*3600000&&ends>occupied.getTime())return refuse(409,'layover_buddy_already_booked');}
 return {ok:true};
}

/** Recertify an existing booking for acceptance or a bounded timing adjustment. No flight context is returned. */
export async function revalidateLayoverBuddyBooking(db:SupabaseClient,booking:Record<string,any>,change?:{field:string;value:Record<string,unknown>}):Promise<{ok:true;context:LayoverBuddyBookingContext}|Refusal>{
 if(!await isFlagEnabled(db,LAYOVER_SPECIALIST_FLAG))return refuse(403,'layover_specialist_disabled');
 if(change&&(!['date','start_time','duration_h'].includes(change.field)||(change.field==='duration_h'&&Number(change.value.duration_h)>Number(booking.duration_h))))return refuse(409,'layover_checkout_required');
 try{
  const bound=await db.from('layover_buddy_booking_links').select('layover_session_id,user_id,certified_end_by,earliest_start_at').eq('booking_id',booking.id).maybeSingle();
  if(bound.error)return refuse(503,'layover_booking_unavailable');if(!bound.data||bound.data.user_id!==booking.traveler_id)return refuse(409,'layover_checkout_required');
  const profile=await db.from('rent_buddy_profiles').select('*').eq('id',booking.buddy_id).maybeSingle();if(profile.error)return refuse(503,'layover_booking_unavailable');if(!profile.data||profile.data.status!=='active'||profile.data.admin_status!=='active')return refuse(409,'layover_specialist_unavailable');
  const prepared=await prepareLayoverBuddyBooking(db,{userId:booking.traveler_id,sessionId:bound.data.layover_session_id,buddy:profile.data,bookingDate:change?.field==='date'?change.value.date:booking.booking_date,startTime:change?.field==='start_time'?change.value.start_time:booking.start_time,durationH:change?.field==='duration_h'?change.value.duration_h:booking.duration_h,ignoreBookingId:booking.id});if(!prepared.ok)return prepared;
  prepared.endsBy=new Date(Math.min(Date.parse(prepared.endsBy),Date.parse(bound.data.certified_end_by))).toISOString();prepared.earliestStartsAt=new Date(Math.max(Date.parse(prepared.earliestStartsAt),Date.parse(bound.data.earliest_start_at))).toISOString();
  if(Date.parse(prepared.endsAt)>=Date.parse(prepared.endsBy)||Date.parse(prepared.startsAt)<Date.parse(prepared.earliestStartsAt))return refuse(409,'layover_booking_crosses_deadline');
  if(!change){const write=await db.from('layover_buddy_booking_links').update({certified_end_by:prepared.endsBy,earliest_start_at:prepared.earliestStartsAt,certification:prepared.certification}).eq('booking_id',booking.id).select('booking_id');if(write.error||write.data?.length!==1)return refuse(503,'layover_booking_unavailable');}
  return {ok:true,context:prepared};
 }catch{return refuse(503,'layover_booking_unavailable');}
}
export async function acceptLayoverBuddyChange(db:SupabaseClient,booking:Record<string,any>,request:Record<string,any>,actorId:string,note:unknown):Promise<{ok:true}|Refusal>{
 const prepared=await revalidateLayoverBuddyBooking(db,booking,{field:request.change_field,value:request.proposed_value??{}});if(!prepared.ok)return prepared;const c=prepared.context;
 const write=await db.rpc('layover_buddy_accept_change',{p_booking_id:booking.id,p_request_id:request.id,p_actor_id:actorId,p_note:typeof note==='string'?note:null,p_earliest_start:c.earliestStartsAt,p_end_by:c.endsBy,p_certification:c.certification});
 return write.error?refuse(409,'layover_change_not_applied'):{ok:true};
}

/** Only the existing readiness policy's two reads; no payment writer/provider surface enters this adapter. */
async function layoverBuddyPaymentReadiness(db:SupabaseClient,userId:string){
 return readBuddyPaymentReadiness({
  partyForProfile:async(profileId)=>{const r=await db.from('payment_parties').select('id').eq('profile_id',profileId).maybeSingle();return r.error?{ok:false,detail:'payment party unavailable'}:{ok:true,value:r.data?.id??null};},
  getRecipient:async(partyId)=>{const r=await db.from('rent_buddy_payment_recipients').select('onboarding,charges_enabled').eq('party_id',partyId).maybeSingle();return r.error?{ok:false,detail:'payment recipient unavailable'}:{ok:true,value:r.data?{onboarding:r.data.onboarding,chargesEnabled:r.data.charges_enabled===true}:null};},
 },userId);
}
