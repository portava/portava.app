/** Windowed return cohorts, read only after the measured-outcome/link schemas
 * exist. This reader never treats an unavailable source as an empty cohort. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { probeSchemaReadiness } from '../../lib/capability/schemaCapability.js';
import { SCHEMA_PROBE_SENTINEL_ID } from '../../lib/capability/schemaRequirement.js';
import { countedLayoverWindow } from '../layover/LayoverDecisionStore.js';
import { logger } from '../../lib/logger.js';
import type { LayoverEventRow, SafeReturnMetricWindow } from './layoverObservability.js';
const LIMIT = 5000;
const LINKS = 'layover_session_id,return_started_at';
const OUTCOMES = 'session_id,left_airport,actual_airport_return_at';
export async function readSafeReturnMetricWindow(db: SupabaseClient, events: LayoverEventRow[], eventsTruncated: boolean, fromIso: string, toIso: string): Promise<SafeReturnMetricWindow> {
  const unavailable = (reason: string): SafeReturnMetricWindow => { logger.warn({ operation:'readSafeReturnMetricWindow',reason },'layover return metric unavailable'); return { available:false,reason }; };
  try {
    const ready = await probeSchemaReadiness(db, {
      flag:'schema:layover-metrics-returns:3893:v1',providedBy:['2992_layover_decision_record_and_operational_tables.sql','3893_layover_safe_return_links.sql'],consumers:['services/airport/LayoverMetricsReturns.ts'],note:'Historical return measurements require complete outcome and linked timer schemas, regardless of current product flag state.',
      requires:{tables:{
        layover_safe_return_links:{columns:['layover_session_id','return_started_at'],probe:{column:'layover_session_id',value:SCHEMA_PROBE_SENTINEL_ID}},
        layover_outcomes:{columns:['session_id','left_airport','actual_airport_return_at'],probe:{column:'session_id',value:SCHEMA_PROBE_SENTINEL_ID}},
      }},
    });
    if (ready.state !== 'ready') return unavailable(`layover_outcomes (2992) and layover_safe_return_links (3893) readiness ${ready.state}; no return completion rate reported.`);
    const links = countedLayoverWindow(await db.from('layover_safe_return_links').select(LINKS,{count:'exact'}).gte('return_started_at',fromIso).lt('return_started_at',toIso).order('return_started_at',{ascending:false}).limit(LIMIT+1),LINKS,LIMIT);
    if (!links) return unavailable('layover_safe_return_links window could not be read completely.');
    const started = events.filter(e=>e.eventType==='safe_return_aborted').map(e=>({sessionId:e.sessionId,at:e.at}));
    for (const l of links.rows) started.push({sessionId:String(l.layover_session_id),at:String(l.return_started_at)});
    const ids = [...new Set(started.map(s=>s.sessionId))];
    const outcomes: Array<{sessionId:string;leftAirport:boolean|null;returnedAt:string|null}> = [];
    let truncated = eventsTruncated || links.truncated;
    // Bound PostgREST URL size and require an exact count for every batch.
    for (let offset=0;offset<ids.length;offset+=100) {
      const group=ids.slice(offset,offset+100);
      const rows=countedLayoverWindow(await db.from('layover_outcomes').select(OUTCOMES,{count:'exact'}).in('session_id',group).limit(group.length+1),OUTCOMES,group.length);
      if (!rows) return unavailable('layover_outcomes read failed; a missing measurement is not a completed return.');
      truncated ||= rows.truncated;
      for (const row of rows.rows) {
        const returnedAt = row.actual_airport_return_at as string|null;
        if (returnedAt !== null && Date.parse(returnedAt) >= Date.parse(toIso)) continue;
        outcomes.push({sessionId:String(row.session_id),leftAirport:row.left_airport as boolean|null,returnedAt});
      }
    }
    return {available:true,started,outcomes,truncated};
  } catch(err) { logger.warn({err,operation:'readSafeReturnMetricWindow'},'layover return metric read threw');return {available:false,reason:'layover_outcomes / layover_safe_return_links read threw; no rate reported.'}; }
}
