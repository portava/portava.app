/** Sourced anonymous duration samples. Marginal quantiles are never a journey quantile. */
import { z } from 'zod';
import type { Estimate, EstimatePercentile } from './LayoverFeasibility.js';

export const TIMING_STAGES = ['deplane','arrival_immigration','baggage_claim','airport_exit','outbound_transport','return_transport','security_reentry','baggage_recheck','terminal_transfer','boarding_buffer','contingency'] as const;
export type TimingStage = typeof TIMING_STAGES[number];
const processingStages = ['deplane','arrival_immigration','baggage_claim','airport_exit','security_reentry','baggage_recheck','terminal_transfer','boarding_buffer','contingency'] as const;
const minutes = z.number().finite().min(0).max(1440);
const samples = z.array(minutes).min(20).max(200);
const terminalId=z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u).transform(v=>v.toUpperCase());
const context = z.object({ flightType: z.enum(['domestic','international']), immigrationRequired: z.boolean(), checkedBags: z.boolean(), arrivalTerminalId:terminalId.optional(), departureTerminalId:terminalId.optional() }).strict();
const source = z.object({ observedAt: z.string().datetime(), expiresAt: z.string().datetime(), confidence: z.enum(['LOW','MEDIUM','HIGH']), sourceRefs: z.array(z.string().trim().min(5).max(500)).min(1).max(10) }).strict();
const vector = z.object(Object.fromEntries(TIMING_STAGES.map(k => [k,minutes])) as Record<TimingStage,typeof minutes>).strict();
export const timingEvidenceInputSchema = source.extend({
  context,
  stages: z.array(z.object({ stage: z.enum(processingStages), samplesMinutes: samples }).strict()).max(processingStages.length),
  // Every vector is one observed complete journey to this place in this mode, excluding experience dwell.
  journeys: z.array(z.object({ placeId: z.string().uuid(), mode: z.enum(['walk','drive','transit']), sampleDefinition: z.literal('paired_complete_journey_excluding_experience'), samples: z.array(vector).min(20).max(100) }).strict()).max(4),
}).strict().superRefine((v,c) => {
  if (Date.parse(v.expiresAt) <= Date.parse(v.observedAt) || Date.parse(v.expiresAt)-Date.parse(v.observedAt)>30*86400000) c.addIssue({code:'custom',message:'measurement TTL must be positive and at most 30 days'});
  if (new Set(v.stages.map(s=>s.stage)).size !== v.stages.length) c.addIssue({code:'custom',message:'duplicate stage samples'});
  if (new Set(v.journeys.map(s=>`${s.placeId}:${s.mode}`)).size !== v.journeys.length) c.addIssue({code:'custom',message:'duplicate journey scope'});
  if (!v.stages.length && !v.journeys.length) c.addIssue({code:'custom',message:'at least one measured stage or complete journey is required'});
  const forbidden = (stage: TimingStage) => stage === 'arrival_immigration' && !v.context.immigrationRequired || (stage === 'baggage_claim' || stage === 'baggage_recheck') && !v.context.checkedBags;
  if (v.stages.some(s=>forbidden(s.stage)&&s.samplesMinutes.some(n=>n!==0)) || v.journeys.some(j=>j.samples.some(s=>TIMING_STAGES.some(k=>forbidden(k)&&s[k]!==0)))) c.addIssue({code:'custom',message:'inapplicable stages must be observed as zero for this context'});
});
export type TimingEvidenceInput = z.infer<typeof timingEvidenceInputSchema>;
export interface TimingEvidence extends TimingEvidenceInput { factId: string; sourceKind: 'official_airport'|'official_operator'|'official_government'|'curator_survey' }
const kinds = new Set(['official_airport','official_operator','official_government','curator_survey']);
export function timingEvidenceIssues(raw: unknown, sourceKind: string, nowMs: number, factExpiresAt: string): string[] {
  const p=timingEvidenceInputSchema.safeParse(raw);
  if(!p.success)return p.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`);
  return [...(!kinds.has(sourceKind)?['observations require an official source or a documented curator survey; judgment is not a measurement']:[]), ...(!Number.isFinite(Date.parse(factExpiresAt))?['source fact expiry is unavailable']:[]),
    ...(Date.parse(p.data.observedAt)>nowMs || Date.parse(p.data.expiresAt)<=nowMs || Date.parse(p.data.expiresAt)>Date.parse(factExpiresAt)?['measurement timestamps must be current and within the source fact expiry']:[])];
}
/** Exact projection from the published fact. Malformed, stale or unbound rows remain absent. */
export function timingEvidenceFromRow(row: Record<string,unknown>, nowMs: number): TimingEvidence | null {
  const raw=row.curated_timing_evidence;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const r=raw as Record<string,unknown>, p=timingEvidenceInputSchema.safeParse(r.evidence);
  if(!p.success||r.factId!==row.curated_timing_fact_id||typeof r.factId!=='string'||typeof r.sourceKind!=='string'||!kinds.has(r.sourceKind)
    ||timingEvidenceIssues(p.data,r.sourceKind,nowMs,String(row.curated_timing_expires_at)).length)return null;
  return {...p.data,factId:r.factId,sourceKind:r.sourceKind as TimingEvidence['sourceKind']};
}
export function namedTimingEvidence(value: TimingEvidence | null | undefined, nowMs: number): TimingEvidence | null {
  if(!value)return null;
  const {factId,sourceKind,...raw}=value;
  const p=timingEvidenceInputSchema.safeParse(raw);
  if(!p.success||!factId||!kinds.has(sourceKind)||Date.parse(p.data.observedAt)>nowMs||Date.parse(p.data.expiresAt)<=nowMs)return null;
  return {...p.data,factId,sourceKind};
}
type Context = {flightType:string;immigrationRequired:boolean;checkedBags:boolean;arrivalTerminalId?:string|null;departureTerminalId?:string|null};
/** Exact source labels only: no equivalence between "1" and "T1" is inferred. */
export function normalizeTimingTerminalId(value:unknown):string|null {const parsed=terminalId.safeParse(value);return parsed.success?parsed.data:null;}
export function timingForContext(e: TimingEvidence | null | undefined, c: Context, nowMs: number): TimingEvidence | null {
  const v=namedTimingEvidence(e,nowMs);
  return v && v.context.flightType===c.flightType && v.context.immigrationRequired===c.immigrationRequired && v.context.checkedBags===c.checkedBags && (!v.context.arrivalTerminalId||v.context.arrivalTerminalId===normalizeTimingTerminalId(c.arrivalTerminalId)) && (!v.context.departureTerminalId||v.context.departureTerminalId===normalizeTimingTerminalId(c.departureTerminalId))?v:null;
}
const quantile=(ns:readonly number[],p:number)=>[...ns].sort((a,b)=>a-b)[Math.max(0,Math.ceil(ns.length*p)-1)]!;
export function sampledTimingEstimate(ns:readonly number[],e:TimingEvidence,scope:string): Estimate {
  return {valueMinutes:quantile(ns,.5),p50Minutes:quantile(ns,.5),p75Minutes:quantile(ns,.75),p90Minutes:quantile(ns,.9),confidence:e.confidence,sourceClass:'HISTORICAL',observedAt:e.observedAt,expiresAt:e.expiresAt,fallbackLevel:1,sourceRefs:[`airport_curated_facts:${e.factId}`,`empirical nearest-rank quantiles; n=${ns.length}; ${scope}`,...e.sourceRefs]};
}
export const selectedTimingMinutes=(e:Estimate,p:EstimatePercentile)=>Math.max(e.valueMinutes,p==='p50'?e.p50Minutes:p==='p75'?e.p75Minutes:e.p90Minutes);
export function stageTimingEstimates(e:TimingEvidence|null|undefined,c:Context,nowMs:number): Partial<Record<TimingStage,Estimate>> {
  const v=timingForContext(e,c,nowMs); return v?Object.fromEntries(v.stages.map(s=>[s.stage,sampledTimingEstimate(s.samplesMinutes,v,s.stage)])):{};
}
export function returnProcessingFloor(e:TimingEvidence|null|undefined,c:Context,nowMs:number,p:EstimatePercentile): number {
  const stages=stageTimingEstimates(e,c,nowMs);
  return (['security_reentry','baggage_recheck','terminal_transfer','boarding_buffer','contingency'] as TimingStage[]).reduce((sum,k)=>sum+(stages[k]?selectedTimingMinutes(stages[k]!,p):0),0);
}
export function jointJourneyEstimate(e:TimingEvidence|null|undefined,c:Context,nowMs:number,placeId:string,mode:string): {estimate:Estimate;stages:Record<TimingStage,Estimate>;sampleCount:number}|null {
  const v=timingForContext(e,c,nowMs),j=v?.journeys.find(j=>j.placeId===placeId&&j.mode===mode);
  if(!v||!j)return null;
  return {estimate:sampledTimingEstimate(j.samples.map(s=>TIMING_STAGES.reduce((sum,k)=>sum+s[k],0)),v,'paired complete journey excluding experience; NOT sum of marginal quantiles'),stages:Object.fromEntries(TIMING_STAGES.map(k=>[k,sampledTimingEstimate(j.samples.map(s=>s[k]),v,`${k}; paired journey to ${placeId} in ${mode}`)])) as Record<TimingStage,Estimate>,sampleCount:j.samples.length};
}
