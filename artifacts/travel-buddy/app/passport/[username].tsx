/**
 * app/passport/[username].tsx
 * Deep-link target: travelbuddy://passport/@<username>  /  HTTPS universal link /passport/@<username>
 * Public-facing Passport viewer. Works without auth (read-only).
 * Fetches from GET /api/users/:username/profile (new profile endpoint) +
 * GET /api/users/:username/passport/postcards (existing public postcards endpoint).
 * Private profiles show a minimal "This profile is private" stub.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Users } from 'lucide-react-native';
import { getPublicProfile, getPublicPostcards } from '../../src/services/profile';
import { useSession } from '../../src/context/SessionContext';
import { useFollow } from '../../src/hooks/useFollow';
import { PassportHero } from '../../src/components/PassportHero';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { AboutTab } from '../../src/components/AboutTab';
import { MapTab } from '../../src/components/MapTab';
import type { PublicProfile, PassportPostcard } from '../../src/types/models';
import { color, space, radius, type as t } from '../../src/theme/tokens';

type Tab = 'postcards' | 'stamps' | 'map' | 'about';
const TABS: { key: Tab; label: string }[] = [
  { key: 'postcards', label: 'Postcards' },
  { key: 'stamps', label: 'Stamps' },
  { key: 'map', label: 'Map' },
  { key: 'about', label: 'About' },
];

interface ScreenState {
  profile: PublicProfile | null;
  postcards: PassportPostcard[];
  loading: boolean;
  error: string | null;
  isPrivate: boolean;
  notFound: boolean;
}

export default function PassportDeepLinkScreen() {
  const { username: rawUsername } = useLocalSearchParams<{ username: string }>();
  const username = (rawUsername ?? '').replace(/^@/, '');

  const [state, setState] = useState<ScreenState>({
    profile: null, postcards: [], loading: true,
    error: null, isPrivate: false, notFound: false,
  });

  useEffect(() => {
    if (!username) return;
    let alive = true;
    setState({ profile: null, postcards: [], loading: true, error: null, isPrivate: false, notFound: false });

    getPublicProfile(username).then(async (res) => {
      if (!alive) return;
      if (!res.ok) {
        if (res.errorKind === 'not_found') {
          setState((s) => ({ ...s, loading: false, notFound: true }));
        } else {
          setState((s) => ({ ...s, loading: false, error: res.message ?? 'Failed to load profile' }));
        }
        return;
      }

      const card = res.data!;
      if (card.private || card.visibility === 'private') {
        setState((s) => ({ ...s, loading: false, isPrivate: true }));
        return;
      }

      const profile: PublicProfile = {
        id: card.id ?? '',
        username: card.username,
        displayName: card.displayName,
        bio: card.bio ?? null,
        avatarUrl: card.avatarUrl,
        homeCity: null,
        homeCountry: null,
        travelStyle: null,
        interests: [],
        verified: false,
        passportVisibility: 'public',
        createdAt: null,
      };
      setState((s) => ({ ...s, profile, loading: false }));

      const pcRes = await getPublicPostcards(username);
      if (alive) {
        setState((s) => ({ ...s, postcards: pcRes.ok ? (pcRes.data ?? []) : [] }));
      }
    }).catch(() => {
      if (alive) setState((s) => ({ ...s, loading: false, error: 'Failed to load profile' }));
    });

    return () => { alive = false; };
  }, [username]);

  const { profile, postcards, loading, error, isPrivate, notFound } = state;
  const { isAuthed } = useSession();
  const follow = useFollow(profile?.id ?? null);
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
          <Pressable style={styles.homeBtn} onPress={() => router.replace('/(tabs)/' as any)}>
            <Text style={styles.homeBtnText}>Go home</Text>
          </Pressable>
        </View>
      );
    }

    if (isPrivate) {
      return (
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔒</Text>
          <Text style={styles.stateTitle}>This Passport is private</Text>
          <Text style={styles.stateSub}>@{username} hasn't made their Passport public yet.</Text>
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

    const countries = new Set(postcards.map((c) => c.locationCountry).filter(Boolean)).size;
    const cities = new Set(postcards.map((c) => c.locationCity).filter(Boolean)).size;

    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: color.paper }}
        contentContainerStyle={{ paddingBottom: space.xxxl }}
        showsVerticalScrollIndicator={false}
      >
        <PassportHero
          profile={profile}
          isOwner={false}
          isFollowing={isAuthed ? follow.isFollowing : undefined}
          followLoading={isAuthed ? (follow.loading || follow.toggling) : undefined}
          onFollowPress={isAuthed ? follow.toggle : undefined}
        />

        <View style={styles.statsRow}>
          {[
            { n: postcards.length, label: 'Postcards' },
            { n: countries, label: 'Countries' },
            { n: cities, label: 'Cities' },
            { n: follow.followersCount, label: 'Followers' },
          ].map((item, i) => (
            <React.Fragment key={item.label}>
              {i > 0 && <View style={styles.statsDivider} />}
              <View style={styles.statsCell}>
                <Text style={styles.statsN}>
                  {follow.loading && item.label === 'Followers' ? '—' : item.n}
                </Text>
                <Text style={styles.statsL}>{item.label}</Text>
              </View>
            </React.Fragment>
          ))}
        </View>

        {follow.followingCount > 0 && (
          <View style={styles.followingPill}>
            <Users size={12} color={color.mute} />
            <Text style={styles.followingText}>
              Following {follow.followingCount}{' '}
              {follow.followingCount === 1 ? 'traveler' : 'travelers'}
            </Text>
          </View>
        )}

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
          {tab === 'postcards' && <PostcardsTab postcards={postcards} isOwner={false} />}
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
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any))}
          style={styles.backBtn}
          hitSlop={8}
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {profile
            ? (profile.displayName || `@${profile.username ?? username}`)
            : `@${username || 'Passport'}`}
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

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md, minHeight: 300,
  },
  stateIcon: { fontSize: 56 },
  stateTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  stateSub: { ...t.body, color: color.mute, textAlign: 'center' },
  homeBtn: {
    marginTop: space.sm,
    paddingVertical: space.md, paddingHorizontal: space.xl,
    backgroundColor: color.ink, borderRadius: radius.pill,
  },
  homeBtnText: { color: color.onInk, fontWeight: '700', fontSize: 14 },

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

  followingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginHorizontal: space.lg, marginTop: space.sm,
    paddingVertical: 6, paddingHorizontal: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, alignSelf: 'flex-start',
  },
  followingText: { ...t.small, color: color.mute, fontSize: 12 },

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
