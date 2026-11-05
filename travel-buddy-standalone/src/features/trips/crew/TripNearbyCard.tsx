import React,{useCallback,useEffect,useRef,useState}from'react';
import{AppState,Pressable,Text,View,StyleSheet,ActivityIndicator}from'react-native';
import{useFocusEffect}from'expo-router';
import{color,space,radius,type as t}from'../../../theme/tokens.ts';
import{captureMessagingOwnerRequest}from'../../../services/messagingOwnerRequest.ts';
import{newPostDestinationOperation}from'../../../services/postDestinations.ts';
import{nearbyAvailable,type NearbyPeer}from'../../../services/tripNearby.ts';
import{tripNearbyNative}from'../../../services/tripNearbyNative.ts';
import{createTripNearbyRun,type NearbyRunState}from'../../../services/tripNearbyRun.ts';
import{usePrivateSurfaceKey}from'../../../hooks/usePrivateSurfaceKey.ts';
export function TripNearbyCard({tripId,hidden=false}:{tripId:string;hidden?:boolean}){const key=usePrivateSurfaceKey();return <TripNearbyInner key={key+':'+tripId+':'+hidden} tripId={tripId} hidden={hidden}/>;}
function TripNearbyInner({tripId,hidden}:{tripId:string;hidden:boolean}){
 const owner=useRef(captureMessagingOwnerRequest()).current;const mounted=useRef(true);const focused=useRef(false);
 const run=useRef<ReturnType<typeof createTripNearbyRun>|null>(null);
 const[available,setAvailable]=useState<boolean|null>(null);const[state,setState]=useState<NearbyRunState>('stopped');
 const[message,setMessage]=useState<string|null>(null);const[peers,setPeers]=useState<NearbyPeer[]>([]);const[retry,setRetry]=useState(0);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;void run.current?.stop();};},[]);
 useEffect(()=>{
  const abort=new AbortController();setAvailable(null);setMessage(null);
  if(!owner||!tripNearbyNative||hidden){setAvailable(false);return;}
  void Promise.all([nearbyAvailable(tripId,{owner,signal:abort.signal}),tripNearbyNative.capabilities()]).then(([enabled,c])=>{
   if(!abort.signal.aborted&&owner.isCurrent())setAvailable(enabled&&c.supported);
  }).catch(()=>{if(!abort.signal.aborted)setMessage('Nearby checkpoints could not be checked.');});
  return()=>abort.abort();
 },[tripId,owner,hidden,retry]);
 useFocusEffect(useCallback(()=>{focused.current=true;return()=>{focused.current=false;void run.current?.stop();};},[]));
 useEffect(()=>{const sub=AppState.addEventListener('change',s=>{if(s!=='active')void run.current?.stop();});return()=>sub.remove();},[]);
 async function start(){
  if(!owner?.isCurrent()||!available||!focused.current||AppState.currentState!=='active')return;
  setMessage(null);await run.current?.stop();
  if(!mounted.current||!focused.current||!owner.isCurrent())return;
  const next=createTripNearbyRun({tripId,sessionId:newPostDestinationOperation(),owner,durationMinutes:5,
   onState:(s,m)=>{if(mounted.current&&owner.isCurrent()&&run.current===next){setState(s);setMessage(m??null);}},
   onPeers:p=>{if(mounted.current&&owner.isCurrent()&&run.current===next)setPeers(p);}});run.current=next;
  try{await next.start();}catch{if(mounted.current&&run.current===next)setMessage('Nearby Bluetooth is unavailable on this device.');}
 }
 const running=state==='active'||state==='starting';
 return <View style={s.card} testID="trip-nearby-card">
  <Text style={s.title}>Nearby trip members</Text>
  <Text style={s.body}>For five minutes, exchange rotating Bluetooth checkpoints with trip members who also opt in. Nearby members can see your handle. This uses the phone’s Bluetooth and nearby/location permission; it does not collect coordinates. Results expire within a minute. It stops when you leave this screen or the app.</Text>
  {available===null&&!message?<ActivityIndicator accessibilityLabel="Checking nearby availability"/>:null}
  {available===false?<Text style={s.body}>{hidden?'Nearby sharing is off while Ghost Mode is on.':'Nearby Bluetooth is not available for this trip or app build.'}</Text>:null}
  {message?<Text accessibilityRole="alert" style={s.body}>{message}</Text>:null}
  {available===null&&message?<Pressable accessibilityRole="button" onPress={()=>setRetry(v=>v+1)}><Text style={s.action}>Retry</Text></Pressable>:null}
  {available?<Pressable accessibilityRole="button" onPress={()=>running?void run.current?.stop():void start()} style={s.button}><Text style={s.action}>{state==='starting'?'Cancel starting':running?'Stop nearby sharing':'Opt in for 5 minutes'}</Text></Pressable>:null}
  {running?<Text accessibilityLiveRegion="polite" style={s.body}>{state==='starting'?'Preparing temporary nearby sharing…':'Nearby sharing is active. Bluetooth strength is approximate.'}</Text>:null}
  {state==='active'&&peers.length===0?<Text style={s.body}>No current nearby checkpoints.</Text>:null}
  {peers.map(p=><Text key={p.userId} style={s.body}>@{p.handle??'traveler'} · {p.proximity==='very_close'?'Strong nearby signal':p.proximity==='nearby'?'Nearby signal':p.proximity==='within_area'?'In Bluetooth range':'Weak Bluetooth signal'}</Text>)}
 </View>;
}
const s=StyleSheet.create({card:{padding:space.md,gap:space.sm,borderRadius:radius.lg,borderWidth:1,borderColor:color.haze,backgroundColor:color.paperRaised},title:{...t.bodyStrong,color:color.ink},body:{...t.small,color:color.mute},button:{padding:space.md,borderWidth:1,borderColor:color.signal,borderRadius:radius.md},action:{...t.bodyStrong,color:color.signalStrong}});
