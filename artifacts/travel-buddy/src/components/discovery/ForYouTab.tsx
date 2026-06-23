/**
 * For You tab — AI-backed recommendations from Telegraph.
 *
 * Uses PlaceCard for full interaction parity (Save, Get Directions, Add to Plan,
 * tap to open PlaceDetailSheet). Shows a "Why this?" reason banner above each card.
 * Falls back to OSM attraction mix when Telegraph is unavailable or user is not signed in.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Pressable,
} from 'react-native';
import { Sparkles, Info } from 'lucide-react-native';
import type { TelegraphRecommendation } from '../../services/telegraphRecommend';
import { getForYouRecommendations } from '../../services/telegraphRecommend';
import type { DiscoveryPlace } from '../../services/discovery';
import { getDiscoveryPlaces } from '../../services/discovery';
import { PlaceSkeletonList } from './PlaceSkeleton';
import PlaceCard from './PlaceCard';
import { PlaceDetailSheet } from './PlaceDetailSheet';
import { color, space, radius, type as t } from '../../theme/tokens';
import { useSession } from '../../context/SessionContext';
import { useCommunityDiscovery } from '../../hooks/useCommunityDiscovery';
import { HiddenGemsSection, TravelerPicksSection } from '../DiscoveryWall2';

// ── Convert a Telegraph recommendation to DiscoveryPlace shape ────────────────

function recToPlace(rec: TelegraphRecommendation): DiscoveryPlace {
  const tags: string[] = [rec.estimatedTime, rec.priceLevel].filter((s) => s && s !== 'free') as string[];
  return {
    id:           rec.id,
    name:         rec.title,
    category:     'for_you',
    type:         rec.category || null,
    description:  rec.locationContext || null,
    distanceKm:   null,
    lat:          null,
    lng:          null,
    tags,
    address:      rec.locationContext || null,
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       null,
    isOpenNow:    null,
  };
}

// ── Main component ────────────────────────────────────────────────────────────

interface ForYouTabProps {
  destination: string;
  onAddToPlan: (item: { id: string; name: string; category: string; address?: string | null }) => void;
}

type ForYouItem =
  | { kind: 'telegraph'; rec: TelegraphRecommendation; place: DiscoveryPlace }
  | { kind: 'osm'; place: DiscoveryPlace };

export function ForYouTab({ destination, onAddToPlan }: ForYouTabProps) {
  const { isAuthed }            = useSession();
  const [items, setItems]       = useState<ForYouItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource]     = useState<'telegraph' | 'osm' | 'none'>('none');
  const [detail, setDetail]     = useState<DiscoveryPlace | null>(null);

  const community = useCommunityDiscovery(destination ?? null);

  // Monotonically-increasing counter so stale async callbacks from an old
  // load() call can detect they've been superseded and bail out safely.
  const loadIdRef = React.useRef(0);

  const load = useCallback(async (isRefresh = false) => {
    if (!destination) return;
    const myId = ++loadIdRef.current;
    const stale = () => loadIdRef.current !== myId;

    if (!isRefresh) setLoading(true);

    // Fire OSM and Telegraph simultaneously.
    // OSM is a simple geocode + database query (~1–2 s).
    // Telegraph is an AI call — capped at 10 s by AbortController in the service.
    const osmPromise = getDiscoveryPlaces(destination, 'for_you', { radiusKm: 25, openNow: false, minRating: null });
    const telPromise = isAuthed
      ? getForYouRecommendations({ destination, count: 5 })
      : null;

    // Show OSM content the instant it resolves — clears the skeleton immediately.
    osmPromise.then((osm) => {
      if (stale()) return;
      setLoading(false);
      setRefreshing(false);
      if (osm.ok && osm.data.places.length > 0) {
        setItems(osm.data.places.slice(0, 15).map((p) => ({ kind: 'osm' as const, place: p })));
        setSource('osm');
      } else {
        setItems([]);
        setSource('none');
      }
    }).catch(() => {
      if (!stale()) { setLoading(false); setRefreshing(false); }
    });

    // Silently upgrade to Telegraph AI picks when (if) the AI call returns.
    // If it times out (10 s), OSM results are already visible — no extra wait.
    if (telPromise) {
      try {
        const tel = await telPromise;
        if (!stale() && tel.ok && tel.recommendations.length > 0) {
          setItems(tel.recommendations.map((rec) => ({
            kind: 'telegraph' as const,
            rec,
            place: recToPlace(rec),
          })));
          setSource('telegraph');
        }
      } catch {
        // telegraph failed — OSM is already showing, nothing to do
      }
      // Guarantee loading is cleared even if osmPromise somehow never resolved
      if (!stale()) { setLoading(false); setRefreshing(false); }
    }
  }, [destination, isAuthed]);

  useEffect(() => {
    setItems([]);
    setSource('none');
    load(false);
  }, [destination, isAuthed, load]);

  const handleRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  if (!destination) return null;

  if (loading && items.length === 0) {
    return <PlaceSkeletonList count={5} />;
  }

  return (
    <>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={color.signal} />
        }
      >
        {/* Source label */}
        <View style={styles.sourceRow}>
          <Sparkles size={13} color={color.signal} />
          <Text style={styles.sourceLabel}>
            {source === 'telegraph'
              ? 'Personalised picks · powered by Telegraph AI'
              : source === 'osm'
              ? 'Popular spots from OpenStreetMap · sign in for personalised picks'
              : 'Curated picks'}
          </Text>
        </View>

        {items.map((item) => (
          <View key={item.place.id}>
            {/* "Why this?" reason banner — only for Telegraph cards */}
            {item.kind === 'telegraph' && item.rec.reason ? (
              <View style={styles.reasonBanner}>
                <Info size={11} color={color.signal} />
                <Text style={styles.reasonText} numberOfLines={2}>
                  {item.rec.reason}
                </Text>
              </View>
            ) : null}

            <PlaceCard
              place={item.place}
              onPress={() => setDetail(item.place)}
              onAddToPlan={() => onAddToPlan({
                id:       item.place.id,
                name:     item.place.name,
                category: item.place.category,
                address:  item.place.address,
              })}
            />
          </View>
        ))}

        {source === 'none' && (
          <View style={styles.empty}>
            <Sparkles size={28} color={color.faint} />
            <Text style={styles.emptyTitle}>No recommendations yet</Text>
            <Text style={styles.emptyDesc}>
              {isAuthed
                ? `Couldn't load recommendations for ${destination}. Pull to refresh.`
                : `Sign in to get personalised picks for ${destination}.`}
            </Text>
          </View>
        )}

        {/* ── Community sections: traveler-submitted from Supabase ── */}
        {community.gems.length > 0 && (
          <View style={styles.communitySection}>
            <HiddenGemsSection gems={community.gems} />
          </View>
        )}
        {community.picks.length > 0 && (
          <View style={styles.communitySection}>
            <TravelerPicksSection picks={community.picks} />
          </View>
        )}
      </ScrollView>

      {/* Full-parity detail sheet (same as OSM tabs) */}
      <PlaceDetailSheet
        place={detail}
        visible={detail !== null}
        onClose={() => setDetail(null)}
        onAddToPlan={(p) => {
          setDetail(null);
          onAddToPlan({ id: p.id, name: p.name, category: p.category, address: p.address });
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingTop: space.md,
    paddingBottom: space.xxxl,
  },
  communitySection: {
    marginTop: space.xl,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  sourceLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    flex: 1,
    lineHeight: 16,
  },
  reasonBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginBottom: -space.xs,
    backgroundColor: color.signal + '10',
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: color.signal + '30',
  },
  reasonText: {
    ...t.small,
    color: color.signal,
    fontStyle: 'italic',
    fontSize: 11,
    flex: 1,
    lineHeight: 15,
  },
  empty: {
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
    paddingTop: space.xxl,
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyDesc: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 19 },
});

export default ForYouTab;
