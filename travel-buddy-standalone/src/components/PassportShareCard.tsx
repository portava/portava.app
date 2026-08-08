import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CachedImage } from './CachedImage.tsx';
import { Plane, Map, Award } from 'lucide-react-native';
import { color, space, radius } from '../theme/tokens.ts';
import { primaryIdentityText, secondaryIdentityText } from '../lib/displayIdentity.ts';
import { VerifiedStamp } from './ui/VerifiedStamp.tsx';

export interface PassportShareCardProps {
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  tripCount: number;
  stampCount: number;
  tagline?: string | null;
  /** When true, renders a verified stamp badge next to the display name. */
  verified?: boolean;
}

export const PassportShareCard = React.forwardRef<View, PassportShareCardProps>(
  ({ displayName, username, avatarUrl, tripCount, stampCount, tagline, verified }, ref) => {
    return (
      <View ref={ref} style={styles.card} collapsable={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <Plane size={14} color={color.onInk} />
            <Text style={styles.brand}>PORTAVA PASSPORT</Text>
          </View>
        </View>

        {/* Avatar */}
        <View style={styles.avatarWrap}>
          {avatarUrl ? (
            <CachedImage source={{ uri: avatarUrl }} style={styles.avatar} fallbackLabel="" />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarEmoji}>✈️</Text>
            </View>
          )}
        </View>

        {/* Name + handle */}
        <View style={styles.nameRow}>
          <Text style={styles.displayName} numberOfLines={1}>
            {primaryIdentityText({ displayName, username })}
          </Text>
          {verified ? <VerifiedStamp size="md" dark /> : null}
        </View>
        {secondaryIdentityText({ displayName, username }) ? (
          <Text style={styles.handle}>{secondaryIdentityText({ displayName, username })}</Text>
        ) : null}
        {tagline ? (
          <Text style={styles.tagline} numberOfLines={2}>{tagline}</Text>
        ) : null}

        {/* Stats */}
        <View style={styles.stats}>
          <View style={styles.statItem}>
            <Map size={16} color={color.onInkMute} />
            <Text style={styles.statNum}>{tripCount}</Text>
            <Text style={styles.statLabel}>TRIPS</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Award size={16} color={color.onInkMute} />
            <Text style={styles.statNum}>{stampCount}</Text>
            <Text style={styles.statLabel}>STAMPS</Text>
          </View>
        </View>

        {/* MRZ footer */}
        <View style={styles.footer}>
          <Text style={styles.mrzText}>PORTAVA · SOCIAL PASSPORT</Text>
        </View>
      </View>
    );
  },
);

PassportShareCard.displayName = 'PassportShareCard';

const styles = StyleSheet.create({
  card: {
    width: 320,
    backgroundColor: color.ink,
    borderRadius: radius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    paddingBottom: space.md,
  },
  header: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  brand: {
    color: color.onInk,
    fontFamily: 'Courier',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  avatarWrap: {
    marginTop: space.xl,
    marginBottom: space.md,
    borderRadius: 52,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
  },
  avatarPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarEmoji: { fontSize: 36 },
  nameRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    gap: 6,
    paddingHorizontal: space.lg,
  },
  displayName: {
    color: color.onInk,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.3,
    textAlign: 'center',
    flexShrink: 1,
  },
  handle: {
    color: color.onInkMute,
    fontFamily: 'Courier',
    fontSize: 13,
    marginTop: 3,
    textAlign: 'center',
  },
  tagline: {
    color: color.onInkMute,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: space.xl,
    marginTop: space.sm,
    lineHeight: 17,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.xl,
    marginHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    width: 280,
    justifyContent: 'center',
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  statDivider: {
    width: 1,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  statNum: {
    color: color.onInk,
    fontSize: 22,
    fontWeight: '800',
  },
  statLabel: {
    color: color.onInkMute,
    fontFamily: 'Courier',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },
  footer: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    width: '100%',
    alignItems: 'center',
  },
  mrzText: {
    color: 'rgba(250,249,246,0.3)',
    fontFamily: 'Courier',
    fontSize: 8,
    letterSpacing: 1,
    fontWeight: '700',
    textAlign: 'center',
  },
});
