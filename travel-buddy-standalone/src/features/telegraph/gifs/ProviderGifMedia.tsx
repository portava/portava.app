import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Modal,Pressable,Text,View,StyleSheet,type StyleProp,type ViewStyle,type TextStyle} from 'react-native';
import {Image} from 'expo-image';
import {usePrivateSurfaceKey} from '../../../hooks/usePrivateSurfaceKey.ts';
import {useMediaSurfaceActivity} from '../../../hooks/useMediaSurfaceActivity.ts';
import {captureMessagingOwnerRequest} from '../../../services/messagingOwnerRequest.ts';
import {resolveGif,validGifId,type GifItem} from './giphyApi.ts';
import {GiphyAttribution} from './GiphyAttribution.tsx';
interface Props {providerId:string;reduceMotion:boolean;dataSaver:boolean;style:StyleProp<ViewStyle>;textStyle:StyleProp<TextStyle>}
export function ProviderGifMedia(props:Props){const scope=usePrivateSurfaceKey();return <OwnedProviderGif key={`${scope}:${props.providerId}`} {...props}/>;}
function OwnedProviderGif({providerId,reduceMotion,dataSaver,style,textStyle}:Props){
 const owner=useMemo(()=>captureMessagingOwnerRequest(),[]),controller=useRef<AbortController|null>(null),alive=useRef(true);
 const [item,setItem]=useState<GifItem|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false),[playing,setPlaying]=useState(false),[full,setFull]=useState(false);
 const activity=useMediaSurfaceActivity(()=>{controller.current?.abort();setItem(null);setPlaying(false);setFull(false);setBusy(false);});
 useEffect(()=>()=>{alive.current=false;controller.current?.abort();},[]);
 useEffect(()=>{if(reduceMotion||dataSaver)setPlaying(false);},[reduceMotion,dataSaver]);
 const current=()=>alive.current&&Boolean(owner?.isCurrent()&&activity.isCurrent());
 async function load(){
  if(!current()||busy)return;const abort=new AbortController();controller.current=abort;setBusy(true);setError(false);
  const result=await resolveGif(providerId,{signal:abort.signal,isCurrent:current});
  if(abort.signal.aborted||!current())return;setBusy(false);
  if(result.ok){setItem(result.data);setPlaying(!reduceMotion&&!dataSaver);}else setError(true);
 }
 const button=(label:string,action:()=>void)=><Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:busy}} disabled={busy} onPress={()=>{if(current())action();}} style={{minHeight:44,justifyContent:'center',padding:8}}><Text style={textStyle}>{label}</Text></Pressable>;
 if(!activity.active||!owner?.isCurrent()||!validGifId(providerId))return <Text style={textStyle}>GIF unavailable</Text>;
 // No recipient contacts a provider merely because a sender posted an id.
 if(!item)return <View style={style}><Text style={textStyle}>{busy?'Loading GIF…':error?'GIF unavailable. Try again.':'Load this GIF from GIPHY.'}</Text>{button(error?'Retry GIF':'Load GIF',()=>void load())}</View>;
 const uri=playing?item.url:item.stillUrl;
 return <View>{!full&&<Pressable accessibilityRole="button" accessibilityLabel="View GIF full screen" style={style} onPress={()=>{if(current())setFull(true);}}><Image source={{uri}} cachePolicy="none" contentFit="contain" style={StyleSheet.absoluteFill} accessibilityLabel={item.title}/></Pressable>}
 {button(playing?'Pause GIF':'Play GIF',()=>setPlaying(!playing))}<GiphyAttribution/>
 <Modal visible={full} animationType="fade" onRequestClose={()=>setFull(false)}><View style={{flex:1,backgroundColor:'#000',paddingTop:55,paddingBottom:35}}><Pressable accessibilityRole="button" accessibilityLabel="Close full-screen GIF" onPress={()=>setFull(false)} style={{minHeight:48,padding:16}}><Text style={{color:'#fff'}}>Close</Text></Pressable><Image source={{uri}} cachePolicy="none" contentFit="contain" style={{flex:1}} accessibilityLabel={item.title}/><Pressable accessibilityRole="button" accessibilityLabel={playing?'Pause GIF':'Play GIF'} onPress={()=>{if(current())setPlaying(!playing);}} style={{minHeight:48,padding:16}}><Text style={{color:'#fff'}}>{playing?'Pause GIF':'Play GIF'}</Text></Pressable><GiphyAttribution/></View></Modal></View>;
}
