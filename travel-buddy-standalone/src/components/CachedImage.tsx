import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import type { ImageContentFit } from 'expo-image';
import type { ImageStyle, StyleProp, ViewStyle } from 'react-native';
import { useHydratedMedia } from '../services/mediaUrl.ts';
import { MediaFallback } from './ui/DisplayMediaImage.tsx';
import { resolveFilterStyle } from '../lib/media/filters.ts';
import { aspect as aspectTokens } from '../theme/tokens.ts';

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
  /**
   * Media filter id (see lib/media/filters.ts). Unknown, malformed and absent
   * values all render the image unfiltered — never blank.
   */
  filterId?: string | null;
  /** Filter strength 0–100. Defaults to full strength when absent. */
  filterIntensity?: number | null;
  /**
   * Caption for the fallback. Pass '' on surfaces too small to fit one —
   * map pins, badges, tiles under roughly 64pt — where the icon alone is the
   * affordance and "Image unavailable" would just be clipped. See MediaFallback.
   */
  fallbackLabel?: string;
  /**
   * Forwarded to the image. Set it whenever the image carries meaning the
   * surrounding text does not already state — callers that swapped in from a
   * bare <Image> must not silently drop the label they had.
   */
  accessibilityLabel?: string;
  /**
   * Optional sizing contract. Accepts a named ratio from `theme/tokens.ts`
   * `aspect` (wide/card/square/portrait/story) or a raw width/height number.
   * Applied as `aspectRatio` on top of `style`, so callers keep controlling
   * width via `style` and stop hand-writing `aspectRatio: 4 / 5` inline.
   * Purely additive — omitting it leaves every existing caller unchanged.
   */
  aspect?: keyof typeof aspectTokens | number;
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
  filterId,
  filterIntensity,
  fallbackLabel,
  accessibilityLabel,
  aspect,
}: CachedImageProps) {
  const contentFit: ImageContentFit = CONTENT_FIT_MAP[resizeMode] ?? 'cover';
  const uri = source?.uri;

  // undefined when `aspect` is omitted, so sizedStyle === style and every
  // pre-existing caller renders byte-for-byte the same as before this prop
  // existed.
  const aspectRatio = aspect === undefined ? undefined : (typeof aspect === 'number' ? aspect : aspectTokens[aspect]);
  const sizedStyle = aspectRatio === undefined ? style : [style, { aspectRatio }];

  // undefined for every no-filter case (absent / 'original' / unknown id /
  // malformed intensity). Not a hook — safe to compute before the early return.
  const filterStyle = resolveFilterStyle(
    filterId,
    filterIntensity,
    Platform.OS === 'web' ? 'web' : 'native',
  );

  const { resolved: hydrated } = useHydratedMedia(uri ? [uri] : []);
  const [failed, setFailed] = useState(false);

  // Initialised with the plain URI so the common case paints without waiting
  // on the async resolve; useHydratedMedia swaps in the signed URL.
  const [resolvedSource, setResolvedSource] = useState<{ uri: string } | null>(
    uri ? { uri } : null,
  );

  // When `uri` changes to a different value (e.g. a caller that pre-hydrates
  // before handing us a URL — see PostcardsTab — settling from a raw storage
  // path to a signed URL across renders), resync BOTH `failed` and
  // `resolvedSource` together in the same render. Resetting only `failed`
  // here left `resolvedSource` pinned to the stale prior URI for one extra
  // render; if that stale URI failed to load (e.g. an unsigned private-bucket
  // path), it re-latched `failed = true` and the flag was never cleared again
  // once `uri` stabilized — even after this component's own hydration below
  // resolved the correct signed URL, permanently blanking the tile.
  const prevUri = useRef(uri);
  if (prevUri.current !== uri) {
    prevUri.current = uri;
    setFailed(false);
    setResolvedSource(uri ? { uri } : null);
  }

  useEffect(() => {
    if (!uri) { setResolvedSource(null); return; }
    const next = hydrated[uri];
    if (typeof next === 'string') setResolvedSource({ uri: next });
    else if (next === null) { setResolvedSource(null); setFailed(true); }
    // undefined = still resolving; keep the plain URI.
  }, [uri, hydrated]);

  if (!uri || failed || !resolvedSource) {
    return (
      <View style={sizedStyle as any} testID={testID}>
        <MediaFallback style={{ flex: 1 }} label={fallbackLabel} />
      </View>
    );
  }

  const image = (
    <ExpoImage
      source={resolvedSource}
      style={filterStyle ? StyleSheet.absoluteFill : (sizedStyle as any)}
      contentFit={contentFit}
      cachePolicy="disk"
      transition={200}
      onLoad={onLoad ? () => onLoad() : undefined}
      onError={() => { setFailed(true); onError?.(); }}
      testID={testID}
      placeholder={placeholder ? { blurhash: placeholder } : undefined}
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
    />
  );

  // No filter → return the image exactly as this component always has. The
  // wrapper is introduced ONLY when a filter is active, so the default feed
  // render path is unchanged and an unknown filter id cannot alter layout.
  if (!filterStyle) return image;

  // `filter` is typed on ViewStyle but not ImageStyle (ImageStyle does not
  // extend ViewStyle), so it has to ride on a wrapper. The wrapper takes the
  // caller's style — including any borderRadius — and clips, while the image
  // fills it absolutely.
  return (
    <View style={[sizedStyle as StyleProp<ViewStyle>, { overflow: 'hidden' }, filterStyle as StyleProp<ViewStyle>]}>
      {image}
    </View>
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
