import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { FullscreenPhoto } from '../../components/ui/FullscreenPhoto.tsx';
import { CachedImage } from '../../components/CachedImage.tsx';
import { PostReferenceCard } from '../../components/PostReferenceCard.tsx';
import { SharedVideoPlayer } from '../../components/ui/SharedVideoPlayer.tsx';
import { POST_REFERENCE_MEDIA_TYPE } from '../../services/postDestinations.ts';
import type { MemoryItem } from '../../services/memories.ts';
import { MemoryVideoSegments } from './MemoryVideoSegments.tsx';
import { color } from '../../theme/tokens.ts';

/** One explicit renderer per stored media kind. A shared video remains a video. */
export function MemoryItemMedia({ item, ownerId, memoryId, isOwner, style }: { item: MemoryItem; ownerId: string; memoryId: string; isOwner: boolean; style?: StyleProp<ViewStyle> }) {
  if (item.mediaType === POST_REFERENCE_MEDIA_TYPE) return <PostReferenceCard mediaType={item.mediaType} uri={item.mediaUrl} />;
  if (!item.mediaUrl) return <View style={[style, { alignItems: 'center', justifyContent: 'center' }]}><Text style={{ color: color.mute }}>Media unavailable</Text></View>;
  if (item.mediaType === 'video' || item.mediaType?.startsWith('video/')) {
    return isOwner ? <MemoryVideoSegments ownerId={ownerId} memoryId={memoryId} itemId={item.id} uri={item.mediaUrl} style={style} />
      : <SharedVideoPlayer uri={item.mediaUrl} autoplay={false} style={style} />;
  }
  return <FullscreenPhoto uri={item.mediaUrl} style={style}><CachedImage source={{ uri: item.mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /></FullscreenPhoto>;
}
