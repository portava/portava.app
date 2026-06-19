import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bookmark, Sparkles } from 'lucide-react-native';
import { Stamp } from '../../src/components/ui';
import { StampBadge } from '../../src/components/PassportStamps';
import { PassportStampStrip } from '../../src/components/PassportStampCard';
import { PostcardWall } from '../../src/components/PostcardTile';
import { PassportHero } from '../../src/components/PassportHero';
import { InfoBar } from '../../src/components/PassportHeader';
import { PassportSection, PlanRow, PerksRow } from '../../src/components/PassportSections';
import { usePassport } from '../../src/hooks/usePassport';
import { useAvailability } from '../../src/hooks/useCityPulse';
import { resolveStatus } from '../../src/lib/availability';
import { AvailabilityCard } from '../../src/components/AvailabilityCard';
import { posts } from '../../src/data/cebu';
import { color, space, radius, type as t } from '../../src/theme/tokens';

type Tab = 'plans' | 'stamps' | 'postcards';

export default function Passport() {
  const { data, loading, error } = usePassport();
  const { availability } = useAvailability();
  const availStatus = resolveStatus(availability, new Date().toISOString(), 'cebu');
  const [tab, setTab] = useState<Tab>('plans');
  const insets = useSafeAreaInsets();
  const myPosts = posts.slice(0, 4);

  if (loading) {
    return <View style={[styles.center, { backgroundColor: color.paper }]}><ActivityIndicator color={color.signal} /></View>;
  }
  if (error || !data) {
    return <View style={[styles.center, { backgroundColor: color.paper }]}><Text style={styles.errText}>Couldn't load your Passport.</Text></View>;
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: color.paper }} contentContainerStyle={{ paddingTop: insets.top, paddingBottom: space.xxxl }}>
      {/* Passport-document hero card */}
      <PassportHero user={data.user} trustScore={data.trust.score} />

      {/* Clickable info bar */}
      <InfoBar
        stats={data.stats}
        onStamps={() => setTab('stamps')}
        onCircle={() => router.push('/circle')}
        onPlans={() => setTab('plans')}
        onCities={() => router.push('/(tabs)/trips')}
      />

      {/* Availability */}
      <View style={{ paddingHorizontal: space.lg }}>
        <AvailabilityCard status={availStatus} />
      </View>

      {/* Featured illustrated stamps */}
      <PassportStampStrip stamps={data.stamps} />

      {/* Small actions above tabs: Saved + Compass AI */}
      <View style={styles.miniActions}>
        <Pressable style={styles.miniBtn} onPress={() => router.push('/saved')}>
          <Bookmark size={15} color={color.ink} /><Text style={styles.miniText}>Saved</Text>
        </Pressable>
        <Pressable style={styles.miniBtn} onPress={() => router.push('/(tabs)/ai')}>
          <Sparkles size={15} color={color.signal} /><Text style={styles.miniText}>Compass AI</Text>
        </Pressable>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        {(['plans', 'stamps', 'postcards'] as Tab[]).map((tb) => (
          <Pressable key={tb} style={[styles.tab, tab === tb && styles.tabActive]} onPress={() => setTab(tb)}>
            <Text style={[styles.tabText, tab === tb && styles.tabTextActive]}>
              {tb === 'plans' ? 'Plans' : tb === 'stamps' ? 'Stamps' : 'Postcards'}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'plans' && (
        <View>
          {availability?.trips?.length ? (
            <PassportSection title="Trip windows">
              <View style={{ gap: space.sm }}>
                {availability.trips.map((tw) => (
                  <View key={tw.id} style={styles.tripWindow}>
                    <Stamp label={tw.citySlug} tone="deep" />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.twDates}>{tw.startDate} – {tw.endDate}</Text>
                      <Text style={styles.twBlocks}>Open {tw.blocks.join(', ')}</Text>
                    </View>
                    <Stamp label="active" tone="signal" rotate={2} />
                  </View>
                ))}
              </View>
            </PassportSection>
          ) : null}
          <PassportSection title="Your plans" action="See all" onAction={() => router.push('/(tabs)/trips')}>
            <PlanRow plans={data.plans} />
          </PassportSection>
        </View>
      )}

      {tab === 'stamps' && (
        <View>
          <PassportSection title="All stamps" action="Open collection" onAction={() => router.push('/stamps')}>
            <View style={styles.stampGrid}>
              {data.stamps.map((s, i) => (
                <View key={s.id} style={styles.stampCell}>
                  <StampBadge stamp={s} size={88} rotate={((i % 3) - 1) * 4} onPress={() => router.push('/stamps')} />
                </View>
              ))}
            </View>
          </PassportSection>
          <PassportSection title="Perks" action="View all" onAction={() => router.push('/saved')}>
            <PerksRow perks={data.perks.slice(0, 2)} />
          </PassportSection>
        </View>
      )}

      {tab === 'postcards' && (
        <PassportSection title="Your postcards">
          <PostcardWall posts={myPosts} />
        </PassportSection>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errText: { ...t.body, color: color.mute },

  miniActions: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, marginTop: space.lg },
  miniBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  miniText: { ...t.small, fontWeight: '700', color: color.ink },

  tabBar: { flexDirection: 'row', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, padding: 4, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill },
  tab: { flex: 1, paddingVertical: space.sm, borderRadius: radius.pill, alignItems: 'center' },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.bodyStrong, color: color.mute, fontSize: 14 },
  tabTextActive: { color: color.onInk },

  tripWindow: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  twDates: { ...t.bodyStrong, color: color.ink },
  twBlocks: { ...t.small, color: color.mute, marginTop: 2 },

  stampGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.lg },
  stampCell: { width: '31%', alignItems: 'center' },
});
