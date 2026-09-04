/**
 * Place detail screen — /place/[id]
 *
 * Two rendering paths:
 *
 * 1. Canonical places (external_places_enabled flag ON, canonical UUID):
 *    Fetches the canonical place envelope from the API and renders PlaceCard
 *    plus the standard MapEntityActionRow and a report button.
 *
 * 2. Discovery places (OSM / db-style IDs from the map layer):
 *    getCanonicalPlace returns null for non-canonical IDs. The caller encodes
 *    the DiscoveryPlace payload as `placeJson` in the URL so this screen can
 *    render a full detail view without a second network round-trip.
 *    Falls back to "Place not available" only when neither source has data.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Linking,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { firstParam } from '../../src/lib/routeParams.ts';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Flag, MapPin, Globe, Phone, Tag, Bookmark, Navigation, Clock, Star, ListPlus, Bell } from 'lucide-react-native';
import { color, space, radius, type as t, avatar, dot } from '../../src/theme/tokens';
import { getCanonicalPlace, getPlaceLiving } from '../../src/services/places';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { PlaceCard } from '../../src/components/place/PlaceCard';
import { PlaceInfoSection } from '../../src/components/place/PlaceInfoSection';
import { PlaceReportSheet } from '../../src/components/PlaceReportSheet';
import { MapEntityActionRow } from '../../src/components/map/MapEntityActionRow';
import { PlainBottomFiller } from '../../src/hooks/useBottomInset';
import { TripWishlistPicker } from '../../src/components/discovery/TripWishlistPicker';
import { checkSaved, toggleSave } from '../../src/services/collections';
import { freshToken as freshApiToken } from '../../src/services/apiToken';
import { getPlaceLiveStatus } from '../../src/services/discovery';
import { categoryColor } from '../../src/components/discovery/PlaceCard';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { WorthItVoteRow } from '../../src/components/WorthItVoteRow';
import { useSession } from '../../src/context/SessionContext';
import { LivingDestinationPage } from '../../src/components/place/living/LivingDestinationPage';
import { RequestAViewPrompt } from '../../src/features/media/components/RequestAViewPrompt';
import type { CanonicalPlace } from '../../src/types/canonicalPlace';
import type { MapEntity } from '../../src/types/mapTypes';
import type { DiscoveryPlace, PlaceLiveStatus } from '../../src/services/discovery';
import type { PlaceLivingResponse } from '../../src/types/placeLiving';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a synthetic MapEntity from the canonical place envelope so
 * MapEntityActionRow can render Save · Directions · Add to Trip · Share.
 */
function buildMapEntity(place: CanonicalPlace): MapEntity {
  return {
    id:   place.id,
    type: 'places',
    lat:  place.coordinates.lat,
    lng:  place.coordinates.lng,
    payload: {
      id:       place.id,
      name:     place.name,
      category: place.category,
      address:  place.address,
      city:     place.city,
      lat:      place.coordinates.lat,
      lng:      place.coordinates.lng,
      rating:   place.rating ?? null,
    },
    detailRoute: place.detailRoute,
    actionCapabilities: ['save', 'directions', 'add_to_trip', 'share'],
  };
}

/** Parse placeJson query param into a DiscoveryPlace, or return null. */
function parsePlaceJson(raw: string | string[] | undefined): DiscoveryPlace | null {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str) return null;
  try {
    return JSON.parse(decodeURIComponent(str)) as DiscoveryPlace;
  } catch {
    return null;
  }
}

// ── Discovery-place fallback view ─────────────────────────────────────────────

