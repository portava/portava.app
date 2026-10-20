/** L259: route dependencies certified on publication, retained for displayed cards and saved stops. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFlagState } from "../../lib/featureFlags.js";
import { validLayoverRouteSubject } from "../../lib/layoverRouteSubjectRef.js";
import { logger } from "../../lib/logger.js";
import { probeSchemaReadiness } from "../../lib/capability/schemaCapability.js";
import { SCHEMA_PROBE_SENTINEL_ID } from "../../lib/capability/schemaRequirement.js";

type Refusal = { ok: false; reason: string };
/** A route capability cannot publish cards without the schemas and canonical flags
 * that store the exact measured contract. OFF touches none of the new schema. */
export async function routeSubjectPublicationGate(db: SupabaseClient, stableIds: boolean): Promise<{ok:true;required:boolean}|Refusal> {
 try {
  const state=await readFlagState(db,"layover_route_subjects_enabled");
  if(state==='off')return{ok:true,required:false};
  if(state!=='on')return{ok:false,reason:'route_subject_flags_unreadable'};
  const flags=await Promise.all([readFlagState(db,"layover_decision_persistence_enabled"),readFlagState(db,"layover_canonical_snapshot_enabled"),readFlagState(db,"layover_recommendation_snapshot_enabled"),readFlagState(db,"layover_recommendation_status_enabled"),readFlagState(db,"layover_stable_recommendation_ids_enabled")]);
  if(!stableIds||flags.some(flag=>flag!=='on')||await readFlagState(db,'layover_route_fanout_enabled')!=='on'||await readFlagState(db,'layover_event_ingest_enabled')!=='on')return{ok:false,reason:'route_subject_prerequisites_unavailable'};
  if((process.env['LAYOVER_ROUTE_SUBJECT_HMAC_SECRET']??'').length<32)return{ok:false,reason:'route_subject_identity_unavailable'};
  const ready=await probeSchemaReadiness(db,{flag:'schema:layover-route-watch:3895:v2',providedBy:['3895_layover_route_subject_index.sql','3871_layover_recommendation_status_and_supersession.sql','3908_layover_route_fanout.sql'],consumers:['services/airport/LayoverRouteSubjects.ts'],note:'Atomic recommendation and stop watch publication requires the exact private index and stored contract.',requires:{tables:{layover_route_work:{columns:['id','event_id','session_id','user_id','state','lease_token','lease_until'],probe:{column:'id',value:SCHEMA_PROBE_SENTINEL_ID}},layover_route_dispatches:{columns:['event_id','after_session_id','scan_complete'],probe:{column:'event_id',value:SCHEMA_PROBE_SENTINEL_ID}},layover_route_subjects:{columns:['id','session_id','user_id','snapshot_id','recommendation_id','stop_id','route_ref'],probe:{column:'id',value:SCHEMA_PROBE_SENTINEL_ID}},layover_recommendations:{columns:['id','plan_json','snapshot_id'],probe:{column:'id',value:SCHEMA_PROBE_SENTINEL_ID}}}}});
  if(ready.state!=='ready')return{ok:false,reason:'route_subject_schema_unavailable'};
  return{ok:true,required:true};
 }catch(err){logger.warn({err},'Layover route watch publication gate unavailable');return{ok:false,reason:'route_subject_prerequisites_unavailable'};}
}

export async function activeLayoverRouteSessions(db: SupabaseClient, refs: readonly string[], nowMs: number, limit: number): Promise<{ ok: true; rows: Array<{ session: Record<string, unknown>; routeRefs: string[] }> } | Refusal> {
  try {
    if (refs.length < 1 || refs.length > 64 || !refs.every(validLayoverRouteSubject)) return { ok: false, reason: "route_subject_invalid" };
    const flag = await readFlagState(db, "layover_route_subjects_enabled");
    if (flag !== "on") return { ok: false, reason: flag === "off" ? "route_subjects_disabled" : "route_subject_flags_unreadable" };
    const max = Math.min(200, Math.max(1, Math.floor(limit)));
    const { data, error } = await db.rpc("layover_active_sessions_by_routes", { p_refs: [...refs], p_now: new Date(nowMs).toISOString(), p_limit: max });
    if (error || !Array.isArray(data)) return { ok: false, reason: "route_subject_sessions_unreadable" };
    // Refuse before replanning any session. The queue retains its claimed-failure outcome for recovery.
    if (data.length > max) return { ok: false, reason: "route_subject_session_limit" };
    const rows: Array<{ session: Record<string, unknown>; routeRefs: string[] }> = [];
    for (const row of data) {
      if (!row || typeof row.session !== "object" || row.session === null || typeof row.session.id !== "string"
        || !Array.isArray(row.routeRefs) || !row.routeRefs.every(validLayoverRouteSubject)) return { ok: false, reason: "route_subject_sessions_unreadable" };
      rows.push(row);
    }
    return { ok: true, rows };
  } catch (err) {
    logger.warn({ err }, "Layover route dependency lookup threw");
    return { ok: false, reason: "route_subject_sessions_unreadable" };
  }
}
