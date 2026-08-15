/**
 * DisplayMediaImage — unified image component with skeleton, onError fallback,
 * and designed no-image state. Replaces bare <Image> + ad-hoc gray-box patterns.
 *
 * Use DisplayMediaImage for content images (covers, thumbnails, postcards).
 * Use AvatarImage for circular user/buddy avatars.
 *
 * Both components:
 *   - Never render a blank rectangle — onError → designed fallback
 *   - Respect reduce-motion (skeleton omits pulse animation when enabled)
 *   - Forward accessibilityLabel from alt / title
 *
 * Media sources are resolved through useHydratedMedia() so that when the
 * `media_private_buckets_enabled` flag is ON, images are served via signed
 * URLs. When the flag is OFF (default) the original URL is used with no
 * overhead.  On a 403/onError the cached entry is evicted and one re-hydration
 * attempt is made before transitioning to the designed fallback.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import type { ImageContentFit } from 'expo-image';
import { color, radius, space, type as t, icon } from '../../theme/tokens.ts';
import { type IdentityInput, fallbackInitials } from '../../utils/identity.ts';
import { resolveDisplayMedia } from '../../lib/displayMedia.ts';
import { hydrateMediaUrls, useHydratedMedia } from '../../services/mediaUrl.ts';
import { _evictBatchSignEntry } from '../../lib/batchSignMedia.ts';
import { resolveFilterStyle, type FilterStyle } from '../../lib/media/filters.ts';

// Only these two buckets can benefit from re-hydration; all other URLs get an
// immediate error fallback rather than a no-op re-sign attempt.
const PRIVATE_BUCKET_ERROR_RE = /\/storage\/v1\/object\/public\/(post-media|profile-media)\//;

// ── Skeleton pulse ──────────────────────────────────────────────────────────

function SkeletonBox({ style }: { style?: StyleProp<ViewStyle> }) {
  const anim = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View style={[sk.box, style, { opacity: anim }]} />
  );
}

const sk = StyleSheet.create({
  box: { backgroundColor: color.haze },
});

// ── Designed fallback (generic content image) ───────────────────────────────

/**
 * Shown when a label is not supplied. An unlabelled fallback is a grey box
 * with a dot in it — indistinguishable from dead whitespace, which is how the
 * blank-media bug read to users on the surfaces that DID degrade correctly.
 * Every fallback says something.
 */
const DEFAULT_FALLBACK_LABEL = 'Image unavailable';

interface FallbackProps {
  /** Icon rendered as the visual affordance. Defaults to a simple placeholder. */
  icon?: React.ReactNode;
  /**
   * Text rendered below the icon. Defaults to "Image unavailable"; pass an
   * empty string only for surfaces too small to fit a caption (badges, tiles
   * under ~64pt), where the icon alone is the affordance.
   */
  label?: string;
  style?: StyleProp<ViewStyle>;
  bg?: string;
}

export function MediaFallback({ icon, label, style, bg }: FallbackProps) {
  const text = label ?? DEFAULT_FALLBACK_LABEL;
  return (
    <View style={[fb.wrap, bg ? { backgroundColor: bg } : undefined, style]}>
      {icon ?? <View style={fb.dot} />}
      {text ? <Text style={fb.label} numberOfLines={2}>{text}</Text> : null}
    </View>
  );
}

const fb = StyleSheet.create({
  wrap: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  dot: { width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2, backgroundColor: color.paper, opacity: 0.6 },
  label: { ...t.small, color: color.paper, fontWeight: '600', textAlign: 'center', paddingHorizontal: space.sm },
});

// ── Filter wrapper ──────────────────────────────────────────────────────────

/**
 * Wrap `node` in a filter-carrying View — or return it completely untouched
 * when there is no filter to apply.
 *
 * The untouched branch is the point: the no-filter render path stays exactly
 * what it was before filters existed, so a missing or unrecognised filter id
 * cannot introduce an extra view, change layout, or otherwise become a new way
 * for an image to fail to appear.
 */
