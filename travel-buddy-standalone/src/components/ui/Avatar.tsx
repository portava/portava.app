/**
 * Avatar — user or group image with a fallback.
 *
 * Composed from the three hand-rolled versions, taking the best part of each:
 *
 *   ShareSheet.ThreadAvatar   distinguishes a trip / circle from a person with
 *                             a distinct ICON (Globe, Users) rather than a
 *                             colour swap. The only one that did, and the
 *                             reason the §23 "group vs person distinguishable
 *                             by more than colour" rule is satisfied by
 *                             construction here.
 *   TagPreviewSheet.UserCard  two-letter initials from the first two words,
 *                             instead of one letter. "Maya Chen" reads MC.
 *   TripInviteSheet.Avatar    a `size` prop, so one component serves the 38pt
 *                             row and the 56pt header.
 *
 * DiscoveryShareSheet's is a near-identical copy of ShareSheet's — finding the
 * two side by side is most of the argument for this file existing.
 *
 * `selected` is kept because the recipient pickers need it, and it deliberately
 * changes the border AND the fill, never colour alone.
 */
import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Globe, Users } from 'lucide-react-native';
import { color, type as t } from '../../theme/tokens.ts';

/** What the avatar stands for. Drives the fallback glyph, not just the tint. */
export type AvatarKind = 'person' | 'trip' | 'circle' | 'group';

export interface AvatarProps {
  uri?: string | null;
  /** Used for the initials fallback and, if no label is given, the a11y label. */
  name?: string | null;
  kind?: AvatarKind;
  size?: number;
  selected?: boolean;
  /** Overrides the derived label. Give one whenever the name is not the whole story. */
  accessibilityLabel?: string;
  testID?: string;
}

/** "Maya Chen" → "MC"; "maya" → "M"; nothing usable → "?". */
export function initialsFor(name: string | null | undefined): string {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
}

const KIND_NOUN: Record<AvatarKind, string> = {
  person: 'person',
  trip: 'trip chat',
  circle: 'circle',
  group: 'group chat',
};

export function Avatar({
  uri,
  name,
  kind = 'person',
  size = 38,
  selected = false,
  accessibilityLabel,
  testID,
}: AvatarProps) {
  // Screen readers get the kind as words, so "Trip chat" and "Maya" are never
  // ambiguous even though sighted users tell them apart by the glyph.
  const label = accessibilityLabel
    ?? (name ? `${name}, ${KIND_NOUN[kind]}` : KIND_NOUN[kind]);

  const box = { width: size, height: size, borderRadius: size / 2 };

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={[box, selected && s.selectedRing]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={label}
        testID={testID}
      />
    );
  }

  const glyph = Math.round(size * 0.38);
  const tint = selected ? color.onInk : color.signal;

  return (
    <View
      style={[box, s.fallback, selected && s.fallbackSelected, selected && s.selectedRing]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      testID={testID}
    >
      {kind === 'trip' ? (
        <Globe size={glyph} color={tint} />
      ) : kind === 'circle' || kind === 'group' ? (
        <Users size={glyph} color={tint} />
      ) : (
        <Text
          // Initials must not overflow the circle when the OS text size is
          // cranked up, so this one string opts out of scaling. Everything
          // else in the sheet still scales.
          allowFontScaling={false}
          style={[s.initial, { fontSize: Math.round(size * 0.4) }, selected && { color: color.onInk }]}
        >
          {initialsFor(name)}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  fallback: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackSelected: { backgroundColor: color.signal },
  // Shape change, not only colour — visible without colour perception.
  selectedRing: { borderWidth: 2, borderColor: color.ink },
  initial: { ...t.small, fontWeight: '700', color: color.ink },
});

export default Avatar;
