/**
 * CompassCardMessage — renders a compass_card system message as a rich inline card.
 *
 * Body is JSON matching the CompassCardPayload shape set by CompassTelegraphTray
 * when the user taps "Share to chat".
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { Compass, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';

export interface CompassCardPayload {
  id:          string;
  type:        string;
  title:       string | null;
  category:    string | null;
  city:        string | null;
  description: string | null;
  imageUrl:    string | null;
}

function parsePayload(body: string): CompassCardPayload | null {
  try {
    const parsed = JSON.parse(body) as Partial<CompassCardPayload>;
    if (typeof parsed.type !== 'string') return null;
    return parsed as CompassCardPayload;
  } catch {
    return null;
  }
}

interface Props {
  body: string;
  mine: boolean;
}

export function CompassCardMessage({ body, mine }: Props) {
  const payload = parsePayload(body);

  if (!payload) {
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <Text style={[card.fallback, mine && card.fallbackMine]}>Compass recommendation</Text>
      </View>
    );
  }

  const label = payload.title ?? payload.category ?? payload.type;

  return (
    <View style={[card.wrap, mine && card.wrapMine]}>
      {/* Header */}
      <View style={card.header}>
        <View style={card.compassBadge}>
          <Compass size={11} color={color.onInk} />
        </View>
        <Text style={[card.brandLabel, mine && card.brandLabelMine]}>COMPASS</Text>
        {payload.type ? (
          <View style={[card.chip, mine && card.chipMine]}>
            <Text style={[card.chipText, mine && card.chipTextMine]}>{payload.type}</Text>
          </View>
        ) : null}
      </View>

      {/* Title */}
      <Text style={[card.title, mine && card.titleMine]} numberOfLines={2}>
        {label}
      </Text>

      {/* City */}
      {payload.city ? (
        <View style={card.locRow}>
          <MapPin size={11} color={mine ? color.onInk + 'AA' : color.mute} />
          <Text style={[card.loc, mine && card.locMine]} numberOfLines={1}>{payload.city}</Text>
        </View>
      ) : null}

      {/* Description */}
      {payload.description ? (
        <Text style={[card.desc, mine && card.descMine]} numberOfLines={3}>
          {payload.description}
        </Text>
      ) : null}
    </View>
  );
}

const card = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
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
  fallbackMine: { color: color.onInk + 'AA' },

  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  compassBadge: {
    width: 18, height: 18, borderRadius: 5,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  brandLabel: {
    fontFamily: 'Courier', fontSize: 9, color: color.signal,
    letterSpacing: 1, flex: 1,
  },
  brandLabelMine: { color: color.onInk + 'BB' },
  chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: color.haze },
  chipMine: { backgroundColor: color.onInk + '22' },
  chipText: { fontSize: 9, fontFamily: 'Courier', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, color: color.mute },
  chipTextMine: { color: color.onInk + 'CC' },

  title: { color: color.ink, fontWeight: '700', fontSize: 14, lineHeight: 18 },
  titleMine: { color: color.onInk },

  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  loc: { ...t.small, color: color.mute, fontSize: 11, flex: 1 },
  locMine: { color: color.onInk + 'BB' },

  desc: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 16 },
  descMine: { color: color.onInk + 'BB' },
});
