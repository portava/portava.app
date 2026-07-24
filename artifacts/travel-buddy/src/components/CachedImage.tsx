import React, { useEffect, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import type { ImageContentFit } from 'expo-image';
import type { ImageStyle, StyleProp } from 'react-native';
import { mediaSource } from '../lib/mediaSource.ts';

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
 *
 * The source URI is resolved through mediaSource() so that when the
 * `media_private_buckets_enabled` flag is ON the relay endpoint and
 * Bearer token are used. When the flag is OFF the original URI is used
 * unchanged (fast path via module-level cache after the first call).
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

  // Resolved source: starts as the original source object so the image begins
  // loading immediately (correct for flag-OFF, the common case).  When the
  // async resolution completes (nearly instant from cache on subsequent calls)
  // it is updated to include the relay URL + auth headers when the flag is ON.
  const [resolvedSource, setResolvedSource] = useState<
    { uri: string | undefined; headers?: Record<string, string> }
  >(source);

  useEffect(() => {
    const uri = source.uri;
    if (!uri) {
      setResolvedSource(source);
      return;
    }
    let cancelled = false;
    mediaSource(uri).then((src) => {
      if (!cancelled) setResolvedSource(src);
    });
    return () => { cancelled = true; };
  }, [source.uri]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ExpoImage
      source={resolvedSource}
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
 * When the `media_private_buckets_enabled` flag is ON the relay endpoint
 * serves raw files (transform params are stripped by toAppMediaUrl), so
 * this helper's params are only meaningful in the flag-OFF path.
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
