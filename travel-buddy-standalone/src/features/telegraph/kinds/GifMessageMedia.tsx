import React, { useState } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import { ContentMedia } from '../../../components/ui/ContentMedia.tsx';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import { messageTreeMediaOrNull } from '../media/messageTreeMedia.ts';

export function isGifAnimated(opts:{reduceMotion:boolean;dataSaver:boolean}):boolean {
  return !opts.reduceMotion && !opts.dataSaver;
}

interface Props {
  url: unknown;
  stillUrl?: unknown;
  altText?: string;
  reduceMotion: boolean;
  dataSaver: boolean;
  style: StyleProp<ViewStyle>;
  textStyle: StyleProp<TextStyle>;
}

export function GifMessageMedia(props:Props) {
  const scope = usePrivateSurfaceKey();
  return <ScopedGif key={`${scope}:${String(props.url)}:${props.reduceMotion}:${props.dataSaver}`} {...props} />;
}
function ScopedGif({url,stillUrl,altText,reduceMotion,dataSaver,style,textStyle}:Props) {
  const [choice,setChoice] = useState<boolean | null>(null);
  const activity = useMediaSurfaceActivity(()=>setChoice(false));
  const source = messageTreeMediaOrNull(url);
  const still = messageTreeMediaOrNull(stillUrl);
  const playing = activity.active && (choice ?? isGifAnimated({reduceMotion,dataSaver}));
  // A missing/same/animated still must not silently load the animation while
  // announcing that motion is disabled. Originals remain one explicit tap away.
  const safeStill = still && still !== source && !/\.(gif|webp)(?:[?#]|$)/i.test(still) ? still : null;
  const uri = messageTreeMediaOrNull(playing ? source : source ? safeStill : null);
  return <View>
    {uri && activity.active
      ? <ContentMedia uri={uri} alt={altText ?? 'GIF'} style={style} />
      : <View style={[style,{alignItems:'center',justifyContent:'center'}]}><Text style={textStyle}>{source ? 'GIF paused' : 'GIF unavailable'}</Text></View>}
    {!playing ? <Text style={textStyle} testID="telegraph-kind-gif-still">
      {choice === false ? 'Animation paused' : reduceMotion ? 'Reduced motion is on' : 'Data saver is on'}
    </Text> : null}
    {source ? <Pressable accessibilityRole="button" accessibilityLabel={playing ? 'Pause GIF' : 'Play GIF'}
      disabled={!activity.active} style={{minHeight:44,justifyContent:'center'}}
      onPress={()=>{if(activity.isCurrent()) setChoice(!playing);}}>
      <Text style={textStyle}>{playing ? 'Pause GIF' : 'Play GIF'}</Text>
    </Pressable> : null}
  </View>;
}
