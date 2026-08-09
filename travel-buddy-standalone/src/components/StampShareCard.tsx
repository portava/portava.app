/**
 * StampShareCard — export-safe stamp card for sharing.
 *
 * Privacy rules:
 *   - When visibility !== 'public', city/country labels are omitted and
 *     replaced with the category label only (e.g. "CITY STAMP" not "CEBU").
 *   - Sublabel (typically year + country) is always shown when public.
 *   - Locked stamps cannot be shared — callers should not render this.
 *
 * Design: dark passport-cover background, cream text, stamp artwork centered.
 * Sized for social sharing (320 × 400px by default).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles,
} from 'lucide-react-native';
import type { ComponentType } from 'react';
import type { PassportStamp } from '../types/models.ts';
import { resolveArtwork } from '../lib/stampArtworkResolver.ts';
import { STAMP_RARITY_LABELS, STAMP_RARITY_COLORS } from '../types/stampArtwork.ts';
import { StampSvgFrame } from './StampSvgFrame.tsx';
import { dot } from '../theme/tokens.ts';

type IconCmp = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ICON_MAP: Record<string, IconCmp> = {
  MapPin, Users, Gem, ShieldCheck, Crown, Ticket, Sparkles,
};

function resolveIcon(key: string): IconCmp {
  return ICON_MAP[key] ?? MapPin;
}

export type StampShareVisibility = 'public' | 'circle_only' | 'trip_crew' | 'private';

interface StampShareCardProps {
  stamp: PassportStamp;
  /** Controls whether city/country details are shown. */
  visibility?: StampShareVisibility;
  /** Card width. Default 320. */
  width?: number;
  username?: string | null;
  /**
   * Called once the artwork area is settled: the remote AI artwork loaded,
   * it failed (procedural fallback is rendered), or there is no remote
   * artwork at all. Lets capture flows wait before snapshotting the card.
   */
  onArtworkSettled?: () => void;
}

