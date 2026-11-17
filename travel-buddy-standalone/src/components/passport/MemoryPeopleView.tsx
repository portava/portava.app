import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSession } from '../../context/SessionContext.tsx';
import { capturePostDestinationOwner, listPostDestinationMemories } from '../../services/postDestinations.ts';
import type { MessagingOwnerRequest } from '../../services/messagingOwnerRequest.ts';
import { loadPassportPeople, setPassportMemorySource, type PeopleMemory } from '../../services/passportMemoryPeople.ts';
import type { Memory } from '../../services/memories.ts';
import { color, space, radius } from '../../theme/tokens.ts';

export function MemoryPeopleView() {
  const {userId}=useSession();
  return userId ? <OwnerPeople key={userId} ownerId={userId}/> : <Text>Sign in to view People.</Text>;
}
function OwnerPeople({ownerId}:{ownerId:string}) {
  const router=useRouter();
  const owner=useRef<MessagingOwnerRequest|null>(null);
  const [rows,setRows]=useState<PeopleMemory[]>([]);
  const [loading,setLoading]=useState(true), [error,setError]=useState<string|null>(null);
  const [editing,setEditing]=useState<PeopleMemory|null>(null);
  const refresh=useCallback(async()=>{
    owner.current?.invalidate();const request=capturePostDestinationOwner();owner.current=request;
    setRows([]);setEditing(null);setError(null);setLoading(true);
    if(!request||request.ownerId!==ownerId){setError('Sign in again to view People.');setLoading(false);return;}
    const result=await loadPassportPeople(request);
    if(owner.current!==request||!request.isCurrent())return;
    setLoading(false);if(result.ok)setRows(result.data);else setError(result.message);
  },[ownerId]);
  useFocusEffect(useCallback(()=>{
    void refresh();
    const sub=AppState.addEventListener('change',state=>{
      if(state==='active')void refresh();else{owner.current?.invalidate();setRows([]);setEditing(null);}
    });
    return ()=>{sub.remove();owner.current?.invalidate();owner.current=null;setRows([]);setEditing(null);};
  },[refresh]));
  const groups=new Map<string,{label:string;memories:PeopleMemory[]}>();
  for(const row of rows)if(row.people.state==='ready')for(const person of row.people.participants){
    const group=groups.get(person.userId)??{label:person.name??person.handle??'Traveller',memories:[]};
    group.memories.push(row);groups.set(person.userId,group);
  }
  return <View style={s.wrap} testID="memories-view-people-list">
    <Text style={s.description}>People from albums you choose to link. Each person’s current sharing settings apply.</Text>
    {loading&&<ActivityIndicator accessibilityLabel="Loading people"/>}
    {error&&<Text accessibilityRole="alert">{error}</Text>}
    <Pressable accessibilityRole="button" onPress={()=>void refresh()}><Text style={s.link}>Refresh people</Text></Pressable>
    {[...groups].map(([id,group])=><View key={id} style={s.section}>
      <Text style={s.heading}>{group.label}</Text>
      {group.memories.map(row=><Pressable key={row.id} accessibilityRole="button" onPress={()=>{if(row.people.state==='ready')router.push(`/memories/${row.people.resolvedSourceId}` as any);}}><Text style={s.link}>{row.title??'Untitled memory'}</Text></Pressable>)}
    </View>)}
    {!loading&&!error&&groups.size===0&&rows.some(r=>r.people.state==='ready')&&rows.every(r=>r.people.state!=='unavailable')&&<Text>No visible people in your linked albums.</Text>}
    {rows.map(row=><View key={row.id} style={s.section}>
      <Text style={s.heading}>{row.title??'Untitled memory'}</Text>
      <Text>{row.people.state==='unlinked'?'No album linked.':row.people.state==='unavailable'?'People are unavailable for this memory.':row.people.anonymousCount>0?`${row.people.anonymousCount} additional people are private.`:'Linked album'}</Text>
      {(row.people.state!=='unavailable'||row.people.sourceId)&&<Pressable accessibilityRole="button" accessibilityLabel={`Choose album for ${row.title??'memory'}`} onPress={()=>setEditing(row)}><Text style={s.link}>{row.people.state==='unlinked'?'Link an album':'Change linked album'}</Text></Pressable>}
    </View>)}
    {editing&&owner.current?.isCurrent()&&<SourcePicker key={editing.id} row={editing} owner={owner.current} onClose={()=>void refresh()} onChanged={()=>void refresh()}/>}
  </View>;
}
function SourcePicker({row,owner,onClose,onChanged}:{row:PeopleMemory;owner:MessagingOwnerRequest;onClose:()=>void;onChanged:()=>void}) {
  const [albums,setAlbums]=useState<Memory[]>([]), [cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState<string|null>(null);
  const busy=useRef(false),alive=useRef(true);
  const load=useCallback(async(after?:string|null)=>{
    if(!owner.isCurrent()||busy.current)return;busy.current=true;setLoading(true);setError(null);
    const result=await listPostDestinationMemories(owner,after);
    busy.current=false;if(!alive.current||!owner.isCurrent())return;setLoading(false);
    if(result.ok){setAlbums(prev=>[...new Map([...(after?prev:[]),...result.data.memories].map(m=>[m.id,m])).values()]);setCursor(result.data.nextCursor);}else setError(result.message);
  },[owner]);
  React.useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[load]);
  const save=async(memoryId:string|null)=>{
    if(!owner.isCurrent()||busy.current)return;busy.current=true;setSaving(true);setError(null);
    const expected=row.people.state==='unlinked'?null:row.people.sourceId;
    if(expected===undefined){busy.current=false;setSaving(false);setError('Refresh this memory before linking an album.');return;}
    const result=await setPassportMemorySource(owner,row.id,memoryId,expected);
    if(!alive.current||!owner.isCurrent())return;
    if(result.ok){onChanged();return;}
    // Keep writes disabled after an uncertain outcome. Closing and refreshing
    // re-reads the actual association before any new command can be attempted.
    setError(result.message);setSaving(false);
  };
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={s.wrap}>
      <Text style={s.heading}>Link an album</Text><Text>This changes your private People view. It does not add people or change either memory’s audience.</Text>
      {albums.map(album=><Pressable key={album.id} accessibilityRole="button" disabled={loading||saving||busy.current} onPress={()=>void save(album.id)} style={s.section}><Text>{album.title||'Untitled album'}</Text></Pressable>)}
      {loading&&<ActivityIndicator accessibilityLabel="Loading albums"/>}
      {cursor&&!loading&&<Pressable accessibilityRole="button" onPress={()=>void load(cursor)}><Text style={s.link}>Load more albums</Text></Pressable>}
      {row.people.state!=='unlinked'&&<Pressable accessibilityRole="button" disabled={loading||saving||busy.current} onPress={()=>void save(null)}><Text style={s.link}>Unlink album</Text></Pressable>}
      {saving&&<ActivityIndicator accessibilityLabel="Saving link"/>}
      {error&&<Text accessibilityRole="alert">{error}</Text>}
      <Pressable accessibilityRole="button" onPress={onClose}><Text style={s.link}>Close</Text></Pressable>
    </ScrollView>
  </Modal>;
}
const s=StyleSheet.create({wrap:{padding:space.md,gap:space.md},section:{gap:space.sm,padding:space.md,borderWidth:1,borderColor:color.haze,borderRadius:radius.md},heading:{fontSize:17,fontWeight:'600',color:color.ink},description:{color:color.mute,lineHeight:20},link:{color:color.ink,textDecorationLine:'underline',paddingVertical:8}});
