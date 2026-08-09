/**
 * stamps/StampCard — grid card for a single PassportStampNew.
 * Wraps the existing StampArtwork component and adds text labels,
 * a lock badge for private/friends-only stamps visible to the owner,
 * and an earned date line.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Lock, EyeOff } from 'lucide-react-native';
import { UniversalStampArtwork } from './UniversalStampArtwork.tsx';
import type { PassportStamp } from '../../types/models.ts';
import type { PassportStampNew } from '../../services/passportStamps.ts';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import { RARITY_COLORS, normalizeRarity, hasGlowRing } from '../../lib/stampRarity.ts';

const VISIBILITY_LABEL: Record<string, string> = {
  private:      'Private',
  circle_only:  'Friends',
  friends_only: 'Friends',
  trip_crew:    'Crew',
};

// Re-exported for existing importers — implementation lives in the pure
// mappers module so hooks can use it without pulling in component code.
export { toLegacyStamp as toLegacy } from '../../services/passportStampMappers.ts';
import { toLegacyStamp as toLegacy } from '../../services/passportStampMappers.ts';

interface Props {
  stamp: PassportStampNew;
  isOwner: boolean;
  onPress?: () => void;
}

export function StampCard({ stamp, isOwner, onPress }: Props) {
  const legacy = toLegacy(stamp);
  const rarity = normalizeRarity(stamp.definition?.rarity);
  const rarityColor = RARITY_COLORS[rarity].ring;
  const showGlow = hasGlowRing(rarity);
  const isNonPublic = stamp.visibility !== 'public' && !stamp.isRevoked;
  const isHidden = isOwner && !stamp.displayOnPassport && !stamp.isRevoked;
  const visLabel = VISIBILITY_LABEL[stamp.visibility];

  const inner = (
    <View style={[styles.card, isHidden && styles.cardHidden]}>
      <View style={[
        styles.artworkWrap,
        showGlow && { borderWidth: 1.5, borderRadius: 12, borderColor: RARITY_COLORS[rarity].ring },
      ]}>
        <UniversalStampArtwork
          activeArtworkUrl={stamp.activeArtworkUrl ?? stamp.definition?.universalArtworkUrl}
          thumbnailUrl={stamp.thumbnailUrl}
          stamp={legacy}
          size={64}
          showPendingLabel={false}
        />
        {isOwner && isNonPublic && (
          <View style={styles.lockBadge}>
            <Lock size={9} color="#fff" strokeWidth={2.5} />
          </View>
        )}
        {isHidden && (
          <View style={styles.hiddenBadge}>
            <EyeOff size={9} color="#fff" strokeWidth={2.5} />
          </View>
        )}
      </View>

      <Text style={styles.name} numberOfLines={2}>{legacy.label}</Text>

      {rarity && (
        <View style={[styles.rarityDot, { backgroundColor: rarityColor }]} />
      )}

      {(stamp.neighborhood || stamp.city || stamp.country) && (
        <Text style={styles.location} numberOfLines={1}>
          {[stamp.neighborhood, stamp.city, stamp.country].filter(Boolean).join(', ')}
        </Text>
      )}

      <Text style={styles.date}>
        {new Date(stamp.earnedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
      </Text>

      {isOwner && isNonPublic && visLabel && (
        <View style={styles.visPill}>
          <Text style={styles.visText}>{visLabel}</Text>
        </View>
      )}
      {isHidden && (
        <View style={[styles.visPill, styles.hiddenPill]}>
          <Text style={[styles.visText, styles.hiddenText]}>Hidden</Text>
        </View>
      )}
    </View>
  );

  return onPress ? (
    <Pressable onPress={onPress} hitSlop={4} style={styles.pressable}>
      {inner}
    </Pressable>
  ) : inner;
}

const styles = StyleSheet.create({
  pressable: { flex: 1 },
  card: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.xs,
    gap: 3,
  },
  artworkWrap: { position: 'relative', marginBottom: 4 },
  lockBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: icon.md, height: icon.md,
    borderRadius: icon.md / 2,
    backgroundColor: '#6B7280',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: color.paper,
  },
  name: {
    ...t.small,
    color: color.ink,
    fontWeight: '700',
    textAlign: 'center',
    fontFamily: 'Courier',
    letterSpacing: 0.4,
  },
  rarityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginVertical: 2,
    opacity: 0.8,
  },
  location: { ...t.small, color: color.mute, fontSize: 10, textAlign: 'center' },
  date:     { ...t.small, color: color.faint, fontSize: 10, textAlign: 'center' },
  visPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: '#F3F4F6',
    marginTop: 2,
  },
  visText: { fontSize: 10, color: '#6B7280', fontWeight: '600' },
  cardHidden: { opacity: 0.65 },
  hiddenBadge: {
    position: 'absolute',
    bottom: -3,
    right: -3,
    width: icon.md, height: icon.md,
    borderRadius: icon.md / 2,
    backgroundColor: '#9CA3AF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: color.paper,
  },
  hiddenPill: { backgroundColor: '#E5E7EB' },
  hiddenText: { color: '#9CA3AF' },
});
