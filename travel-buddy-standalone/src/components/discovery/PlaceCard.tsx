import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { MapPin, Plus, Check, ChevronRight, Bookmark, Navigation, Route, ListPlus } from 'lucide-react-native';
import type { DiscoveryPlace, PlaceLiveStatus } from '../../services/discovery.ts';
import { getPlaceLiveStatusCached } from '../../services/discovery.ts';
import { useFsqPhoto } from '../../hooks/useFsqPhoto.ts';
import { checkSaved, saveItem, unsaveItem } from '../../services/collections.ts';
import { getSavedListIds } from '../../services/discoveryBookmarks.ts';
import { usePlanPicker } from '../PlanPickerController.tsx';
import type { RouteStopDraft } from '../RouteBuilderSheet.tsx';
import { color, space, radius, type as t, shadow, layout } from '../../theme/tokens.ts';
import { TripWishlistPicker } from './TripWishlistPicker.tsx';
import { DisplayMediaImage, MediaFallback } from '../ui/DisplayMediaImage.tsx';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';

const HEADER_HEIGHT = 140;

interface PlaceCardProps {
  place: DiscoveryPlace;
  onPress: () => void;
  onAddToPlan: () => void;
  onAddToRoute?: (draft: RouteStopDraft) => void;
  /** Show the distance badge. Defaults to true; pass false to hide it (e.g. non-nearest sorts). */
  showDistance?: boolean;
  /** City context used to disambiguate the live open-now lookup. When absent, no live pill is fetched. */
  city?: string | null;
}

