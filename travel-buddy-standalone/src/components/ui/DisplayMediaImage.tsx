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
 * Private media waits for viewer-scoped signing through useHydratedMedia().
 * On a 403/onError the cached entry is evicted and one re-hydration
 * attempt is made before transitioning to the designed fallback.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AccessibilityInfo,
  Pressable,
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
import { isPrivateMediaRefOf, mediaSigningReference } from '../../services/playbackUri.ts';
import { useMediaScopeKey } from '../../hooks/useMediaScopeKey.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../services/discoveryViewerScope.ts';
import { resolveFilterStyle, type FilterStyle } from '../../lib/media/filters.ts';

// ── Skeleton pulse ──────────────────────────────────────────────────────────

function SkeletonBox({ style }: { style?: StyleProp<ViewStyle> }) {
  const anim = useRef(new Animated.Value(0.5)).current;

  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let mounted = true;
    let changed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted && !changed) setReduced(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => { changed = true; setReduced(value); });
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (reduced) { anim.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 0.5, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [anim, reduced]);

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

export function DisplayMediaImage(props: DisplayMediaImageProps) {
  const scope = useMediaScopeKey();
  const [attempt, setAttempt] = useState(0);
  return <ScopedMediaImage key={JSON.stringify([scope, props.uri, attempt])} {...props} onRetry={() => {
    const resolved = resolveDisplayMedia([props.uri]);
    if (resolved && isPrivateMediaRefOf(resolved)) _evictBatchSignEntry(mediaSigningReference(resolved));
    setAttempt(value => value + 1);
  }} />;
}

/** This instance owns exactly one source, viewer and user-initiated attempt. */
function useMediaAttempt() {
  const [scope] = useState(currentDiscoveryScope);
  const mounted = useRef(true);
  const retired = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => mounted.current && !retired.current && isCurrentDiscoveryScope(scope), [scope]);
  return { current, retired };
}

function ScopedMediaImage({
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
  onRetry,
}: DisplayMediaImageProps & { onRetry: () => void }) {
  const resolved = resolveDisplayMedia([uri]);
  const { current, retired } = useMediaAttempt();
  const [phase, setPhase] = useState<Phase>(resolved ? 'loading' : 'error');
  const reHydrated = useRef(false);
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const [resolvedSource, setResolvedSource] = useState<{ uri: string } | null>(
    resolved && !isPrivateMediaRefOf(resolved) ? { uri: resolved } : null,
  );
  const sourceRef = useRef(resolvedSource?.uri); sourceRef.current = resolvedSource?.uri;
  const [deadline] = useState(() => Date.now() + 12_000);
  useEffect(() => {
    if (phase !== 'loading') return;
    const timer = setTimeout(() => {
      if (!current()) return;
      retired.current = true; setPhase('error'); onErrorRef.current?.();
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [phase, deadline, current, retired]);

  // Hydrate via signed-URL layer — replaces the old mediaSource() useEffect.
  const { resolved: hydratedMap } = useHydratedMedia(resolved ? [resolved] : []);

  useEffect(() => {
    if (!current() || !resolved) return;
    const hydratedUrl = hydratedMap[resolved];
    if (typeof hydratedUrl === 'string') setResolvedSource({ uri: hydratedUrl });
    else if (hydratedUrl === null) {
      retired.current = true; setResolvedSource(null); setPhase('error'); onErrorRef.current?.();
    }
  }, [resolved, hydratedMap, current, retired]);

  const handleError = useCallback(() => {
    if (!current() || sourceRef.current !== resolvedSource?.uri) return;
    const fail = () => {
      if (!current()) return;
      retired.current = true; setPhase('error'); onErrorRef.current?.();
    };
    if (resolved && isPrivateMediaRefOf(resolved) && !reHydrated.current) {
      reHydrated.current = true;
      _evictBatchSignEntry(mediaSigningReference(resolved));
      hydrateMediaUrls([resolved]).then(result => {
        if (!current()) return;
        const newUrl = result[resolved];
        if (!newUrl) fail();
        else setResolvedSource({ uri: newUrl });
      }).catch(fail);
    } else fail();
  }, [resolved, resolvedSource?.uri, current, retired]);

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
      {phase === 'error' && resolved && <Pressable onPress={onRetry} accessibilityRole="button"
        accessibilityLabel="Retry image" style={dm.retry}>
        <Text style={dm.retryText}>Retry</Text>
      </Pressable>}

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
            key={resolvedSource.uri}
            recyclingKey={resolvedSource.uri}
            source={resolvedSource}
            style={StyleSheet.absoluteFill}
            contentFit={contentFit}
            cachePolicy="memory-disk"
            transition={200}
            placeholder={blurhash ? { blurhash } : undefined}
            accessibilityLabel={label}
            accessible={!!label}
            onLoad={() => { if (current() && sourceRef.current === resolvedSource.uri) { setPhase('loaded'); onLoad?.(); } }}
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
  retry: { position: 'absolute', bottom: 0, alignSelf: 'center', minWidth: 64, minHeight: 44, justifyContent: 'center', alignItems: 'center', backgroundColor: color.deep, borderRadius: radius.sm },
  retryText: { ...t.small, color: color.paper, fontWeight: '600' },
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
 * Private avatar URLs wait for viewer-scoped signing through useHydratedMedia().
 * On a 403/onError the cache entry is evicted and one re-hydration attempt is
 * made before falling back to the initials chip.
 */
export function AvatarImage(props: AvatarImageProps) {
  const scope = useMediaScopeKey();
  const uri = resolveDisplayMedia([props.uri, props.user?.avatarUrl ?? undefined]);
  return <ScopedAvatar key={JSON.stringify([scope, uri])} {...props} />;
}

function ScopedAvatar({ uri, user, size, style, bg, testID }: AvatarImageProps) {
  const { current, retired } = useMediaAttempt();
  const resolvedUri = resolveDisplayMedia([uri, user?.avatarUrl ?? undefined]);
  const initials = user ? fallbackInitials(user) : (uri ? '?' : '?');
  const [imgError, setImgError] = useState(false);
  const reHydrated = useRef(false);

  // Reset error state AND source when the URI changes so no stale relay URL
  // from the previous avatar is briefly shown for the new one.
  const [resolvedSource, setResolvedSource] = useState<{ uri: string } | null>(
    resolvedUri && !isPrivateMediaRefOf(resolvedUri) ? { uri: resolvedUri } : null,
  );

  // Hydrate via signed-URL layer — replaces the old mediaSource() useEffect.
  const { resolved: hydratedMap } = useHydratedMedia(resolvedUri ? [resolvedUri] : []);

  useEffect(() => {
    if (!current() || !resolvedUri) return;
    const hydratedUrl = hydratedMap[resolvedUri];
    if (typeof hydratedUrl === 'string') setResolvedSource({ uri: hydratedUrl });
    else if (hydratedUrl === null) { retired.current = true; setResolvedSource(null); setImgError(true); }
  }, [resolvedUri, hydratedMap, current, retired]);

  const handleAvatarError = useCallback(() => {
    if (!current()) return;
    const fail = () => { if (current()) { retired.current = true; setImgError(true); } };
    if (resolvedUri && isPrivateMediaRefOf(resolvedUri) && !reHydrated.current) {
      reHydrated.current = true;
      _evictBatchSignEntry(mediaSigningReference(resolvedUri));
      hydrateMediaUrls([resolvedUri]).then(result => {
        if (!current()) return;
        const newUrl = result[resolvedUri];
        if (!newUrl) fail();
        else setResolvedSource({ uri: newUrl });
      }).catch(fail);
    } else fail();
  }, [resolvedUri, current, retired]);

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
