import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifyFeasibility, certifySessionFeasibility, recomputeFeasibility, type FeasibilityAirport, type FeasibilitySession } from '../services/airport/LayoverFeasibility.js';
import { timingEvidenceInputSchema, timingEvidenceIssues, timingEvidenceFromRow, jointJourneyEstimate, stageTimingEstimates, TIMING_STAGES, type TimingEvidence, type TimingStage } from '../services/airport/layoverTimingEvidence.js';
import { activityCommitmentFromRows, requiredActivityMinutes, readActivityCommitments } from '../services/airport/layoverActivityCommitment.js';
import { judgeRoutedCandidate, routedCardContract } from '../services/airport/LayoverRoutedFeasibility.js';
import type { RoutedLeg, RoutedLegs } from '../services/airport/LayoverReturnCorridor.js';
const now=Date.parse('2030-06-14T09:00:00Z'),iso=(n:number)=>new Date(n).toISOString();
const place='11111111-1111-4111-8111-111111111111';
const airport:FeasibilityAirport={id:'22222222-2222-4222-8222-222222222222',iataCode:'ZZZ',timezone:'UTC',verified:true,domesticBufferMin:60,internationalBufferMin:120,immigrationExtraMin:30,checkedBagsExtraMin:15,trafficExtraMin:20};
const session:FeasibilitySession={id:'s',arrivalTime:iso(now-3600000),departureTime:iso(now+10*3600000),boardingTime:null,flightType:'domestic',immigrationRequired:false,checkedBags:false,wantsToLeave:true};
const evidence=(over:Partial<TimingEvidence>={}):TimingEvidence=>({factId:'33333333-3333-4333-8333-333333333333',sourceKind:'official_airport',observedAt:iso(now-60000),expiresAt:iso(now+3600000),confidence:'MEDIUM',sourceRefs:['https://example.test/anonymous-measured-samples'],context:{flightType:'domestic',immigrationRequired:false,checkedBags:false},stages:[{stage:'deplane',samplesMinutes:Array.from({length:20},(_,i)=>i+10)},{stage:'security_reentry',samplesMinutes:Array.from({length:20},(_,i)=>i+100)}],journeys:[],...over});
const inputOf=(e:TimingEvidence)=>{const {factId,sourceKind,...input}=e;return input;};
const record=(e?:TimingEvidence,percentile:'p50'|'p75'|'p90'='p90')=>certifySessionFeasibility({...airport,...(e?{timingEvidence:e}:{})},session,{nowMs:now,bufferPercentile:percentile,entry:{state:'permitted',status:'visa_free',corridor:{passportCountry:'US',destinationCountry:'SG'}}});
test('real sample quantiles retain source, count, observation/expiry and do not invent a spread',()=>{
  const e=evidence(),s=stageTimingEstimates(e,session,now).deplane!;
  assert.equal(s.p50Minutes,19);assert.equal(s.p75Minutes,24);assert.equal(s.p90Minutes,27);assert.equal(s.valueMinutes,19);assert.equal(s.sourceClass,'HISTORICAL');assert.equal(s.fallbackLevel,1);assert.match(s.sourceRefs.join(' '),/n=20/);assert.equal(s.observedAt,e.observedAt);
  const flat=stageTimingEstimates(evidence({stages:[{stage:'deplane',samplesMinutes:Array(20).fill(22)}]}),session,now).deplane!;assert.equal(flat.p50Minutes,flat.p90Minutes);
});
test('measurement curation rejects judgment, stale/future/overlong data, missing samples, duplicate scopes and inappropriate stages',()=>{
  const e=evidence();assert.deepEqual(timingEvidenceIssues(inputOf(e),'official_airport',now,iso(now+7200000)),[]);
  assert.ok(timingEvidenceIssues(inputOf(e),'curator_judgment',now,e.expiresAt).length);
  for(const bad of [{observedAt:iso(now+1)},{expiresAt:iso(now)},{expiresAt:iso(now+31*86400000)},{stages:[{stage:'deplane',samplesMinutes:[20]}]},{stages:[e.stages[0],e.stages[0]]},{stages:[{stage:'baggage_recheck',samplesMinutes:Array(20).fill(5)}]}])assert.ok(timingEvidenceIssues({...inputOf(e),...bad},e.sourceKind,now,iso(now+40*86400000)).length);
  assert.equal(timingEvidenceInputSchema.safeParse({...inputOf(e),stages:[{stage:'outbound_transport',samplesMinutes:Array(20).fill(5)}]}).success,false,'generic airport transport samples cannot describe an unspecified place');
});
test('only the matching published fact/context can project measured timing; missing or expired evidence is explicit',()=>{
  const e=evidence(),row={curated_timing_fact_id:e.factId,curated_timing_expires_at:e.expiresAt,curated_timing_evidence:{factId:e.factId,sourceKind:e.sourceKind,evidence:inputOf(e)}};
  assert.deepEqual(timingEvidenceFromRow(row,now),e);assert.equal(timingEvidenceFromRow({...row,curated_timing_fact_id:'other'},now),null);assert.equal(timingEvidenceFromRow(row,Date.parse(e.expiresAt)),null);
  assert.deepEqual(stageTimingEstimates(e,{...session,checkedBags:true},now),{});
  const stale=record({...e,expiresAt:iso(now-1)});assert.equal(stale.verdict,'no');assert.equal(stale.confidence,'INSUFFICIENT');assert.ok(stale.landsideGate.closedBy.includes('timing_evidence_unavailable'));
});
test('selected observed stage quantiles drive actual exit and return deadlines, never widen baseline, and replay/incremental agree',()=>{
  const baseline=record(),e=evidence(),p50=record(e,'p50'),p90=record(e);
  assert.ok(p50.envelope.exitDelayMin>=baseline.envelope.exitDelayMin);assert.ok(p90.envelope.exitDelayMin>p50.envelope.exitDelayMin);
  assert.ok(p90.deadline.hardReturnTime.getTime()<p50.deadline.hardReturnTime.getTime());assert.ok(p50.deadline.hardReturnTime.getTime()<=baseline.deadline.hardReturnTime.getTime());
  assert.equal(p90.bufferMinutesAtPercentile,p90.deadline.breakdown.totalBuffer);assert.equal(p90.estimates.stageLadder?.wholeJourney,null);assert.equal(p90.estimates.stageLadder?.stages.find(s=>s.stage==='return_transport')?.estimate,null);
  assert.notEqual(baseline.inputHash,p50.inputHash);assert.notEqual(p50.inputHash,p90.inputHash);assert.deepEqual(certifyFeasibility(p90.inputs),p90);assert.deepEqual(recomputeFeasibility(p50,p90.inputs),p90);
  for(let n=0;n<200;n+=7){const r=record(evidence({stages:[{stage:'security_reentry',samplesMinutes:Array(20).fill(n)},{stage:'deplane',samplesMinutes:Array(20).fill(n)}]}));assert.ok(r.deadline.hardReturnTime<=baseline.deadline.hardReturnTime);assert.ok(r.envelope.exitDelayMin>=baseline.envelope.exitDelayMin);}
});
const vector=(n:number)=>Object.fromEntries(TIMING_STAGES.map(k=>[k,k==='outbound_transport'?n:k==='return_transport'?200-n:0])) as Record<TimingStage,number>;
test('whole-journey p90 comes from paired observed totals, not the sum of marginal p90s',()=>{
  const e=evidence({stages:[],journeys:[{placeId:place,mode:'drive',sampleDefinition:'paired_complete_journey_excluding_experience',samples:Array.from({length:20},(_,i)=>vector(i*10))}]}),j=jointJourneyEstimate(e,session,now,place,'drive')!;
  assert.equal(j.estimate.p90Minutes,200);assert.ok(j.stages.outbound_transport.p90Minutes+j.stages.return_transport.p90Minutes>j.estimate.p90Minutes);assert.equal(j.sampleCount,20);
  assert.equal(jointJourneyEstimate(e,session,now,place,'walk'),null);assert.equal(jointJourneyEstimate(e,session,now,'other','drive'),null);
});
const leg=(departAt:string):RoutedLeg=>({departAt,minutes:10,freeFlowMinutes:10,forecast:true,confidence:'MEDIUM',offeredRoutes:2,independentRoutes:2,transferCount:0,interruptibility:'interruptible',conveyances:[{mode:'drive',minutes:10,interruptibility:'interruptible',endsAt:null}]});
const legs=():RoutedLegs=>({mode:'drive',outbound:leg(iso(now)),returnLeg:leg(iso(now+40*60000)),expiresAt:iso(now+300000),sourceRefs:['fixture']});
test('joint observed journey and committed activity can demote/refuse a routed candidate, never rescue an unsafe one',()=>{
  const base={key:'candidate',placeId:place,legs:legs(),risk:null,minExperienceMin:30,straightLine:null},r=record();
  assert.equal(judgeRoutedCandidate({...base,record:r}).state,'FEASIBLE');
  const slow=evidence({stages:[],journeys:[{placeId:place,mode:'drive',sampleDefinition:'paired_complete_journey_excluding_experience',samples:Array(20).fill({...vector(190),security_reentry:700})}]});
  const refused=judgeRoutedCandidate({...base,record:record(slow)});assert.equal(refused.state,'INFEASIBLE');assert.equal(refused.inEnvelope,false);assert.equal(routedCardContract(refused)?.journeyTiming?.estimate.p90Minutes,900);
  const known=activityCommitmentFromRows([activityRow()],now)!;assert.equal(judgeRoutedCandidate({...base,record:r,activityCommitment:known}).band,'TIGHT');assert.equal(judgeRoutedCandidate({...base,record:r,activityCommitment:null}).state,'UNMEASURED');
});
const activityRow=()=>({id:place,kind:'activity_commitment',value:{interruptibility:'committed',minimumCommitmentMinutes:60,exitDelayMinutes:12},source_class:'venue_operator',source_url:'https://example.test/actual-venue-terms',source_note:'Explicitly stated minimum programme duration',observed_at:iso(now-60000),expires_at:iso(now+3600000)});
test('activity facts require fresh nonconflicting source evidence; required duration includes actual commitment and exit delay',()=>{
  const row=activityRow(),value=activityCommitmentFromRows([row],now)!;assert.ok(value);assert.equal(requiredActivityMinutes(30,value),72);assert.equal(requiredActivityMinutes(90,value),102);assert.equal(requiredActivityMinutes(null,value),null);
  const twin={...row,id:'00000000-0000-4000-8000-0000000000ff',source_url:'https://a.example.test/second'};assert.deepEqual(activityCommitmentFromRows([row,twin],now),activityCommitmentFromRows([twin,row],now),'agreeing facts in either row order are one commitment (the plan input hash covers it)');
  assert.equal(activityCommitmentFromRows([row,{...row,value:{...row.value,minimumCommitmentMinutes:90}}],now),null);assert.equal(activityCommitmentFromRows([{...row,expires_at:iso(now)}],now),null);assert.equal(activityCommitmentFromRows([{...row,source_url:'http://example.test'}],now),null);
});
test('an unreadable stricter activity flag refuses instead of disabling the requirement',async()=>{
  for(const outcome of ['absent','off','on','error','throw'] as const){let evidenceReads=0;const query:any={select(){return this;},eq(){return this;},maybeSingle:async()=>{if(outcome==='throw')throw new Error('fixture read failure');return {data:outcome==='absent'?null:{enabled:outcome==='on'},error:outcome==='error'?{message:'fixture unreadable'}:null};}};const db:any={from(table:string){if(table!=='feature_flags'){evidenceReads++;throw new Error('unexpected evidence read');}return query;}};
    const result=await readActivityCommitments(db,null,[place],now);assert.equal(result.state,outcome==='absent'||outcome==='off'?'disabled':'unavailable');if(result.state==='unavailable')assert.equal(result.reason,outcome==='on'?'airport_unavailable':'activity_capability_unreadable');assert.equal(evidenceReads,0);
  }
});
test('terminal-scoped observations require the exact linked labels, change the hash, and invalidate incremental timing',()=>{
  const e=evidence({context:{...evidence().context,arrivalTerminalId:'T1',departureTerminalId:'T2'}}),scopedAirport={...airport,timingEvidence:e};
  const options={nowMs:now,entry:{state:'permitted' as const,status:'visa_free' as const,corridor:{passportCountry:'US',destinationCountry:'SG'}}};
  const valid=certifySessionFeasibility(scopedAirport,{...session,arrivalTerminalId:' t1 ',departureTerminalId:'t2'},options);assert.equal(valid.inputs.session.arrivalTerminalId,'T1');assert.equal(valid.verdict,'yes');assert.ok(valid.estimates.deplane.p90Minutes>record().estimates.deplane.p90Minutes);
  for(const terminals of [{},{arrivalTerminalId:null,departureTerminalId:'T2'},{arrivalTerminalId:'1',departureTerminalId:'T2'},{arrivalTerminalId:'T1',departureTerminalId:'T3'}]){const r=certifySessionFeasibility(scopedAirport,{...session,...terminals},options);assert.notEqual(r.inputHash,valid.inputHash);assert.equal(r.verdict,'no');assert.equal(r.confidence,'INSUFFICIENT');assert.ok(r.landsideGate.closedBy.includes('timing_evidence_unavailable'));assert.deepEqual(recomputeFeasibility(valid,r.inputs),r);}
  const airportWide=certifySessionFeasibility({...airport,timingEvidence:evidence()},{...session,arrivalTerminalId:'T8',departureTerminalId:null},options);assert.equal(airportWide.verdict,'yes','explicit airport-wide source remains applicable');
});
import { decisionRecordFor } from '../services/airport/layoverLedger.js';
import { replayDecision } from '../services/airport/layoverReplay.js';
test('sourced timing replays exactly and earlier arithmetic/shape versions refuse rather than silently re-certify',()=>{
  const r=record(evidence()),stored={sessionId:session.id,inputs:r.inputs,decision:decisionRecordFor(session.id,r)};assert.equal(replayDecision(structuredClone(stored)).status,'match');
  const oldEngine={...stored,inputs:{...stored.inputs,engineVersion:'2026.09.22-1'},decision:{...stored.decision,engineVersion:'2026.09.22-1'}};assert.equal(replayDecision(oldEngine).refusal,'ENGINE_VERSION_CHANGED');
  assert.equal(replayDecision({...stored,inputs:{...stored.inputs,feasibilityVersion:'2026.10.19-1'}}).refusal,'RECORD_SHAPE_CHANGED');
});
