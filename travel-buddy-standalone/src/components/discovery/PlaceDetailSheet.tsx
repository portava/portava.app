import React, { useEffect, useMemo, useState } from 'react';
import { useFsqPhoto } from '../../hooks/useFsqPhoto.ts';
import { resolveHeaderImage } from '../../lib/visuals/resolveHeaderImage.ts';
import type { HeaderCandidate } from '../../lib/visuals/resolveHeaderImage.ts';
import { fallbackUriFor } from '../../lib/visuals/fallbackAssets.ts';
import { AiRepresentationLabel } from '../visuals/AiRepresentationLabel.tsx';
import { ImageSourceBadge } from '../visuals/ImageSourceBadge.tsx';
import { usePlaceImage } from '../../hooks/usePlaceImage.ts';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, Linking,
} from 'react-native';
import { Platform } from 'react-native';
import { X, MapPin, Globe, Phone, Tag, Plus, Bookmark, Navigation, Clock, Star, ListPlus, Sparkles, Info } from 'lucide-react-native';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import { useSession } from '../../context/SessionContext.tsx';
import { GenerateHeaderSheet } from '../events/GenerateHeaderSheet.tsx';
import type { DiscoveryPlace, PlaceLiveStatus, WikidataEnrichment } from '../../services/discovery.ts';
import { getPlaceLiveStatus, getWikidataEnrichment } from '../../services/discovery.ts';
import { checkSaved, toggleSave } from '../../services/collections.ts';
import { color, space, radius, type as t, shadow, avatar, dot } from '../../theme/tokens.ts';
import { categoryColor } from './PlaceCard.tsx';
import { TripWishlistPicker } from './TripWishlistPicker.tsx';
import { usePlainBottomInset } from '../../hooks/useBottomInset.ts';
import { DisplayMediaImage, MediaFallback } from '../ui/DisplayMediaImage.tsx';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';
import { useLocationContext } from '../../context/LocationContext.tsx';
import { haversineKm, travelTimeLabel } from '../../utils/geoDistance.ts';

const SHEET_IMAGE_HEIGHT = 180;

// ── Props ─────────────────────────────────────────────────────────────────────

interface PlaceDetailSheetProps {
  place: DiscoveryPlace | null;
  visible: boolean;
  onClose: () => void;
  onAddToPlan: (place: DiscoveryPlace) => void;
  /** City context used to disambiguate the live open-now lookup. */
  city?: string | null;
}

