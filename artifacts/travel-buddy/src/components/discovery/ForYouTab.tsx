/**
 * For You tab — AI-backed recommendations from Telegraph.
 *
 * Uses PlaceCard for full interaction parity (Save, Get Directions, Add to Plan,
 * tap to open PlaceDetailSheet). Shows a "Why this?" reason banner above each card.
 * Falls back to OSM attraction mix when Telegraph is unavailable or user is not signed in.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Sparkles, Info, Share2 } from 'lucide-react-native';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet';
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
import { HiddenGemsSection, TravelerPicksSection } from '../DiscoveryWall';
import { useCompassFeed } from '../../hooks/compass/useCompassFeed';
import { CompassFeedbackMenu } from '../compass/CompassFeedbackMenu';
import { CompassWhySheet } from '../compass/CompassWhySheet';
import { postCompassFrontloadEvent } from '../../services/compass';

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
  contextMode?: import('../../services/discovery').DiscoveryContextMode | null;
}

type ForYouItem =
  | { kind: 'telegraph'; rec: TelegraphRecommendation; place: DiscoveryPlace }
  | { kind: 'osm'; place: DiscoveryPlace }
  | { kind: 'compass'; item: import('../../services/compass').CompassFeedItem; place: DiscoveryPlace };

function compassItemToPlace(item: import('../../services/compass').CompassFeedItem): DiscoveryPlace {
  return {
    id:           item.id,
    name:         item.title ?? item.type,
    category:     'for_you',
    type:         item.category ?? null,
    description:  (item.data?.description as string) ?? null,
    distanceKm:   null,
    lat:          null,
    lng:          null,
    tags:         [],
    address:      (item.data?.city as string) ?? null,
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       null,
    isOpenNow:    null,
  };
}

export function ForYouTab({ destination, onAddToPlan, contextMode }: ForYouTabProps) {
  const { isAuthed }            = useSession();
  const [items, setItems]       = useState<ForYouItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource]     = useState<'compass' | 'telegraph' | 'osm' | 'none'>('none');
  const [detail, setDetail]     = useState<DiscoveryPlace | null>(null);
  const [shareItem, setShareItem] = useState<ForYouItem | null>(null);

  // Why sheet state
  const [whyId, setWhyId]         = useState<string | null>(null);
  const [whySheetOpen, setWhySheetOpen] = useState(false);
  // Dismissed item ids (optimistic hide for "not interested")
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // "Show more" tagged items
  const [showMoreIds, setShowMoreIds] = useState<Set<string>>(new Set());

  // Compass feed — runs in background alongside OSM/Telegraph
  const compass = useCompassFeed({ section: 'for_you', city: destination, enabled: isAuthed });

  const handleWhyPress = (id: string) => {
    setWhyId(id);
    setWhySheetOpen(true);
  };

  // Post a navigation learning event when this tab comes into focus, and
  // silently background-refresh the Compass feed so data stays fresh.
  useFocusEffect(
    useCallback(() => {
      postCompassFrontloadEvent({
        eventType: 'navigation',
        screen: 'discovery_for_you',
        city: destination ?? undefined,
      }).catch(() => {});
      compass.refresh?.();
    }, [destination, compass.refresh]),
  );

  const community = useCommunityDiscovery(destination ?? null);

  // Monotonically-increasing counter so stale async callbacks from an old
  // load() call can detect they've been superseded and bail out safely.
  const loadIdRef = React.useRef(0);

  // When the Compass feed resolves with enabled items, silently upgrade the feed
  // to Compass source — runs independently of load() so it never wipes existing
  // OSM/Telegraph content; only upgrades when Compass data is present and enabled.
  useEffect(() => {
    if (!compass.data || !compass.compassEnabled) return;
    const compassItems = (compass.data.sections ?? []).flatMap((s) => s.items ?? []);
    const safeItems = compass.data.safeItems ?? [];
    const all = compassItems.length > 0 ? compassItems : safeItems;
    if (all.length > 0) {
      setItems(all.map((ci) => ({ kind: 'compass' as const, item: ci, place: compassItemToPlace(ci) })));
      setSource('compass');
      setLoading(false);
      setRefreshing(false);
    }
  }, [compass.data, compass.compassEnabled]);

  // load() always fetches OSM + Telegraph as the reliable baseline.
  // The Compass useEffect above upgrades items asynchronously when Compass
  // data resolves — no short-circuiting inside load() based on Compass state,
  // so OSM fallback always runs regardless of whether Compass is enabled/disabled.
  const load = useCallback(async (isRefresh = false) => {
    if (!destination) return;
    const myId = ++loadIdRef.current;
    const stale = () => loadIdRef.current !== myId;

    if (!isRefresh) setLoading(true);

    // Fire OSM and Telegraph simultaneously as baseline content.
    // Compass data (if enabled) will upgrade items via its own useEffect.
    const osmPromise = getDiscoveryPlaces(destination, 'for_you', { radiusKm: 25, openNow: false, minRating: null }, 1, contextMode);
    const telPromise = isAuthed
      ? getForYouRecommendations({ destination, count: 5 })
      : null;

    // Show OSM content the instant it resolves — clears skeleton immediately.
    osmPromise.then((osm) => {
      if (stale()) return;
      setLoading(false);
      setRefreshing(false);
      setItems((prev) => {
        // Don't overwrite if Compass has already upgraded the feed.
        if (prev.some((i) => i.kind === 'compass')) return prev;
        if (osm.ok && osm.data.places.length > 0) {
          setSource('osm');
          return osm.data.places.slice(0, 15).map((p) => ({ kind: 'osm' as const, place: p }));
        }
        setSource('none');
        return [];
      });
    }).catch(() => {
      if (!stale()) { setLoading(false); setRefreshing(false); }
    });

    // Silently upgrade to Telegraph AI picks when (if) the AI call returns.
    if (telPromise) {
      try {
        const tel = await telPromise;
        if (!stale() && tel.ok && tel.recommendations.length > 0) {
          setItems((prev) => {
            if (prev.some((i) => i.kind === 'compass')) return prev;
            setSource('telegraph');
            return tel.recommendations.map((rec) => ({
              kind: 'telegraph' as const,
              rec,
              place: recToPlace(rec),
            }));
          });
        }
      } catch {
        // telegraph failed — OSM is already showing, nothing to do
      }
      if (!stale()) { setLoading(false); setRefreshing(false); }
    }
  }, [destination, isAuthed]);

  // Reset state and start loading when destination or auth changes.
  // load() identity only changes with destination/isAuthed, so this effect
  // fires exactly when the user switches city or logs in/out.
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
            {source === 'compass'
              ? 'Compass picks · personalised for you'
              : source === 'telegraph'
              ? 'Personalised picks · powered by Telegraph AI'
              : source === 'osm'
              ? 'Popular spots from OpenStreetMap · sign in for personalised picks'
              : 'Curated picks'}
          </Text>
        </View>

        {items.filter((item) => !dismissed.has(item.place.id)).map((item) => {
          const isShowMore = showMoreIds.has(item.place.id);
          return (
            <View key={item.place.id} style={isShowMore ? styles.showMoreHighlight : undefined}>
              {/* Reason banner — Compass items or Telegraph cards */}
              {item.kind === 'compass' ? (
                <View style={styles.reasonBanner}>
                  <Info size={11} color={color.signal} />
                  <Text style={styles.reasonText} numberOfLines={2}>
                    {item.item.explanationKey
                      ? 'Recommended based on your preferences'
                      : 'Personalised pick for you'}
                  </Text>
                  <CompassFeedbackMenu
                    recommendationId={item.item.recommendationToken ?? item.item.id}
                    itemType={item.item.type}
                    category={item.item.category}
                    onWhyPress={() => handleWhyPress(item.item.recommendationToken ?? item.item.id)}
                    onDismiss={() => setDismissed((prev) => { const s = new Set(prev); s.add(item.place.id); return s; })}
                    onTagShowMore={() => setShowMoreIds((prev) => { const s = new Set(prev); s.add(item.place.id); return s; })}
                  />
                </View>
              ) : item.kind === 'telegraph' && item.rec.reason ? (
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

              {/* Bottom row: Send to Telegraph + non-compass feedback menu */}
              <View style={styles.shareRow}>
                <Pressable
                  style={styles.shareBtn}
                  onPress={() => setShareItem(item)}
                >
                  <Share2 size={12} color={color.mute} />
                  <Text style={styles.shareLabel}>Send to Telegraph</Text>
                </Pressable>
                {item.kind !== 'compass' && isAuthed && (
                  <CompassFeedbackMenu
                    recommendationId={item.place.id}
                    itemType="place"
                    category={item.place.category ?? undefined}
                    onDismiss={() => setDismissed((prev) => { const s = new Set(prev); s.add(item.place.id); return s; })}
                    onTagShowMore={() => setShowMoreIds((prev) => { const s = new Set(prev); s.add(item.place.id); return s; })}
                  />
                )}
              </View>
            </View>
          );
        })}

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

      {/* Discovery share sheet */}
      <DiscoveryShareSheet
        visible={shareItem !== null}
        item={shareItem ? buildSharePayload(shareItem) : null}
        onClose={() => setShareItem(null)}
      />

      {/* "Why am I seeing this?" sheet — Compass explanations */}
      <CompassWhySheet
        visible={whySheetOpen}
        recommendationId={whyId}
        onClose={() => { setWhySheetOpen(false); setWhyId(null); }}
      />
    </>
  );
}

function buildSharePayload(item: ForYouItem): DiscoverySharePayload {
  if (item.kind === 'telegraph') {
    return {
      sourceId: item.rec.id,
      sourceType: 'for_you',
      title: item.rec.title,
      category: item.rec.category ?? 'for_you',
      city: item.rec.locationContext ?? '',
      blurb: item.rec.reason,
    };
  }
  if (item.kind === 'compass') {
    return {
      sourceId: item.item.id,
      sourceType: 'for_you',
      title: item.item.title ?? item.item.type,
      category: item.item.category ?? 'for_you',
      city: (item.item.data?.city as string) ?? '',
      blurb: undefined,
    };
  }
  return {
    sourceId: item.place.id,
    sourceType: 'place',
    title: item.place.name,
    category: item.place.category ?? 'place',
    city: item.place.address ?? '',
    blurb: item.place.description ?? undefined,
  };
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
  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
    marginTop: -StyleSheet.hairlineWidth,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  shareLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  showMoreHighlight: {
    borderWidth: 1,
    borderColor: color.signal + '30',
    borderRadius: radius.md,
    marginHorizontal: space.lg,
    overflow: 'hidden',
    marginBottom: space.sm,
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
