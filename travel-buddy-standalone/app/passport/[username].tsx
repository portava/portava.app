/**
 * app/passport/[username].tsx
 * Public-facing Passport viewer — passport document design.
 * Works without auth (read-only). Preserves all existing functionality.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MoreVertical } from 'lucide-react-native';
import { getPublicProfile, getPublicPostcards } from '../../src/services/profile';
import { blockUser } from '../../src/services/blocks';
import { submitReport, type ReportReason } from '../../src/services/reports';
import { useSession } from '../../src/context/SessionContext';
import { useFollow } from '../../src/hooks/useFollow';
import { useHighlightRingState } from '../../src/hooks/useHighlightRingState';
import { HighlightViewer } from '../../src/components/HighlightViewer';
import { PostcardsTab } from '../../src/components/PostcardsTab';
import { StampsTab } from '../../src/components/StampsTab';
import { AboutTab } from '../../src/components/AboutTab';
import { MapTab } from '../../src/components/MapTab';
import type { PublicProfile, PassportPostcard } from '../../src/types/models';
import { resolveDisplayName, formatHandle } from '../../src/utils/identity';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { PP, PP_LABEL } from '../../src/theme/passportTokens';

// New passport design components
import { PassportIdentityCard } from '../../src/components/passport/PassportIdentityCard';
import { PassportDivider } from '../../src/components/passport/PassportDivider';
import { NavBarFiller, useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';

type Tab = 'posts' | 'stamps' | 'map' | 'about';
const TABS: { key: Tab; label: string }[] = [
  { key: 'posts',  label: 'Posts' },
  { key: 'stamps', label: 'Stamps' },
  { key: 'map',    label: 'Map' },
  { key: 'about',  label: 'About' },
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

      const { resolveAvatarUrl } = await import('../../src/utils/identity');
      const profile: PublicProfile = {
        id: card.id ?? '',
        username: card.username,
        displayName: card.displayName,
        bio: card.bio ?? null,
        avatarUrl: resolveAvatarUrl(card.avatarUrl),
        homeCity: card.homeCity ?? null,
        homeCountry: card.homeCountry ?? null,
        travelStyle: card.travelStyle ?? null,
        interests: card.interests ?? [],
        verified: card.verified ?? false,
        verificationStatus: (card.verificationStatus ?? 'unverified') as PublicProfile['verificationStatus'],
        verifiedAt: card.verifiedAt ?? null,
        passportVisibility: (card.passportVisibility ?? 'public') as 'public' | 'private',
        createdAt: card.createdAt ?? null,
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
  const { isAuthed, userId: viewerUserId } = useSession();
  const isOwner = !!profile && !!viewerUserId && profile.id === viewerUserId;
  const follow = useFollow(profile?.id ?? null);
  const ringState = useHighlightRingState(profile?.id ?? null);
  const [highlightViewerOpen, setHighlightViewerOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('posts');
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();

  const handleMorePress = useCallback(() => {
    if (!profile) return;
    const displayName = resolveDisplayName(profile);
    Alert.alert(displayName, undefined, [
      {
        text: 'Report',
        onPress: () => {
          Alert.alert('Report profile', 'Why are you reporting this profile?', [
            { text: 'Spam',        onPress: () => doReport('spam') },
            { text: 'Harassment',  onPress: () => doReport('harassment') },
            { text: 'Fake account',onPress: () => doReport('fake_account') },
            { text: 'Other',       onPress: () => doReport('other') },
            { text: 'Cancel', style: 'cancel' },
          ]);
        },
      },
      {
        text: 'Block', style: 'destructive',
        onPress: () => {
          Alert.alert(`Block ${displayName}?`,
            "They won't be able to message you, follow you, or see your profile.",
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Block', style: 'destructive',
                onPress: async () => {
                  const res = await blockUser(profile.id);
                  if (res.ok) {
                    router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any);
                  } else {
                    Alert.alert('Error', res.error ?? 'Could not block user');
                  }
                },
              },
            ],
          );
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [profile, username]);

  async function doReport(reason: ReportReason) {
    if (!profile) return;
    const res = await submitReport({ targetUserId: profile.id, reason });
    if (res.ok) Alert.alert('Report submitted', 'Thank you for helping keep the community safe.');
    else Alert.alert('Could not submit report', res.error ?? 'Please try again.');
  }

  // ── Render states ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>{formatHandle(username) ?? 'Passport'}</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={PP.ink} />
        </View>
      </View>
    );
  }

  if (notFound) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>Not Found</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.stateCenter}>
          <Text style={vs.stateIcon}>🔍</Text>
          <Text style={vs.stateTitle}>No one here</Text>
          <Text style={vs.stateSub}>@{username} doesn't exist.</Text>
          <Pressable style={vs.homeBtn} onPress={() => router.replace('/(tabs)/' as any)}>
            <Text style={vs.homeBtnText}>Go home</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (isPrivate) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>{formatHandle(username) ?? 'Passport'}</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.stateCenter}>
          <Text style={vs.stateIcon}>🔒</Text>
          <Text style={vs.stateTitle}>This Passport is private</Text>
          <Text style={vs.stateSub}>@{username} hasn't made their Passport public yet.</Text>
        </View>
      </View>
    );
  }

  if (error || !profile) {
    return (
      <View style={[vs.container, { backgroundColor: PP.paperDeep, paddingTop: insets.top }]}>
        <View style={vs.header}>
          <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)} style={vs.backBtn} hitSlop={8}>
            <ArrowLeft size={22} color={PP.ink} />
          </Pressable>
          <Text style={vs.headerTitle}>Error</Text>
          <View style={{ width: 38 }} />
        </View>
        <View style={vs.stateCenter}>
          <Text style={vs.stateTitle}>Couldn't load Passport</Text>
          <Text style={vs.stateSub}>{error ?? 'Unknown error'}</Text>
        </View>
      </View>
    );
  }

  // ── Visitor stats ──────────────────────────────────────────────────────────
  const countries = new Set(postcards.map((c) => c.locationCountry).filter(Boolean)).size;
  const cities    = new Set(postcards.map((c) => c.locationCity).filter(Boolean)).size;

  const visitorStats = [
    { n: postcards.length, label: 'Posts' },
    { n: countries,        label: 'Countries' },
    { n: cities,           label: 'Cities' },
    { n: follow.followersCount, label: 'Followers' },
  ];

  return (
    <View style={[vs.container, { backgroundColor: PP.paperDeep }]}>
      {/* Nav header */}
      <View style={[vs.header, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any)}
          style={vs.backBtn}
          hitSlop={8}
        >
          <ArrowLeft size={20} color={PP.ink} />
        </Pressable>
        <Text style={vs.headerTitle} numberOfLines={1}>
          {resolveDisplayName(profile)}
        </Text>
        {isAuthed && !isOwner ? (
          <Pressable style={vs.moreBtn} onPress={handleMorePress} hitSlop={8} accessibilityLabel="More options">
            <MoreVertical size={20} color={PP.ink} />
          </Pressable>
        ) : (
          <View style={{ width: 38 }} />
        )}
      </View>

      {/* Header rule */}
      <View style={vs.headerRule} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 80 }}
        showsVerticalScrollIndicator={false}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >
        {/* ── Passport Identity Card ── */}
        <PassportIdentityCard
          profile={profile}
          isOwner={false}
          hasHighlights={ringState?.hasActive}
          allHighlightsViewed={ringState?.allViewed}
          onHighlightRingPress={ringState?.hasActive ? () => setHighlightViewerOpen(true) : undefined}
          isFollowing={isAuthed ? follow.isFollowing : undefined}
          followLoading={isAuthed ? (follow.loading || follow.toggling) : undefined}
          onFollowPress={isAuthed ? follow.toggle : undefined}
          overrideStats={visitorStats}
        />

        {/* ── Document-style tab bar ── */}
        <PassportDivider />
        <View style={vs.tabBar}>
          {TABS.map((tb) => (
            <Pressable key={tb.key} style={vs.tabItem} onPress={() => setTab(tb.key)}>
              <Text style={[vs.tabText, tab === tb.key && vs.tabTextActive]}>
                {tb.label}
              </Text>
              {tab === tb.key && <View style={vs.tabIndicator} />}
            </Pressable>
          ))}
        </View>
        <View style={vs.tabRule} />

        {/* ── Tab content ── */}
        <View style={{ marginTop: space.md }}>
          {tab === 'posts'  && <PostcardsTab postcards={postcards} isOwner={false} />}
          {tab === 'stamps' && <StampsTab stamps={[]} viewingUsername={username} viewingUserId={profile?.id} />}
          {tab === 'map'    && <MapTab postcards={postcards} />}
          {tab === 'about'  && <AboutTab profile={profile} isOwner={false} />}
        </View>
        <NavBarFiller />
      </ScrollView>

      <HighlightViewer
        visible={highlightViewerOpen}
        highlights={ringState?.highlights ?? []}
        onClose={() => setHighlightViewerOpen(false)}
      />
    </View>
  );
}

