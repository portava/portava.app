import React,{useEffect,useState} from 'react';
import {ActivityIndicator,Text,View} from 'react-native';
import type {ExperiencePlan} from '../../services/layoverExperiencePlans.ts';
import {getExperienceGeometry,currentExperienceGeometry,type ExperienceGeometry} from '../../services/layoverExperienceGeometry.ts';
import {LayoverGoogleRouteMap} from './LayoverGoogleRouteMap';
import {color,space,type as t} from '../../theme/tokens.ts';
interface Props{sessionId:string;plan:ExperiencePlan;usable:boolean;offline?:boolean}
export function LayoverExperienceGeometry(props:Props){return <CurrentPlanGeometry key={`${props.sessionId}:${props.plan.id}:${props.plan.version}:${props.plan.contract.snapshotId}:${props.plan.stopIds.join(',')}`} {...props}/>;}
function CurrentPlanGeometry({sessionId,plan,usable,offline=false}:Props){
 const [map,setMap]=useState<ExperienceGeometry|null>(null),[busy,setBusy]=useState(false),[reason,setReason]=useState<string|null>(null);
 useEffect(()=>{
  setMap(null);setReason(null);if(!usable||offline||plan.contract.insideAirport)return;
  let current=true;const controller=new AbortController();setBusy(true);
  void getExperienceGeometry(sessionId,plan,controller.signal).then(result=>{if(!current)return;setBusy(false);if(result.ok)setMap(result.map);else setReason(result.reason);});
  return()=>{current=false;controller.abort();};
 },[sessionId,plan.id,plan.version,usable,offline]);
 useEffect(()=>{if(!map)return;const timer=setTimeout(()=>{setMap(null);setReason('route_geometry_stale');},Math.max(0,Math.min(Date.parse(map.expiresAt),Date.parse(plan.contract.expiresAt))-Date.now()));return()=>clearTimeout(timer);},[map,plan.contract.expiresAt]);
 if(plan.contract.insideAirport)return null;
 const current=usable&&!offline&&currentExperienceGeometry(map,plan,Date.now());
 return <View testID="experience-geometry" style={{gap:space.sm}}>
  {busy&&usable&&!offline?<ActivityIndicator/>:null}
  {current?<LayoverGoogleRouteMap data={null} selectedIds={[]} currentSnapshotId={plan.contract.snapshotId} experienceMap={map} experiencePlan={plan} airport={map.airport} nowMs={Date.now()}/>:<Text testID="experience-geometry-unavailable" style={{...t.small,color:color.mute}}>{offline?'Street navigation is not saved offline.':reason==='plan_route_terms_changed'||reason==='plan_route_expired'||reason==='candidate_changed'||reason==='plan_review_required'?'The measured route no longer fits this timetable. Review a new timed experience.':'The ordered street route is unavailable. Your return timetable remains above.'}</Text>}
 </View>;
}
