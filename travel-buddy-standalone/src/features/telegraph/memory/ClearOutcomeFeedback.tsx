import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {usePrivateSurfaceKey} from '../../../hooks/usePrivateSurfaceKey.ts';
import {useMediaSurfaceActivity} from '../../../hooks/useMediaSurfaceActivity.ts';
import {captureMessagingOwnerRequest} from '../../../services/messagingOwnerRequest.ts';
import {removeAllOutcomeResponses} from './memoryApi.ts';
import {PP} from '../../../theme/passportTokens.ts';
export function ClearOutcomeFeedback(){const scope=usePrivateSurfaceKey();return <OwnedClear key={scope}/>;}
function OwnedClear(){
 const owner=useMemo(()=>captureMessagingOwnerRequest(),[]),controller=useRef<AbortController|null>(null),lock=useRef(false);
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>()=>controller.current?.abort(),[]);
 const activity=useMediaSurfaceActivity(()=>{controller.current?.abort();lock.current=false;setBusy(false);setConfirm(false);setMessage('');});
 async function remove(){
  if(!owner?.isCurrent()||!activity.isCurrent()||lock.current)return;
  const abort=new AbortController();controller.current=abort;lock.current=true;setBusy(true);setMessage('');
  const result=await removeAllOutcomeResponses({owner,signal:abort.signal,isCurrent:activity.isCurrent});
  if(abort.signal.aborted||!owner.isCurrent()||!activity.isCurrent())return;
  lock.current=false;setBusy(false);if(result.ok){setConfirm(false);setMessage('Your coordination feedback has been removed.');}else setMessage('Your feedback could not be removed. Please try again.');
 }
 if(!activity.active||!owner?.isCurrent())return null;
 return <View style={{padding:16,gap:8}}><Text style={{color:PP.inkMuted}}>Remove all optional answers about whether you met up, including plans you no longer have access to.</Text>
 <Pressable accessibilityRole="button" accessibilityLabel={confirm?'Remove all my answers':'Clear my coordination feedback'} accessibilityState={{disabled:busy}} disabled={busy} onPress={()=>confirm?void remove():setConfirm(true)} style={{minHeight:44,justifyContent:'center'}}><Text style={{color:PP.ink,fontWeight:'600'}}>{busy?'Removing…':confirm?'Remove all my answers':'Clear my coordination feedback'}</Text></Pressable>
 {confirm&&!busy&&<Pressable accessibilityRole="button" onPress={()=>setConfirm(false)} style={{minHeight:44,justifyContent:'center'}}><Text style={{color:PP.ink}}>Cancel</Text></Pressable>}
 {Boolean(message)&&<Text accessibilityLiveRegion="polite" style={{color:PP.inkMuted}}>{message}</Text>}</View>;
}
