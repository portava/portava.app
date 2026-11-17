import React, {useCallback,useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {useSession} from '../../context/SessionContext.tsx';
import {getMemoryMediaBindings,reconcileMemoryMediaReference,type MemoryMediaBindingReview} from '../../services/adminMedia.ts';
import {color,space,radius} from '../../theme/tokens.ts';

const labels:Record<MemoryMediaBindingReview['status'],string>={candidate:'Matching original found',external_reference:'External photo link',unsupported_reference:'Link needs investigation',missing_source:'Original not found',ambiguous_source:'Multiple originals found',owner_mismatch:'Ownership does not match',unavailable:'Source unavailable'};

export function MemoryMediaBindingsPanel() {
 const {userId}=useSession();
 const [items,setItems]=useState<MemoryMediaBindingReview[]>([]),[next,setNext]=useState<string|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
 const [reasons,setReasons]=useState<Record<string,string>>({}),[refreshRequired,setRefreshRequired]=useState(false),[loaded,setLoaded]=useState(false);
 const epoch=useRef(0),pending=useRef(false),identity=useRef(userId);identity.current=userId;
 const load=useCallback(async(after?:string)=>{
  if(pending.current||!userId)return;
  const run=++epoch.current;pending.current=true;setBusy(true);setError(null);setMessage(null);
  try {
   const result=await getMemoryMediaBindings(after);
   if(run!==epoch.current||identity.current!==userId)return;
   if(!result.ok)throw new Error(result.error);
   if(!Array.isArray(result.data?.items)||!(result.data.nextCursor===null||typeof result.data.nextCursor==='string')
     ||result.data.items.some(item=>!item||!Object.hasOwn(labels,item.status)||typeof item.itemId!=='string'||typeof item.reviewedUrlHash!=='string'))throw new Error('The review response could not be verified.');
   setItems(result.data.items);setNext(result.data.nextCursor);setReasons({});setRefreshRequired(false);setLoaded(true);
  }catch(e){if(run===epoch.current&&identity.current===userId){setError(e instanceof Error?e.message:'References could not be loaded.');setRefreshRequired(true);}}
  finally{if(run===epoch.current){pending.current=false;setBusy(false);}}
 },[userId]);
 useEffect(()=>{
  pending.current=false;setItems([]);setNext(null);setReasons({});setError(null);setMessage(null);setLoaded(false);setRefreshRequired(true);void load();
  return()=>{epoch.current++;pending.current=false;};
 },[load]);
 async function reconcile(item:MemoryMediaBindingReview){
  const reason=(reasons[item.itemId]??'').trim();
  if(pending.current||refreshRequired||!userId||!reason||!item.assetId||item.status!=='candidate')return;
  const run=++epoch.current;pending.current=true;setBusy(true);setError(null);setMessage(null);
  try{
   const result=await reconcileMemoryMediaReference(item,reason);
   if(run!==epoch.current||identity.current!==userId)return;
   if(!result.ok)throw new Error(result.error);
   if(result.data?.ok!==true||result.data.itemId!==item.itemId||result.data.assetId!==item.assetId)throw new Error('The result could not be confirmed.');
   setItems(current=>current.filter(row=>row.itemId!==item.itemId));setMessage('Original linked. The Memory’s visibility is unchanged.');
  }catch(e){if(run===epoch.current&&identity.current===userId){setError(`${e instanceof Error?e.message:'The result could not be confirmed.'} Refresh the review before another action.`);setRefreshRequired(true);}}
  finally{if(run===epoch.current){pending.current=false;setBusy(false);}}
 }
 if(!userId)return null;
 return <ScrollView contentContainerStyle={styles.content}>
  <Text style={styles.title}>Memory originals</Text>
  <Text>Review older photo links before recovery. Linking an original preserves the Memory’s privacy and does not publish or restore the photo.</Text>
  <Pressable accessibilityRole="button" accessibilityLabel="Refresh Memory references" disabled={busy} onPress={()=>void load()} style={styles.button}><Text>Refresh review</Text></Pressable>
  {busy&&<ActivityIndicator accessibilityLabel="Loading Memory references"/>}
  {error&&<Text accessibilityRole="alert" testID="memory-bindings-error">{error}</Text>}
  {message&&<Text accessibilityRole="alert">{message}</Text>}
  {loaded&&!error&&!items.length&&<Text testID="memory-bindings-empty">No unlinked references on this page.</Text>}
  {items.map(item=><View key={item.itemId} style={styles.item}>
   <Text style={styles.title}>{item.memoryTitle||'Untitled Memory'}</Text>
   <Text>{labels[item.status]}</Text>
   {item.source&&<Text selectable>{item.source.bucket}/{item.source.path}</Text>}
   {item.status==='candidate'&&item.assetId&&<>
    <TextInput accessibilityLabel={`Reason for ${item.itemId}`} placeholder="Reason for linking this original" value={reasons[item.itemId]??''} onChangeText={value=>setReasons(current=>({...current,[item.itemId]:value}))} editable={!busy&&!refreshRequired} maxLength={1000} style={styles.input}/>
    <Pressable accessibilityRole="button" accessibilityLabel={`Link original for ${item.itemId}`} disabled={busy||refreshRequired||!(reasons[item.itemId]??'').trim()} onPress={()=>void reconcile(item)} style={styles.button}><Text>Link reviewed original</Text></Pressable>
   </>}
  </View>)}
  {next&&<Pressable accessibilityRole="button" disabled={busy||refreshRequired} onPress={()=>void load(next)} style={styles.button}><Text>Next page</Text></Pressable>}
  <Text>Refresh starts a new review of current records. New or changed references may appear on an earlier page.</Text>
 </ScrollView>;
}
const styles=StyleSheet.create({content:{padding:space.md,gap:space.md},title:{fontSize:17,fontWeight:'600',color:color.ink},item:{gap:space.sm,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:color.mute},button:{padding:space.sm,borderWidth:1,borderColor:color.mute,borderRadius:radius.md},input:{padding:space.sm,borderWidth:1,borderColor:color.mute,borderRadius:radius.md,color:color.ink}});
