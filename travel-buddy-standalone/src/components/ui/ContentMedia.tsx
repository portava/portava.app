import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
import { FullscreenPhoto } from './FullscreenPhoto.tsx';
import { SharedVideoPlayer } from './SharedVideoPlayer.tsx';
import { refPlaysAsVideo } from '../../lib/media/videoPosterRef.ts';

export interface ContentMediaProps {
  uri?: string | null;
  thumbnailUri?: string | null;
  mediaType?: string | null;
  photos?: string[];
  style: StyleProp<ViewStyle>;
  alt?: string;
}

/** Content previews open originals; a thumbnail alone never becomes an original. */
export function ContentMedia({ uri, thumbnailUri, mediaType, photos, style, alt }: ContentMediaProps) {
  if (uri && refPlaysAsVideo(uri, { mediaType })) {
    return <SharedVideoPlayer uri={uri} poster={thumbnailUri ?? undefined} autoplay={false} style={style} />;
  }
  const image = thumbnailUri || uri;
  if (!image) return null;
  if (!uri) return <View style={style}><CachedImage source={{ uri: image }} style={StyleSheet.absoluteFill} accessibilityLabel={alt ?? 'Media preview'} resizeMode="cover" /></View>;
  return <FullscreenPhoto uri={uri} photos={photos} style={style}>
    <CachedImage source={{ uri: image }} style={StyleSheet.absoluteFill} accessibilityLabel={alt ?? 'Photo'} resizeMode="cover" />
  </FullscreenPhoto>;
}
