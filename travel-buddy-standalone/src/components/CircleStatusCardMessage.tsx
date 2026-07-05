/**
 * CircleStatusCardMessage — renders a circle_status_card system message as an
 * inline rich card in the Telegraph thread.
 *
 * Privacy design:
 *   - `isCircleMember === false` → show a generic "Shared a Circle update."
 *     placeholder.  Non-members can see the message exists but none of the
 *     Circle-specific content.
 *   - `isCircleMember === true`  → show the appropriate card variant based on
 *     the message subtype.
 *
 * Card variants:
 *   "meeting_point"          → MapPin icon + venue/approx label
 *   "arrived" | "with_group" | "leaving" | "safe" → check-in card
 *   null / unrecognised      → generic placeholder (safe for all viewers)
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Users, MapPin, CheckCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';

// ── Subtype classification ─────────────────────────────────────────────────

type CardVariant = 'checkin' | 'meeting_point' | 'unknown';

function classifySubtype(subtype: string | null | undefined): CardVariant {
  if (!subtype) return 'unknown';
  if (subtype === 'meeting_point') return 'meeting_point';
  return 'checkin';
}

/** Human-readable label for a check-in subtype. */
function checkinLabel(subtype: string): string {
  switch (subtype) {
    case 'arrived':    return 'Arrived at the destination';
    case 'with_group': return 'Checked in with the group';
    case 'leaving':    return 'Heading out';
    case 'safe':       return 'Marked as safe';
    default:           return 'Checked in';
  }
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  subtype:       string | null | undefined;
  venueLabel?:   string | null;
  approxArea?:   string | null;
  senderName?:   string | null;
  mine:          boolean;
  isCircleMember?: boolean | null;
}

export function CircleStatusCardMessage({
  subtype,
  venueLabel,
  approxArea,
  senderName,
  mine,
  isCircleMember,
}: Props) {
  const variant = classifySubtype(subtype);

  // ── Privacy placeholder — shown until membership is positively confirmed ──
  // Fail-closed: null (loading) and false (non-member) both show the placeholder.
  // Full card content is rendered only when isCircleMember === true.
  if (isCircleMember !== true) {
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <View style={card.header}>
          <View style={[card.badge, mine && card.badgeMine]}>
            <Users size={10} color={color.onInk} />
          </View>
          <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
        </View>
        <Text style={[card.body, mine && card.bodyMine]}>Shared a Circle update.</Text>
      </View>
    );
  }

  // ── Generic placeholder — unrecognised subtype or null ────────────────────
  if (variant === 'unknown') {
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <View style={card.header}>
          <View style={[card.badge, mine && card.badgeMine]}>
            <Users size={10} color={color.onInk} />
          </View>
          <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
        </View>
        <Text style={[card.body, mine && card.bodyMine]}>Shared a Circle update.</Text>
      </View>
    );
  }

  // ── Meeting-point card ────────────────────────────────────────────────────
  if (variant === 'meeting_point') {
    const locationText = venueLabel || approxArea || null;
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <View style={card.header}>
          <View style={[card.badge, mine && card.badgeMine]}>
            <Users size={10} color={color.onInk} />
          </View>
          <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
          <View style={[card.chip, mine && card.chipMine]}>
            <Text style={[card.chipText, mine && card.chipTextMine]}>MEETING POINT</Text>
          </View>
        </View>

        <View style={card.row}>
          <MapPin size={14} color={mine ? color.onInk + 'CC' : color.signal} />
          <Text style={[card.title, mine && card.titleMine]}>
            {locationText ?? 'Meeting point updated'}
          </Text>
        </View>

        {senderName ? (
          <Text style={[card.meta, mine && card.metaMine]} numberOfLines={1}>
            {senderName}
          </Text>
        ) : null}
      </View>
    );
  }

  // ── Check-in card ─────────────────────────────────────────────────────────
  return (
    <View style={[card.wrap, mine && card.wrapMine]}>
      <View style={card.header}>
        <View style={[card.badge, mine && card.badgeMine]}>
          <Users size={10} color={color.onInk} />
        </View>
        <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
        <View style={[card.chip, mine && card.chipMine]}>
          <Text style={[card.chipText, mine && card.chipTextMine]}>CHECK-IN</Text>
        </View>
      </View>

      <View style={card.row}>
        <CheckCircle size={14} color={mine ? color.onInk + 'CC' : '#22c55e'} />
        <Text style={[card.title, mine && card.titleMine]}>
          {checkinLabel(subtype ?? '')}
        </Text>
      </View>

      {senderName ? (
        <Text style={[card.meta, mine && card.metaMine]} numberOfLines={1}>
          {senderName}
        </Text>
      ) : null}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const card = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised,
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     color.haze,
    borderBottomLeftRadius: 4,
    padding:  space.md,
    gap:      6,
    maxWidth: 280,
  },
  wrapMine: {
    backgroundColor:      color.signal,
    borderColor:          color.signal,
    borderBottomLeftRadius:  radius.lg,
    borderBottomRightRadius: 4,
  },

  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  badge: {
    width: 18, height: 18, borderRadius: 5,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
  },
  badgeMine: { backgroundColor: color.onInk + '33' },

  brand: {
    fontFamily: 'Courier', fontSize: 9, color: color.signal,
    letterSpacing: 1, flex: 1,
  },
  brandMine: { color: color.onInk + 'BB' },

  chip: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 8, backgroundColor: color.haze,
  },
  chipMine: { backgroundColor: color.onInk + '22' },
  chipText: {
    fontSize: 9, fontFamily: 'Courier', fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.3, color: color.mute,
  },
  chipTextMine: { color: color.onInk + 'CC' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  title: { color: color.ink, fontWeight: '700', fontSize: 13, lineHeight: 17, flex: 1 },
  titleMine: { color: color.onInk },

  body: { ...t.small, color: color.mute, fontStyle: 'italic' },
  bodyMine: { color: color.onInk + 'AA' },

  meta: { ...t.small, color: color.mute, fontSize: 11 },
  metaMine: { color: color.onInk + 'BB' },
});
