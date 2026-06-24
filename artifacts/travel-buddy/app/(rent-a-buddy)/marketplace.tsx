import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, RefreshControl,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, Sparkles, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  TravelSectionHeader, HorizontalScrollStrip,
  TravelErrorState, TravelLoadingState,
} from '../../src/components/primitives';
import { BuddyCard } from '../../src/components/BuddyCard';
import { getDiscoverySections, type DiscoverySection, type BuddyProfile } from '../../src/services/rentABuddy';

function SectionStrip({ section, onBuddyPress }: { section: DiscoverySection; onBuddyPress: (b: BuddyProfile) => void }) {
  if (section.isCtaSection) {
    return (
      <View style={cta.wrap}>
        <Text style={cta.title}>Can't find the right Buddy?</Text>
        <Text style={cta.sub}>Post an open request and let eligible Buddies send you offers.</Text>
        <Pressable style={cta.btn} onPress={() => router.push('/(rent-a-buddy)/request-buddy' as any)}>
          <Text style={cta.btnLabel}>Post a Request</Text>
        </Pressable>
      </View>
    );
  }

  if (section.buddies.length === 0) return null;

  return (
    <View>
      <TravelSectionHeader
        title={section.title}
        onAction={() => router.push({ pathname: '/(rent-a-buddy)/search', params: { sectionKey: section.key } } as any)}
      />
      <HorizontalScrollStrip>
        {section.buddies.map((buddy) => (
          <BuddyCard
            key={buddy.id}
            buddy={buddy}
            compact
            availableNow={buddy.availableNow}
            onBook={() => onBuddyPress(buddy)}
          />
        ))}
      </HorizontalScrollStrip>
    </View>
  );
}

export default function Marketplace() {
  const insets = useSafeAreaInsets();
  const { fromQuiz } = useLocalSearchParams<{ fromQuiz?: string }>();
  const [sections, setSections] = useState<DiscoverySection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const result = await getDiscoverySections();
    if (!silent) setLoading(false);
    setRefreshing(false);
    if (!result.ok) { setError(result.error); return; }
    setSections(result.data.sections);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onBuddyPress = useCallback((buddy: BuddyProfile) => {
    router.push({ pathname: '/(rent-a-buddy)/buddy/[id]', params: { id: buddy.id } } as any);
  }, []);

  if (loading) return <TravelLoadingState label="Loading marketplace…" />;
  if (error) return <TravelErrorState title="Failed to load" sub={error} onRetry={() => load()} />;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <View style={s.titleRow}>
          <Text style={s.title}>Find a Buddy</Text>
          {fromQuiz === '1' && (
            <View style={s.quizBadge}>
              <Text style={s.quizBadgeText}>Quiz matched</Text>
            </View>
          )}
        </View>
        <Pressable style={s.searchBtn} onPress={() => router.push('/(rent-a-buddy)/search' as any)}>
          <Search size={18} color={color.mute} />
          <Text style={s.searchPlaceholder}>Search Buddies, cities, categories…</Text>
        </Pressable>
        <View style={s.quickActions}>
          <Pressable style={s.qaBtn} onPress={() => router.push('/(rent-a-buddy)/match-quiz' as any)}>
            <Sparkles size={14} color={color.deep} />
            <Text style={s.qaLabel}>Take Match Quiz</Text>
          </Pressable>
          <Pressable style={s.qaBtn} onPress={() => router.push('/(rent-a-buddy)/request-buddy' as any)}>
            <MapPin size={14} color={color.deep} />
            <Text style={s.qaLabel}>Request a Buddy</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}
      >
        {sections.map((section) => (
          <SectionStrip key={section.key} section={section} onBuddyPress={onBuddyPress} />
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md },
  title: { ...t.title, color: color.ink },
  quizBadge: { backgroundColor: `${color.deep}20`, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  quizBadgeText: { ...t.small, color: color.deep, fontWeight: '600' },
  searchBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.haze, borderRadius: radius.md, padding: space.md,
    marginBottom: space.md,
  },
  searchPlaceholder: { ...t.body, color: color.mute, flex: 1 },
  quickActions: { flexDirection: 'row', gap: space.sm },
  qaBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, padding: space.md, backgroundColor: `${color.deep}12`,
    borderRadius: radius.md, borderWidth: 1, borderColor: `${color.deep}30`,
  },
  qaLabel: { ...t.small, color: color.deep, fontWeight: '600' },
});

const cta = StyleSheet.create({
  wrap: { margin: space.lg, padding: space.xl, backgroundColor: `${color.deep}08`, borderRadius: radius.lg, borderWidth: 1.5, borderColor: `${color.deep}25` },
  title: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  sub: { ...t.body, color: color.mute, marginBottom: space.lg },
  btn: { backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  btnLabel: { ...t.body, color: '#fff', fontWeight: '700' },
});
