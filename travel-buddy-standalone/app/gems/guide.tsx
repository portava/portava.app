/**
 * Local Guide Profile screen
 *
 * Shows a guide's profile, stats, level, city expertise, and their contributed gems.
 * Route: /gems/guide/[userId]
 */
import { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { avatar } from '../../src/theme/tokens';
import { getGuideProfile } from '../../src/services/hiddenGems';
import { useGemList } from '../../src/hooks/useHiddenGems';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

// ── Guide level badges ─────────────────────────────────────────────────────────

const LEVEL_BADGES = [
  { level: 1, label: 'Newcomer',  color: '#8A9BB5', icon: 'star-outline' },
  { level: 2, label: 'Explorer',  color: '#4CAF7D', icon: 'star-half'    },
  { level: 3, label: 'Regular',   color: '#4C8BF5', icon: 'star'         },
  { level: 4, label: 'Expert',    color: '#F5A623', icon: 'ribbon'       },
  { level: 5, label: 'Master',    color: '#FF6B6B', icon: 'trophy'       },
];

function LevelBadge({ level }: { level: number }) {
  const badge = LEVEL_BADGES[Math.min(level - 1, 4)] ?? LEVEL_BADGES[0];
  return (
    <View style={[styles.levelBadge, { borderColor: badge.color }]}>
      <Ionicons name={badge.icon as any} size={16} color={badge.color} />
      <Text style={[styles.levelText, { color: badge.color }]}>
        Level {level} · {badge.label}
      </Text>
    </View>
  );
}

// ── Stat tile ─────────────────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function GuideProfileScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [guide, setGuide]   = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const g = await getGuideProfile(userId);
      setGuide(g);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load guide profile');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  // Load on mount
  useState(() => { load(); });

  // Contributed gems (gems submitted by this user)
  const { gems: contributedGems } = useGemList({ submittedBy: userId });

  if (loading) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4C8BF5" />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !guide) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color="#FF6B6B" />
          <Text style={styles.errorText}>{error ?? 'Guide not found'}</Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const accuracy = typeof guide.accuracyScore === 'number'
    ? `${Math.round(guide.accuracyScore * 100)}%`
    : '—';

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBack}>
            <Ionicons name="arrow-back" size={22} color="#E8F0FE" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Local Guide</Text>
          <View style={{ width: 30 }} />
        </View>

        {/* Profile card */}
        <View style={styles.profileCard}>
          <View style={styles.avatarCircle}>
            <Ionicons name="person" size={36} color="#4C8BF5" />
          </View>
          <LevelBadge level={guide.guideLevel ?? 1} />

          {guide.cityExpertise?.length > 0 && (
            <Text style={styles.cities}>
              Expert in: {(guide.cityExpertise as string[]).join(', ')}
            </Text>
          )}

          {guide.bio && (
            <Text style={styles.bio}>{guide.bio}</Text>
          )}
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <StatTile label="Gems" value={guide.contributionCount ?? 0} />
          <StatTile label="Helpful votes" value={guide.helpfulVotes ?? 0} />
          <StatTile label="Accuracy" value={accuracy} />
        </View>

        {/* Contributed gems */}
        {contributedGems.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Gems by this guide</Text>
            {contributedGems.map((gem) => (
              <TouchableOpacity
                key={gem.id}
                style={styles.gemRow}
                onPress={() => router.push(`/gems/${gem.id}`)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.gemName}>{gem.name}</Text>
                  <Text style={styles.gemCity}>{gem.city}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#8A9BB5" />
              </TouchableOpacity>
            ))}
          </View>
        )}
        <NavBarFiller />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:  { flex: 1, backgroundColor: '#0A1628' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  errorText: { color: '#FF6B6B', fontSize: 16, textAlign: 'center' },
  scroll: { paddingBottom: 40 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  headerBack: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#E8F0FE' },
  backBtn: { backgroundColor: '#1E2D45', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  backBtnText: { color: '#4C8BF5', fontWeight: '600' },

  profileCard: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 24, gap: 12 },
  avatarCircle: { width: avatar.xxxxl, height: avatar.xxxxl, borderRadius: avatar.xxxxl / 2, backgroundColor: '#1E2D45', alignItems: 'center', justifyContent: 'center' },
  levelBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 },
  levelText: { fontSize: 14, fontWeight: '600' },
  cities: { color: '#8A9BB5', fontSize: 14, textAlign: 'center' },
  bio: { color: '#B0C4DE', fontSize: 14, textAlign: 'center', lineHeight: 20 },

  statsRow: { flexDirection: 'row', marginHorizontal: 16, marginBottom: 24, borderRadius: 16, backgroundColor: '#1E2D45', overflow: 'hidden' },
  statTile: { flex: 1, alignItems: 'center', paddingVertical: 16 },
  statValue: { fontSize: 20, fontWeight: '700', color: '#E8F0FE' },
  statLabel: { fontSize: 12, color: '#8A9BB5', marginTop: 2 },

  section: { paddingHorizontal: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#E8F0FE', marginBottom: 12 },
  gemRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E2D45', borderRadius: 12, padding: 14, marginBottom: 8 },
  gemName: { fontSize: 15, fontWeight: '600', color: '#E8F0FE' },
  gemCity: { fontSize: 13, color: '#8A9BB5', marginTop: 2 },
});
