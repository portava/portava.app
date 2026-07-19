import React from 'react';
import { Image as ExpoImage } from 'expo-image';
import type { ImageContentFit } from 'expo-image';
import type { ImageStyle, StyleProp } from 'react-native';

type ResizeMode = 'cover' | 'contain' | 'stretch' | 'center' | 'repeat';

const CONTENT_FIT_MAP: Record<ResizeMode, ImageContentFit> = {
  cover:   'cover',
  contain: 'contain',
  stretch: 'fill',
  center:  'none',       // RN 'center' keeps original size centred; expo-image 'none' is equivalent
  repeat:  'cover',      // expo-image has no tiling mode; fall back to cover
};

interface CachedImageProps {
  /** Remote URI source — do NOT use for static local require() assets. */
  source: { uri: string | undefined } | { uri: string };
  style?: StyleProp<ImageStyle>;
  /** Maps to expo-image contentFit. Defaults to 'cover'. */
  resizeMode?: ResizeMode;
  onLoad?: () => void;
  onError?: () => void;
  testID?: string;
  /** Optional blur-hash string shown while the image loads. */
  placeholder?: string;
}

/**
 * Drop-in replacement for RN <Image> in list/feed contexts.
 *
 * Renders expo-image with disk + memory caching and a 200 ms fade-in
 * transition. Use this for all remote URI images in feed lists (Pulse
 * cards, event covers, postcard grids, avatars). For static local assets
 * (require(...)) continue using RN Image directly.
 *
 * Props are a subset of RN ImageProps so it is a drop-in replacement:
 *   source, style, resizeMode, onLoad, onError, testID, placeholder.
 */
export function CachedImage({
  source,
  style,
  resizeMode = 'cover',
  onLoad,
  onError,
  testID,
  placeholder,
}: CachedImageProps) {
  const contentFit: ImageContentFit = CONTENT_FIT_MAP[resizeMode] ?? 'cover';
  return (
    <ExpoImage
      source={source}
      style={style as any}
      contentFit={contentFit}
      cachePolicy="disk"
      transition={200}
      onLoad={onLoad ? () => onLoad() : undefined}
      onError={onError ? () => onError() : undefined}
      testID={testID}
      placeholder={placeholder ? { blurhash: placeholder } : undefined}
    />
  );
}

/**
 * Append Supabase image-transform query params to a storage URL if not
 * already present. Only modifies URLs containing 'supabase' so CDN,
 * Unsplash, or other third-party URLs are left unchanged.
 *
 * @example
 *   withStorageParams(avatarUrl, 'width=100&quality=80')
 *   // → "https://<project>.supabase.co/storage/v1/...?width=100&quality=80"
 */
export function withStorageParams(
  uri: string | undefined | null,
  params: string,
): string | undefined {
  if (!uri) return undefined;
  // Leave non-Supabase URLs and already-transformed URLs untouched
  if (!uri.includes('supabase') || uri.includes('width=')) return uri;
  return uri.includes('?') ? `${uri}&${params}` : `${uri}?${params}`;
}
