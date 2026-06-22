import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { MapPin, Plus, Check, ChevronRight, Bookmark, Navigation } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { isSaved, toggleSave } from '../../services/discoveryBookmarks';
import { usePlanPicker } from '../PlanPickerController';
import { color, space, radius, type as t, shadow, layout } from '../../theme/tokens';

interface PlaceCardProps {
  place: DiscoveryPlace;
  onPress: () => void;
  onAddToPlan: () => void;
}

export function PlaceCard({ place, onPress, onAddToPlan }: PlaceCardProps) {
  const [saved, setSaved] = useState(false);
  const accent = categoryColor(place.category);
  const { isAdded } = usePlanPicker();
  const alreadyAdded = isAdded(place.id);

  useEffect(() => {
    isSaved(place.id).then(setSaved).catch(() => {});
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

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
    >
      {/* Left accent strip */}
      <View style={[styles.strip, { backgroundColor: accent }]} />

      <View style={styles.body}>
        {/* Top row: name + chevron */}
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>{place.name}</Text>
          <ChevronRight size={16} color={color.faint} />
        </View>

        {/* Type + distance */}
        <View style={styles.metaRow}>
          {place.type ? (
            <View style={[styles.typePill, { backgroundColor: accent + '22' }]}>
              <Text style={[styles.typeText, { color: accent }]} numberOfLines={1}>
                {capitalize(place.type)}
              </Text>
            </View>
          ) : null}
          {place.distanceKm != null && (
            <View style={styles.distRow}>
              <MapPin size={11} color={color.faint} />
              <Text style={styles.dist}>
                {place.distanceKm < 1
                  ? `${Math.round(place.distanceKm * 1000)}m`
                  : `${place.distanceKm}km`}
              </Text>
            </View>
          )}
          {place.openingHours ? (
            <Text style={styles.hours} numberOfLines={1}>{formatHoursShort(place.openingHours)}</Text>
          ) : null}
        </View>

        {/* Description */}
        {place.description ? (
          <Text style={styles.desc} numberOfLines={2}>{place.description}</Text>
        ) : null}

        {/* Address */}
        {place.address && !place.description ? (
          <Text style={styles.address} numberOfLines={1}>{place.address}</Text>
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
              const bookmark = { id: place.id, name: place.name, category: place.category, type: place.type, address: place.address, savedAt: Date.now() };
              toggleSave(bookmark).then(setSaved).catch(() => setSaved((s) => !s));
            }}
            hitSlop={6}
          >
            <Bookmark size={14} color={saved ? color.signal : color.faint} fill={saved ? color.signal : 'none'} />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

function formatHoursShort(hours: string): string {
  if (!hours) return '';
  // Show first token (e.g. "Mo-Fr 09:00-18:00" → "Mo-Fr 09:00-18:00")
  // Common abbreviation: just show first 24 chars
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
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    overflow: 'hidden',
    ...shadow.card,
  },
  strip: {
    width: 4,
    borderTopLeftRadius: radius.md,
    borderBottomLeftRadius: radius.md,
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
  distRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  dist: {
    ...t.stamp,
    color: color.faint,
    fontSize: 10,
  },
  hours: {
    ...t.stamp,
    color: color.mute,
    fontSize: 10,
  },
  desc: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    lineHeight: 17,
  },
  address: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
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
});

export default PlaceCard;
