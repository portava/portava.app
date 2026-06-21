import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, Plus, ChevronRight } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t, shadow, layout } from '../../theme/tokens';

interface PlaceCardProps {
  place: DiscoveryPlace;
  onPress: () => void;
  onAddToPlan: () => void;
}

export function PlaceCard({ place, onPress, onAddToPlan }: PlaceCardProps) {
  const tagColor = categoryColor(place.category);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
    >
      {/* Left accent strip */}
      <View style={[styles.strip, { backgroundColor: tagColor }]} />

      <View style={styles.body}>
        {/* Top row: name + chevron */}
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>{place.name}</Text>
          <ChevronRight size={16} color={color.faint} />
        </View>

        {/* Type + distance */}
        <View style={styles.metaRow}>
          {place.type ? (
            <View style={[styles.typePill, { backgroundColor: tagColor + '22' }]}>
              <Text style={[styles.typeText, { color: tagColor }]} numberOfLines={1}>
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
      </View>

      {/* Add to Plan */}
      <Pressable
        style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.7 }]}
        onPress={onAddToPlan}
        hitSlop={8}
      >
        <Plus size={16} color={color.signal} />
      </Pressable>
    </Pressable>
  );
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
  addBtn: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: color.haze,
  },
});

export default PlaceCard;
