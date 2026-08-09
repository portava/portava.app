/**
 * CompassStatusCard — Active-user visibility status shown on the profile screen.
 *
 * Displays tier label, earned badges, and a single plain-English visibility
 * message. Raw algorithm scores are never shown. Hidden automatically when
 * the user's boost visibility preference is off (opted out).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Sparkles, ChevronRight, Star, Shield, Zap, Globe, Award } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { fetchCompassActiveReward, type CompassActiveReward } from '../../services/compass.ts';
import { useSession } from '../../context/SessionContext.tsx';

const BADGE_LABELS: Record<string, string> = {
  city_ambassador_candidate: 'Ambassador',
  social_connector:          'Connector',
  trusted_guide:             'Trusted Guide',
  safety_champion:           'Safety Champion',
  consistent_explorer:       'Explorer',
};

const BADGE_ICONS: Record<string, React.ComponentType<{ size: number; color: string }>> = {
  city_ambassador_candidate: Award,
  social_connector:          Globe,
  trusted_guide:             Star,
  safety_champion:           Shield,
  consistent_explorer:       Zap,
};

const TIER_COLOR: Record<string, string> = {
  active_traveler:           '#4A90D9',
  local_guide:               '#27AE60',
  city_connector:            '#8E44AD',
  city_ambassador_candidate: '#E67E22',
};

function BadgeChip({ badge }: { badge: string }) {
  const label = BADGE_LABELS[badge] ?? badge;
  const Icon  = BADGE_ICONS[badge] ?? Star;
  return (
    <View style={bs.chip}>
      <Icon size={11} color={color.signal} />
      <Text style={bs.label}>{label}</Text>
    </View>
  );
}

export function CompassStatusCard() {
  const { isAuthed } = useSession();
  const [reward, setReward]   = useState<CompassActiveReward | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthed) return;
    setLoading(true);
    fetchCompassActiveReward().then((r) => {
      setLoading(false);
      if (r.ok && r.data) setReward(r.data);
    }).catch(() => setLoading(false));
  }, [isAuthed]);

  if (!isAuthed || loading) {
    return loading ? (
      <View style={styles.loading}><ActivityIndicator size="small" color={color.signal} /></View>
    ) : null;
  }
  if (!reward) return null;
  // If user opted out of boost, don't show the card
  if (!reward.boostEnabled) return null;

  const tierColor = TIER_COLOR[reward.tier] ?? color.signal;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push('/compass-preferences' as any)}
      accessibilityRole="button"
      accessibilityLabel="View Compass visibility settings"
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.iconWrap, { backgroundColor: tierColor + '18' }]}>
          <Sparkles size={16} color={tierColor} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.tierLabel}>{reward.tierLabel}</Text>
          <Text style={styles.sectionTitle}>Visibility Status</Text>
        </View>
        <ChevronRight size={16} color={color.faint} />
      </View>

      {/* Badges */}
      {reward.badges.length > 0 && (
        <View style={styles.badges}>
          {reward.badges.slice(0, 4).map((b) => (
            <BadgeChip key={b} badge={b} />
          ))}
        </View>
      )}

      {/* Plain-English message */}
      <Text style={styles.message}>{reward.visibilityMessage}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: {
    paddingVertical: space.md,
    alignItems: 'center',
  },
  card: {
    marginHorizontal: space.lg,
    marginBottom: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  iconWrap: {
    width: avatar.smMd, height: avatar.smMd,
    borderRadius: avatar.smMd / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    gap: 1,
  },
  tierLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  sectionTitle: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  message: {
    ...t.small,
    color: color.deep,
    fontSize: 12,
    lineHeight: 17,
    fontStyle: 'italic',
  },
});

const bs = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: color.signal + '12',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  label: {
    ...t.small,
    color: color.signal,
    fontSize: 10,
    fontWeight: '700',
  },
});