export function PlaceDetailSheet({ place, visible, onClose, onAddToPlan, city }: PlaceDetailSheetProps) {
  const plainInset = usePlainBottomInset();
  const [saved, setSaved]               = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [liveStatus, setLiveStatus]     = useState<PlaceLiveStatus | null>(null);
  const [generateSheetVisible, setGenerateSheetVisible] = useState(false);
  // Local override applied when an AI header is accepted — so the image updates
  // immediately without needing to refetch the parent data.
  const [localAiHeaderUrl, setLocalAiHeaderUrl] = useState<string | null>(null);
  // Wikidata enrichment — description, Wikipedia link, Commons image.
  // Fetched lazily when the sheet opens for a place that has a wikidataId.
  const [wikidataEnrichment, setWikidataEnrichment] = useState<WikidataEnrichment | null>(null);

  // Feature flag + role guard for the "Generate header image" admin action.
  const { isEnabled } = useFeatureFlags();
  const { role } = useSession();
  const canGenerateHeader = isEnabled('ai_place_headers_enabled') && role === 'admin';

  // User location — used to compute distance when place.distanceKm is absent.
  const { resolvedLocation } = useLocationContext();
  const effectiveHeaderUrl = localAiHeaderUrl ?? place?.headerImageUrl ?? null;
  const effectiveHeaderSource = localAiHeaderUrl ? 'ai_generated' : (place?.headerImageSource ?? null);
  const isAiHeader = effectiveHeaderSource === 'ai_generated';
  const fsqPassthrough = isAiHeader ? undefined : (effectiveHeaderUrl ?? undefined);
  const photoUrl = useFsqPhoto(place?.name ?? '', place?.lat, place?.lng, fsqPassthrough, place?.id);

  // Reset local override and enrichment when a different place is shown.
  useEffect(() => {
    setLocalAiHeaderUrl(null);
    setWikidataEnrichment(null);
  }, [place?.id]);

  // Fetch Wikidata enrichment lazily when the sheet opens for a place that
  // has a wikidataId. Any failure is silently ignored — the sheet still works
  // without enrichment.
  useEffect(() => {
    if (!place?.wikidataId || !visible) return;
    let cancelled = false;
    getWikidataEnrichment(place.wikidataId)
      .then((data) => { if (!cancelled) setWikidataEnrichment(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [place?.id, place?.wikidataId, visible]);

  // Build candidates with real source metadata so the resolver can set
  // isRepresentation correctly for the AI disclosure label.
  const _sheetCandidates: HeaderCandidate[] = [];
  if (effectiveHeaderUrl) {
    _sheetCandidates.push({
      url: effectiveHeaderUrl,
      source: (effectiveHeaderSource as HeaderCandidate['source']) ?? 'provider',
    });
  }
  if (photoUrl && photoUrl !== effectiveHeaderUrl) {
    _sheetCandidates.push({ url: photoUrl, source: 'provider' });
  }
  // osmImageUrl is the second-lowest-priority candidate — only used when no
  // headerImageUrl or FSQ photo is available.
  if (place?.osmImageUrl && place.osmImageUrl !== effectiveHeaderUrl && place.osmImageUrl !== photoUrl) {
    _sheetCandidates.push({ url: place.osmImageUrl, source: 'provider' });
  }
  // Wikidata Commons image (P18) is the absolute lowest-priority candidate —
  // only used when no headerImageUrl, FSQ photo, or OSM image is available.
  // Special:FilePath redirects to the actual file, so it renders as a normal
  // image URL. Wikimedia content is freely licensed (CC-BY-SA / public domain).
  if (wikidataEnrichment?.commonsImageUrl) {
    const commonsUrl = wikidataEnrichment.commonsImageUrl;
    const alreadyPresent = _sheetCandidates.some((c) => c.url === commonsUrl);
    if (!alreadyPresent) {
      _sheetCandidates.push({ url: commonsUrl, source: 'provider' });
    }
  }
  const resolvedSheet = place ? resolveHeaderImage(_sheetCandidates, {
    entityType: 'place',
    category: place.category,
    fallbackUrlFor: fallbackUriFor,
  }) : null;

  useEffect(() => {
    if (place) {
      checkSaved('place', place.id)
        .then(({ saved }) => setSaved(saved))
        .catch(() => {});
    }
  }, [place?.id]);

  // Live open-now lookup (Phase 8) — honest degradation: any failure leaves
  // liveStatus null and no pill is shown; a status is never invented.
  useEffect(() => {
    setLiveStatus(null);
    if (!place || !visible) return;
    let cancelled = false;
    getPlaceLiveStatus(place.name, city ?? null)
      .then((ls) => { if (!cancelled) setLiveStatus(ls); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [place?.id, visible]);

  const liveOpenNow: boolean | null =
    liveStatus?.available && typeof liveStatus.openNow === 'boolean'
      ? liveStatus.openNow
      : null;

  // Effective distance — prefer server-supplied value, fall back to computing
  // from the user's resolved location coords.
  const distanceKm = useMemo<number | null>(() => {
    if (place?.distanceKm != null) return place.distanceKm;
    if (!place || place.lat == null || place.lng == null) return null;
    const coords = resolvedLocation?.coords;
    if (!coords) return null;
    return haversineKm(coords.lat, coords.lng, place.lat, place.lng);
  }, [place, resolvedLocation]);

  const placeImage = usePlaceImage({
    url: resolvedSheet?.url ?? null,
    imageSourceType: place?.imageSourceType,
    accuracyStatus: place?.accuracyStatus,
    disclaimerRequired: place?.disclaimerRequired,
    disclaimerText: place?.disclaimerText,
    isRepresentation: resolvedSheet?.isRepresentation,
    altText: place?.name,
  });

  if (!place) return null;

  const accent = categoryColor(place.category);
  const fallbackDesc = getPlaceCategoryFallback(place.category);

  const openWeb = () => {
    if (place.website) Linking.openURL(place.website).catch(() => {});
  };

  const openPhone = () => {
    if (place.phone) Linking.openURL(`tel:${place.phone}`).catch(() => {});
  };

  // Honest coordinates only: never fall back to a name-only Google Maps
  // query. A name-only "destination" search silently used the VIEWER's
  // current location as the implicit origin/anchor and frequently failed to
  // resolve (e.g. an idea-style title like "Beach bonfire & music" isn't a
  // geocodable address), producing bogus cross-city directions. If we don't
  // have the real place's coordinates, we don't offer directions.
  const hasRealCoords = place.lat != null && place.lng != null;

  const openMap = () => {
    if (!hasRealCoords) return;
    const url = `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}&zoom=17`;
    Linking.openURL(url).catch(() => {});
  };

  const openDirections = () => {
    if (!hasRealCoords) return;
    if (Platform.OS === 'web') {
      // Open in a new tab on web — navigating the current tab to
      // maps.google.com blanks the PWA instead of just launching directions.
      // Matches the pattern used by the Roam "Navigate" chip (openInMaps.ts).
      if (typeof window !== 'undefined') {
        window.open(`https://maps.google.com/?q=${place.lat},${place.lng}`, '_blank');
      }
      return;
    }
    // Include the place name alongside the coordinates so Google Maps labels
    // the destination correctly instead of resolving the pin to whatever
    // business happens to be nearest those coordinates (e.g. "BDO ATM").
    const destination = `${place.lat},${place.lng}(${encodeURIComponent(place.name)})`;
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${destination}`).catch(() => {});
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={styles.sheet}>
        {/* Handle */}
        <View style={styles.handle} />

        {/* Image header — category fallback when no real image available */}
        <View style={styles.imageWrap}>
          <DisplayMediaImage
            uri={resolvedSheet?.url ?? null}
            width={0}
            height={SHEET_IMAGE_HEIGHT}
            style={styles.sheetImage}
            resizeMode="cover"
            alt={placeImage.accessibilityLabel ?? place.name}
            fallback={
              <MediaFallback
                icon={<Text style={styles.fallbackEmoji}>{fallbackDesc.emoji}</Text>}
                label={fallbackDesc.label}
                bg={fallbackDesc.color + '33'}
                style={StyleSheet.absoluteFill}
              />
            }
            testID="place-sheet-image"
          />
          {/* Image source badge — accuracy pipeline labels; falls back to legacy AI label */}
          {placeImage.sourceLabel !== null ? (
            <ImageSourceBadge
              sourceLabel={placeImage.sourceLabel}
              disclaimerRequired={placeImage.disclaimerRequired}
              disclaimerText={placeImage.disclaimerText}
              placeId={place.id}
              imageUrl={resolvedSheet?.url ?? undefined}
              style={styles.aiLabel}
              testID="place-sheet-image-source-badge"
            />
          ) : resolvedSheet?.isRepresentation ? (
            <AiRepresentationLabel style={styles.aiLabel} testID="place-sheet-ai-label" />
          ) : null}
          {/* Open/closed overlay on image */}
          {liveOpenNow != null && (
            <View
              style={[styles.liveOverlay, liveOpenNow ? styles.liveOverlayOpen : styles.liveOverlayClosed]}
              testID={`place-open-now-${place.id}`}
              accessibilityLabel={liveOpenNow ? 'Open now — verified live' : 'Closed now — verified live'}
            >
              <Text style={[styles.liveOverlayText, { color: liveOpenNow ? '#047857' : '#B91C1C' }]}>
                {liveOpenNow ? 'Open now' : 'Closed now'}
              </Text>
            </View>
          )}
        </View>

        {/* Illustrative image disclaimer — shown inline (not hidden behind a tap) per spec:
            "displayed visibly (not hidden behind a tap)" for illustrative_only accuracy status. */}
        {placeImage.sourceLabel === 'illustrative' && placeImage.disclaimerText ? (
          <View
            style={{ backgroundColor: '#FEF3C7', borderLeftWidth: 3, borderLeftColor: '#D97706', paddingHorizontal: space.md, paddingVertical: space.sm }}
            testID="place-sheet-illustrative-disclaimer"
          >
            <Text style={{ fontSize: 12, lineHeight: 17, color: '#92400E' }}>
              {placeImage.disclaimerText}
            </Text>
          </View>
        ) : null}

        {/* Header row: name + type + save + close */}
        <View style={styles.header}>
          <View style={[styles.accentDot, { backgroundColor: accent }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={2}>{place.name}</Text>
            <View style={styles.typeRow}>
              {/* Specific place type label */}
              {(place.type || place.category) ? (
                <Text style={[styles.type, { color: accent }]}>
                  {capitalize(place.type ?? place.category)}
                </Text>
              ) : null}
            </View>
          </View>
          <Pressable
            style={({ pressed }) => [styles.saveHeaderBtn, saved && styles.saveHeaderBtnActive, pressed && { opacity: 0.7 }]}
            onPress={() => {
              if (!place) return;
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
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.content, { paddingBottom: plainInset }]}
          showsVerticalScrollIndicator={false}
        >
          {/* Distance + travel time */}
          {distanceKm != null && (
            <View style={styles.infoRow} testID="place-sheet-distance">
              <MapPin size={15} color={color.mute} />
              <Text style={styles.infoText}>
                {distanceKm < 1
                  ? `${Math.round(distanceKm * 1000)} m away`
                  : `${distanceKm.toFixed(1)} km away`}
                {' · '}
                <Text style={styles.travelTime}>{travelTimeLabel(distanceKm)}</Text>
              </Text>
            </View>
          )}

          {/* Address */}
          {place.address && (
            <View style={styles.infoRow}>
              <MapPin size={15} color={color.mute} />
              <Text style={styles.infoText}>{place.address}</Text>
            </View>
          )}

          {/* Rating */}
          {place.rating != null && (
            <View style={styles.infoRow}>
              <Star size={15} color="#F59E0B" fill="#F59E0B" />
              <Text style={[styles.infoText, { color: color.ink, fontWeight: '600' }]}>
                {place.rating.toFixed(1)}
                <Text style={[styles.infoText, { fontWeight: '400' }]}> · OSM community rating</Text>
              </Text>
            </View>
          )}

          {/* Opening hours */}
          {place.openingHours && (
            <View style={styles.infoRow}>
              <Clock size={15} color={color.mute} />
              <Text style={styles.infoText}>
                {place.openingHours}
                {liveStatus != null && liveOpenNow == null ? (
                  <Text style={styles.lastKnownNote}>  · Last known hours — can't verify live</Text>
                ) : null}
              </Text>
            </View>
          )}

          {/* Map thumbnail area — tap to open */}
          {place.lat != null && place.lng != null && (
            <Pressable style={styles.mapThumb} onPress={openMap}>
              <Navigation size={18} color={color.deep} />
              <View>
                <Text style={styles.mapThumbTitle}>View on map</Text>
                <Text style={styles.mapThumbSub}>
                  {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
                </Text>
              </View>
            </Pressable>
          )}

          {/* Description — prefer the place's own description; fall back to
              the Wikidata English description when available and no local one. */}
          {(place.description || wikidataEnrichment?.description) && (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>About</Text>
              <Text style={styles.desc}>{place.description ?? wikidataEnrichment?.description}</Text>
            </View>
          )}

          {/* Tags */}
          {place.tags.filter((t) => !isInternalTag(t)).length > 0 && (
            <View style={styles.section}>
              <View style={styles.infoRow}>
                <Tag size={14} color={color.mute} />
                <Text style={styles.sectionLabel}>Tags</Text>
              </View>
              <View style={styles.tagRow}>
                {place.tags.filter((t) => !isInternalTag(t)).map((tag) => (
                  <View key={tag} style={[styles.tag, { backgroundColor: accent + '18' }]}>
                    <Text style={[styles.tagText, { color: accent }]}>{capitalize(tag)}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Contact — always shows phone (or "Phone not available") */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Contact</Text>
            <View style={styles.linkRow}>
              {/* Phone — tappable or "Phone not available" */}
              <Pressable
                style={styles.linkBtn}
                onPress={place.phone ? openPhone : undefined}
                disabled={!place.phone}
                testID="place-sheet-phone"
              >
                <Phone size={15} color={place.phone ? color.deep : color.faint} />
                <Text style={[styles.linkText, !place.phone && styles.linkTextNA]}>
                  {place.phone ?? 'Phone not available'}
                </Text>
              </Pressable>
              {place.website && (
                <Pressable style={styles.linkBtn} onPress={openWeb}>
                  <Globe size={15} color={color.deep} />
                  <Text style={styles.linkText} numberOfLines={1}>Website</Text>
                </Pressable>
              )}
              {wikidataEnrichment?.wikipediaUrl && (
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => Linking.openURL(wikidataEnrichment.wikipediaUrl!).catch(() => {})}
                  testID="place-sheet-wikipedia"
                >
                  <Info size={15} color={color.deep} />
                  <Text style={styles.linkText} numberOfLines={1}>Wikipedia</Text>
                </Pressable>
              )}
              {place.wikidataId && (
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => Linking.openURL(`https://www.wikidata.org/wiki/${place.wikidataId}`).catch(() => {})}
                  testID="place-sheet-wikidata"
                >
                  <Info size={15} color={color.deep} />
                  <Text style={styles.linkText} numberOfLines={1}>Wikidata</Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* Attribution — events are member-hosted activities, not resolved
              venues, so the OSM attribution (which implies venue data) would
              be misleading. */}
          <Text style={styles.attribution}>
            {place.isCompassEvent
              ? 'Hosted event · not a verified venue'
              : (place.attribution ?? 'Place data © OpenStreetMap contributors (ODbL)')}
          </Text>
        </ScrollView>

        {/* Admin: generate AI header image */}
        {canGenerateHeader && (
          <Pressable
            style={styles.generateHeaderBtn}
            onPress={() => setGenerateSheetVisible(true)}
            testID="place-sheet-generate-header-btn"
          >
            <Sparkles size={15} color={color.signal} />
            <Text style={styles.generateHeaderText}>Generate header image</Text>
          </Pressable>
        )}

        {/* Footer actions */}
        <View style={styles.footer}>
          {hasRealCoords ? (
            <Pressable style={styles.dirBtn} onPress={openDirections}>
              <Navigation size={18} color={color.deep} />
              <Text style={styles.dirText}>Directions</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={styles.wishlistBtn}
            onPress={() => setPickerVisible(true)}
          >
            <ListPlus size={18} color={color.deep} />
            <Text style={styles.wishlistText}>Save to Trip</Text>
          </Pressable>
          <Pressable style={styles.addBtn} onPress={() => onAddToPlan(place)}>
            <Plus size={18} color={color.onInk} />
            <Text style={styles.addText}>Plan</Text>
          </Pressable>
        </View>
      </View>

      <TripWishlistPicker
        place={place}
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSaved={() => setPickerVisible(false)}
      />

      {canGenerateHeader && (
        <GenerateHeaderSheet
          visible={generateSheetVisible}
          entityType="place"
          entityId={place.id}
          onDismiss={() => setGenerateSheetVisible(false)}
          onAccepted={(url) => {
            setLocalAiHeaderUrl(url);
            setGenerateSheetVisible(false);
          }}
        />
      )}
    </Modal>
  );
}

function capitalize(s: string) {
  // Internal category/tag values can arrive as snake_case or camelCase
  // (e.g. "traveler_pick", "hiddenGem") — always render Title Case words,
  // never the raw internal token.
  return s
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/** Raw OpenStreetMap node/way/relation IDs (e.g. "osm:node/123") are internal
 * data and must never be shown to users — filter them out of the tags list. */
function isInternalTag(tag: string): boolean {
  return /^osm[:/]/i.test(tag);
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '90%',
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    ...shadow.float,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.sm,
  },

  // ── Image ─────────────────────────────────────────────────────────────────
  imageWrap: {
    width: '100%',
    height: SHEET_IMAGE_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
  },
  aiLabel: {
    position: 'absolute',
    bottom: 8,
    left: 8,
  },
  sheetImage: {
    width: '100%' as any,
    height: SHEET_IMAGE_HEIGHT,
  },
  fallbackEmoji: {
    fontSize: 40,
    lineHeight: 50,
    textAlign: 'center',
  },
  liveOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  liveOverlayOpen: {
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  liveOverlayClosed: {
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  liveOverlayText: {
    fontSize: 10,
    fontWeight: '700',
  },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  accentDot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    marginTop: 5,
  },
  name: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  type: {
    ...t.stamp,
    fontSize: 11,
    textTransform: 'capitalize',
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: 2,
  },
  lastKnownNote: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
  },
  saveHeaderBtn: {
    width: avatar.s34, height: avatar.s34,
    borderRadius: avatar.s34 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveHeaderBtnActive: {
    backgroundColor: color.signal + '18',
  },
  closeBtn: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: space.md,
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
  travelTime: {
    color: color.deep,
    fontWeight: '600',
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
  linkRow: {
    gap: space.sm,
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
  linkTextNA: {
    color: color.faint,
    fontStyle: 'italic',
  },
  attribution: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
    textAlign: 'center',
    marginTop: space.md,
  },
  generateHeaderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal + '55',
    backgroundColor: color.signal + '0D',
  },
  generateHeaderText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
    fontSize: 13,
  },
  footer: {
    flexDirection: 'row',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
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
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flex: 1,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
  },
  addText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontWeight: '700',
  },
});

export default PlaceDetailSheet;
