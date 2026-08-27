/**
 * For You tab — Compass-powered recommendations with OSM fallback.
 *
 * Primary source: Compass feed (when enabled). Falls back to OSM when
 * compassEnabled is false. Uses PlaceCard for full interaction parity.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, RefreshControl, Pressable,
  TextInput, Modal, Platform,
} from 'react-native';
import { KeyboardSafeScrollView } from '../ui/KeyboardSafeView.tsx';
import { useFocusEffect } from 'expo-router';
import { Sparkles, Info, Navigation, X } from 'lucide-react-native';
import { TelegraphSendIcon } from '../icons/TelegraphSendIcon.tsx';
import { DiscoveryShareSheet } from '../DiscoveryShareSheet.tsx';
import type { DiscoverySharePayload } from '../DiscoveryShareSheet.tsx';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { getDiscoveryPlaces, getSavedPlaceIds, getCachedDiscoveryPlaces } from '../../services/discovery.ts';
import { PlaceSkeletonList } from './PlaceSkeleton.tsx';
import PlaceCard from './PlaceCard.tsx';
import { PlaceDetailSheet } from './PlaceDetailSheet.tsx';
import { DiscoveryMapView } from './DiscoveryMapView';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useSession } from '../../context/SessionContext.tsx';
import { useCommunityDiscovery } from '../../hooks/useCommunityDiscovery.ts';
import { HiddenGemsSection, TravelerPicksSection, prefillSavedPlaceIds } from '../DiscoveryWall.tsx';
import type { RouteStopDraft } from '../RouteBuilderSheet.tsx';
import { useCompassFeed } from '../../hooks/compass/useCompassFeed.ts';
import { CompassFeedbackMenu } from '../compass/CompassFeedbackMenu.tsx';
import { resolveCompassTitle } from '../../utils/compassFormat.ts';
import { CompassWhySheet } from '../compass/CompassWhySheet.tsx';
import { postCompassFrontloadEvent, postCompassContext } from '../../services/compass.ts';
import { CompassPicksSection } from '../compass/CompassPicksSection.tsx';
import { CompassTravelerRow } from '../compass/CompassTravelerRow.tsx';
import { CompassOnboardingCard } from '../compass/CompassOnboardingCard.tsx';

// ── Main component ────────────────────────────────────────────────────────────

interface ForYouTabProps {
  destination: string;
  onAddToPlan: (item: { id: string; name: string; category: string; address?: string | null }) => void;
  onAddToRoute?: (draft: RouteStopDraft) => void;
  contextMode?: import('../../services/discovery.ts').DiscoveryContextMode | null;
  lat?: number | null;
  lng?: number | null;
  userLat?: number | null;
  userLng?: number | null;
  fallbackZoom?: number;
  viewMode?: 'list' | 'map';
  sortBy?: string | null;
  /** Height of the Discover screen's floating chrome (tab bar + filters + banner) so the list starts below it. */
  listTopInset?: number;
  bottomInset?: number;
  /** Called when the user pulls to refresh, after the re-fetch is initiated. */
  onRefresh?: () => void;
}

type ForYouItem =
  | { kind: 'osm'; place: DiscoveryPlace }
  | { kind: 'compass'; item: import('../../services/compass.ts').CompassFeedItem; place: DiscoveryPlace };

