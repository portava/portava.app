import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { z } from 'zod';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
const labels={deplane:'Leave the plane',arrival_immigration:'Arrival immigration',baggage_claim:'Collect baggage',airport_exit:'Exit the airport',outbound_transport:'Travel to the experience',return_transport:'Travel back',security_reentry:'Security and re-entry',baggage_recheck:'Recheck baggage',terminal_transfer:'Reach the terminal and gate',boarding_buffer:'Boarding allowance',contingency:'Contingency'};
const minutes=z.number().finite().min(0).max(20000),instant=z.string().refine(v=>Number.isFinite(Date.parse(v)));
const estimate=z.object({valueMinutes:minutes,p50Minutes:minutes,p75Minutes:minutes,p90Minutes:minutes,confidence:z.enum(['LOW','MEDIUM','HIGH']),sourceClass:z.literal('HISTORICAL'),observedAt:instant,expiresAt:instant,sourceRefs:z.array(z.string().max(1000)).max(30)}).refine(v=>v.p50Minutes<=v.p75Minutes&&v.p75Minutes<=v.p90Minutes);
const ladder=z.object({stageLadder:z.object({percentile:z.enum(['p50','p75','p90']),stages:z.array(z.object({stage:z.enum(Object.keys(labels) as [keyof typeof labels,...Array<keyof typeof labels>]),estimate:z.unknown()})).length(11)})});
const box={padding:space.md,borderRadius:radius.md,backgroundColor:color.paperRaised,gap:space.sm};
export function LayoverTimingEvidenceCard({estimates,nowMs}:{estimates:unknown;nowMs?:number}){
 const [open,setOpen]=useState(false),[clock,setClock]=useState(Date.now());useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),30000);return()=>clearInterval(timer);},[]);
 const parsed=ladder.safeParse(estimates);if(!parsed.success||new Set(parsed.data.stageLadder.stages.map(s=>s.stage)).size!==11)return null;
 const now=nowMs??clock;
 return <View style={box} testID="layover-timing-evidence"><Pressable accessibilityRole="button" accessibilityState={{expanded:open}} accessibilityLabel="Timing evidence by journey stage" onPress={()=>setOpen(v=>!v)}><Text style={{...t.bodyStrong,color:color.ink}}>Timing evidence by journey stage</Text></Pressable>{open&&<>
  <Text style={{...t.small,color:color.mute}}>The return deadline keeps the existing cautious allowances. Available measurements can increase them. Separate stage percentiles are not a whole-journey percentile.</Text>
  {parsed.data.stageLadder.stages.map(s=>{const e=estimate.safeParse(s.estimate),fresh=e.success&&Date.parse(e.data.observedAt)<=now&&Date.parse(e.data.expiresAt)>now;return <View key={s.stage} style={{gap:space.xs}}><Text style={{...t.bodyStrong,color:color.ink}}>{labels[s.stage]}</Text>{fresh&&e.success?<><Text style={{...t.small,color:color.ink}}>Observed p50 {e.data.p50Minutes} min · p75 {e.data.p75Minutes} min · p90 {e.data.p90Minutes} min</Text><Text style={{...t.small,color:color.mute}}>Uses {parsed.data.stageLadder.percentile} with a minimum safety allowance. Confidence: {e.data.confidence.toLowerCase()}. Observed {new Date(e.data.observedAt).toLocaleString()}; expires {new Date(e.data.expiresAt).toLocaleString()}.</Text>{e.data.sourceRefs.filter(ref=>ref.startsWith('https://')).map(ref=><Text key={ref} style={{...t.small,color:color.mute}}>{ref}</Text>)}</>:<Text style={{...t.small,color:color.mute}}>No current stage observations for this journey. Existing allowances still apply; travel times need a selected route.</Text>}</View>;})}
 </>}</View>;
}
const commitment=z.object({interruptibility:z.enum(['interruptible','committed']),minimumCommitmentMinutes:minutes,exitDelayMinutes:minutes,expiresAt:instant});
export function LayoverActivityTimingNote({routing,nowMs=Date.now()}:{routing:unknown;nowMs?:number}){
 if(!routing||typeof routing!=='object')return null;const raw=routing as Record<string,unknown>;if(!Object.hasOwn(raw,'activityCommitment'))return null;
 const p=commitment.safeParse(raw.activityCommitment);if(!p.success||Date.parse(p.data.expiresAt)<=nowMs)return <Text style={{...t.small,color:color.mute}}>The activity's minimum commitment and exit time could not be confirmed.</Text>;
 return <Text style={{...t.small,color:color.ink}}>{p.data.interruptibility==='committed'?`Cannot leave early: ${p.data.minimumCommitmentMinutes} min minimum commitment.`:'The source says this activity can be interrupted.'} Allow {p.data.exitDelayMinutes} min to leave. These terms are included in the checked visit time.</Text>;
}
