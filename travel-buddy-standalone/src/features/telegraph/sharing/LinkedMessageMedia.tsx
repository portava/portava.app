import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { PortavaObjectMessage } from './PortavaObjectMessage.tsx';
import type { MediaShareRef } from './canonicalMediaLink.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';

/** Opening an encrypted reference explicitly requests its current source from Portava. */
export function LinkedMessageMedia({refInfo, encrypted, threadId, messageId, mine}: {
  refInfo: MediaShareRef & {caption: string | null}; encrypted: boolean; threadId: string | null; messageId: string; mine: boolean;
}) {
  const [requested, setRequested] = useState(false);
  const palette = useTelegraphPalette();
  if (encrypted && !requested) return <View>{refInfo.caption ? <Text style={{color: palette.recvText}}>{refInfo.caption}</Text> : null}<Pressable onPress={() => setRequested(true)} accessibilityRole="button" style={{padding: 12}}>
    <Text style={{color: palette.operational}}>Load shared {refInfo.objectType === 'POST' ? 'post' : 'media'}</Text>
  </Pressable></View>;
  return <PortavaObjectMessage body={JSON.stringify({kind:'PORTAVA_OBJECT', ...refInfo, shareProjectionVersion:'1'})} mine={mine} threadId={threadId} messageId={messageId} />;
}
