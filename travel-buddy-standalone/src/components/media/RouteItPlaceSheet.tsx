/**
 * RouteItPlaceSheet — bottom sheet opened by swiping right on a Watch video.
 *
 * Shows the video's place info and an "Add to Trip" button that hooks into the
 * existing PlanPickerController flow. Shows a graceful empty state when the
 * video has no location.
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StyleSheet,
  Dimensions,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, X, Navigation } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, avatar } from '../../theme/tokens.ts';
import { usePlanPicker } from '../PlanPickerController.tsx';
import type { MediaFeedPlace } from '../../types/media.ts';

const { width: SCREEN_W } = Dimensions.get('window');

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';

export interface RouteItPlaceSheetProps {
  visible: boolean;
  place: MediaFeedPlace | null;
  mediaId: string;
  mediaTitle?: string;
  onClose: () => void;
}

export function RouteItPlaceSheet({
  visible,
  place,
  mediaId,
  mediaTitle,
  onClose,
}: RouteItPlaceSheetProps) {
  const insets = useSafeAreaInsets();
  const { open: openPlanPicker } = usePlanPicker();

  const handleAddToTrip = useCallback(() => {
    const locationParts = [place?.name, place?.city].filter(Boolean);
    openPlanPicker({
      id: place?.id ?? mediaId,
      type: 'place',
      title: mediaTitle ?? place?.name ?? 'Video location',
      city: place?.city ?? undefined,
      locationName: locationParts.join(', ') || undefined,
      lat: place?.lat ?? null,
      lng: place?.lng ?? null,
    });
    onClose();
  }, [place, mediaId, mediaTitle, openPlanPicker, onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <Navigation size={18} color={color.signal} />
          <Text style={s.title}>Route It</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={18} color={color.ink} />
          </Pressable>
        </View>

        {place ? (
          <View style={{ gap: space.md }}>
            {/* Place card */}
            <View style={s.placeCard}>
              <View style={s.placeIcon}>
                <MapPin size={20} color={color.onInk} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.placeName} numberOfLines={1}>
                  {place.name}
                </Text>
                {(place.city || place.country) ? (
                  <Text style={s.placeMeta} numberOfLines={1}>
                    {[place.city, place.country].filter(Boolean).join(', ')}
                  </Text>
                ) : null}
              </View>
            </View>

            {/* Map thumbnail — real MapTiler static map when coordinates are available */}
            {place.lat != null && place.lng != null && MAPTILER_KEY ? (
              <Image
                source={{
                  uri: `https://api.maptiler.com/maps/streets-v2/static/${place.lng},${place.lat},13/320x120.png?key=${MAPTILER_KEY}`,
                }}
                style={s.mapThumb}
                resizeMode="cover"
                accessibilityLabel={`Map showing ${place.name}`}
              />
            ) : (
              <View style={s.mapThumb}>
                <MapPin size={28} color={color.signal} />
                <Text style={s.mapThumbLabel}>
                  {place.city ?? place.name}
                </Text>
              </View>
            )}

            {/* Add to Trip button */}
            <Pressable
              style={({ pressed }) => [s.addBtn, pressed && s.addBtnPressed]}
              onPress={handleAddToTrip}
              accessibilityRole="button"
              accessibilityLabel="Add to Trip"
            >
              <Navigation size={16} color={color.onInk} />
              <Text style={s.addBtnText}>Add to Trip</Text>
            </Pressable>
          </View>
        ) : (
          /* No location state */
          <View style={s.emptyWrap}>
            <MapPin size={32} color={color.faint} />
            <Text style={s.emptyTitle}>No location on this video</Text>
            <Text style={s.emptyBody}>
              The creator hasn't added a place to this video yet.
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.5)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    ...shadow.float,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  closeBtn: {
    width: avatar.s32, height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  placeIcon: {
    width: avatar.s44, height: avatar.s44,
    borderRadius: avatar.s44 / 2,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeName: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
  },
  placeMeta: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
  },
  mapThumb: {
    height: 120,
    borderRadius: radius.md,
    backgroundColor: '#D6E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: color.haze,
  },
  mapThumbLabel: {
    ...t.small,
    color: color.deep,
    fontWeight: '700',
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  addBtnPressed: {
    opacity: 0.8,
  },
  addBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 15,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingVertical: space.xl,
    gap: space.sm,
  },
  emptyTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  emptyBody: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
});
