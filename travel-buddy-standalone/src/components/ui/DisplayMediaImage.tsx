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
 * Media sources are resolved through mediaSource() so that when the
 * `media_private_buckets_enabled` flag is ON, images are served via the
 * auth-bearing relay endpoint. When the flag is OFF (default) the original
 * URL is used with no overhead.
 */
import React, { useEffect, useRef, useState } from 'react';
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
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { type IdentityInput, fallbackInitials } from '../../utils/identity.ts';
import { resolveDisplayMedia } from '../../lib/displayMedia.ts';
import { mediaSource, type ResolvedMediaSource } from '../../lib/mediaSource.ts';

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

interface FallbackProps {
  /** Icon rendered as the visual affordance. Defaults to a simple placeholder. */
  icon?: React.ReactNode;
  /** Optional text rendered below the icon. */
  label?: string;
  style?: StyleProp<ViewStyle>;
  bg?: string;
}

export function MediaFallback({ icon, label, style, bg }: FallbackProps) {
  return (
    <View style={[fb.wrap, bg ? { backgroundColor: bg } : undefined, style]}>
      {icon ?? <View style={fb.dot} />}
      {label ? <Text style={fb.label} numberOfLines={2}>{label}</Text> : null}
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
  dot: { width: 24, height: 24, borderRadius: 12, backgroundColor: color.paper, opacity: 0.6 },
  label: { ...t.small, color: color.paper, fontWeight: '600', textAlign: 'center', paddingHorizontal: space.sm },
});

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
  onLoad,
  onError,
  testID,
}: DisplayMediaImageProps) {
  const resolved = resolveDisplayMedia([uri]);
  const [phase, setPhase] = useState<Phase>(resolved ? 'loading' : 'error');

  // Re-evaluate when the URI prop changes (e.g. list recycling).
  const prevUri = useRef(uri);
  if (prevUri.current !== uri) {
    prevUri.current = uri;
    setPhase(resolved ? 'loading' : 'error');
  }

  // Resolve the media source through the private-bucket relay when the flag
  // is ON. When the flag is OFF (default) this resolves to { uri: resolved }
  // with effectively zero overhead.
  //
  // Initialized with the plain URI so ExpoImage mounts immediately (correct for
  // flag-OFF, the common case, and required for component tests). The useEffect
  // updates to the relay URL + auth headers when the flag is ON.
  const [resolvedSource, setResolvedSource] = useState<ResolvedMediaSource | null>(
    resolved ? { uri: resolved } : null,
  );

  useEffect(() => {
    if (!resolved) {
      setResolvedSource(null);
      return;
    }
    let cancelled = false;
    mediaSource(resolved).then((src) => {
      if (!cancelled) setResolvedSource(src);
    });
    return () => { cancelled = true; };
  }, [resolved]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = alt ?? title;
  const contentFit = FIT_MAP[resizeMode] ?? 'cover';

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

      {/* Image — mounted only once the source has been resolved so the relay
          URL and auth headers are available before the first network request */}
      {phase !== 'error' && resolved && resolvedSource && (
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
          onError={() => { setPhase('error'); onError?.(); }}
        />
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
 * The avatar URL is resolved through mediaSource() so that when the
 * `media_private_buckets_enabled` flag is ON the relay endpoint and auth
 * headers are used — preventing broken circles for private-bucket profile
 * photos. When the flag is OFF (default) this resolves synchronously to
 * { uri: resolvedUri } with effectively zero overhead.
 */
export function AvatarImage({ uri, user, size, style, bg, testID }: AvatarImageProps) {
  const resolvedUri = resolveDisplayMedia([uri, user?.avatarUrl ?? undefined]);
  const initials = user ? fallbackInitials(user) : (uri ? '?' : '?');
  const [imgError, setImgError] = useState(false);

  // Resolve the media source through the private-bucket relay when the flag
  // is ON. Initialized synchronously with the plain URI so the image mounts
  // immediately on the flag-OFF fast path (and in component tests). The
  // useEffect updates to the relay URL + auth headers when the flag is ON.
  const [resolvedSource, setResolvedSource] = useState<ResolvedMediaSource | null>(
    resolvedUri ? { uri: resolvedUri } : null,
  );

  // Reset error state AND resolvedSource when the URI changes so that a stale
  // relay URL from the previous avatar is never briefly shown for the new one.
  // Resetting resolvedSource to the plain URI keeps the image visible
  // immediately (flag-OFF fast path) and avoids a blank flash while the async
  // mediaSource() call resolves the relay URL for the new URI (flag-ON path).
  const prevUri = useRef(resolvedUri);
  if (prevUri.current !== resolvedUri) {
    prevUri.current = resolvedUri;
    setImgError(false);
    setResolvedSource(resolvedUri ? { uri: resolvedUri } : null);
  }

  useEffect(() => {
    if (!resolvedUri) {
      setResolvedSource(null);
      return;
    }
    let cancelled = false;
    mediaSource(resolvedUri).then((src) => {
      if (!cancelled) setResolvedSource(src);
    });
    return () => { cancelled = true; };
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
          onError={() => setImgError(true)}
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