function compassItemToPlace(item: import('../../services/compass.ts').CompassFeedItem): DiscoveryPlace {
  return {
    id:           item.id,
    name:         resolveCompassTitle(item),
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

export function ForYouTab({ destination, onAddToPlan, onAddToRoute, contextMode, lat, lng, userLat, userLng, fallbackZoom, viewMode = 'list', sortBy, listTopInset, bottomInset, onRefresh }: ForYouTabProps) {
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

  // Compass city switcher — Compass-local context (does not update profile city)
  const [compassCity, setCompassCity]               = useState<string | null>(null);
  const [citySwitcherOpen, setCitySwitcherOpen]     = useState(false);
  const [citySwitcherInput, setCitySwitcherInput]   = useState('');

  // Why sheet state
  const [whyId, setWhyId]         = useState<string | null>(null);
  const [whySheetOpen, setWhySheetOpen] = useState(false);
  // Dismissed item ids (optimistic hide for "not interested")
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // "Show more" tagged items
  const [showMoreIds, setShowMoreIds] = useState<Set<string>>(new Set());

  const handleCompassCityConfirm = useCallback(() => {
    const city = citySwitcherInput.trim();
    if (!city) { setCitySwitcherOpen(false); return; }
    setCompassCity(city);
    setCitySwitcherOpen(false);
    // Persist the override as a Compass context update (fire-and-forget)
    postCompassContext({ city }).catch(() => {});
  }, [citySwitcherInput]);

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

    // Pass user's actual coords as separate userLat/userLng params when sortBy=nearest.
    // lat/lng always remain the destination coords — Overpass query centre must not use user position.
    const nearestUserLat = sortBy === 'nearest' ? userLat : null;
    const nearestUserLng = sortBy === 'nearest' ? userLng : null;

    // Fire OSM as baseline. Compass upgrades items via its own useEffect when enabled.
    const osmPromise = getDiscoveryPlaces(
      destination, 'for_you',
      { radiusKm: 25, openNow: false, minRating: null, sortBy: sortBy ?? null },
      1, contextMode, null, null, null, lat, lng, nearestUserLat, nearestUserLng,
    );

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

  }, [destination, isAuthed, sortBy, lat, lng, userLat, userLng, contextMode]);

  // Reset state and start loading when destination, auth, or sort/coord changes.
  // load() identity changes when any dependency changes, so this effect fires
  // when the user switches city, logs in/out, or changes the sort filter.
  // SWR: immediately hydrate with the cache for the active destination so that
  // city switches never show content from the previous city while loading.
  useEffect(() => {
    // Preserve an active Compass-personalized feed across a sort/filter change.
    // The Compass upgrade effect keys on compass.data, which a sort switch does
    // NOT change, so it will not re-personalize — wiping to OSM here would
    // silently drop personalization until the next Compass fetch. When Compass is
    // active we keep the current items and just refresh the OSM baseline in the
    // background (load() won't overwrite Compass items — see the guard in load()).
    const compassActive = Boolean(
      compass?.compassEnabled && compass?.data &&
      (((compass.data.sections ?? []).some((s: any) => (s.items ?? []).length > 0)) ||
        (compass.data.safeItems ?? []).length > 0),
    );
    if (!compassActive) {
      const cachedResult = destination
        ? getCachedDiscoveryPlaces(destination, 'for_you', 25, 1)
        : null;
      if (cachedResult) {
        setItems(cachedResult.places.slice(0, 15).map((p) => ({ kind: 'osm' as const, place: p })));
        setLoading(false);
      } else {
        setItems([]);
      }
      setSource('none');
      load(cachedResult !== null); // isRefresh=true when cache hit → no skeleton
    } else {
      load(true); // keep personalized items; refresh OSM baseline without a skeleton
    }
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    setRefreshing(true);
    load(true);
    onRefresh?.();
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
          city={destination}
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
        testID="main-scroll"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.list, listTopInset ? { paddingTop: listTopInset + space.md } : null]}
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
              ? (isAuthed ? 'Popular spots' : 'Popular spots · sign in for personalised picks')
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

        {/* ── Compass Onboarding Card — shown once for new users ──
            Card is self-managing: it checks onboarding_completed on mount
            and hides itself when already done. Gate is auth-only. */}
        {isAuthed && <CompassOnboardingCard />}

        {/* ── Compass Picks section — horizontal card strip ── */}
        <CompassPicksSection
          city={destination}
          compassCity={compassCity}
          enabled={isAuthed}
          onSwitchCity={() => {
            setCitySwitcherInput(compassCity ?? destination ?? '');
            setCitySwitcherOpen(true);
          }}
        />

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

      {/* ── Compass city switcher modal ── */}
      <Modal
        visible={citySwitcherOpen}
        transparent
        animationType={Platform.OS === 'android' ? 'fade' : 'slide'}
        onRequestClose={() => setCitySwitcherOpen(false)}
      >
        <KeyboardSafeScrollView style={styles.citySwitcherBackdrop}>
          <Pressable style={{ flex: 1 }} onPress={() => setCitySwitcherOpen(false)} />
          <View style={styles.citySwitcherSheet}>
            <View style={styles.citySwitcherHandle} />
            <Text style={styles.citySwitcherTitle}>Change Compass City</Text>
            <Text style={styles.citySwitcherSub}>
              Compass Picks will reload for this city. Your profile city stays the same.
            </Text>
            <View style={styles.citySwitcherInputRow}>
              <Navigation size={14} color={color.mute} />
              <TextInput
                style={styles.citySwitcherInput}
                value={citySwitcherInput}
                onChangeText={setCitySwitcherInput}
                placeholder="Enter a city name…"
                placeholderTextColor={color.faint}
                autoFocus
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleCompassCityConfirm}
              />
              {citySwitcherInput.length > 0 && (
                <Pressable onPress={() => setCitySwitcherInput('')} hitSlop={8}>
                  <X size={14} color={color.mute} />
                </Pressable>
              )}
            </View>
            <Pressable
              style={[styles.citySwitcherConfirm, !citySwitcherInput.trim() && { opacity: 0.4 }]}
              onPress={handleCompassCityConfirm}
              disabled={!citySwitcherInput.trim()}
            >
              <Text style={styles.citySwitcherConfirmText}>Show Compass Picks</Text>
            </Pressable>
          </View>
        </KeyboardSafeScrollView>
      </Modal>
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
  // ── City switcher modal ──────────────────────────────────────────────────
  citySwitcherBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  citySwitcherSheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 36,
    gap: space.md,
  },
  citySwitcherHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
  },
  citySwitcherTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  citySwitcherSub: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
  citySwitcherInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
    borderWidth: 1.5,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  citySwitcherInput: {
    flex: 1,
    ...t.body,
    color: color.ink,
    padding: 0,
  },
  citySwitcherConfirm: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  citySwitcherConfirmText: {
    ...t.bodyStrong,
    color: '#fff',
    fontSize: 15,
  },
});

export default ForYouTab;
