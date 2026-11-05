import { useEffect, useMemo, useRef, useState } from 'react';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { fetchRecapAvailability } from './memoryApi.ts';

export interface ThreadRecapState { available:boolean; loading:boolean; reason:string|null; planId:string|null }

/** Startup reads plan availability only. Messages and participant lists load
 * on an explicit Recap open. Responses belong to one owner, thread and focus. */
export function useThreadRecap(threadId: string | null | undefined): ThreadRecapState {
  const scope=usePrivateSurfaceKey();
  const owner=useMemo(()=>captureMessagingOwnerRequest(),[scope]);
  const controller=useRef<AbortController|null>(null);
  const activity=useMediaSurfaceActivity(()=>controller.current?.abort());
  const key=`${scope}:${threadId}:${activity.epoch}`;
  const empty={available:false,loading:false,reason:null as string|null,planId:null as string|null};
  const [state,setState]=useState({...empty,key:''});
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;
    setState({...empty,key});
    if(!threadId||!owner||!activity.active)return()=>abort.abort();
    setState({...empty,key,loading:true});
    void fetchRecapAvailability(threadId,{owner,signal:abort.signal,isCurrent:activity.isCurrent}).then(result=>{
      if(abort.signal.aborted||!owner.isCurrent()||!activity.isCurrent())return;
      setState({key,planId:result.ok?result.data.planId:null,available:result.ok&&result.data.available,loading:false,reason:result.ok?result.data.available?null:'no_completed_plan':result.error});
    });
    return()=>abort.abort();
  },[key,threadId,owner,activity.active,activity.isCurrent]);
  return state.key===key&&owner?.isCurrent()&&activity.active?state:empty;
}