function withFilter(
  filterStyle: FilterStyle | undefined,
  node: React.ReactElement,
): React.ReactElement {
  if (!filterStyle) return node;
  return (
    <View style={[StyleSheet.absoluteFill, filterStyle as StyleProp<ViewStyle>]}>
      {node}
    </View>
  );
}

// ── DisplayMediaImage ───────────────────────────────────────────────────────

type ResizeMode = 'cover' | 'contain' | 'stretch' | 'center';

const FIT_MAP: Record<ResizeMode, ImageContentFit> = {
  cover:   'cover',
  contain: 'contain',
  stretch: 'fill',
  center:  'none',
};

export interface DisplayMediaImageProps {
  /** Source URL. Null / undefined → designed fallback immediately. */
  uri: string | null | undefined;
  /** Required for reserved dimensions; must not be 0. */
  width: number;
  /** Required for reserved dimensions; must not be 0. */
  height: number;
  style?: StyleProp<ViewStyle>;
  resizeMode?: ResizeMode;
  /** Optional blurhash string shown while the image loads. */
  blurhash?: string;
  /** Forwarded to accessibilityLabel. */
  alt?: string;
  /** Alias for alt when no separate alt string is available. */
  title?: string;
  /** Content rendered when uri is null or the image fails to load. */
  fallback?: React.ReactNode;
  /** Background colour for the fallback / skeleton. Defaults to color.haze. */
  fallbackBg?: string;
  /** Short text shown in the fallback when no custom fallback node is provided. */
  fallbackLabel?: string;
  /** Icon rendered in the fallback when no custom fallback node is provided. */
  fallbackIcon?: React.ReactNode;
  /** Optional attribution text line rendered below the image. */
  attribution?: string;
  /**
   * Media filter id (see lib/media/filters.ts). Unknown, malformed and absent
   * values all render the image unfiltered — never blank.
   */
  filterId?: string | null;
  /** Filter strength 0–100. Defaults to full strength when absent. */
  filterIntensity?: number | null;
  onLoad?: () => void;
  onError?: () => void;
  testID?: string;
}

type Phase = 'loading' | 'loaded' | 'error';

