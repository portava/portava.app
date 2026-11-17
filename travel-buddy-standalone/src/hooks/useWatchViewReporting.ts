import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../services/ownedApiRequest.ts';
import { newClientEventId } from '../services/clientEventId.ts';
import { WatchViewObservation, type WatchPlaybackSample } from '../services/watchViewObservation.ts';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event callbacks only: no timer, poller, disk queue, or automatic retry. */
export function useWatchViewReporting(options: { mediaId: string; sessionId?: string; visible: boolean; eligible: boolean }) {
  const enabled=useFeatureFlags().isEnabled('MEDIA_RANKING_ENABLED');
  const scope=useRef({mediaId:options.mediaId,sessionId:options.sessionId,owner:captureMessagingOwnerRequest(),observation:new WatchViewObservation()});
  const current=useRef({...options,enabled});
  const controllers=useRef(new Set<AbortController>());
  useLayoutEffect(()=>{
    current.current={...options,enabled};
    if(scope.current.mediaId!==options.mediaId || scope.current.sessionId!==options.sessionId){
      for(const controller of controllers.current) controller.abort();
      controllers.current.clear();
      scope.current={mediaId:options.mediaId,sessionId:options.sessionId,owner:captureMessagingOwnerRequest(),observation:new WatchViewObservation()};
    }
    if(!enabled || !options.visible) scope.current.observation.reset();
    else if(!options.eligible) scope.current.observation.pause();
    if(!enabled){for(const controller of controllers.current) controller.abort();controllers.current.clear();}
  },[options.mediaId,options.sessionId,options.visible,options.eligible,enabled]);
  useEffect(()=>()=>{current.current.enabled=false;for(const controller of controllers.current) controller.abort();controllers.current.clear();},[]);
  return useCallback((status:WatchPlaybackSample)=>{
    const state=current.current; const captured=scope.current;
    if(state.mediaId!==options.mediaId || state.sessionId!==options.sessionId) return;
    const eligible=state.enabled && state.visible && state.eligible && AppState.currentState==='active' && captured.owner?.isCurrent()===true;
    if(!state.sessionId || !uuid.test(state.sessionId) || !uuid.test(state.mediaId)) return;
    const events=captured.observation.sample(status,eligible,Date.now());
    for(const event of events){
      const controller=new AbortController(); controllers.current.add(controller);
      const body={...event,sessionId:state.sessionId,eventId:newClientEventId()};
      void fetchOwnedApi(`/api/media/${state.mediaId}/view`,{method:'POST',body,owner:captured.owner!,signal:controller.signal,
        isCurrent:()=>current.current.enabled && scope.current===captured,
      }).then(async response=>{
        // Consume the receipt only; no optimistic counter or inferred success.
        // Failed, refused and malformed receipts never create client counters.
        if(response.ok) await response.json();
      }).catch(()=>{}).finally(()=>{controllers.current.delete(controller);});
    }
  },[options.mediaId,options.sessionId]);
}
