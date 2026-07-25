/**
 * CompassPassportSuggestions — "Suggested for You" section on the Passport tab.
 *
 * Owner-only (the Passport tab is always the signed-in user's own passport).
 * Fetches from GET /api/compass/recommendations?surface=passport and renders a
 * horizontal card strip of personalised traveler, event, and place suggestions.
 *
 * Self-hides when:
 *   - Compass is disabled (endpoint returns empty list)
 *   - No items returned
 *   - Network / auth error
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { Sparkles, UserPlus, UserCheck, MapPin, Calendar } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fetchCompassRecommendations, type CompassRecommendation } from '../../services/compass.ts';
import { getFollowStatus, followUser } from '../../services/follows.ts';
import { resolveCompassTitle, formatCompassSubtitle } from '../../utils/compassFormat.ts';

type FollowState = 'none' | 'following' | 'requested' | 'loading';

// ── Action label + icon per type (base — follow state overrides for travelers) ─

const EVENT_META  = { label: 'View',    icon: <Calendar size={10} color={color.onInk} />,   bg: color.signal };
const PLACE_META  = { label: 'Explore', icon: <MapPin size={10} color={color.onInk} />,     bg: color.deep };
const DEFAULT_META = { label: 'View',   icon: <Sparkles size={10} color={color.onInk} />,   bg: color.signal };

function getMeta(type: string) {
  if (type === 'event')                     return EVENT_META;
  if (type === 'place')                     return PLACE_META;
  return DEFAULT_META;
}

function travelerMeta(state: FollowState): { label: string; icon: React.ReactNode; bg: string } {
  if (state === 'following') return { label: 'Following', icon: <UserCheck size={10} color={color.onInk} />, bg: color.success };
  if (state === 'requested') return { label: 'Requested', icon: <UserCheck size={10} color={color.onInk} />, bg: color.mute };
  if (state === 'loading')   return { label: '…',         icon: <ActivityIndicator size="small" color={color.onInk} />, bg: color.ink };
  return { label: 'Follow', icon: <UserPlus size={10} color={color.onInk} />, bg: color.ink };
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <View style={[s.card, s.skeletonCard]}>
      <View style={[s.skel, { width: 44, height: 8, marginBottom: 8 }]} />
      <View style={[s.skel, { width: 100, height: 12, marginBottom: 6 }]} />
      <View style={[s.skel, { width: 80, height: 9, marginBottom: 10 }]} />
      <View style={[s.skel, { width: 64, height: 26, borderRadius: radius.sm }]} />
    </View>
  );
}

// ── Individual suggestion card ────────────────────────────────────────────────

function SuggestionCard({
  item,
  followState,
  onFollowStateChange,
}: {
  item: CompassRecommendation;
  followState?: FollowState;
  onFollowStateChange?: (id: string, state: FollowState) => void;
}) {
  const isTraveler = item.type === 'traveler' || item.type === 'user';
  const meta = isTraveler ? travelerMeta(followState ?? 'none') : getMeta(item.type);

  async function handlePress() {
    if (item.type === 'event' && item.id) {
      router.push(`/event/${item.id}` as any);
    } else if (item.type === 'hidden_gem') {
      // data.id is the raw UUID; item.id is prefixed "gem:<uuid>"
      const rawId = (item.data as any)?.id ?? item.id.replace(/^gem:/, '');
      router.push(`/gems/${rawId}` as any);
    } else if (item.type === 'place') {
      // No standalone place detail route — navigate to Discovery tab
      router.push('/(tabs)/discovery' as any);
    } else if (isTraveler) {
      const handle = (item.data as any)?.handle ?? (item.data as any)?.username;
      if (followState === 'following' || followState === 'requested') {
        // Already following → go to profile
        if (handle) router.push(`/u/${encodeURIComponent(handle)}` as any);
        else router.push('/(tabs)/discovery' as any);
      } else if (followState === 'none' && item.id) {
        // Follow the user
        onFollowStateChange?.(item.id, 'loading');
        const res = await followUser(item.id);
        if (res.ok) {
          onFollowStateChange?.(item.id, res.data?.following ? 'following' : 'requested');
        } else {
          onFollowStateChange?.(item.id, 'none');
          if (handle) router.push(`/u/${encodeURIComponent(handle)}` as any);
          else router.push('/(tabs)/discovery' as any);
        }
      } else {
        // Unknown state — navigate to profile
        if (handle) router.push(`/u/${encodeURIComponent(handle)}` as any);
        else router.push('/(tabs)/discovery' as any);
      }
    } else {
      router.push('/(tabs)/discovery' as any);
    }
  }

  return (
    <View style={s.card}>
      <View style={s.typeRow}>
        <View style={[s.typeChip, { backgroundColor: meta.bg + '20' }]}>
          <Text style={[s.typeText, { color: meta.bg }]}>{item.type.replace('_', ' ')}</Text>
        </View>
      </View>
      <Text style={s.cardTitle} numberOfLines={2}>{resolveCompassTitle(item)}</Text>
      {(() => {
        const subtitle = formatCompassSubtitle(item);
        return subtitle ? (
          <View style={s.cityRow}>
            <MapPin size={9} color={color.faint} />
            <Text style={s.cityText} numberOfLines={1}>{subtitle}</Text>
          </View>
        ) : null;
      })()}
      <View style={s.reasonPill}>
        <Sparkles size={8} color={color.signal} />
        <Text style={s.reasonText} numberOfLines={2}>{item.reason}</Text>
      </View>
      <Pressable
        style={[s.actionBtn, { backgroundColor: meta.bg }]}
        onPress={handlePress}
        disabled={followState === 'loading'}
      >
        {meta.icon}
        <Text style={s.actionText}>{meta.label}</Text>
      </Pressable>
    </View>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function Header() {
  return (
    <View style={s.header}>
      <Sparkles size={12} color={color.signal} />
      <Text style={s.sectionTitle}>Suggested for You</Text>
      <Pressable style={s.allBtn} onPress={() => router.push('/(tabs)/ai')} hitSlop={6}>
        <Text style={s.allBtnText}>Ask Compass</Text>
      </Pressable>
    </View>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface CompassPassportSuggestionsProps {
  /** Must be true — this section is owner-only. Pass false to suppress. */
  isOwner: boolean;
}