const vs = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 10,
    backgroundColor: PP.paper,
  },
  headerRule: { height: 2, backgroundColor: PP.ink },
  backBtn: { padding: 6, width: 38 },
  headerTitle: {
    fontFamily: 'Courier', fontSize: 13, fontWeight: '700',
    color: PP.ink, flex: 1, textAlign: 'center',
    letterSpacing: 0.5,
  },
  moreBtn: { padding: 6, width: 38, alignItems: 'center' },

  stateCenter: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.md, minHeight: 300,
  },
  stateIcon: { fontSize: 48 },
  stateTitle: { fontSize: 18, fontWeight: '700', color: PP.ink, textAlign: 'center' },
  stateSub: { fontSize: 14, color: PP.inkMuted, textAlign: 'center', lineHeight: 20 },
  homeBtn: {
    marginTop: space.sm,
    paddingVertical: space.md, paddingHorizontal: space.xl,
    backgroundColor: PP.ink, borderRadius: radius.pill,
  },
  homeBtnText: { color: PP.paper, fontWeight: '700', fontSize: 14 },

  tabBar: { flexDirection: 'row', marginHorizontal: 16, marginTop: 4 },
  tabItem: { flex: 1, alignItems: 'center', paddingVertical: 10, position: 'relative' },
  tabText: { ...PP_LABEL, fontSize: 10, color: PP.inkMuted, letterSpacing: 1.5 },
  tabTextActive: { color: PP.ink },
  tabIndicator: {
    position: 'absolute', bottom: 0, left: '20%', right: '20%',
    height: 2, borderRadius: 1, backgroundColor: PP.inkLight,
  },
  tabRule: { height: 1, backgroundColor: PP.borderLight, marginHorizontal: 16 },
});
