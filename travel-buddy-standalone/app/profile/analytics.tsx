/**
 * Profile Analytics — owner-only screen showing profile views, follower
 * growth, post impressions, lifetime stamps earned, and milestone history.
 *
 * Data source: GET /me/profile/analytics
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';
import { router } from 'expo-router';
import { ChevronLeft, Eye, Users, TrendingUp, Stamp, Award } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getProfileAnalytics, type ProfileAnalytics } from '../../src/services/profile';
import { PP, PP_LABEL, fmtMonthYear } from '../../src/theme/passportTokens';
import { space, type as t, radius, avatar, dot} from '../../src/theme/tokens';
import { ProfileViewersSheet } from '../../src/components/ProfileViewersSheet';

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function milestoneName(level: number): string {
  if (level >= 10_000) return '10,000 Stamps';
  if (level >= 1_000) return '1,000 Stamps';
  if (level >= 100) return '100 Stamps';
  return `${level} Stamps`;
}

// ─── subcomponents ────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <View style={s.sectionLabel}>
      <Text style={s.sectionLabelText}>{label.toUpperCase()}</Text>
      <View style={s.sectionRule} />
    </View>
  );
}

function StatCard({
  icon, label, sevenDay, thirtyDay,
}: {
  icon: React.ReactNode;
  label: string;
  sevenDay: number;
  thirtyDay: number;
}) {
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View style={s.cardIcon}>{icon}</View>
        <Text style={s.cardLabel}>{label}</Text>
      </View>
      <View style={s.cardBody}>
        <View style={s.statCell}>
          <Text style={s.statValue}>{fmtN(sevenDay)}</Text>
          <Text style={s.statPeriod}>7 days</Text>
        </View>
        <View style={s.statDivider} />
        <View style={s.statCell}>
          <Text style={s.statValue}>{fmtN(thirtyDay)}</Text>
          <Text style={s.statPeriod}>30 days</Text>
        </View>
      </View>
    </View>
  );
}

function SingleStatCard({
  icon, label, value, sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <View style={s.card}>
      <View style={s.cardHeader}>
        <View style={s.cardIcon}>{icon}</View>
        <Text style={s.cardLabel}>{label}</Text>
      </View>
      <View style={s.singleBody}>
        <Text style={s.singleValue}>{value}</Text>
        {sub ? <Text style={s.singleSub}>{sub}</Text> : null}
      </View>
    </View>
  );
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function ProfileAnalyticsScreen() {
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<ProfileAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewersSheetVisible, setViewersSheetVisible] = useState(false);

  useEffect(() => {
    setLoading(true);
    getProfileAnalytics()
      .then((res) => {
        if (res.ok && res.data) {
          setData(res.data);
        } else {
          setError(res.message ?? 'Could not load analytics');
        }
      })
      .catch(() => setError('Could not load analytics'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          style={s.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityLabel="Back"
          accessibilityRole="button"
        >
          <ChevronLeft size={22} color={PP.ink} strokeWidth={2} />
        </Pressable>
        <Text style={s.title}>Profile Analytics</Text>
        <View style={s.headerRight} />
      </View>

      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={PP.inkLight} />
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable
            style={s.retryBtn}
            onPress={() => {
              setError(null);
              setLoading(true);
              getProfileAnalytics()
                .then((res) => {
                  if (res.ok && res.data) setData(res.data);
                  else setError(res.message ?? 'Could not load analytics');
                })
                .catch(() => setError('Could not load analytics'))
                .finally(() => setLoading(false));
            }}
            accessibilityLabel="Retry"
            accessibilityRole="button"
          >
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : data ? (
        <ScrollView
          style={s.scroll}
          contentContainerStyle={[s.scrollContent, { paddingBottom: Math.max(insets.bottom, space.xl) + 16 }]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.caption}>
            All figures are your private owner stats — never visible to other travelers.
          </Text>

          {/* ── Reach ── */}
          <SectionLabel label="Reach" />

          <Pressable onPress={() => setViewersSheetVisible(true)} accessibilityRole="button" accessibilityLabel="Open profile viewers list">
            <StatCard
              icon={<Eye size={16} color="#3B7DED" strokeWidth={1.8} />}
              label="Profile Views"
              sevenDay={data.profileViews.sevenDay}
              thirtyDay={data.profileViews.thirtyDay}
            />
          </Pressable>

          <SingleStatCard
            icon={<TrendingUp size={16} color="#059669" strokeWidth={1.8} />}
            label="Post Impressions"
            value={fmtN(data.postImpressions7d)}
            sub="Last 7 days"
          />

          {/* ── Audience ── */}
          <SectionLabel label="Audience" />

          <StatCard
            icon={<Users size={16} color="#DB2777" strokeWidth={1.8} />}
            label="New Followers"
            sevenDay={data.followerGrowth.sevenDay}
            thirtyDay={data.followerGrowth.thirtyDay}
          />

          {/* ── Stamps ── */}
          <SectionLabel label="Stamps" />

          <SingleStatCard
            icon={<Stamp size={16} color="#D97706" strokeWidth={1.8} />}
            label="Stamps Earned"
            value={fmtN(data.stampsEarned)}
            sub="Lifetime total"
          />

          {data.milestones.length > 0 && (
            <View style={s.card}>
              <View style={s.cardHeader}>
                <View style={s.cardIcon}>
                  <Award size={16} color="#7B5CE5" strokeWidth={1.8} />
                </View>
                <Text style={s.cardLabel}>Milestones</Text>
              </View>
              <View style={s.milestoneList}>
                {data.milestones
                  .slice()
                  .sort((a, b) => b.level - a.level)
                  .map((m) => (
                    <View key={m.level} style={s.milestoneRow}>
                      <View style={s.milestoneDot} />
                      <View style={s.milestoneInfo}>
                        <Text style={s.milestoneName}>{milestoneName(m.level)}</Text>
                        <Text style={s.milestoneDate}>{fmtMonthYear(m.celebratedAt)}</Text>
                      </View>
                    </View>
                  ))}
              </View>
            </View>
          )}
        </ScrollView>
      ) : null}

      <ProfileViewersSheet
        visible={viewersSheetVisible}
        onClose={() => setViewersSheetVisible(false)}
      />
    </View>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PP.paperDeep,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
    backgroundColor: PP.paper,
  },
  backBtn: {
    width: avatar.md, height: avatar.md,
    borderRadius: avatar.md / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: PP.paperDeep,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: PP.ink,
    letterSpacing: -0.2,
  },
  headerRight: { width: 36 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { ...t.body, color: PP.inkMuted, textAlign: 'center', paddingHorizontal: space.xl },
  retryBtn: {
    paddingHorizontal: space.xl,
    paddingVertical: 10,
    backgroundColor: PP.ink,
    borderRadius: radius.pill,
  },
  retryText: { ...t.bodyStrong, color: PP.paper, fontSize: 14 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: space.lg, paddingTop: space.lg },
  caption: {
    ...t.small,
    color: PP.inkMuted,
    lineHeight: 17,
    marginBottom: space.md,
  },

  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    marginBottom: space.sm,
  },
  sectionLabelText: {
    ...PP_LABEL,
    fontSize: 10,
    letterSpacing: 1.4,
    color: PP.inkMuted,
  },
  sectionRule: {
    flex: 1,
    height: 1,
    backgroundColor: PP.borderLight,
  },

  card: {
    backgroundColor: PP.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: PP.borderLight,
    marginBottom: space.md,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
  },
  cardIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: PP.paperDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardLabel: {
    ...t.bodyStrong,
    color: PP.ink,
    fontSize: 14,
  },
  cardBody: {
    flexDirection: 'row',
    paddingVertical: space.md,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  statDivider: {
    width: 1,
    backgroundColor: PP.borderLight,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '800',
    color: PP.ink,
    letterSpacing: -0.5,
  },
  statPeriod: {
    ...PP_LABEL,
    fontSize: 10,
    letterSpacing: 1,
    color: PP.inkMuted,
  },

  singleBody: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: 2,
  },
  singleValue: {
    fontSize: 28,
    fontWeight: '800',
    color: PP.ink,
    letterSpacing: -0.5,
  },
  singleSub: {
    ...PP_LABEL,
    fontSize: 10,
    letterSpacing: 1,
    color: PP.inkMuted,
  },

  milestoneList: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.md,
  },
  milestoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  milestoneDot: {
    width: dot.md,
    height: dot.md,
    borderRadius: dot.md / 2,
    backgroundColor: '#7B5CE5',
  },
  milestoneInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  milestoneName: {
    ...t.bodyStrong,
    color: PP.ink,
    fontSize: 14,
  },
  milestoneDate: {
    ...t.small,
    color: PP.inkMuted,
    fontSize: 12,
  },
});
