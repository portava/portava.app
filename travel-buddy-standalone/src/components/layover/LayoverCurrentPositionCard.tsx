import React,{useEffect,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {color,space,radius,type as t} from '../../theme/tokens.ts';
import type {LayoverRecommendation} from '../../services/layover.ts';
import {checkLayoverCurrentPosition,type CurrentPositionPreview} from '../../services/layoverCurrentPosition.ts';
import {experienceRequestId} from '../../services/layoverExperiencePlans.ts';
import {requestLocationForUserAction,USER_PRESS_MAP_CONTEXT} from '../../lib/location/locationRequestDoor.ts';
import {fmtClock} from './layoverFormat.ts';
import {LayoverActivityTimingNote} from './LayoverTimingEvidenceCard.tsx';
export function LayoverCurrentPositionCard({sessionId,recs,timezone,enabled}:{sessionId:string;recs:LayoverRecommendation[];timezone:string|null;enabled:boolean}){
  const choices=recs.filter(r=>r.id&&r.snapshotId&&!r.insideAirport&&r.routing?.state==='FEASIBLE'&&r.available!==false/* census-layover §83: a card served unavailable is never checked as an option */),[selected,setSelected]=useState<string|null>(null),[preview,setPreview]=useState<CurrentPositionPreview|null>(null),[message,setMessage]=useState<string|null>(null),[busy,setBusy]=useState(false),[now,setNow]=useState(Date.now());
  const generation=useRef(0),inFlight=useRef(false),candidate=choices.find(c=>c.id===selected)??choices[0];const identity=`${sessionId}:${candidate?.id}:${candidate?.snapshotId}:${enabled}`;
  useEffect(()=>{setPreview(null);setMessage(null);setBusy(false);inFlight.current=false;return()=>{generation.current++;};},[identity]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  async function checkFromLocation(){
    if(!enabled||!candidate?.id||!candidate.snapshotId||inFlight.current)return;inFlight.current=true;setBusy(true);setPreview(null);setMessage(null);const mine=generation.current;
    try {const fix=await requestLocationForUserAction(USER_PRESS_MAP_CONTEXT);if(mine!==generation.current)return;
      if(!fix.granted||fix.lat===null||fix.lng===null||fix.accuracyMeters===null||fix.accuracyMeters>1000||!Number.isFinite(fix.observedAtMs)||Date.now()-(fix.observedAtMs??0)>=120000||fix.observedAtMs!>Date.now()){setMessage('A current, accurate location was unavailable. Your saved plan has not changed.');return;}
      const result=await checkLayoverCurrentPosition(sessionId,candidate.id,candidate.snapshotId,experienceRequestId(),{lat:fix.lat,lng:fix.lng,accuracyMeters:fix.accuracyMeters,observedAt:new Date(fix.observedAtMs!).toISOString(),mode:'drive'});if(mine!==generation.current)return;
      if(result.ok){setPreview(result.preview);setNow(Date.now());}else setMessage(result.reason==='return_deadline_exceeded'||result.reason==='confidence_insufficient'?'From where you are, there is not enough measured time to do this and still return by your deadline. Your saved plan has not changed.':'This experience could not be checked from your location. Refresh the recommendations or use Return to airport.');
    }catch{if(mine===generation.current)setMessage('The location check was unavailable. Your saved plan has not changed.');}finally{if(mine===generation.current){inFlight.current=false;setBusy(false);}}
  }
  if(!enabled||!candidate)return null;const fresh=preview&&Date.parse(preview.expiresAt)>now;
  return <View testID="layover-current-position" style={{padding:space.md,gap:space.sm,borderRadius:radius.md,backgroundColor:color.paperRaised}}><Text style={{...t.bodyStrong,color:color.ink}}>Check an experience from here</Text><Text style={{...t.small,color:color.mute}}>Uses your location once to check driving there and returning. This temporary preview does not start or update your saved experience, which still starts at the airport.</Text>
    {choices.map(c=><Pressable key={c.id} disabled={busy} accessibilityRole="radio" accessibilityState={{selected:c.id===candidate.id}} onPress={()=>setSelected(c.id!)}><Text style={{...t.small,color:c.id===candidate.id?color.deep:color.mute}}>{c.title}</Text></Pressable>)}
    <Pressable testID="check-from-location" onPress={checkFromLocation} disabled={busy} accessibilityRole="button"><Text style={{...t.bodyStrong,color:color.deep}}>{busy?'Checking your location and routes…':'Check driving from my current location'}</Text></Pressable>
    {message&&<Text accessibilityRole="alert" style={{...t.small,color:color.mute}}>{message}</Text>}
    {fresh&&preview?<View testID="current-position-preview"><Text style={{...t.small,color:color.ink}}>{preview.outbound.conservativeMinutes} min there · {preview.activityMinutes} min experience · {preview.returnRoute.conservativeMinutes} min back</Text><Text style={{...t.small,color:color.ink}}>Risk remains {preview.riskBand.toLowerCase()}. Return by {fmtClock(preview.hardReturnBy,timezone)}. Current-location time window: {preview.window.usableMinutes} min.</Text><LayoverActivityTimingNote routing={{activityCommitment:preview.activityCommitment}}/><Text style={{...t.small,color:color.mute}}>Temporary check expires {fmtClock(preview.expiresAt,timezone)}. Recheck after moving.</Text></View>:preview?<Text accessibilityRole="alert" style={{...t.small,color:color.mute}}>This location check expired. Check again before relying on these times.</Text>:null}
  </View>;
}
