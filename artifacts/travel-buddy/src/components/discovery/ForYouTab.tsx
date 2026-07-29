/**
 * For You tab — Compass-powered recommendations with OSM fallback.
 *
 * Primary source: Compass feed (when enabled). Falls back to OSM when
 * compassEnabled is false. Uses PlaceCard for full interaction parity.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, RefreshControl, Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Sparkles, Info } from 'lucide-react-native';
import { TelegraphSendIcon } from '../icons/TelegraphSendIcon.tsx';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet.tsx';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { getDiscoveryPlaces, getSavedPlaceIds, getCachedDiscoveryPlaces } from '../../services/discovery.ts';
import { PlaceSkeletonList } from './PlaceSkeleton.tsx';
import PlaceCard from './PlaceCard.tsx';
import { PlaceDetailSheet } from './PlaceDetailSheet.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useSession } from '../../context/SessionContext.tsx';
import { useCommunityDiscovery } from '../../hooks/useCommunityDiscovery.ts';
import { HiddenGemsSection, TravelerPicksSection, prefillSavedPlaceIds } from '../DiscoveryWall.tsx';
import type { RouteStopDraft } from '../RouteBuilderSheet.tsx';
import { useCompassFeed } from '../../hooks/compass/useCompassFeed.ts';
import { CompassFeedbackMenu } from '../compass/CompassFeedbackMenu.tsx';
import { resolveCompassTitle } from '../../utils/compassFormat.ts';
import { CompassWhySheet } from '../compass/CompassWhySheet.tsx';
import { postCompassFrontloadEvent, reportCompassViewed } from '../../services/compass.ts';
import { CompassTravelerRow } from '../compass/CompassTravelerRow.tsx';

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
  sortBy?: string | null;
  bottomInset?: number;
  /** Reanimated scroll handler forwarded from the parent discovery screen. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onScroll?: any;
  /** Shared header element from the parent discovery screen — scrolls inside this tab's FlatList. */
  listHeaderComponent?: React.ReactElement;
}

type ForYouItem =
  | { kind: 'osm'; place: DiscoveryPlace }
  | { kind: 'compass'; item: import('../../services/compass').CompassFeedItem; place: DiscoveryPlace };

function compassItemToPlace(item: import('../../services/compass').CompassFeedItem): DiscoveryPlace {
  // Real coordinates/photo come from discovery_places / events (server-side
  // hydrator) — surface them instead of fabricating null. Never invent a
  // fallback location: a card without real lat/lng must render honestly
  // (no Directions button, no distance claim) rather than defaulting to the
  // viewer's own position, which produced bogus cross-city directions links.
  const rawLat = item.data?.lat;
  const rawLng = item.data?.lng;
  const lat = typeof rawLat === 'number' ? rawLat : null;
  const lng = typeof rawLng === 'number' ? rawLng : null;
  const locationName = (item.data?.locationName as string) ?? null;
  const isEvent = item.type === 'event';
  return {
    id:           item.id,
    name:         resolveCompassTitle(item),
    category:     'for_you',
    type:         item.category ?? null,
    description:  (item.data?.description as string) ?? null,
    distanceKm:   null,
    lat,
    lng,
    tags:         [],
    address:      locationName ?? (item.data?.city as string) ?? null,
    // Events are activities hosted by a member, not venues — they never have
    // a phone/website/hours/rating, so never fabricate those fields.
    website:      null,
    phone:        null,
    openingHours: null,
    rating:       null,
    isOpenNow:    null,
    headerImageUrl: (item.data?.headerImageUrl as string) ?? null,
    // Flag consumed by PlaceCard/PlaceDetailSheet to present this honestly as
    // an event (RSVP-based activity) rather than a resolved venue.
    isCompassEvent: isEvent,
  } as DiscoveryPlace;
}