export function StampShareCard({
  stamp,
  visibility = 'public',
  width = 320,
  username,
  onArtworkSettled,
}: StampShareCardProps) {
  const art = resolveArtwork(stamp);
  const Icon = resolveIcon(art.iconKey);
  const [artFailed, setArtFailed] = useState(false);
  const hasRemoteArtwork = Boolean(stamp.universalArtworkUrl);
  const showAiArtwork = hasRemoteArtwork && !artFailed;

  const settledRef = React.useRef(false);
  const settle = React.useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onArtworkSettled?.();
  }, [onArtworkSettled]);

  // Settle once the procedural design is committed: either there was no
  // remote artwork at all, or the remote image failed and the fallback has
  // now rendered (this effect runs after that commit, avoiding a capture
  // race against a pre-rerender frame).
  React.useEffect(() => {
    if (!hasRemoteArtwork || artFailed) settle();
  }, [hasRemoteArtwork, artFailed, settle]);
  const isPublic = visibility === 'public';
  const stampSize = Math.round(width * 0.42);
  const iconSize = Math.round(stampSize * 0.28);
  const rarityColor = STAMP_RARITY_COLORS[art.rarity];
  const rarityLabel = STAMP_RARITY_LABELS[art.rarity];
  const cardHeight = Math.round(width * 1.28);

  // Privacy: hide location when not public
  const displayLabel = isPublic ? stamp.label : art.categoryLabel;
  const displaySublabel = isPublic ? stamp.sublabel : undefined;
  const displayCaption = isPublic ? art.captionText : undefined;

  return (
    <View style={[styles.card, { width, height: cardHeight }]}>
      {/* Passport cover decorative lines */}
      <View style={styles.decorTop} />
      <View style={styles.decorBottom} />

      {/* App branding */}
      <View style={styles.brandRow}>
        <Text style={styles.brandText}>PORTAVA</Text>
        <Text style={styles.brandDivider}>·</Text>
        <Text style={styles.brandText}>PASSPORT STAMP</Text>
      </View>

      {/* Stamp artwork */}
      <View style={[styles.stampWrap, { height: stampSize + 40 }]}>
        {showAiArtwork ? (
          <View
            style={{
              width: stampSize,
              height: stampSize,
              borderRadius: Math.round(stampSize / 8),
              overflow: 'hidden',
            }}
          >
            <Image
              source={{ uri: stamp.universalArtworkUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
              cachePolicy="memory-disk"
              onLoad={settle}
              onError={() => setArtFailed(true)}
              accessibilityIgnoresInvertColors
              accessibilityLabel={`${art.categoryLabel} stamp artwork`}
            />
          </View>
        ) : (
        <View style={{ width: stampSize, height: stampSize, overflow: 'hidden' }}>
          <StampSvgFrame
            size={stampSize}
            shape={art.shape}
            borderStyle={art.borderStyle}
            borderWeight={art.borderWeight}
            accent={art.accent}
            background={art.background}
            pattern={art.pattern}
          />
          <View style={styles.stampContent} pointerEvents="none">
            <Icon size={iconSize} color={art.accent} strokeWidth={2} />
            <Text style={[styles.stampLabel, { color: art.accent, fontSize: Math.round(stampSize * 0.13) }]} numberOfLines={1}>
              {displayLabel}
            </Text>
            {displayCaption ? (
              <Text style={[styles.stampCaption, { color: art.accent, fontSize: Math.round(stampSize * 0.095) }]} numberOfLines={1}>
                {displayCaption}
              </Text>
            ) : null}
          </View>
        </View>
        )}

        {/* Rarity badge */}
        <View style={[styles.rarityBadge, { borderColor: rarityColor + '55' }]}>
          <View style={[styles.rarityDot, { backgroundColor: rarityColor }]} />
          <Text style={[styles.rarityText, { color: rarityColor }]}>{rarityLabel}</Text>
        </View>
      </View>

      {/* Text block */}
      <View style={styles.textBlock}>
        <Text style={styles.displayLabel} numberOfLines={2}>
          {displayLabel}
        </Text>
        {displaySublabel && (
          <Text style={styles.displaySublabel}>{displaySublabel}</Text>
        )}
        <Text style={styles.categoryLabel}>{art.categoryLabel} STAMP</Text>
        {!isPublic && (
          <Text style={styles.privacyNote}>📍 Location details private</Text>
        )}
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        {username && <Text style={styles.footerText}>@{username}</Text>}
        <Text style={styles.footerText}>travel-buddy.app</Text>
      </View>
    </View>
  );
}

const CREAM = '#F5EDD6';
const DARK = '#11110F';

const styles = StyleSheet.create({
  card: {
    backgroundColor: DARK,
    borderRadius: 16,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 28,
    paddingHorizontal: 24,
  },
  decorTop: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 6,
    backgroundColor: '#C8851A',
    opacity: 0.8,
  },
  decorBottom: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    height: 6,
    backgroundColor: '#C8851A',
    opacity: 0.8,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  brandText: {
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '700',
    color: CREAM,
    letterSpacing: 2,
    opacity: 0.55,
  },
  brandDivider: {
    color: CREAM,
    opacity: 0.3,
  },
  stampWrap: {
    alignItems: 'center',
    gap: 12,
  },
  stampContent: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 8,
  },
  stampLabel: {
    fontFamily: 'Courier',
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 1,
  },
  stampCaption: {
    fontFamily: 'Courier',
    textAlign: 'center',
    letterSpacing: 0.6,
    opacity: 0.85,
  },
  rarityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  rarityDot: { width: dot.xxs, height: dot.xxs, borderRadius: dot.xxs / 2 },
  rarityText: {
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  textBlock: {
    alignItems: 'center',
    gap: 6,
  },
  displayLabel: {
    fontFamily: 'Courier',
    fontSize: 22,
    fontWeight: '700',
    color: CREAM,
    letterSpacing: 2,
    textAlign: 'center',
  },
  displaySublabel: {
    fontFamily: 'Courier',
    fontSize: 12,
    color: CREAM,
    opacity: 0.6,
    letterSpacing: 1,
  },
  categoryLabel: {
    fontFamily: 'Courier',
    fontSize: 10,
    color: CREAM,
    opacity: 0.45,
    letterSpacing: 2,
  },
  privacyNote: {
    fontFamily: 'Courier',
    fontSize: 10,
    color: CREAM,
    opacity: 0.4,
    letterSpacing: 0.5,
    marginTop: 2,
  },
  footer: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
  },
  footerText: {
    fontFamily: 'Courier',
    fontSize: 10,
    color: CREAM,
    opacity: 0.35,
    letterSpacing: 1,
  },
});
