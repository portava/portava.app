/**
 * CompassCardMessage — renders a compass_card system message as a rich inline card.
 *
 * Body is JSON set by CompassTelegraphTray when the user taps "Share to chat".
 *
 * TELEGRAPH §5.3 / §30A.20 — LIVE OR NOTHING (census-telegraph T448 / T359 /
 * T445, lane w-tg-cardtruth). This card used to draw the sender's snapshot —
 * title, city, description — forever, with no re-resolution at all: the one
 * legacy card §5.3 never reached. It now draws one of four things, decided by
 * `legacyCardMode` exactly as the Discovery and post cards are:
 *
 *   live       the server's projection of the source FOR THIS VIEWER, now —
 *              from the message's `card` (resolved in the page's one batch) or,
 *              on an older server, from its own resolve;
 *   revoked    the source is gone, private or no longer this viewer's to see;
 *   loading    nothing from the source;
 *   otherwise  the reference only: this was a Compass recommendation, and it
 *              cannot be checked now. A card whose source has no §5 family (a
 *              Compass `place:` pick from `discovery_places`) always lands here.
 *
 * Nothing the sender serialised is drawn in any mode: a Compass card carries no
 * caption, so the snapshot is all it had.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { Compass, MapPin } from 'lucide-react-native';
import { space, radius, type as t } from '../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../features/telegraph/theme/telegraphTheme.ts';
import { useShareRevocation, revokedLabel } from '../features/telegraph/sharing/useShareRevocation.ts';
import { compassCardRef, normalizeLegacySourceId, SHARED_CARD_UNVERIFIABLE_COPY, type SharedCardTruth } from '../features/telegraph/sharing/shareApi.ts';
import { legacyCardMode, objectKindLabel } from '../features/telegraph/sharing/legacyCardView.ts';

export interface CompassCardPayload {
  id:          string;
  type:        string;
  cardType?:   string | null;
  title:       string | null;
  category:    string | null;
  city:        string | null;
  description: string | null;
  imageUrl:    string | null;
}

/** Any JSON object — the reference (`id`, `cardType`) survives every served form, the snapshot does not. */
function parseRaw(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Props {
  body: string;
  mine: boolean;
  /** The thread the card is drawn in — what a card with no server truth resolves against. */
  threadId?: string | null;
  messageId?: string | null;
  /** census-telegraph T448: the server's truth for this card (the message's `card`). */
  serverCard?: SharedCardTruth | null;
}

export function CompassCardMessage({ body, mine, threadId = null, messageId = null, serverCard = null }: Props) {
  const { palette, styles: card } = useTelegraphTheme(makeCardStyles);
  const raw = parseRaw(body);
  const named = compassCardRef(raw as { id?: unknown; cardType?: unknown } | null);
  const ref = named && normalizeLegacySourceId(named.objectId) ? { ...named, objectId: normalizeLegacySourceId(named.objectId)! } : null; // F1: only a uuid is resolved
  const revocation = useShareRevocation(threadId, ref ? { ...ref, messageId } : null, serverCard);
  const mode = legacyCardMode(revocation, Boolean(threadId && ref));

  if (mode === 'revoked') {
    return (
      <View style={[card.wrap, card.wrapRevoked, mine && card.wrapMine]} testID="compass-card-revoked">
        <Text style={[card.fallback, mine && card.fallbackMine]}>{revokedLabel(revocation.reason)}</Text>
      </View>
    );
  }

  if (mode === 'loading') {
    return (
      <View style={[card.wrap, mine && card.wrapMine]} testID="compass-card-loading">
        <Text style={[card.fallback, mine && card.fallbackMine]}>Loading…</Text>
      </View>
    );
  }

  const live = mode === 'live' && revocation.resolved?.available ? revocation.resolved : null;
  if (!live) {
    // `reference` or `legacy`: nothing could vouch for the source, so nothing
    // from it is drawn — not the title, not the city, not the description.
    return (
      <View style={[card.wrap, mine && card.wrapMine]} testID="compass-card-reference">
        <View style={card.header}>
          <View style={card.compassBadge}>
            <Compass size={11} color={palette.operationalOn} />
          </View>
          <Text style={[card.brandLabel, mine && card.brandLabelMine]}>COMPASS</Text>
        </View>
        <Text style={[card.fallback, mine && card.fallbackMine]}>
          {raw ? `Compass recommendation · ${SHARED_CARD_UNVERIFIABLE_COPY}` : 'Compass recommendation'}
        </Text>
      </View>
    );
  }

  const p = live.projection;
  return (
    <View style={[card.wrap, mine && card.wrapMine]} testID="compass-card-live">
      {/* Header */}
      <View style={card.header}>
        <View style={card.compassBadge}>
          <Compass size={11} color={palette.operationalOn} />
        </View>
        <Text style={[card.brandLabel, mine && card.brandLabelMine]}>COMPASS</Text>
        <View style={[card.chip, mine && card.chipMine]}>
          <Text style={[card.chipText, mine && card.chipTextMine]}>{objectKindLabel(p.objectType)}</Text>
        </View>
      </View>

      {/* Title — the source's, for this viewer, now */}
      <Text style={[card.title, mine && card.titleMine]} numberOfLines={2}>
        {p.title}
      </Text>

      {p.subtitle ? (
        <View style={card.locRow}>
          <MapPin size={11} color={mine ? palette.sentText + 'AA' : palette.mute} />
          <Text style={[card.loc, mine && card.locMine]} numberOfLines={1}>{p.subtitle}</Text>
        </View>
      ) : null}
    </View>
  );
}

// census T123/T124: every colour is the scheme's. A card the viewer SENT is a sent
// bubble (it was vermilion — the attention colour — for an ordinary message), and
// the Compass mark is the operational teal.
const makeCardStyles = (p: TelegraphPalette) => StyleSheet.create({
  wrap: {
    backgroundColor: p.surfaceRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: p.recvBorder,
    borderBottomLeftRadius: 4,
    padding: space.md,
    gap: 6,
    maxWidth: 280,
  },
  wrapMine: {
    backgroundColor: p.sentBubble,
    borderColor: p.sentBubble,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: 4,
  },
  /** §5.3 revoked state — dashed, unfilled, carrying nothing from the source. */
  wrapRevoked: {
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  fallback: { ...t.small, color: p.mute, fontStyle: 'italic' },
  fallbackMine: { color: p.sentText + 'AA' },

  header: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  compassBadge: {
    width: 18, height: 18, borderRadius: 5,
    backgroundColor: p.operational,
    alignItems: 'center', justifyContent: 'center',
  },
  brandLabel: {
    fontFamily: 'Courier', fontSize: 9, color: p.operational,
    letterSpacing: 1, flex: 1,
  },
  brandLabelMine: { color: p.sentText + 'BB' },
  chip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: p.haze },
  chipMine: { backgroundColor: p.sentText + '22' },
  chipText: { fontSize: 9, fontFamily: 'Courier', fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.3, color: p.mute },
  chipTextMine: { color: p.sentText + 'CC' },

  title: { color: p.recvText, fontWeight: '700', fontSize: 14, lineHeight: 18 },
  titleMine: { color: p.sentText },

  locRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  loc: { ...t.small, color: p.mute, fontSize: 11, flex: 1 },
  locMine: { color: p.sentText + 'BB' },
});
