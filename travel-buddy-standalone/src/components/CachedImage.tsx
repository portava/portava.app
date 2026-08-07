import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import type { ImageContentFit } from 'expo-image';
import type { ImageStyle, StyleProp } from 'react-native';
import { useHydratedMedia } from '../services/mediaUrl.ts';
import { MediaFallback } from './ui/DisplayMediaImage.tsx';

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
 * ## Hydration is not optional
 *
 * post-media and profile-media are PRIVATE buckets. A stored value is either a
 * bare `<bucket>/<path>` reference or a legacy public URL into one of them, and
 * neither loads in an <Image>. useHydratedMedia turns both into a signed URL.
 * A component that skips this renders dead whitespace, which is what this one
 * used to do.
 *
 * On a null resolve or a load error it renders MediaFallback rather than
 * nothing, so a broken image is visibly broken instead of invisible.
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
  const uri = source?.uri;

  const { resolved: hydrated } = useHydratedMedia(uri ? [uri] : []);
  const [failed, setFailed] = useState(false);

  const prevUri = useRef(uri);
  if (prevUri.current !== uri) {
    prevUri.current = uri;
    setFailed(false);
  }

  // Initialised with the plain URI so the common case paints without waiting
  // on the async resolve; useHydratedMedia swaps in the signed URL.
  const [resolvedSource, setResolvedSource] = useState<{ uri: string } | null>(
    uri ? { uri } : null,
  );
  useEffect(() => {
    if (!uri) { setResolvedSource(null); return; }
    const next = hydrated[uri];
    if (typeof next === 'string') setResolvedSource({ uri: next });
    else if (next === null) { setResolvedSource(null); setFailed(true); }
    // undefined = still resolving; keep the plain URI.
  }, [uri, hydrated]);

  if (!uri || failed || !resolvedSource) {
    return (
      <View style={style as any} testID={testID}>
        <MediaFallback style={{ flex: 1 }} />
      </View>
    );
  }

  return (
    <ExpoImage
      source={resolvedSource}
      style={style as any}
      contentFit={contentFit}
      cachePolicy="disk"
      transition={200}
      onLoad={onLoad ? () => onLoad() : undefined}
      onError={() => { setFailed(true); onError?.(); }}
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