function DiscoveryFallback({ place, city }: { place: DiscoveryPlace; city: string | null }) {
  const [saved, setSaved] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [liveStatus, setLiveStatus] = useState<PlaceLiveStatus | null>(null);

  useEffect(() => {
    checkSaved('place', place.id)
      .then(({ saved: s }) => setSaved(s))
      .catch(() => {});
  }, [place.id]);

  useEffect(() => {
    setLiveStatus(null);
    let cancelled = false;
    getPlaceLiveStatus(place.name, city)
      .then((ls) => { if (!cancelled) setLiveStatus(ls); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [place.id, city]);

  const liveOpenNow: boolean | null =
    liveStatus?.available && typeof liveStatus.openNow === 'boolean'
      ? liveStatus.openNow
      : null;

  const accent = categoryColor(place.category);

  const openMap = () => {
    if (place.lat != null && place.lng != null) {
      Linking.openURL(
        `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}&zoom=17`,
      ).catch(() => {});
    } else {
      const q = encodeURIComponent(place.name + (place.address ? ` ${place.address}` : ''));
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
    }
  };

  const openDirections = () => {
    if (place.lat != null && place.lng != null) {
      Linking.openURL(
        `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`,
      ).catch(() => {});
    } else {
      Linking.openURL(
        `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place.name)}`,
      ).catch(() => {});
    }
  };

  return (
    <SafeAreaView style={fb.safeArea} edges={['bottom']}>
      <ScrollView style={fb.scroll} contentContainerStyle={fb.content}>
        {/* Header */}
        <View style={fb.headerRow}>
          <View style={[fb.accentDot, { backgroundColor: accent }]} />
          <View style={{ flex: 1 }}>
            {place.type ? (
              <Text style={[fb.type, { color: accent }]}>{capitalize(place.type)}</Text>
            ) : null}
            {liveOpenNow != null ? (
              <Text
                style={[
                  fb.openPill,
                  liveOpenNow
                    ? { color: '#047857', backgroundColor: '#04785716' }
                    : { color: '#B91C1C', backgroundColor: '#B91C1C16' },
                ]}
              >
                {liveOpenNow ? 'Open now' : 'Closed now'}
              </Text>
            ) : null}
          </View>
          <Pressable
            style={[fb.saveBtn, saved && fb.saveBtnActive]}
            onPress={() => {
              const next = !saved;
              setSaved(next);
              toggleSave('place', place.id, !next)
                .then(setSaved)
                .catch(() => setSaved((s) => !s));
            }}
            hitSlop={8}
          >
            <Bookmark size={18} color={saved ? color.signal : color.mute} fill={saved ? color.signal : 'none'} />
          </Pressable>
        </View>

        {/* Address */}
        {place.address ? (
          <View style={fb.infoRow}>
            <MapPin size={15} color={color.mute} />
            <Text style={fb.infoText}>{place.address}</Text>
          </View>
        ) : null}

        {/* Rating */}
        {place.rating != null ? (
          <View style={fb.infoRow}>
            <Star size={15} color="#F59E0B" fill="#F59E0B" />
            <Text style={[fb.infoText, { color: color.ink, fontWeight: '600' }]}>
              {place.rating.toFixed(1)}
              <Text style={[fb.infoText, { fontWeight: '400' }]}> · OSM community rating</Text>
            </Text>
          </View>
        ) : null}

        {/* Opening hours */}
        {place.openingHours ? (
          <View style={fb.infoRow}>
            <Clock size={15} color={color.mute} />
            <Text style={fb.infoText}>
              {place.openingHours}
              {liveStatus != null && liveOpenNow == null ? (
                <Text style={fb.lastKnownNote}>  · Last known hours — can't verify live</Text>
              ) : null}
            </Text>
          </View>
        ) : null}

        {/* Map thumbnail */}
        {place.lat != null && place.lng != null ? (
          <Pressable style={fb.mapThumb} onPress={openMap}>
            <Navigation size={18} color={color.deep} />
            <View>
              <Text style={fb.mapThumbTitle}>View on map</Text>
              <Text style={fb.mapThumbSub}>
                {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
              </Text>
            </View>
          </Pressable>
        ) : null}

        {/* Description */}
        {place.description ? (
          <View style={fb.section}>
            <Text style={fb.sectionLabel}>About</Text>
            <Text style={fb.desc}>{place.description}</Text>
          </View>
        ) : null}

        {/* Tags */}
        {place.tags.length > 0 ? (
          <View style={fb.section}>
            <View style={fb.infoRow}>
              <Tag size={14} color={color.mute} />
              <Text style={fb.sectionLabel}>Tags</Text>
            </View>
            <View style={fb.tagRow}>
              {place.tags.map((tag) => (
                <View key={tag} style={[fb.tag, { backgroundColor: accent + '18' }]}>
                  <Text style={[fb.tagText, { color: accent }]}>{capitalize(tag)}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Links */}
        {(place.website || place.phone) ? (
          <View style={fb.section}>
            <Text style={fb.sectionLabel}>Contact</Text>
            {place.website ? (
              <Pressable
                style={fb.linkBtn}
                onPress={() => place.website && Linking.openURL(place.website).catch(() => {})}
              >
                <Globe size={15} color={color.deep} />
                <Text style={fb.linkText} numberOfLines={1}>Website</Text>
              </Pressable>
            ) : null}
            {place.phone ? (
              <Pressable
                style={fb.linkBtn}
                onPress={() => Linking.openURL(`tel:${place.phone}`).catch(() => {})}
              >
                <Phone size={15} color={color.deep} />
                <Text style={fb.linkText}>{place.phone}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Text style={fb.attribution}>Place data © OpenStreetMap contributors (ODbL)</Text>

        <PlainBottomFiller />
      </ScrollView>

      {/* Footer */}
      <View style={fb.footer}>
        <Pressable style={fb.dirBtn} onPress={openDirections}>
          <Navigation size={18} color={color.deep} />
          <Text style={fb.dirText}>Directions</Text>
        </Pressable>
        <Pressable style={fb.wishlistBtn} onPress={() => setPickerVisible(true)}>
          <ListPlus size={18} color={color.deep} />
          <Text style={fb.wishlistText}>Save to Trip</Text>
        </Pressable>
      </View>

      <TripWishlistPicker
        place={place}
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSaved={() => setPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function PlaceDetailScreen() {
  const params = useLocalSearchParams<{ id: string; placeJson?: string; city?: string }>();
  const id = firstParam(params.id);
  const city = firstParam(params.city);

  const { isEnabled: isFlagEnabled, isLivePlacesEnabled } = useFeatureFlags();
  const { isAuthed } = useSession();

  // undefined = loading, null = not found / flag off
  const [canonicalPlace, setCanonicalPlace] = useState<CanonicalPlace | null | undefined>(undefined);
  // undefined = loading, null = not available (living endpoint not accessible)
  const [living, setLiving] = useState<PlaceLivingResponse | null | undefined>(undefined);
  const [reportOpen, setReportOpen] = useState(false);

  // Parse discovery-place fallback from URL param (set by map/index.tsx placeEntities).
  const discoveryPlace = parsePlaceJson(params.placeJson);

  useEffect(() => {
    // When external_places_enabled flag is off, skip the canonical fetch entirely
    // and fall through to the discovery fallback — fail-soft, no crash.
    if (!id || !isFlagEnabled('external_places_enabled')) {
      setCanonicalPlace(null);
      setLiving(null);
      return;
    }
    // Canonical discovery remains independent; the experiential living page
    // requires the reversible Live Places master switch.
    void Promise.all([
      getCanonicalPlace(id),
      isLivePlacesEnabled('live_places_enabled') ? getPlaceLiving(id) : Promise.resolve(null),
    ]).then(([place, livingData]) => {
      setCanonicalPlace(place);
      setLiving(livingData);
    });
  }, [id, isFlagEnabled, isLivePlacesEnabled]);

  // ── Place engagement signal — write a place_view rank event on mount ─────────
  // Fire-and-forget: failures are non-fatal. A missed signal never blocks the UI.
  // Only fires when the viewer is authenticated and the route param is a
  // UUID-style canonical place id (non-canonical discovery IDs are OSM slugs).
  useEffect(() => {
    if (!isAuthed || !id) return;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (!isUuid) return;
    const write = async () => {
      try {
        const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
        if (!base) return;
        const token = await freshApiToken();
        if (!token) return;
        await fetch(`${base}/api/rank-events`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_type: 'place_view', entity_type: 'place', entity_id: id }),
        });
      } catch {
        /* non-fatal — signal missed, screen unaffected */
      }
    };
    void write();
  }, [isAuthed, id]);

  const placeName = canonicalPlace?.name ?? discoveryPlace?.name ?? 'Place';

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (canonicalPlace === undefined || living === undefined) {
    return (
      <>
        <Stack.Screen options={{ title: 'Place' }} />
        <View style={ps.centered}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      </>
    );
  }

  // ── Canonical place — Living Destination Page ────────────────────────────────
  // When the living endpoint returns data, render the full LivingDestinationPage.
  // Falls back to the classic PlaceCard layout when living is null (e.g. network
  // error, endpoint unavailable, or non-UUID place ID).
  if (canonicalPlace !== null && living !== null) {
    return (
      <>
        <Stack.Screen options={{ title: canonicalPlace.name, headerTransparent: true }} />
        <SafeAreaView style={ps.safeArea} edges={['bottom']}>
          <LivingDestinationPage
            place={canonicalPlace}
            living={living}
            placeDaysEnabled={isLivePlacesEnabled('place_days_enabled')}
          />
        </SafeAreaView>
        <PlaceReportSheet
          visible={reportOpen}
          onClose={() => setReportOpen(false)}
          placeId={canonicalPlace.id}
          placeName={canonicalPlace.name}
        />
      </>
    );
  }

  // ── Canonical place — classic fallback layout ────────────────────────────────
  // Living endpoint unavailable (null): render existing PlaceCard view.
  if (canonicalPlace !== null) {
    const entity = buildMapEntity(canonicalPlace);
    return (
      <>
        <Stack.Screen options={{ title: canonicalPlace.name }} />
        <SafeAreaView style={ps.safeArea} edges={['bottom']}>
          <ScrollView style={ps.scroll} contentContainerStyle={ps.scrollContent}>
            <PlaceCard place={canonicalPlace} />
            {/* Supplemental section: full opening hours + provisional disclaimer.
                PlaceCard already shows phone, website, and address. */}
            <PlaceInfoSection place={canonicalPlace} supplemental />
            <View style={ps.actionRowWrap}>
              <MapEntityActionRow entity={entity} />
            </View>
            {/* Media v2 Phase 10 (§19): Request-a-View when visual coverage is
                stale. ADDITIVE + flag-gated (media_request_a_view_enabled) —
                renders nothing until the capability is enabled. */}
            <RequestAViewPrompt placeId={canonicalPlace.id} city={city} />
            {/* Worth-It / Skip-It voting */}
            <View style={ps.socialCard}>
              <WorthItVoteRow entityId={canonicalPlace.id} entityType="place" />
            </View>

            {/* Reviews */}
            <View style={ps.socialCard}>
              <ReviewsSection
                entityType="place"
                entityId={canonicalPlace.id}
                entityName={canonicalPlace.name}
                canReview={isAuthed}
              />
            </View>

            <Pressable
              testID="place-detail-report-btn"
              style={ps.reportBtn}
              onPress={() => setReportOpen(true)}
            >
              <Flag size={14} color={color.faint} />
              <Text style={ps.reportBtnLabel}>Report a problem with this place</Text>
            </Pressable>
            <PlainBottomFiller />
          </ScrollView>
        </SafeAreaView>
        <PlaceReportSheet
          visible={reportOpen}
          onClose={() => setReportOpen(false)}
          placeId={canonicalPlace.id}
          placeName={canonicalPlace.name}
        />
      </>
    );
  }

  // ── Discovery-place fallback ────────────────────────────────────────────────
  // getCanonicalPlace returned null (non-canonical ID or flag off).
  // Render from the placeJson payload passed by map/index.tsx.
  if (discoveryPlace) {
    return (
      <>
        <Stack.Screen options={{ title: discoveryPlace.name }} />
        <DiscoveryFallback place={discoveryPlace} city={city} />
      </>
    );
  }

  // ── Nothing available ───────────────────────────────────────────────────────
  return (
    <>
      <Stack.Screen options={{ title: 'Place' }} />
      <View style={ps.centered}>
        <Text style={ps.notAvailableTitle}>Place not available</Text>
        <Text style={ps.notAvailableSub}>
          This place can't be shown right now.
        </Text>
      </View>
    </>
  );
}

// ── Styles — canonical screen ─────────────────────────────────────────────────

const ps = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: color.paper,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: space.md,
    paddingBottom: space.xl,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  notAvailableTitle: {
    ...t.bodyStrong,
    fontSize: 18,
    color: color.ink,
    marginBottom: space.sm,
    textAlign: 'center',
  },
  notAvailableSub: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  actionRowWrap: {
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    padding: space.md,
    marginBottom: space.md,
  },
  socialCard: {
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    padding: space.md,
    marginBottom: space.md,
  },
  reportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.sm,
    alignSelf: 'center',
  },
  reportBtnLabel: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
  },
});

// ── Styles — discovery fallback ───────────────────────────────────────────────

const fb = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: color.paperRaised,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  accentDot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    marginTop: 4,
    flexShrink: 0,
  },
  type: {
    ...t.stamp,
    fontSize: 11,
    textTransform: 'capitalize',
  },
  openPill: {
    ...t.stamp,
    fontSize: 9,
    fontWeight: '700',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  saveBtn: {
    width: avatar.s34, height: avatar.s34,
    borderRadius: avatar.s34 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  saveBtnActive: {
    backgroundColor: color.signal + '18',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  infoText: {
    ...t.small,
    color: color.mute,
    flex: 1,
  },
  lastKnownNote: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
  },
  mapThumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: '#E2EDF0',
    borderRadius: radius.md,
    padding: space.md,
  },
  mapThumbTitle: {
    ...t.bodyStrong,
    color: color.deep,
    fontSize: 13,
  },
  mapThumbSub: {
    ...t.stamp,
    color: color.mute,
    fontSize: 10,
    marginTop: 2,
  },
  section: {
    gap: space.sm,
  },
  sectionLabel: {
    ...t.stamp,
    color: color.faint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  desc: {
    ...t.body,
    color: color.ink,
    fontSize: 14,
    lineHeight: 21,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  tag: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
  },
  tagText: {
    ...t.stamp,
    fontSize: 11,
    textTransform: 'capitalize',
  },
  linkBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  linkText: {
    ...t.body,
    color: color.deep,
    fontSize: 14,
    flex: 1,
  },
  attribution: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
    textAlign: 'center',
    marginTop: space.md,
  },
  footer: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  dirBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    borderWidth: 1.5,
    borderColor: color.deep,
  },
  dirText: {
    ...t.bodyStrong,
    color: color.deep,
    fontWeight: '700',
  },
  wishlistBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flex: 1,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    borderWidth: 1.5,
    borderColor: color.deep,
  },
  wishlistText: {
    ...t.bodyStrong,
    color: color.deep,
    fontWeight: '700',
    fontSize: 13,
  },
});
