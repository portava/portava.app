/**
 * For You tab — Compass-powered recommendations with OSM fallback.
 *
 * Primary source: Compass feed (when enabled). Falls back to OSM when
 * compassEnabled is false. Uses PlaceCard for full interaction parity.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Sparkles, Info, Share2 } from 'lucide-react-native';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet';
import type { DiscoveryPlace } from '../../services/discovery';
import { getDiscoveryPlaces, getSavedPlaceIds } from '../../services/discovery';
import { PlaceSkeletonList } from './PlaceSkeleton';
import PlaceCard from './PlaceCard';
import { PlaceDetailSheet } from './PlaceDetailSheet';
import { DiscoveryMapView } from './DiscoveryMapView';
import { color, space, radius, type as t } from '../../theme/tokens';
import { useSession } from '../../context/SessionContext';
import { useCommunityDiscovery } from '../../hooks/useCommunityDiscovery';
import { HiddenGemsSection, TravelerPicksSection, prefillSavedPlaceIds } from '../DiscoveryWall';
import type { RouteStopDraft } from '../RouteBuilderSheet';
import { useCompassFeed } from '../../hooks/compass/useCompassFeed';
import { CompassFeedbackMenu } from '../compass/CompassFeedbackMenu';
import { CompassWhySheet } from '../compass/CompassWhySheet';
import { postCompassFrontloadEvent } from '../../services/compass';
import { CompassTravelerRow } from '../compass/CompassTravelerRow';

// ── Main component ────────────────────────────────────────────────────────────

interface ForYouTabProps {
  destination: string;
  onAddToPlan: (item: { id: string; name: string; category: string; address?: string | null }) => void;
  onAddToRoute?: (draft: RouteStopDraft) => void;
  contextMode?: import('../../services/discovery').DiscoveryContextMode | null;
  lat?: number | null;
  lng?: number | null;
  userLat?: number | null;
  userLng?: number | null;
  fallbackZoom?: number;
  viewMode?: 'list' | 'map';
  sortBy?: string | null;
}

type ForYouItem =
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

export function ForYouTab({ destination, onAddToPlan, onAddToRoute, contextMode, lat, lng, userLat, userLng, fallbackZoom, viewMode = 'list', sortBy }: ForYouTabProps) {
  const { isAuthed }            = useSession();
  const [items, setItems]       = useState<ForYouItem[]>([]);
  const [loading, setLoading]   = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource]     = useState<'compass' | 'osm' | 'none'>('none');
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

  // Pre-populate the module-level savedPlaceIds set so returning users see
  // filled bookmarks for places they saved in previous sessions.
  // Fire-and-forget — no UI dependency; runs once when the user is signed in.
  useEffect(() => {
    if (!isAuthed) return;
    getSavedPlaceIds().then(prefillSavedPlaceIds).catch(() => {});
  }, [isAuthed]);

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

  const community = useCommunityDiscovery(destination ?? null, sortBy);

  // All OSM/Compass items + community places unified for DiscoveryMapView.
  const mapPlaces = useMemo<DiscoveryPlace[]>(() => {
    const osmPlaces = items.map((i) => i.place);
    // Community places already in DiscoveryPlace shape; DiscoveryMapView
    // filters out those without lat/lng so nulls are safe.
    return [...osmPlaces, ...community.places];
  }, [items, community.places]);

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

    // Fire OSM as baseline. Compass upgrades items via its own useEffect when enabled.
    const osmPromise = getDiscoveryPlaces(destination, 'for_you', { radiusKm: 25, openNow: false, minRating: null }, 1, contextMode, null, null, null, lat, lng);

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

  if (viewMode === 'map') {
    return (
      <>
        <DiscoveryMapView
          key={destination}
          places={mapPlaces}
          onSelectPlace={(p) => {
            // Strip "comm/" prefix so PlaceDetailSheet uses the bare UUID
            // for save/bookmark calls — the prefix only exists for map rendering.
            const id = p.id.startsWith('comm/') ? p.id.slice(5) : p.id;
            setDetail(id === p.id ? p : { ...p, id });
          }}
          fallbackLat={lat}
          fallbackLng={lng}
          userLat={userLat}
          userLng={userLng}
          fallbackZoom={fallbackZoom}
        />
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
              : source === 'osm'
              ? 'Popular spots · sign in for personalised picks'
              : 'Curated picks'}
          </Text>
        </View>

        {/* Compass traveler matches — people section */}
        <CompassTravelerRow city={destination} limit={6} />

        {items.filter((item) => !dismissed.has(item.place.id)).map((item) => {
          const isShowMore = showMoreIds.has(item.place.id);
          return (
            <View key={item.place.id} style={isShowMore ? styles.showMoreHighlight : undefined}>
              {/* Reason banner — Compass items only */}
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
                onAddToRoute={onAddToRoute ? () => onAddToRoute({
                  id:         `place-${item.place.id}`,
                  title:      item.place.name,
                  lat:        item.place.lat ?? null,
                  lng:        item.place.lng ?? null,
                  sourceType: 'discovery',
                  sourceId:   item.place.id,
                  category:   item.place.category ?? null,
                }) : undefined}
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
        {community.loading && community.gems.length === 0 && community.picks.length === 0 && (
          <View style={styles.communitySection}>
            <PlaceSkeletonList count={2} />
          </View>
        )}
        {community.gems.length > 0 && (
          <View style={styles.communitySection}>
            <HiddenGemsSection gems={community.gems} onAddToRoute={onAddToRoute} />
          </View>
        )}
        {community.picks.length > 0 && (
          <View style={styles.communitySection}>
            <TravelerPicksSection picks={community.picks} onAddToRoute={onAddToRoute} />
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
