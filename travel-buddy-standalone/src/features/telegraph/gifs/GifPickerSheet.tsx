import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Modal,Pressable,ScrollView,Text,TextInput,View} from 'react-native';
import {Image} from 'expo-image';
import {usePrivateSurfaceKey} from '../../../hooks/usePrivateSurfaceKey.ts';
import {useMediaSurfaceActivity} from '../../../hooks/useMediaSurfaceActivity.ts';
import {captureMessagingOwnerRequest} from '../../../services/messagingOwnerRequest.ts';
import {useTelegraphPalette} from '../theme/telegraphTheme.ts';
import {sendTypedMessage} from '../kinds/kindsApi.ts';
import {gifProviderKey,searchGifs,type GifPage,type GifItem} from './giphyApi.ts';
import {GiphyAttribution} from './GiphyAttribution.tsx';
interface Props {visible:boolean;threadId:string;onClose:()=>void;onSent:()=>void}
export function GifPickerSheet(props:Props){const scope=usePrivateSurfaceKey();return props.visible?<OwnedPicker key={`${scope}:${props.threadId}`} {...props}/>:null;}
function OwnedPicker({visible,threadId,onClose,onSent}:Props){
 const p=useTelegraphPalette(),owner=useMemo(()=>captureMessagingOwnerRequest(),[]),controller=useRef<AbortController|null>(null),locked=useRef(false),alive=useRef(true);
 const [query,setQuery]=useState(''),[page,setPage]=useState<GifPage|null>(null),[selection,setSelection]=useState<GifItem|null>(null),[busy,setBusy]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState(''),[searched,setSearched]=useState<string|null>(null);
 const activity=useMediaSurfaceActivity(()=>{controller.current?.abort();setPage(null);setSelection(null);setBusy(false);setSending(false);locked.current=false;});
 useEffect(()=>()=>{alive.current=false;controller.current?.abort();},[]);
 const current=()=>Boolean(alive.current&&owner?.isCurrent()&&activity.isCurrent());
 async function load(q:string|null,offset=0){
  if(!current()||locked.current)return;controller.current?.abort();const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setSelection(null);setPage(null);setSearched(q);
  const result=await searchGifs(q,offset,{signal:abort.signal,isCurrent:current});
  if(abort.signal.aborted||!current())return;setBusy(false);
  if(result.ok)setPage(result.data);else if(result.error!=='cancelled')setError(result.error==='unconfigured'?'GIF search is not available right now.':'GIFs could not be loaded. Try again.');
 }
 async function send(){
  if(!selection||!current()||locked.current)return;locked.current=true;setSending(true);setError('');
  const result=await sendTypedMessage(threadId,'GIF',{provider:'giphy',providerId:selection.id});
  if(!current())return;locked.current=false;setSending(false);
  if(result.ok){onSent();onClose();}else setError('The GIF could not be sent. Try again.');
 }
 const button=(label:string,onPress:()=>void,disabled=false)=><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={{minHeight:44,justifyContent:'center',padding:10}}><Text style={{color:p.recvText,fontWeight:'600'}}>{label}</Text></Pressable>;
 return <Modal visible={visible&&activity.active&&Boolean(owner?.isCurrent())} transparent animationType="slide" onRequestClose={onClose}><View style={{flex:1,justifyContent:'flex-end',backgroundColor:'rgba(0,0,0,.35)'}}><View style={{backgroundColor:p.surface,padding:20,maxHeight:'85%',gap:8,borderTopLeftRadius:24,borderTopRightRadius:24}}>
 <Text accessibilityRole="header" style={{color:p.recvText,fontSize:22,fontWeight:'700'}}>Choose a GIF</Text>{button('Close GIF picker',onClose,sending)}
 {!gifProviderKey()?<Text style={{color:p.mute}}>GIF search is not available right now.</Text>:<>
 <Text style={{color:p.mute}}>Searches and image loads connect to GIPHY. Only the GIF you choose is shared with this conversation.</Text>
 <TextInput accessibilityLabel="Search GIFs" value={query} maxLength={50} onChangeText={value=>{controller.current?.abort();setBusy(false);setPage(null);setSelection(null);setQuery(value);}} placeholder="Search GIFs" placeholderTextColor={p.mute} style={{minHeight:44,color:p.recvText,borderWidth:1,borderColor:p.mute,borderRadius:12,padding:10}} onSubmitEditing={()=>void load(query)}/>
 <View style={{flexDirection:'row'}}>{button('Search',()=>void load(query),!query.trim()||sending)}{button('Browse popular GIFs',()=>void load(null),sending)}</View>
 {busy&&<Text accessibilityLiveRegion="polite" style={{color:p.mute}}>Loading GIFs…</Text>}
 <ScrollView keyboardShouldPersistTaps="handled"><View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>{page?.items.map(item=><Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Select ${item.title}`} accessibilityState={{selected:selection?.id===item.id,disabled:sending}} disabled={sending} onPress={()=>setSelection(item)} style={{width:'47%',minHeight:100,borderWidth:selection?.id===item.id?3:0,borderColor:p.operational}}><Image source={{uri:item.stillUrl}} cachePolicy="none" contentFit="contain" accessibilityLabel={item.title} style={{height:110,width:'100%'}}/></Pressable>)}</View>
 {page?.items.length===0&&<Text style={{color:p.mute}}>No GIFs found. Try another search.</Text>}
 {page?.nextOffset!=null&&button('Next GIFs',()=>void load(searched,page.nextOffset!),sending)}
 </ScrollView>
 {selection&&<Text style={{color:p.recvText}}>Selected: {selection.title}</Text>}{button(sending?'Sending GIF…':'Send selected GIF',()=>void send(),!selection||sending)}<GiphyAttribution/>
 </>}{Boolean(error)&&<View><Text accessibilityLiveRegion="polite" style={{color:p.mute}}>{error}</Text>{!selection&&button('Retry GIF search',()=>void load(searched),sending)}</View>}
 </View></View></Modal>;
}