export function PlaceCard({ place, onPress, onAddToPlan, onAddToRoute, showDistance = true, city }: PlaceCardProps) {
  const [saved, setSaved]               = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [savedCount, setSavedCount]     = useState(0);
  const accent = categoryColor(place.category);
  const { isAdded } = usePlanPicker();
  const alreadyAdded = isAdded(place.id);
  const savedCountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [liveStatus, setLiveStatus] = useState<PlaceLiveStatus | null>(null);
  const photoUrl = useFsqPhoto(place.name, place.lat, place.lng, place.headerImageUrl);

  // Live open-now pill — viewport-gated: FlatList only mounts near-viewport
  // rows, and the 600 ms delay skips cards flung past while scrolling. The
  // service layer dedupes, caches (10 min) and limits concurrency, so there is
  // no request storm. Honest degradation: any failure leaves the pill hidden.
  useEffect(() => {
    setLiveStatus(null);
    if (!city) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getPlaceLiveStatusCached(place.name, city)
        .then((ls) => { if (!cancelled) setLiveStatus(ls); })
        .catch(() => {});
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [place.id, place.name, city]);

  const liveOpenNow: boolean | null =
    liveStatus?.available && typeof liveStatus.openNow === 'boolean'
      ? liveStatus.openNow
      : null;

  // `checkSaved` is the bookmark icon — must be accurate so fires immediately.
  useEffect(() => {
    checkSaved('place', place.id)
      .then(({ saved }) => setSaved(saved))
      .catch(() => {});
  }, [place.id]);

  // `getSavedListIds` drives the "Saved to N trips" badge — secondary info.
  // Defer 800 ms so it doesn't compete with the initial list-paint requests.
  useEffect(() => {
    savedCountTimer.current = setTimeout(() => {
      getSavedListIds(place.id)
        .then((ids) => setSavedCount(ids.size))
        .catch(() => {});
    }, 800);
    return () => {
      if (savedCountTimer.current) clearTimeout(savedCountTimer.current);
    };
  }, [place.id]);

  const refreshSavedCount = useCallback(() => {
    getSavedListIds(place.id)
      .then((ids) => setSavedCount(ids.size))
      .catch(() => {});
  }, [place.id]);

  const openDirections = () => {
    if (place.lat != null && place.lng != null) {
      const url = `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}&zoom=17`;
      Linking.openURL(url).catch(() => {});
    } else if (place.name) {
      const query = encodeURIComponent(place.name);
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${query}`).catch(() => {});
    }
  };

  const fallbackDesc = getPlaceCategoryFallback(place.category);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
    >
      {/* Header image — category fallback when no real image available */}
      <View style={styles.imageHeader} testID={`place-card-image-${place.id}`}>
        <DisplayMediaImage
          uri={photoUrl}
          width={0}
          height={HEADER_HEIGHT}
          style={styles.headerImage}
          resizeMode="cover"
          alt={place.name}
          fallback={
            <MediaFallback
              icon={<Text style={styles.fallbackEmoji}>{fallbackDesc.emoji}</Text>}
              label={fallbackDesc.label}
              bg={fallbackDesc.color + '33'}
              style={StyleSheet.absoluteFill}
            />
          }
          testID={`place-card-img-${place.id}`}
        />
        {/* Open/closed overlay pill on the image */}
        {liveOpenNow != null && (
          <View
            style={[styles.liveOverlay, liveOpenNow ? styles.liveOverlayOpen : styles.liveOverlayClosed]}
            testID={`card-open-now-${place.id}`}
            accessibilityLabel={liveOpenNow ? 'Open now — verified live' : 'Closed now — verified live'}
          >
            <Text style={[styles.liveOverlayText, { color: liveOpenNow ? '#047857' : '#B91C1C' }]}>
              {liveOpenNow ? 'Open now' : 'Closed now'}
            </Text>
          </View>
        )}
        {/* Rating overlay on image */}
        {place.rating != null && (
          <View style={styles.ratingOverlay}>
            <Text style={styles.ratingOverlayStar}>★</Text>
            <Text style={styles.ratingOverlayValue}>{place.rating.toFixed(1)}</Text>
          </View>
        )}
      </View>

      {/* Content row: accent strip + body */}
      <View style={styles.contentRow}>
        {/* Left accent strip */}
        <View style={[styles.strip, { backgroundColor: accent }]} />

        <View style={styles.body}>
          {/* Top row: name + chevron */}
          <View style={styles.titleRow}>
            <Text style={styles.name} numberOfLines={1}>{place.name}</Text>
            <ChevronRight size={16} color={color.faint} />
          </View>

          {/* Type + distance + hours */}
          <View style={styles.metaRow}>
            {/* Specific place type (e.g. "café", not just "food") */}
            {(place.type || place.category) && (
              <View style={[styles.typePill, { backgroundColor: accent + '22' }]}>
                <Text style={[styles.typeText, { color: accent }]} numberOfLines={1}>
                  {capitalize(place.type ?? place.category)}
                </Text>
              </View>
            )}
            {place.distanceKm != null && showDistance && (
              <View style={styles.distBadge}>
                <MapPin size={10} color="#0891B2" />
                <Text style={styles.distBadgeText}>
                  {place.distanceKm < 1
                    ? `${Math.round(place.distanceKm * 1000)} m`
                    : `${place.distanceKm} km`}
                </Text>
              </View>
            )}
            {place.openingHours ? (
              <Text style={styles.hours} numberOfLines={1}>{formatHoursShort(place.openingHours)}</Text>
            ) : null}
          </View>

          {/* Neighborhood + address line */}
          {(place.neighborhood || place.address) && (
            <View style={styles.addressRow}>
              <MapPin size={10} color={color.faint} />
              <Text style={styles.addressText} numberOfLines={1}>
                {[place.neighborhood, place.address].filter(Boolean).join(' · ')}
              </Text>
            </View>
          )}

          {/* Description */}
          {place.description ? (
            <Text style={styles.desc} numberOfLines={2}>{place.description}</Text>
          ) : null}

          {/* Tags */}
          {place.tags.length > 0 && (
            <View style={styles.tagRow}>
              {place.tags.map((tag) => (
                <View key={tag} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Saved-to-trips badge */}
          {savedCount > 0 && (
            <View style={styles.savedBadge}>
              <ListPlus size={11} color={color.deep} />
              <Text style={styles.savedBadgeText}>
                {savedCount === 1 ? 'Saved to 1 trip' : `Saved to ${savedCount} trips`}
              </Text>
            </View>
          )}

          {/* FSQ attribution — required by CC BY 4.0 wherever FSQ data is displayed */}
          {place.attribution ? (
            <Text style={styles.attribution} numberOfLines={1}>{place.attribution}</Text>
          ) : null}

          {/* Action row */}
          <View style={styles.actionRow}>
            <Pressable
              style={({ pressed }) => [
                styles.actionBtn,
                alreadyAdded && styles.actionBtnAdded,
                !alreadyAdded && pressed && { opacity: 0.7 },
              ]}
              onPress={alreadyAdded ? undefined : onAddToPlan}
              disabled={alreadyAdded}
              hitSlop={6}
            >
              {alreadyAdded
                ? <Check size={14} color={color.deep} />
                : <Plus size={14} color={color.signal} />
              }
              <Text style={[styles.actionText, { color: alreadyAdded ? color.deep : color.signal }]}>
                {alreadyAdded ? 'Added ✓' : 'Plan'}
              </Text>
            </Pressable>

            {onAddToRoute && (
              <Pressable
                style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
                onPress={() => onAddToRoute({
                  id:         `place-${place.id}`,
                  title:      place.name,
                  lat:        place.lat ?? null,
                  lng:        place.lng ?? null,
                  sourceType: 'discovery',
                  sourceId:   place.id,
                  category:   place.category ?? null,
                })}
                hitSlop={6}
              >
                <Route size={14} color={color.deep} />
                <Text style={[styles.actionText, { color: color.deep }]}>Route</Text>
              </Pressable>
            )}

            {(place.lat != null || place.name) && (
              <Pressable
                style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
                onPress={openDirections}
                hitSlop={6}
              >
                <Navigation size={14} color={color.deep} />
                <Text style={[styles.actionText, { color: color.deep }]}>Directions</Text>
              </Pressable>
            )}

            <Pressable
              style={({ pressed }) => [styles.saveBtn, saved && styles.saveBtnActive, pressed && { opacity: 0.7 }]}
              onPress={() => {
                const next = !saved;
                setSaved(next);
                (next ? saveItem('place', place.id) : unsaveItem('place', place.id))
                  .then((ok) => { if (!ok) setSaved(!next); })
                  .catch(() => setSaved(!next));
              }}
              hitSlop={6}
            >
              <Bookmark size={14} color={saved ? color.signal : color.faint} fill={saved ? color.signal : 'none'} />
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.wishlistBtn, pressed && { opacity: 0.7 }]}
              onPress={() => setPickerVisible(true)}
              hitSlop={6}
            >
              <ListPlus size={14} color={color.deep} />
            </Pressable>
          </View>
        </View>
      </View>

      <TripWishlistPicker
        place={place}
        visible={pickerVisible}
        onClose={() => {
          setPickerVisible(false);
          refreshSavedCount();
        }}
        onSaved={() => {
          setSavedCount((c) => c + 1);
          setPickerVisible(false);
        }}
      />
    </Pressable>
  );
}

function formatHoursShort(hours: string): string {
  if (!hours) return '';
  return hours.length > 24 ? hours.slice(0, 24) + '…' : hours;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function categoryColor(cat: string): string {
  switch (cat) {
    case 'places':    return '#0A6EBD';
    case 'food':      return '#D4722A';
    case 'nightlife': return '#7C3AED';
    case 'activities':return '#2E7D5B';
    case 'events':    return '#B45309';
    case 'beaches':   return '#0891B2';
    case 'transport': return '#475569';
    case 'for_you':
    default:          return color.signal;
  }
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'column',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    overflow: 'hidden',
    ...shadow.card,
  },

  // ── Image header ─────────────────────────────────────────────────────────────
  imageHeader: {
    width: '100%',
    height: HEADER_HEIGHT,
    overflow: 'hidden',
    backgroundColor: color.haze,
    position: 'relative',
  },
  headerImage: {
    width: '100%' as any,
    height: HEADER_HEIGHT,
  },
  fallbackEmoji: {
    fontSize: 36,
    lineHeight: 44,
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
  ratingOverlay: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  ratingOverlayStar: {
    fontSize: 10,
    color: '#F59E0B',
    lineHeight: 13,
  },
  ratingOverlayValue: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '700',
  },

  // ── Content row (strip + body) ────────────────────────────────────────────────
  contentRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  strip: {
    width: 4,
  },
  body: {
    flex: 1,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    gap: space.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  name: {
    ...t.bodyStrong,
    color: color.ink,
    flex: 1,
    fontSize: 14,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  typePill: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  typeText: {
    ...t.stamp,
    fontSize: 10,
    textTransform: 'capitalize',
  },
  distBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#0891B215',
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  distBadgeText: {
    ...t.stamp,
    color: '#0891B2',
    fontSize: 10,
    fontWeight: '600',
  },
  hours: {
    ...t.stamp,
    color: color.mute,
    fontSize: 10,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  addressText: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
    flex: 1,
  },
  desc: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    lineHeight: 17,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: 2,
  },
  tag: {
    backgroundColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  tagText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 10,
    textTransform: 'capitalize',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xs,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
  },
  actionBtnAdded: {
    opacity: 0.65,
  },
  actionText: {
    ...t.stamp,
    fontSize: 11,
    fontWeight: '600',
  },
  saveBtn: {
    marginLeft: 'auto',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnActive: {
    backgroundColor: color.signal + '18',
  },
  wishlistBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.deep + '14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attribution: {
    ...t.stamp,
    color: color.faint,
    fontSize: 9,
    marginTop: 2,
  },
  savedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.deep + '12',
  },
  savedBadgeText: {
    ...t.stamp,
    color: color.deep,
    fontSize: 10,
    fontWeight: '600',
  },
});

export default PlaceCard;
