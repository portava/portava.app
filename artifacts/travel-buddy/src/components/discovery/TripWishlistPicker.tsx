/**
 * TripWishlistPicker
 *
 * Bottom-sheet modal that lets the user pick one of their trips to add a
 * Discovery place to. Calls toggleSave(place, tripId) from discoveryBookmarks
 * so the trip-scoped list and its category-filter key are kept in sync.
 *
 * On open the picker reads discoveryBookmarks.getSavedListIds(place.id) to
 * pre-populate which trips already contain the place. Those rows show an
 * "Already saved" chip and tapping them removes the place (full toggle).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { X, MapPin, Check, ListPlus, AlertCircle } from 'lucide-react-native';
import { listMyTrips, type TripRow } from '../../services/trips';
import {
  toggleSave,
  getSavedListIds,
  type BookmarkedPlace,
} from '../../services/discoveryBookmarks';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t, shadow } from '../../theme/tokens';

// ── Helpers ────────────────────────────────────────────────────────────────────

function placeToBookmark(place: DiscoveryPlace): BookmarkedPlace {
  return {
    id:       place.id,
    name:     place.name,
    category: place.category,
    type:     place.type,
    address:  place.address,
    savedAt:  Date.now(),
    lat:      place.lat,
    lng:      place.lng,
  };
}

// ── Component ──────────────────────────────────────────────────────────────────

interface TripWishlistPickerProps {
  place: DiscoveryPlace | null;
  visible: boolean;
  onClose: () => void;
  /** Called after a successful save with the trip that received the place. */
  onSaved?: (trip: TripRow) => void;
}

export function TripWishlistPicker({
  place,
  visible,
  onClose,
  onSaved,
}: TripWishlistPickerProps) {
  const [trips, setTrips]         = useState<TripRow[]>([]);
  const [loading, setLoading]     = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving]       = useState<string | null>(null);
  const [savedIds, setSavedIds]   = useState<Set<string>>(new Set());
  const [errorIds, setErrorIds]   = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    if (!place) return;
    setLoading(true);
    setLoadError(false);
    Promise.all([listMyTrips(), getSavedListIds(place.id)])
      .then(([rows, alreadySaved]) => {
        setTrips(rows);
        setSavedIds(alreadySaved);
        setLoading(false);
      })
      .catch(() => { setLoadError(true); setLoading(false); });
  }, [place]);

  useEffect(() => {
    if (visible) {
      // Do NOT reset savedIds here — keep the last-known state so the picker
      // shows correct chips while the reload is in flight instead of flashing
      // all rows as unsaved. savedIds is updated once load() resolves.
      setErrorIds(new Set());
      load();
    }
  }, [visible, load]);

  const handlePick = useCallback(async (trip: TripRow) => {
    if (!place || saving) return;
    setSaving(trip.id);
    setErrorIds((prev) => {
      const next = new Set(prev);
      next.delete(trip.id);
      return next;
    });
    try {
      const bookmark = placeToBookmark(place);
      const { added: nowSaved } = await toggleSave(bookmark, trip.id);
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (nowSaved) {
          next.add(trip.id);
        } else {
          next.delete(trip.id);
        }
        return next;
      });
      if (nowSaved) {
        onSaved?.(trip);
      }
    } catch {
      setErrorIds((prev) => new Set(prev).add(trip.id));
    } finally {
      setSaving(null);
    }
  }, [place, saving, onSaved]);

  const renderTrip = ({ item }: { item: TripRow }) => {
    const isSaved  = savedIds.has(item.id);
    const isBusy   = saving === item.id;
    const hasError = errorIds.has(item.id);

    return (
      <Pressable
        style={({ pressed }) => [
          styles.tripRow,
          isSaved && styles.tripRowSaved,
          hasError && styles.tripRowError,
          pressed && { opacity: 0.75 },
        ]}
        onPress={() => handlePick(item)}
        disabled={isBusy}
      >
        <View style={styles.badge}>
          <MapPin size={12} color={color.deep} />
        </View>

        <View style={styles.tripInfo}>
          <Text style={styles.tripTitle} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.tripDest} numberOfLines={1}>
            {item.destinationCity}
            {item.destinationCountry ? `, ${item.destinationCountry}` : ''}
          </Text>
          {hasError && (
            <Text style={styles.errorText}>Couldn't save — tap to retry</Text>
          )}
        </View>

        {isBusy ? (
          <ActivityIndicator size="small" color={color.signal} />
        ) : isSaved ? (
          <View style={styles.savedChip}>
            <Check size={12} color={color.deep} />
            <Text style={styles.savedText}>Already saved</Text>
          </View>
        ) : hasError ? (
          <AlertCircle size={18} color="#DC2626" />
        ) : (
          <View style={styles.addChip}>
            <ListPlus size={14} color={color.signal} />
          </View>
        )}
      </Pressable>
    );
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
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Save to Trip</Text>
            {place && (
              <Text style={styles.placeName} numberOfLines={1}>{place.name}</Text>
            )}
          </View>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {/* Body */}
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : loadError ? (
          <View style={styles.center}>
            <AlertCircle size={28} color={color.mute} />
            <Text style={styles.emptyTitle}>Couldn't load trips</Text>
            <Pressable style={styles.retryBtn} onPress={load}>
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : trips.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>No trips yet</Text>
            <Text style={styles.emptyDesc}>
              Create a trip first, then save places to its wishlist.
            </Text>
          </View>
        ) : (
          <FlatList
            data={trips}
            keyExtractor={(item) => item.id}
            renderItem={renderTrip}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
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
    maxHeight: '70%',
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
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
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 16,
  },
  placeName: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
    fontSize: 12,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.sm,
    minHeight: 160,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    textAlign: 'center',
  },
  emptyDesc: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 19,
  },
  retryBtn: {
    marginTop: space.xs,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 13,
  },
  list: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
    gap: space.sm,
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  tripRowSaved: {
    borderColor: color.deep + '50',
    backgroundColor: color.deep + '08',
  },
  tripRowError: {
    borderColor: '#DC262640',
    backgroundColor: '#DC262608',
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E2EDF0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tripInfo: {
    flex: 1,
    gap: 2,
  },
  tripTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  tripDest: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  errorText: {
    ...t.stamp,
    color: '#DC2626',
    fontSize: 11,
    marginTop: 2,
  },
  addChip: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: color.signal + '14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  savedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: color.deep + '14',
  },
  savedText: {
    ...t.stamp,
    color: color.deep,
    fontSize: 11,
    fontWeight: '600',
  },
});

export default TripWishlistPicker;
