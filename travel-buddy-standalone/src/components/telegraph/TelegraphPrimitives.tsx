/**
 * Telegraph primitives — isolated visual building blocks for the messaging
 * redesign. No data fetching, no service calls: pure presentational shells
 * that the existing screens import.
 */
import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { Users, Globe } from 'lucide-react-native';
import { space, type as t } from '../../theme/tokens.ts';
import { TG_AVATAR, TG_SPACING } from '../../theme/telegraphTokens.ts';
import { useTelegraphTheme, useTelegraphStyles, type TelegraphPalette, type TelegraphScheme } from '../../features/telegraph/theme/telegraphTheme.ts';
import { useHydratedMedia } from '../../services/mediaUrl.ts';

// ── TelegraphAvatar ───────────────────────────────────────────────────────────

interface TelegraphAvatarProps {
  /** single = person, trip / circle = group thread glyphs */
  kind?: 'single' | 'trip' | 'circle';
  uri?: string | null;
  name?: string | null;
  size?: number;
}

/**
 * The trip and circle glyph tiles, per scheme. They read as an avatar, so each
 * scheme has its own tint and ink (census T123): the light tints are the
 * original ones, and on the dark surface a pale tile would be the brightest
 * thing in the inbox.
 */
const GROUP_TILES: Readonly<Record<TelegraphScheme, { trip: string; circle: string; circleInk: string }>> = {
  light: { trip: '#E0EFEC', circle: '#F2EBE0', circleInk: '#7A4C20' },
  dark: { trip: '#173A3C', circle: '#3A2E20', circleInk: '#E3B98A' },
};

/** Person / trip / circle avatar with an initial fallback. */
export function TelegraphAvatar({ kind = 'single', uri, name, size = TG_AVATAR.row }: TelegraphAvatarProps) {
  const { palette, styles: av } = useTelegraphTheme(makeAvatarStyles);
  const tiles = GROUP_TILES[palette.scheme];
  const r = kind === 'single' ? size / 2 : size * 0.3;
  const base = { width: size, height: size, borderRadius: r };

  // Hydrate the URI through the signed-URL layer so that when post-media /
  // profile-media buckets go private the avatar still loads.
  const { resolved: hydratedMap } = useHydratedMedia(uri ? [uri] : []);
  // undefined = still loading (show image with plain URI); null = server rejected
  const effectiveUri = uri
    ? (hydratedMap[uri] === null ? null : (hydratedMap[uri] ?? uri))
    : null;

  if (kind === 'trip') {
    return (
      <View style={[base, av.group, { backgroundColor: tiles.trip }]}>
        <Globe size={size * 0.44} color={palette.operational} />
      </View>
    );
  }
  if (kind === 'circle') {
    return (
      <View style={[base, av.group, { backgroundColor: tiles.circle }]}>
        <Users size={size * 0.44} color={tiles.circleInk} />
      </View>
    );
  }
  if (effectiveUri) {
    return <Image source={{ uri: effectiveUri }} style={[base, { backgroundColor: palette.haze }]} />;
  }
  return (
    <View style={[base, av.fallback]}>
      <Text style={[av.initial, { fontSize: size * 0.38 }]}>
        {(name?.[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

const makeAvatarStyles = (p: TelegraphPalette) => StyleSheet.create({
  group: { alignItems: 'center', justifyContent: 'center' },
  fallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: p.haze },
  initial: { fontWeight: '700', color: p.recvText },
});

// ── TelegraphRow ──────────────────────────────────────────────────────────────

interface TelegraphRowProps {
  avatar: React.ReactNode;
  onPress?: () => void;
  children: React.ReactNode;
}

/** Reusable inbox row shell: avatar slot + content column with press state. */
export function TelegraphRow({ avatar, onPress, children }: TelegraphRowProps) {
  const row = useTelegraphStyles(makeRowStyles);
  return (
    <Pressable
      style={({ pressed }) => [row.wrap, pressed && row.pressed]}
      onPress={onPress}
    >
      {avatar}
      <View style={row.content}>{children}</View>
    </Pressable>
  );
}

const makeRowStyles = (p: TelegraphPalette) => StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: 11,
  },
  pressed: { backgroundColor: p.chipFill },
  content: { flex: 1, gap: 3 },
});

// ── TelegraphBubble ───────────────────────────────────────────────────────────

interface TelegraphBubbleProps {
  mine: boolean;
  /** Is this the last bubble in a consecutive-sender group (gets the tail)? */
  groupEnd?: boolean;
  onLongPress?: () => void;
  style?: object;
  children: React.ReactNode;
}

/** Base message bubble with sent (dark green) / received (white) variants. */
export function TelegraphBubble({ mine, groupEnd = true, onLongPress, style, children }: TelegraphBubbleProps) {
  const bb = useTelegraphStyles(makeBubbleStyles);
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={300}
      style={[
        bb.base,
        mine ? bb.mine : bb.other,
        groupEnd && (mine ? bb.mineTail : bb.otherTail),
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const makeBubbleStyles = (p: TelegraphPalette) => StyleSheet.create({
  base: {
    borderRadius: TG_SPACING.bubbleRadius,
    paddingHorizontal: 13,
    paddingTop: 8,
    paddingBottom: 6,
    flexShrink: 1,
    maxWidth: '100%',
  },
  other: {
    backgroundColor: p.recvBubble,
    borderWidth: 1,
    borderColor: p.recvBorder,
  },
  mine: { backgroundColor: p.sentBubble },
  otherTail: { borderBottomLeftRadius: TG_SPACING.bubbleTail },
  mineTail: { borderBottomRightRadius: TG_SPACING.bubbleTail },
});

/** Shared text styles for bubble content, for the current scheme. */
export function useBubbleText() {
  return useTelegraphStyles(makeBubbleText);
}

const makeBubbleText = (p: TelegraphPalette) => StyleSheet.create({
  body: { ...t.body, color: p.recvText, lineHeight: 21, flexShrink: 1, flexWrap: 'wrap' },
  bodyMine: { color: p.sentText },
  time: { fontSize: 10, fontFamily: 'Courier', color: p.faint, marginTop: 2, textAlign: 'right' },
  timeMine: { color: p.sentTextMute },
});