export function DisplayMediaImage({
  uri,
  width,
  height,
  style,
  resizeMode = 'cover',
  blurhash,
  alt,
  title,
  fallback,
  fallbackBg,
  fallbackLabel,
  fallbackIcon,
  attribution,
  filterId,
  filterIntensity,
  onLoad,
  onError,
  testID,
}: DisplayMediaImageProps) {
  const resolved = resolveDisplayMedia([uri]);
  const [phase, setPhase] = useState<Phase>(resolved ? 'loading' : 'error');

  // Re-evaluate when the URI prop changes (e.g. list recycling).
  const prevUri = useRef(uri);
  const reHydrated = useRef(false);
  if (prevUri.current !== uri) {
    prevUri.current = uri;
    setPhase(resolved ? 'loading' : 'error');
    reHydrated.current = false;
  }

  // Initialized with the plain URI so ExpoImage mounts immediately (correct for
  // flag-OFF, the common case, and required for component tests). useHydratedMedia
  // updates to the signed URL once the async call resolves.
  const [resolvedSource, setResolvedSource] = useState<{ uri: string } | null>(
    resolved ? { uri: resolved } : null,
  );

  // Hydrate via signed-URL layer — replaces the old mediaSource() useEffect.
  const { resolved: hydratedMap } = useHydratedMedia(resolved ? [resolved] : []);

  useEffect(() => {
    if (!resolved) {
      setResolvedSource(null);
      return;
    }
    const hydratedUrl = hydratedMap[resolved];
    if (typeof hydratedUrl === 'string') {
      setResolvedSource({ uri: hydratedUrl });
    } else if (hydratedUrl === null) {
      // Server explicitly rejected the URL — show the designed fallback.
      setResolvedSource(null);
      setPhase('error');
    }
    // undefined = still loading; keep the initialised plain-URI source.
  }, [resolved, hydratedMap]); // eslint-disable-line react-hooks/exhaustive-deps

  const retriedPublic = useRef(false);

  // One-time re-hydration on 403 / onError.  The cache entry is evicted first
  // so the next batchSignUrls call fetches a fresh signed URL from the server.
  // Re-hydration is only attempted for private-bucket URLs (post-media /
  // profile-media) — other URLs can't benefit from signing, so they go straight
  // to the error phase.
  const handleError = useCallback(() => {
    if (!resolved) {
      setPhase('error');
      onError?.();
      return;
    }
    const isPrivateBucket = PRIVATE_BUCKET_ERROR_RE.test(resolved);
    if (isPrivateBucket && !reHydrated.current) {
      reHydrated.current = true;
      _evictBatchSignEntry(resolved);
      hydrateMediaUrls([resolved]).then((result) => {
        const newUrl = result[resolved];
        if (newUrl == null) {
          setPhase('error');
          onError?.();
        } else {
          // Update source and let ExpoImage retry.  If this second load also
          // errors, onError fires again → reHydrated.current is true → error phase.
          setResolvedSource({ uri: newUrl });
        }
      });
    } else if (!retriedPublic.current) {
      // Public CDN URLs (e.g. Foursquare place photos) occasionally fail on
      // the first attempt from transient network hiccups rather than a truly
      // dead link — a dead link is already filtered server-side before this
      // component ever sees it. Retry once, after a short delay, before
      // committing to the fallback artwork.
      retriedPublic.current = true;
      setTimeout(() => {
        setResolvedSource({ uri: resolved });
      }, 400);
    } else {
      setPhase('error');
      onError?.();
    }
  }, [resolved, onError]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = alt ?? title;
  const contentFit = FIT_MAP[resizeMode] ?? 'cover';

  // undefined for every no-filter case (absent / 'original' / unknown id /
  // malformed intensity). When it is undefined the tree below is identical to
  // what it was before filters existed — an unrecognised filter cannot change
  // how the image mounts, only how it is tinted.
  const filterStyle = resolveFilterStyle(
    filterId,
    filterIntensity,
    Platform.OS === 'web' ? 'web' : 'native',
  );

  const renderedFallback = fallback ?? (
    <MediaFallback
      icon={fallbackIcon}
      label={fallbackLabel}
      bg={fallbackBg}
      style={StyleSheet.absoluteFill}
    />
  );

  return (
    <View style={[{ width, height, overflow: 'hidden' }, style]} testID={testID}>
      {/* Skeleton shown while image is loading or source is being resolved */}
      {phase === 'loading' && <SkeletonBox style={StyleSheet.absoluteFill} />}

      {/* Fallback shown when uri is null or the image errors (incl. 403) */}
      {phase === 'error' && renderedFallback}

      {/* Image — mounted only once the source has been resolved so the signed
          URL is available before the first network request.

          A filter is carried on a wrapper View, not on the image: RN types
          `filter` on ViewStyle but NOT on ImageStyle (ImageStyle does not
          extend ViewStyle), and the wrapper also keeps the skeleton and the
          fallback — which are siblings — untinted. The wrapper is only
          introduced when a filter is actually active. */}
      {phase !== 'error' && resolved && resolvedSource && (
        withFilter(
          filterStyle,
          <ExpoImage
            source={resolvedSource}
            style={StyleSheet.absoluteFill}
            contentFit={contentFit}
            cachePolicy="memory-disk"
            transition={200}
            placeholder={blurhash ? { blurhash } : undefined}
            accessibilityLabel={label}
            accessible={!!label}
            onLoad={() => { setPhase('loaded'); onLoad?.(); }}
            onError={handleError}
          />,
        )
      )}

      {/* Attribution footer */}
      {attribution && phase === 'loaded' && (
        <View style={dm.attrWrap} pointerEvents="none">
          <Text style={dm.attrText} numberOfLines={1}>{attribution}</Text>
        </View>
      )}
    </View>
  );
}

const dm = StyleSheet.create({
  attrWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  attrText: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.8)',
    fontStyle: 'italic',
  },
});

// ── AvatarImage ─────────────────────────────────────────────────────────────

