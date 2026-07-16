/**
 * Telegraph primitives — isolated visual building blocks for the messaging
 * redesign. No data fetching, no service calls: pure presentational shells
 * that the existing screens import.
 */
import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { Users, Globe } from 'lucide-react-native';
import { color, space, type as t } from '../../theme/tokens.ts';
import { TG, TG_AVATAR, TG_SPACING } from '../../theme/telegraphTokens.ts';

// ── TelegraphAvatar ───────────────────────────────────────────────────────────

interface TelegraphAvatarProps {
  /** single = person, trip / circle = group thread glyphs */
  kind?: 'single' | 'trip' | 'circle';
  uri?: string | null;
  name?: string | null;
  size?: number;
}

/** Person / trip / circle avatar with an initial fallback. */
export function TelegraphAvatar({ kind = 'single', uri, name, size = TG_AVATAR.row }: TelegraphAvatarProps) {
  const r = kind === 'single' ? size / 2 : size * 0.3;
  const base = { width: size, height: size, borderRadius: r };
  if (kind === 'trip') {
    return (
      <View style={[base, av.group, { backgroundColor: '#E0EFEC' }]}>
        <Globe size={size * 0.44} color={color.deep} />
      </View>
    );
  }
  if (kind === 'circle') {
    return (
      <View style={[base, av.group, { backgroundColor: '#F2EBE0' }]}>
        <Users size={size * 0.44} color="#7A4C20" />
      </View>
    );
  }
  if (uri) return <Image source={{ uri }} style={[base, { backgroundColor: color.haze }]} />;
  return (
    <View style={[base, av.fallback]}>
      <Text style={[av.initial, { fontSize: size * 0.38 }]}>
        {(name?.[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

const av = StyleSheet.create({
  group: { alignItems: 'center', justifyContent: 'center' },
  fallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8E5DE' },
  initial: { fontWeight: '700', color: color.ink },
});

// ── TelegraphRow ──────────────────────────────────────────────────────────────

interface TelegraphRowProps {
  avatar: React.ReactNode;
  onPress?: () => void;
  children: React.ReactNode;
}

/** Reusable inbox row shell: avatar slot + content column with press state. */
export function TelegraphRow({ avatar, onPress, children }: TelegraphRowProps) {
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

const row = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: 11,
  },
  pressed: { backgroundColor: 'rgba(0,0,0,0.035)' },
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

const bb = StyleSheet.create({
  base: {
    borderRadius: TG_SPACING.bubbleRadius,
    paddingHorizontal: 13,
    paddingTop: 8,
    paddingBottom: 6,
    flexShrink: 1,
    maxWidth: '100%',
  },
  other: {
    backgroundColor: TG.recvBubble,
    borderWidth: 1,
    borderColor: TG.recvBorder,
  },
  mine: { backgroundColor: TG.sentBubble },
  otherTail: { borderBottomLeftRadius: TG_SPACING.bubbleTail },
  mineTail: { borderBottomRightRadius: TG_SPACING.bubbleTail },
});

/** Shared text styles for bubble content. */
export const bubbleText = StyleSheet.create({
  body: { ...t.body, color: TG.recvText, lineHeight: 21, flexShrink: 1, flexWrap: 'wrap' },
  bodyMine: { color: TG.sentText },
  time: { fontSize: 10, fontFamily: 'Courier', color: color.faint, marginTop: 2, textAlign: 'right' },
  timeMine: { color: TG.sentTextMute },
});