export function CompassPassportSuggestions({ isOwner }: CompassPassportSuggestionsProps) {
  const [items, setItems]               = useState<CompassRecommendation[]>([]);
  const [loading, setLoading]           = useState(true);
  const [done, setDone]                 = useState(false);
  const [followStates, setFollowStates] = useState<Record<string, FollowState>>({});

  const handleFollowStateChange = useCallback((id: string, state: FollowState) => {
    setFollowStates((prev) => ({ ...prev, [id]: state }));
  }, []);

  useEffect(() => {
    if (!isOwner) { setLoading(false); setDone(true); return; }
    fetchCompassRecommendations({ surface: 'passport', limit: 8 })
      .then(async (res) => {
        if (res.ok && res.data) {
          const recs = res.data.recommendations;
          setItems(recs);

          // Batch-fetch follow state for traveler/user suggestions
          const travelerItems = recs.filter(
            (r) => (r.type === 'traveler' || r.type === 'user') && r.id,
          );
          if (travelerItems.length > 0) {
            const initial: Record<string, FollowState> = {};
            for (const r of travelerItems) initial[r.id] = 'loading';
            setFollowStates(initial);

            const settled: Record<string, FollowState> = {};
            await Promise.allSettled(
              travelerItems.map(async (r) => {
                try {
                  const sr = await getFollowStatus(r.id);
                  settled[r.id] = sr.ok && sr.data
                    ? (sr.data.isFollowing ? 'following' : 'none')
                    : 'none';
                } catch {
                  settled[r.id] = 'none';
                }
              }),
            );
            setFollowStates((prev) => ({ ...prev, ...settled }));
          }
        }
      })
      .catch(() => {})
      .finally(() => { setLoading(false); setDone(true); });
  }, [isOwner]);

  // Never render for non-owners
  if (!isOwner) return null;

  if (loading && !done) {
    return (
      <View style={s.container}>
        <Header />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
          <Skeleton /><Skeleton /><Skeleton />
        </ScrollView>
      </View>
    );
  }

  if (done && items.length === 0) return null;

  return (
    <View style={s.container}>
      <Header />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
        {items.map((item) => (
          <SuggestionCard
            key={item.id}
            item={item}
            followState={followStates[item.id]}
            onFollowStateChange={handleFollowStateChange}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    marginTop: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  sectionTitle: {
    ...t.stamp,
    color: color.ink,
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
    textTransform: 'uppercase' as const,
    flex: 1,
  },
  allBtn: {
    backgroundColor: color.signal + '15',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  allBtnText: {
    ...t.small,
    color: color.signal,
    fontSize: 10,
    fontWeight: '600' as const,
  },
  row: {
    paddingHorizontal: space.lg,
    gap: space.sm,
    paddingRight: space.xl,
  },
  card: {
    width: 160,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  skeletonCard: {
    opacity: 0.5,
  },
  skel: {
    backgroundColor: color.haze,
    borderRadius: 4,
  },
  typeRow: {
    flexDirection: 'row',
  },
  typeChip: {
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  typeText: {
    ...t.small,
    fontSize: 9,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
  },
  cardTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
    lineHeight: 17,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  cityText: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
    flex: 1,
  },
  reasonPill: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 3,
    backgroundColor: color.signal + '08',
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 4,
  },
  reasonText: {
    ...t.small,
    color: color.signal,
    fontSize: 10,
    fontStyle: 'italic' as const,
    lineHeight: 13,
    flex: 1,
  },
  actionBtn: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: radius.sm,
    paddingVertical: 7,
  },
  actionText: {
    ...t.small,
    color: color.onInk,
    fontWeight: '700' as const,
    fontSize: 11,
  },
});
