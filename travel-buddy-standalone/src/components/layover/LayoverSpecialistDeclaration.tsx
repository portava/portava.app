import React, {useState} from 'react';
import {View,Text,Switch,Pressable} from 'react-native';
import {router} from 'expo-router';
import {updateOffer,type BuddyCategory} from '../../services/rentABuddy.ts';
import {bookingErrorCopy} from '../../services/rentABuddyBookingErrors.ts';

/** The server validates live identity, payout readiness and trust before saving this declaration. */
export function LayoverSpecialistDeclaration({categories,onSaved}:{categories:BuddyCategory[];onSaved:()=>void}) {
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState<string|null>(null);
 const enabled=categories.includes('layover');
 async function save(value:boolean){if(busy)return;setBusy(true);setFailure(null);try{const result=await updateOffer({categories:value?[...categories,'layover']:categories.filter(c=>c!=='layover')});if(result.ok)onSaved();else setFailure(result.error??'layover_specialist_checks_unavailable');}catch{setFailure('layover_specialist_checks_unavailable');}finally{setBusy(false);}}
 return <View style={{padding:16,gap:8}}><Text>Layover specialist</Text><Text>Offer short visits that fit the traveller’s certified return deadline. Live identity verification, an eligible account and verified payout setup are required.</Text><Switch accessibilityLabel="Offer layover specialist services" value={enabled} disabled={busy} onValueChange={save}/>{failure?<Text accessibilityRole="alert">{bookingErrorCopy(failure)}</Text>:null}{failure==='layover_identity_verification_required'?<Pressable accessibilityRole="button" onPress={()=>router.push('/profile/verification' as never)}><Text>Open identity verification</Text></Pressable>:null}</View>;
}
