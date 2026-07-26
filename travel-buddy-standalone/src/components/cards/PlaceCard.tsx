/**
 * PlaceCard — shared card for place discovery surfaces.
 * Header image, name, place type, address/area, open status, primary action.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin, Clock } from 'lucide-react-native';
import { CachedImage } from '../CachedImage.tsx';
import { color, space, radius, shadow, typography, layout } from '../../theme/tokens.ts';

export interface PlaceCardProps {
  id: string;
  name: string;
  category: string;
  address?: string | null;
  area?: string | null;
  imageUrl?: string | null;
  isOpen?: boolean | null;
  distance?: string | null;
  onPress: () => void;
  primaryAction?: {
    label: string;
    onPress: () => void;
  };
}

export function PlaceCard({
  name, category, address, area, imageUrl, isOpen, distance, onPress, primaryAction,
}: PlaceCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const subtitle = address ?? area ?? null;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${category}${subtitle ? `, ${subtitle}` : ''}`}
    >
      {/* Cover image */}
      {imageUrl && !imgFailed ? (
        <CachedImage
          source={{ uri: imageUrl }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <View style={[styles.image, styles.imageFallback]}>
          <MapPin size={24} color={color.onInk} strokeWidth={1.5} />
        </View>
      )}

      <View style={styles.body}>
        {/* Category label */}
        <Text style={styles.category} numberOfLines={1}>{category}</Text>

        {/* Name */}
        <Text style={styles.name} numberOfLines={2}>{name}</Text>

        {/* Address / area */}
        {subtitle ? (
          <View style={styles.metaRow}>
            <MapPin size={11} color={color.faint} />
            <Text style={styles.meta} numberOfLines={1}>{subtitle}</Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          {/* Open/closed status */}
          {isOpen != null ? (
            <View style={styles.metaRow}>
              <Clock size={11} color={isOpen ? color.success : color.warn} />
              <Text style={[styles.meta, { color: isOpen ? color.success : color.warn, fontWeight: '600' }]}>
                {isOpen ? 'Open' : 'Closed'}
              </Text>
            </View>
          ) : null}

          {/* Distance */}
          {distance ? <Text style={styles.distance}>{distance}</Text> : null}

          {/* Primary action */}
          {primaryAction ? (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.7 }]}
              onPress={(e) => { e.stopPropagation?.(); primaryAction.onPress(); }}
              accessibilityRole="button"
              accessibilityLabel={primaryAction.label}
            >
              <Text style={styles.actionBtnText}>{primaryAction.label}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
    marginBottom: space.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  image: {
    width: '100%',
    height: 140,
  },
  imageFallback: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: space.md,
    gap: space.xs,
  },
  category: {
    ...typography.metadata,
    color: color.mute,
    textTransform: 'uppercase',
  },
  name: {
    ...typography.cardTitle,
    color: color.ink,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  meta: {
    ...typography.caption,
    color: color.mute,
    flex: 1,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
    flexWrap: 'wrap',
  },
  distance: {
    ...typography.metadata,
    color: color.deep,
    flex: 1,
  },
  actionBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  actionBtnText: {
    ...typography.button,
    color: color.onInk,
    fontSize: 12,
  },
});
