import React from 'react';
import {Pressable,Text,View} from 'react-native';
import type {LayoverOverview,ReturnNowOutcome} from '../../services/layover.ts';
import type {SafeReturnAbortController} from './useSafeReturnAbort.ts';
import {color,space,type as t} from '../../theme/tokens.ts';
export function LayoverBuddyAbortToggle({overview,controller}:{overview:LayoverOverview;controller:SafeReturnAbortController}){
 if(overview.buddyAbortNotice?.available!==true||!controller.setTellBuddy)return null;
 return <Pressable testID="abort-tell-buddy-toggle" accessibilityRole="checkbox" accessibilityLabel="Tell my booked Buddy I'm heading back to the airport" accessibilityState={{checked:controller.tellBuddy===true,disabled:controller.busy}} disabled={controller.busy} onPress={()=>controller.setTellBuddy?.(!controller.tellBuddy)} style={{marginTop:space.md}}><Text style={{...t.bodyStrong,color:color.ink}}>{controller.tellBuddy?'☑':'☐'} Tell my booked Buddy I'm heading back</Text><Text style={{...t.small,color:color.mute}}>They will see only that their booked traveler is heading back to the airport.</Text></Pressable>;
}
export function BuddyAbortNotice({outcome}:{outcome:ReturnNowOutcome|null}){
 const result=outcome?.kind==='ok'?outcome.result:outcome?.kind==='partial'?outcome:null;
 if(!result||result.buddyNotifyUnavailableReason===undefined||result.buddyNotifyUnavailableReason==='not_requested'||result.buddyNotifyUnavailableReason==='buddy_notify_not_enabled')return null;
 const count=result.buddyNotifiedCount??0;
 const text=count>0?`${count===1?'Your booked Buddy has':`${count} booked Buddies have`} an in-app heading-back notice.${result.buddyNotifyUnavailableReason?' Some notices could not be confirmed.':''}`:result.buddyNotifyUnavailableReason==='notify_timed_out'?'Your Buddy notice could not be confirmed in time.':'Your booked Buddy could not be notified.';
 return <View><Text testID="abort-buddy-notice" style={{...t.small,color:color.mute}}>{text}</Text></View>;
}
