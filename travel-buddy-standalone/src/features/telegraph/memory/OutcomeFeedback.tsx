import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Pressable,Text,View} from 'react-native';
import {useMediaSurfaceActivity} from '../../../hooks/useMediaSurfaceActivity.ts';
import {captureMessagingOwnerRequest} from '../../../services/messagingOwnerRequest.ts';
import {useTelegraphPalette} from '../theme/telegraphTheme.ts';
import {fetchOutcomeContext,saveOutcomeResponse,removeOutcomeResponse,type OutcomeContext,type OutcomeResponse} from './memoryApi.ts';

/** Mounted only inside the private, owner-keyed recap. Opening it writes nothing. */
export function OutcomeFeedback({threadId,planId}:{threadId:string;planId:string}){
 const p=useTelegraphPalette();const owner=useMemo(()=>captureMessagingOwnerRequest(),[]);
 const controller=useRef<AbortController|null>(null);const locked=useRef(false);
 const activity=useMediaSurfaceActivity(()=>controller.current?.abort());
 const [context,setContext]=useState<OutcomeContext|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[revision,retry]=useState(0);
 const current=()=>Boolean(owner?.isCurrent()&&activity.isCurrent()&&!controller.current?.signal.aborted);
 useEffect(()=>{
  const abort=new AbortController();controller.current=abort;setContext(null);setError(null);setBusy(false);locked.current=false;
  if(!owner||!activity.active)return()=>abort.abort();
  void fetchOutcomeContext(threadId,planId,{owner,signal:abort.signal,isCurrent:activity.isCurrent}).then(result=>{
   if(abort.signal.aborted||!current())return;
   if(result.ok)setContext(result.data);else setError('Feedback is temporarily unavailable.');
  });
  return()=>abort.abort();
 },[threadId,planId,owner,activity.active,activity.epoch,activity.isCurrent,revision]);
 async function choose(response:OutcomeResponse|null){
  if(!owner||!current()||locked.current)return;locked.current=true;setBusy(true);setError(null);
  const requestController=controller.current;
  const request={owner,signal:requestController?.signal,isCurrent:activity.isCurrent};
  const result=response===null?await removeOutcomeResponse(threadId,planId,request):await saveOutcomeResponse(threadId,planId,response,request);
  if(requestController!==controller.current||!current())return;locked.current=false;setBusy(false);
  if(result.ok)setContext(old=>old?{...old,response:result.data.response}:old);else setError(result.message??'Your response could not be saved. Try again.');
 }
 const button=(label:string,action:()=>void)=><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:busy}} disabled={busy} onPress={action} style={{minHeight:44,justifyContent:'center',paddingHorizontal:14,borderRadius:20,backgroundColor:p.chipFill}}><Text style={{color:p.recvText}}>{label}</Text></Pressable>;
 if(!activity.active||!owner?.isCurrent()||context?.enabled===false)return null;
 return <View style={{gap:8}}>
  {context?.enabled&&<><Text accessibilityRole="header" style={{color:p.recvText,fontWeight:'700'}}>Did you meet up for this plan?</Text>
   <Text style={{color:p.mute}}>Optional feedback to improve coordination. Your answer stays private and expires after {context.retentionDays} days. Remove it here or clear all feedback in Message settings.</Text>
   {context.response?<><Text accessibilityLiveRegion="polite" style={{color:p.recvText}}>Your answer: {context.response==='met'?'I met up':"I didn’t meet up"}</Text>{button('Remove my answer',()=>void choose(null))}</>
    :<View style={{flexDirection:'row',gap:8,flexWrap:'wrap'}}>{button('I met up',()=>void choose('met'))}{button('I didn’t meet up',()=>void choose('did_not_meet'))}</View>}
  </>}
  {error&&<View accessibilityLiveRegion="polite"><Text style={{color:p.mute}}>{error}</Text>{!context&&button('Retry feedback',()=>retry(n=>n+1))}</View>}
 </View>;
}
