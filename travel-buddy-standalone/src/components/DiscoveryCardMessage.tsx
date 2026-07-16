/**
 * DiscoveryCardMessage — renders a discovery_card system message as a rich inline card.
 *
 * Parses the JSON body (set by DiscoveryShareSheet when sending) and shows:
 * - Category badge + city
 * - Title
 * - Blurb snippet
 * - Action row: View / Add to Plan / Save
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
  Image,
} from 'react-native';
import { router } from 'expo-router';
import { Compass, MapPin, Bookmark, CalendarPlus, ExternalLink } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import { TG } from '../theme/telegraphTokens';
import { TripWishlistPicker, type AddToTripPayload } from './discovery/TripWishlistPicker';

export interface DiscoveryCardPayload {
  sourceId: string;
  sourceType: string;
  title: string;
  category: string;
  city: string;
  blurb?: string;
  imageUrl?: string;
  priceLevel?: string;
  caption?: string;
}

function parsePayload(body: string): DiscoveryCardPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<DiscoveryCardPayload>;
    if (typeof parsed.title !== 'string' || typeof parsed.category !== 'string') return null;
    return parsed as DiscoveryCardPayload;
  } catch {
    return null;
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  hidden_gem: '#10B981',
  food: '#F97316',
  nightlife: '#8B5CF6',
  beach: '#0EA5E9',
  attraction: '#10B981',
  activity: '#6366F1',
  'for_you': color.signal,
  place: '#6B7280',
};

interface Props {
  body: string;
  mine: boolean;
}

export function DiscoveryCardMessage({ body, mine }: Props) {
  const payload = parsePayload(body);
  const [pickerVisible, setPickerVisible] = useState(false);

  if (!payload) {
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <Text style={[card.fallback, mine && { color: color.onInk + 'AA' }]}>Discovery card</Text>
      </View>
    );
  }

  const accentColor = CATEGORY_COLORS[payload.category.toLowerCase()] ?? CATEGORY_COLORS.place;

  const addPayload: AddToTripPayload = {
    id:       payload.sourceId,
    name:     payload.title,
    category: payload.category,
    lat:      null,
    lng:      null,
  };

  return (
    <>
      <View style={[card.wrap, mine && card.wrapMine]}>
        {/* Header */}
        <View style={card.header}>
          <View style={card.compassBadge}>
            <Compass size={11} color={color.onInk} />
          </View>
          <Text style={[card.brandLabel, mine && { color: color.onInk + 'BB' }]}>DISCOVERY</Text>
          <View style={[card.chip, { backgroundColor: accentColor + '22' }]}>
            <Text style={[card.chipText, { color: accentColor }]}>
              {payload.category}
            </Text>
          </View>
        </View>

        {/* Thumbnail */}
        {payload.imageUrl ? (
          <Image
            source={{ uri: payload.imageUrl }}
            style={card.thumbnail}
            resizeMode="cover"
          />
        ) : null}

        {/* Title */}
        <Text style={[card.title, mine && card.titleMine]} numberOfLines={2}>
          {payload.title}
        </Text>

        {/* Location */}
        <View style={card.locRow}>
          <MapPin size={11} color={mine ? color.onInk + 'AA' : color.mute} />
          <Text style={[card.loc, mine && card.locMine]} numberOfLines={1}>{payload.city}</Text>
          {payload.priceLevel ? (
            <Text style={[card.price, mine && card.priceMine]}> · {payload.priceLevel}</Text>
          ) : null}
        </View>

        {/* Blurb */}
        {payload.blurb ? (
          <Text style={[card.blurb, mine && card.blurbMine]} numberOfLines={2}>
            {payload.blurb}
          </Text>
        ) : null}

        {/* Caption from sender */}
        {payload.caption ? (
          <Text style={[card.caption, mine && card.captionMine]} numberOfLines={2}>
            "{payload.caption}"
          </Text>
        ) : null}

        {/* Action row */}
        <View style={card.actions}>
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            onPress={() => router.push(
              payload.sourceId
                ? (`/(tabs)/discovery?placeId=${encodeURIComponent(payload.sourceId)}` as any)
                : ('/(tabs)/discovery' as any)
            )}
          >
            <ExternalLink size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>View</Text>
          </Pressable>
          <View style={[card.divider, mine && card.dividerMine]} />
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            onPress={() => setPickerVisible(true)}
          >
            <CalendarPlus size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>Add to Plan</Text>
          </Pressable>
          <View style={[card.divider, mine && card.dividerMine]} />
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            onPress={() => Alert.alert('Saved', `"${payload.title}" saved to your Discovery.`)}
          >
            <Bookmark size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>Save</Text>
          </Pressable>
        </View>
      </View>

      <TripWishlistPicker
        place={addPayload}
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
      />
    </>
  );
}

const card = StyleSheet.create({
  wrap: {
    backgroundColor: TG.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: TG.recvBorder,
    borderBottomLeftRadius: 4,
    padding: space.md,
    gap: 6,
    maxWidth: 280,
  },
  wrapMine: {
    backgroundColor: color.signal,
    borderColor: color.signal,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: 4,
  },
  fallback: { ...t.small, color: color.mute, fontStyle: 'italic' },
  thumbnail: {
    width: '100%',
    height: 110,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
  },

  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  compassBadge: { width: 18, height: 18, borderRadius: 5, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  brandLabel: { ...t.stamp, fontFamily: 'Courier', fontSize: 9, color: color.signal, letterSpacing: 1, flex: 1 },
  chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },
  chipText: { fontSize: 9, fontFamily: 'Courier', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3 },

  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 14, lineHeight: 18 },
  titleMine: { color: color.onInk },

  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  loc: { ...t.small, color: color.mute, fontSize: 11, flex: 1 },
  locMine: { color: color.onInk + 'BB' },
  price: { ...t.small, color: color.mute, fontSize: 11 },
  priceMine: { color: color.onInk + 'AA' },

  blurb: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 16 },
  blurbMine: { color: color.onInk + 'BB' },

  caption: { ...t.small, color: color.faint, fontSize: 11, fontStyle: 'italic', lineHeight: 15 },
  captionMine: { color: color.onInk + '99' },

  actions: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, marginTop: 2, paddingTop: 6 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 4 },
  actionBtnMine: {},
  actionLabel: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 10 },
  actionLabelMine: { color: color.onInk },
  divider: { width: StyleSheet.hairlineWidth, height: 14, backgroundColor: color.haze },
  dividerMine: { backgroundColor: color.onInk + '33' },
});