export interface AvatarImageProps {
  /** Explicit URI override. When omitted, user.avatarUrl is used. */
  uri?: string | null;
  /** User data — used for initials fallback and resolving avatarUrl. */
  user?: IdentityInput | null;
  /** Diameter of the circular avatar. */
  size: number;
  style?: StyleProp<ViewStyle>;
  /** Background colour for the initials circle. Defaults to color.deep. */
  bg?: string;
  testID?: string;
}

/**
 * Circular avatar that degrades to an initials chip instead of a blank circle.
 * Covers three cases: null URL, broken URL, and missing user data.
 *
 * The avatar URL is resolved through useHydratedMedia() so that when the
 * `media_private_buckets_enabled` flag is ON the signed URL is used —
 * preventing broken circles for private-bucket profile photos.
 * When the flag is OFF (default) the original URL is used with zero overhead.
 * On a 403/onError the cache entry is evicted and one re-hydration attempt is
 * made before falling back to the initials chip.
 */
export function AvatarImage({ uri, user, size, style, bg, testID }: AvatarImageProps) {
  const resolvedUri = resolveDisplayMedia([uri, user?.avatarUrl ?? undefined]);
  const initials = user ? fallbackInitials(user) : (uri ? '?' : '?');
  const [imgError, setImgError] = useState(false);
  const reHydrated = useRef(false);

  // Reset error state AND source when the URI changes so no stale relay URL
  // from the previous avatar is briefly shown for the new one.
  const [resolvedSource, setResolvedSource] = useState<{ uri: string } | null>(
    resolvedUri ? { uri: resolvedUri } : null,
  );

  const prevUri = useRef(resolvedUri);
  if (prevUri.current !== resolvedUri) {
    prevUri.current = resolvedUri;
    setImgError(false);
    setResolvedSource(resolvedUri ? { uri: resolvedUri } : null);
    reHydrated.current = false;
  }

  // Hydrate via signed-URL layer — replaces the old mediaSource() useEffect.
  const { resolved: hydratedMap } = useHydratedMedia(resolvedUri ? [resolvedUri] : []);

  useEffect(() => {
    if (!resolvedUri) {
      setResolvedSource(null);
      return;
    }
    const hydratedUrl = hydratedMap[resolvedUri];
    if (typeof hydratedUrl === 'string') {
      setResolvedSource({ uri: hydratedUrl });
    } else if (hydratedUrl === null) {
      // Server explicitly rejected — fall back to initials.
      setResolvedSource(null);
      setImgError(true);
    }
    // undefined = still loading; keep the initialised plain-URI source.
  }, [resolvedUri, hydratedMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-time re-hydration on 403 / onError (private-bucket URLs only).
  const handleAvatarError = useCallback(() => {
    if (!resolvedUri) {
      setImgError(true);
      return;
    }
    const isPrivateBucket = PRIVATE_BUCKET_ERROR_RE.test(resolvedUri);
    if (isPrivateBucket && !reHydrated.current) {
      reHydrated.current = true;
      _evictBatchSignEntry(resolvedUri);
      hydrateMediaUrls([resolvedUri]).then((result) => {
        const newUrl = result[resolvedUri];
        if (newUrl == null) {
          setImgError(true);
        } else {
          setResolvedSource({ uri: newUrl });
          // Don't set imgError — let the second load attempt proceed.
          // If it also errors, onError fires → reHydrated true → setImgError.
        }
      });
    } else {
      setImgError(true);
    }
  }, [resolvedUri]); // eslint-disable-line react-hooks/exhaustive-deps

  const showImage = !!resolvedUri && !imgError;
  const bgColor = bg ?? color.deep;
  const fontSize = Math.max(10, Math.round(size * 0.36));

  return (
    <View
      style={[
        av.wrap,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bgColor },
        style,
      ]}
      testID={testID}
    >
      {showImage && resolvedSource ? (
        <ExpoImage
          source={resolvedSource}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={150}
          onError={handleAvatarError}
        />
      ) : (
        <Text style={[av.initials, { fontSize }]}>{initials}</Text>
      )}
    </View>
  );
}

const av = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { color: '#fff', fontWeight: '700' },
});
