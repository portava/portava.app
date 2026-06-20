import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { usePublicPassport } from '../../src/hooks/usePublicPassport';
import { PassportHero } from '../../src/components/PassportHero';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { AboutTab } from '../../src/components/AboutTab';
import { MapTab } from '../../src/components/MapTab';
import type { PublicProfile } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';

type Tab = 'postcards' | 'stamps' | 'map' | 'about';
const TABS: { key: Tab; label: string }[] = [
  { key: 'postcards', label: 'Postcards' },
  { key: 'stamps', label: 'Stamps' },
  { key: 'map', label: 'Map' },
  { key: 'about', label: 'About' },
];

export default function PublicPassportScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { profile, postcards, loading, error, isPrivate, notFound } = usePublicPassport(username ?? '');
  const [tab, setTab] = useState<Tab>('postcards');
  const insets = useSafeAreaInsets();

  const renderContent = () => {
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      );
    }

    if (notFound) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔍</Text>
          <Text style={styles.stateTitle}>No one here</Text>
          <Text style={styles.stateSub}>@{username} doesn't exist.</Text>
        </View>
      );
    }

    if (isPrivate) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔒</Text>
          <Text style={styles.stateTitle}>This Passport is private</Text>
          <Text style={styles.stateSub}>Only the owner can see this Passport.</Text>
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateTitle}>Couldn't load Passport</Text>
          <Text style={styles.stateSub}>{error}</Text>
        </View>
      );
    }

    if (!profile) return null;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: color.paper }}
        contentContainerStyle={{ paddingTop: 0, paddingBottom: space.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        <PassportHero
          profile={profile}
          isOwner={false}
        />

        {/* Compact stats */}
        <View style={styles.statsRow}>
          {[
            { n: postcards.length, label: 'Postcards' },
            { n: new Set(postcards.map((c) => c.locationCountry).filter(Boolean)).size, label: 'Countries' },
            { n: new Set(postcards.map((c) => c.locationCity).filter(Boolean)).size, label: 'Cities' },
          ].map((item, i, arr) => (
            <React.Fragment key={item.label}>
              {i > 0 && <View style={styles.statsDivider} />}
              <View style={styles.statsCell}>
                <Text style={styles.statsN}>{item.n}</Text>
                <Text style={styles.statsL}>{item.label}</Text>
              </View>
            </React.Fragment>
          ))}
        </View>

        {/* Tab bar */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBarWrap}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tb) => (
            <Pressable
              key={tb.key}
              style={[styles.tab, tab === tb.key && styles.tabActive]}
              onPress={() => setTab(tb.key)}
            >
              <Text style={[styles.tabText, tab === tb.key && styles.tabTextActive]}>
                {tb.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={{ marginTop: space.md }}>
          {tab === 'postcards' && (
            <PostcardsTab postcards={postcards} isOwner={false} />
          )}
          {tab === 'stamps' && <StampsTab stamps={[]} />}
          {tab === 'map' && <MapTab postcards={postcards} />}
          {tab === 'about' && <AboutTab profile={profile} isOwner={false} />}
        </View>
      </ScrollView>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {profile ? (('displayName' in profile && profile.displayName) || (username ?? '')) : username ?? ''}
        </Text>
        <View style={{ width: 38 }} />
      </View>
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  backBtn: { padding: 6 },
  headerTitle: { ...t.heading, color: color.ink, flex: 1, textAlign: 'center' },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl, gap: space.md, minHeight: 300 },
  stateIcon: { fontSize: 56 },
  stateTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  stateSub: { ...t.body, color: color.mute, textAlign: 'center' },

  statsRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 10,
  },
  statsCell: { flex: 1, alignItems: 'center' },
  statsDivider: { width: 1, height: 28, backgroundColor: color.haze },
  statsN: { ...t.heading, color: color.ink, fontSize: 18 },
  statsL: { fontFamily: 'Courier', fontSize: 9, color: color.mute, fontWeight: '700' },

  tabBarWrap: { marginTop: space.md },
  tabBarContent: { paddingHorizontal: space.lg, gap: space.xs },
  tab: {
    paddingHorizontal: space.md, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  tabActive: { backgroundColor: color.ink, borderColor: color.ink },
  tabText: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 13 },
  tabTextActive: { color: color.onInk },
});
