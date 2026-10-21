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
 *
 * The entire rendering decision is delegated to `resolveCardRenderFromProps`
 * from CircleStatusCardMessage.logic.ts so the component's render path is
 * directly covered by the logic unit tests.
 */
import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Users, MapPin, CheckCircle } from 'lucide-react-native';
import { space, radius, type as t } from '../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../features/telegraph/theme/telegraphTheme.ts';
import { resolveCardRenderFromProps } from './CircleStatusCardMessage.logic';

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  subtype:       string | null | undefined;
  venueLabel?:   string | null;
  approxArea?:   string | null;
  senderName?:   string | null;
  mine:          boolean;
  isCircleMember?: boolean | null;
  /** Called when the card is tapped. Parent handles navigation vs. alert logic. */
  onPress?:      () => void;
}

export function CircleStatusCardMessage({
  subtype,
  venueLabel,
  approxArea,
  senderName,
  mine,
  isCircleMember,
  onPress,
}: Props) {
  const { palette, styles: card } = useTelegraphTheme(makeCardStyles);
  const isLoading = isCircleMember === null;

  const decision = resolveCardRenderFromProps(
    subtype,
    venueLabel ?? null,
    approxArea ?? null,
    isCircleMember,
    senderName ?? null,
  );

  // ── Shared footer: "View Circle →" link or loading spinner ───────────────
  const linkOrSpinner = onPress ? (
    isLoading ? (
      <ActivityIndicator
        size="small"
        color={mine ? palette.sentText + '99' : palette.operational}
        style={card.spinner}
      />
    ) : (
      <Text style={[card.link, mine && card.linkMine]}>View Circle →</Text>
    )
  ) : null;

  // ── Privacy / unknown-subtype placeholder ─────────────────────────────────
  if (decision.show === 'placeholder') {
    return (
      <View style={[card.wrap, mine && card.wrapMine, isLoading && card.wrapLoading]}>
        <View style={card.header}>
          <View style={[card.badge, mine && card.badgeMine]}>
            <Users size={10} color={mine ? palette.sentText : palette.operationalOn} />
          </View>
          <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
        </View>
        <Text style={[card.body, mine && card.bodyMine]}>{decision.text}</Text>
        {isLoading ? (
          <ActivityIndicator
            size="small"
            color={mine ? palette.sentText + '99' : palette.operational}
            style={card.spinner}
          />
        ) : null}
      </View>
    );
  }

  // ── Meeting-point card ────────────────────────────────────────────────────
  if (decision.show === 'meeting_point') {
    return (
      <View style={[card.wrap, mine && card.wrapMine, isLoading && card.wrapLoading]}>
        <View style={card.header}>
          <View style={[card.badge, mine && card.badgeMine]}>
            <Users size={10} color={mine ? palette.sentText : palette.operationalOn} />
          </View>
          <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
          <View style={[card.chip, mine && card.chipMine]}>
            <Text style={[card.chipText, mine && card.chipTextMine]}>MEETING POINT</Text>
          </View>
        </View>

        <View style={card.row}>
          <MapPin size={14} color={mine ? palette.sentText + 'CC' : palette.operational} />
          <Text style={[card.title, mine && card.titleMine]}>
            {decision.locationText ?? 'Meeting point updated'}
          </Text>
        </View>

        {decision.senderName ? (
          <Text style={[card.meta, mine && card.metaMine]} numberOfLines={1}>
            {decision.senderName}
          </Text>
        ) : null}

        {linkOrSpinner}
      </View>
    );
  }

  // ── Check-in card ─────────────────────────────────────────────────────────
  return (
    <View style={[card.wrap, mine && card.wrapMine, isLoading && card.wrapLoading]}>
      <View style={card.header}>
        <View style={[card.badge, mine && card.badgeMine]}>
          <Users size={10} color={mine ? palette.sentText : palette.operationalOn} />
        </View>
        <Text style={[card.brand, mine && card.brandMine]}>CIRCLE</Text>
        <View style={[card.chip, mine && card.chipMine]}>
          <Text style={[card.chipText, mine && card.chipTextMine]}>CHECK-IN</Text>
        </View>
      </View>

      <View style={card.row}>
        <CheckCircle size={14} color={mine ? palette.sentText + 'CC' : '#22c55e'} />
        <Text style={[card.title, mine && card.titleMine]}>
          {decision.label}
        </Text>
      </View>

      {decision.senderName ? (
        <Text style={[card.meta, mine && card.metaMine]} numberOfLines={1}>
          {decision.senderName}
        </Text>
      ) : null}

      {linkOrSpinner}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

// census T123/T124: the scheme's colours; a card the viewer SENT is a sent bubble
// (it was vermilion), and the Circle mark and link are the operational teal.
const makeCardStyles = (p: TelegraphPalette) => StyleSheet.create({
  wrap: {
    backgroundColor: p.surfaceRaised,
    borderRadius:    radius.lg,
    borderWidth:     1,
    borderColor:     p.haze,
    borderBottomLeftRadius: 4,
    padding:  space.md,
    gap:      6,
    maxWidth: 280,
  },
  wrapMine: {
    backgroundColor:      p.sentBubble,
    borderColor:          p.sentBubble,
    borderBottomLeftRadius:  radius.lg,
    borderBottomRightRadius: 4,
  },

  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  badge: {
    width: 18, height: 18, borderRadius: 5,
    backgroundColor: p.operational,
    alignItems: 'center', justifyContent: 'center',
  },
  badgeMine: { backgroundColor: p.sentText + '33' },

  brand: {
    fontFamily: 'Courier', fontSize: 9, color: p.operational,
    letterSpacing: 1, flex: 1,
  },
  brandMine: { color: p.sentText + 'BB' },

  chip: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 8, backgroundColor: p.haze,
  },
  chipMine: { backgroundColor: p.sentText + '22' },
  chipText: {
    fontSize: 9, fontFamily: 'Courier', fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.3, color: p.mute,
  },
  chipTextMine: { color: p.sentText + 'CC' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  title: { color: p.recvText, fontWeight: '700', fontSize: 13, lineHeight: 17, flex: 1 },
  titleMine: { color: p.sentText },

  body: { ...t.small, color: p.mute, fontStyle: 'italic' },
  bodyMine: { color: p.sentText + 'AA' },

  meta: { ...t.small, color: p.mute, fontSize: 11 },
  metaMine: { color: p.sentText + 'BB' },

  link: { ...t.small, color: p.operational, fontSize: 11, fontWeight: '600', marginTop: 2 },
  linkMine: { color: p.sentText + 'CC' },

  wrapLoading: { opacity: 0.55 },
  spinner: { alignSelf: 'flex-start', marginTop: 2 },
});