export function ForYouTab({ destination, onAddToPlan, onAddToRoute, contextMode, lat, lng, userLat, userLng, sortBy, bottomInset, onScroll, listHeaderComponent }: ForYouTabProps) {
  const { isAuthed }            = useSession();
  // SWR: seed from in-memory client cache so second opens paint instantly.
  const [items, setItems]       = useState<ForYouItem[]>(() => {
    if (!destination) return [];
    const cached = getCachedDiscoveryPlaces(destination, 'for_you', 25, 1);
    return cached?.places.slice(0, 15).map((p) => ({ kind: 'osm' as const, place: p })) ?? [];
  });
  const [loading, setLoading]   = useState<boolean>(() => {
    if (!destination) return false;
    return getCachedDiscoveryPlaces(destination, 'for_you', 25, 1) === null;
  });
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

  // Monotonically-increasing counter so stale async callbacks from an old
  // load() call can detect they've been superseded and bail out safely.
  const loadIdRef = React.useRef(0);

  // When the Compass feed resolves with enabled items, silently upgrade the feed
  // to Compass source — runs independently of load() so it never wipes existing
  // OSM/Telegraph content; only upgrades when Compass data is present and enabled.
  //
  // lastCompassDataRef guards against re-processing the same feed object: the
  // effect's setItems/setSource/setLoading calls re-render this component, and
  // without the ref an unstable compassEnabled toggle could re-fire the effect
  // in a loop. Only a materially new compass.data reference triggers an upgrade.
  const lastCompassDataRef = useRef<typeof compass.data>(null);
  useEffect(() => {
    if (!compass.data || !compass.compassEnabled) return;
    if (lastCompassDataRef.current === compass.data) return;
    lastCompassDataRef.current = compass.data;
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
        // Normalize at the boundary: missing/invalid array → [].
        const places = osm.ok && Array.isArray(osm.data?.places) ? osm.data.places : [];
        if (places.length > 0) {
          setSource('osm');
          return places.slice(0, 15).map((p) => ({ kind: 'osm' as const, place: p }));
        }
        setSource('none');
        return [];
      });
    }).catch(() => {
      if (!stale()) { setLoading(false); setRefreshing(false); }
    });

  }, [destination, isAuthed]);

  // Reset state and start loading when destination or auth changes.
  // SWR: immediately hydrate with the cache for the active destination so that
  // city switches never show content from the previous city while loading.
  useEffect(() => {
    const cachedResult = destination
      ? getCachedDiscoveryPlaces(destination, 'for_you', 25, 1)
      : null;
    if (cachedResult) {
      // Seed with this destination's cache instantly; network update follows.
      setItems(cachedResult.places.slice(0, 15).map((p) => ({ kind: 'osm' as const, place: p })));
      setLoading(false);
    } else {
      setItems([]);
    }
    setSource('none');
    load(cachedResult !== null); // isRefresh=true when cache hit → no skeleton
  }, [destination, isAuthed, load]);

  const handleRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  // ── Hooks hoisted before early returns ──────────────────────────────────────
  // All useMemo/useCallback calls MUST appear before any conditional return.
  // Placing them after the "loading && items.length === 0" early return caused
  // "Rendered fewer hooks than expected" whenever a city switch triggered
  // setItems([]) + setLoading(true) after items had already loaded.

  // Virtualized list data — pre-filtered to exclude dismissed items.
  const listData = useMemo(
    () => items.filter((item) => !dismissed.has(item.place.id)),
    [items, dismissed],
  );

  // Stable header: source label + compass traveler row.
  // useMemo prevents the header from re-mounting on every parent re-render,
  // which would cause CompassTravelerRow to reset its own state.
  const listHeader = useMemo(() => (
    <View>
      <View style={styles.sourceRow}>
        <Sparkles size={13} color={color.signal} />
        <Text style={styles.sourceLabel}>
          {source === 'compass'
            ? 'Compass picks · personalised for you'
            : source === 'osm'
            ? (isAuthed ? 'Popular spots' : 'Popular spots · sign in for personalised picks')
            : 'Curated picks'}
        </Text>
      </View>
      <CompassTravelerRow city={destination} limit={6} />
    </View>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [source, destination, isAuthed]);

  // Combined header: discovery header (from parent) + source label + traveler row.
  // The discovery header is included inline rather than memoised; it changes whenever
  // the parent screen state changes, which is the intended behaviour.
  const combinedHeader = listHeaderComponent ? (
    <View>{listHeaderComponent}{listHeader}</View>
  ) : listHeader;

  // Stable footer: community sections rendered below the virtualized items.
  const listFooter = useMemo(() => (
    <View>
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
    </View>
  ), [community, onAddToRoute]);

  // renderItem is memoized to prevent FlatList from re-rendering all visible
  // rows on unrelated state changes (e.g. community data arriving).
  // NOTE: defined here (before early returns) to keep hook count stable.
  const renderItem = useCallback(({ item }: { item: ForYouItem }) => {
    const isShowMore = showMoreIds.has(item.place.id);
    return (
      <View style={isShowMore ? styles.showMoreHighlight : undefined}>
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
          city={destination}
          onPress={() => {
            if (item.kind === 'compass') {
              // Fire-and-forget "viewed" outcome — the card was actually opened.
              reportCompassViewed(item.item.recommendationToken, item.item.id);
            }
            setDetail(item.place);
          }}
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
          <Pressable style={styles.shareBtn} onPress={() => setShareItem(item)}>
            <TelegraphSendIcon size={12} color={color.mute} />
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
  }, [showMoreIds, onAddToPlan, onAddToRoute, isAuthed, handleWhyPress, destination]);

  // ── Early returns (after all hooks) ─────────────────────────────────────────
  if (!destination) return (
    listHeaderComponent ? <View style={{ flex: 1 }}>{listHeaderComponent}</View> : null
  );

  if (loading && items.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {listHeaderComponent}
        <PlaceSkeletonList count={5} />
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={listData}
        keyExtractor={(item) => item.place.id}
        renderItem={renderItem}
        ListHeaderComponent={combinedHeader}
        ListEmptyComponent={
          source === 'none' ? (
            <View style={styles.empty}>
              <Sparkles size={28} color={color.faint} />
              <Text style={styles.emptyTitle}>No recommendations yet</Text>
              <Text style={styles.emptyDesc}>
                {isAuthed
                  ? `Couldn't load recommendations for ${destination}. Pull to refresh.`
                  : `Sign in to get personalised picks for ${destination}.`}
              </Text>
            </View>
          ) : null
        }
        ListFooterComponent={listFooter}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.list, bottomInset != null ? { paddingBottom: bottomInset } : undefined]}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={color.signal} />
        }
        initialNumToRender={5}
        maxToRenderPerBatch={5}
        windowSize={7}
        removeClippedSubviews
      />

      {/* Full-parity detail sheet (same as OSM tabs) */}
      <PlaceDetailSheet
        place={detail}
        city={destination}
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
    paddingBottom: 130,
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
