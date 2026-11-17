/**
 * CallAvatar — participant avatar for the in-call surfaces.
 *
 * Why this is not `ui/Avatar`: the call screens are the one dark surface in the
 * app. Avatar's fallback is `color.haze` behind `color.ink` initials, which is
 * a light chip on a near-black screen. All four call screens had already
 * hand-rolled the dark version (#1F2937 behind #9CA3AF), four times over, and
 * that palette is deliberate rather than an oversight.
 *
 * What it does share with Avatar is the part that was missing: avatars live in
 * the private `profile-media` bucket, so the stored value is a bare reference
 * that does not load in an <Image>. It is hydrated through the signed-URL
 * layer here, and anything that fails to resolve — or fails to load after
 * resolving — falls back to initials rather than an empty circle.
 *
 * CachedImage/DisplayMediaImage are also wrong for this shape: their
 * MediaFallback renders an "Image unavailable" caption, which does not fit a
 * 46pt circle and is not what you want to read about someone on a call.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useHydratedMedia } from '../../services/mediaUrl.ts';
import { hydratedMediaSource } from '../../services/mediaRequestSource.ts';
import type { MediaRequestSource } from '../../services/mediaRequestSource.ts';
import { useMediaScopeKey } from '../../hooks/useMediaScopeKey.ts';

export interface CallAvatarProps {
  uri?: string | null;
  /** Display name or handle. A leading '@' is stripped before initialling. */
  name?: string | null;
  size: number;
  /** Font size for the initials. Scales with `size` when omitted. */
  initialsSize?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}

/** Matches what the four call screens did inline: first two characters. */
export function callInitials(name: string | null | undefined): string {
  return String(name ?? '').replace('@', '').slice(0, 2).toUpperCase() || '?';
}

export function CallAvatar({
  uri,
  name,
  size,
  initialsSize,
  style,
  accessibilityLabel,
  testID,
}: CallAvatarProps) {
  const box = { width: size, height: size, borderRadius: size / 2 };

  const { resolved: hydrated, sources } = useHydratedMedia(uri ? [uri] : []);
  const scopeKey = useMediaScopeKey();
  const [failed, setFailed] = useState(false);

  const identity = JSON.stringify([uri, scopeKey]);
  const prevUri = useRef(identity);
  if (prevUri.current !== identity) {
    prevUri.current = identity;
    setFailed(false);
  }

  const [source, setSource] = useState<MediaRequestSource | null>(hydratedMediaSource(uri));
  useEffect(() => {
    if (!uri) { setSource(null); return; }
    const next = hydrated[uri];
    if (typeof next === 'string') setSource(hydratedMediaSource(next, sources));
    else if (next === null) { setSource(null); setFailed(true); }
    else setSource(hydratedMediaSource(uri));
    // undefined = still resolving; hold the plain URI so the common case paints
    // immediately, matching Avatar/CachedImage.
  }, [uri, hydrated, sources, scopeKey]);

  if (uri && !failed && source) {
    return (
      <ExpoImage
        source={hydratedMediaSource(source?.uri, sources)}
        // Layout-only by contract, as in ui/Avatar — the ViewStyle/ImageStyle
        // split is only about `overflow: 'scroll'`, which nothing passes here.
        style={[box, s.dark, style as StyleProp<ImageStyle>]}
        contentFit="cover"
        cachePolicy={source?.headers ? 'none' : 'memory-disk'}
        transition={150}
        onError={() => setFailed(true)}
        accessible={!!accessibilityLabel}
        accessibilityRole={accessibilityLabel ? 'image' : undefined}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      />
    );
  }

  return (
    <View style={[box, s.dark, s.center, style]} testID={testID}>
      <Text
        // Initials must not overflow the circle at large OS text sizes.
        allowFontScaling={false}
        style={[s.initials, { fontSize: initialsSize ?? Math.round(size * 0.34) }]}
      >
        {callInitials(name)}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  dark: { backgroundColor: '#1F2937' },
  center: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontWeight: '700', color: '#9CA3AF' },
});

export default CallAvatar;
