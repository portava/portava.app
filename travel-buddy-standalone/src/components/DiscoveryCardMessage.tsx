/**
 * DiscoveryCardMessage — renders a discovery_card system message as a rich inline card.
 *
 * Parses the JSON body (set by DiscoveryShareSheet when sending) and shows:
 * - Category badge + city
 * - Title
 * - Blurb snippet
 * - Action row: View / Add to Plan / Save
 *
 * TELEGRAPH §5.3 — REVOCATION. This card used to be a frozen snapshot: parse
 * the sender's JSON, render it, no refetch, no authorization call — so a place
 * made private or a gem withdrawn after sharing still rendered in full inside
 * the thread forever. When a `threadId` is supplied and the payload's
 * `sourceType` maps to a §5 object family, the card re-resolves FOR THIS
 * VIEWER on mount (`features/telegraph/sharing/useShareRevocation.ts`) and
 * renders a revoked notice instead of the snapshot when the source is gone.
 * A card with no threadId, or an unmappable sourceType, behaves exactly as it
 * did before — `unknown` is its own state and is never read as "revoked".
 *
 * TELEGRAPH §30A.10 / §30A.20 — LIVE, NOT A SNAPSHOT (census T413 / T448 /
 * T411). When the resolve answers, the card draws the SERVER's projection —
 * title, location, image, deep link — and nothing the sender serialised except
 * their own caption; its actions are the server's current `actions` for this
 * viewer (Add to Plan ⇐ ADD_TO_TRIP, Meet here ⇐ MEET_HERE). While the answer
 * is loading it draws nothing from the source, and when a resolve was possible
 * but failed it draws the reference only. The modes are decided in
 * `features/telegraph/sharing/legacyCardView.ts`.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { Compass, MapPin, Bookmark, CalendarPlus, ExternalLink } from 'lucide-react-native';
import { DisplayMediaImage } from './ui/DisplayMediaImage.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { TG } from '../theme/telegraphTokens.ts';
import { TripWishlistPicker, type AddToTripPayload } from './discovery/TripWishlistPicker.tsx';
import { toggleSave } from '../services/discoveryBookmarks.ts'; import { saveDiscoveryCardViaTelegraph } from '../services/discoveryCardSave.ts';
import { useShareRevocation, revokedLabel } from '../features/telegraph/sharing/useShareRevocation.ts';
import { legacySourceTypeToObjectType } from '../features/telegraph/sharing/shareApi.ts';
import { legacyCardMode, offeredCardActions, objectKindLabel, REFERENCE_COPY } from '../features/telegraph/sharing/legacyCardView.ts';
import { postCoordinationKind } from '../features/telegraph/coordination/coordinationApi.ts';

type Href = Parameters<typeof router.push>[0];

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

/** Bubble width cap, shared by the card wrap and its thumbnail. */
const CARD_MAX_WIDTH = 280;
const THUMBNAIL_HEIGHT = 110;

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
  /** §5.3: supply this and the card becomes revocable. Omit it and nothing changes. */
  threadId?: string | null;
  messageId?: string | null;
}

export function DiscoveryCardMessage({ body, mine, threadId = null, messageId = null }: Props) {
  const payload = parsePayload(body);
  const [pickerVisible, setPickerVisible] = useState(false);

  const mappedType = legacySourceTypeToObjectType(payload?.sourceType);
  const revocation = useShareRevocation(
    threadId,
    mappedType && payload?.sourceId ? { objectType: mappedType, objectId: payload.sourceId, messageId } : null,
  );
  const mode = legacyCardMode(revocation, Boolean(threadId && mappedType && payload?.sourceId));

  if (revocation.state === 'unavailable') {
    return (
      <View style={[card.wrap, card.wrapRevoked, mine && card.wrapMine]} testID="discovery-card-revoked">
        <Text style={[card.fallback, mine && { color: color.onInk + 'AA' }]}>
          {revokedLabel(revocation.reason)}
        </Text>
      </View>
    );
  }

  if (!payload) {
    return (
      <View style={[card.wrap, mine && card.wrapMine]}>
        <Text style={[card.fallback, mine && { color: color.onInk + 'AA' }]}>Discovery card</Text>
      </View>
    );
  }

  if (mode === 'loading') {
    return (
      <View style={[card.wrap, mine && card.wrapMine]} testID="discovery-card-loading">
        <Text style={[card.fallback, mine && { color: color.onInk + 'AA' }]}>Loading…</Text>
      </View>
    );
  }

  if (mode === 'reference') {
    // A resolve was possible and could not answer. Draw the reference only —
    // the kind, the sender's own caption and a way to open it — never the
    // snapshot, which is exactly what a revoked place would still look like.
    return (
      <View style={[card.wrap, mine && card.wrapMine]} testID="discovery-card-reference">
        <Text style={[card.brandLabel, mine && { color: color.onInk + 'BB' }]}>
          {objectKindLabel(mappedType ?? 'PLACE').toUpperCase()}
        </Text>
        {payload.caption ? (
          <Text style={[card.caption, mine && card.captionMine]} numberOfLines={2}>"{payload.caption}"</Text>
        ) : null}
        <Text style={[card.fallback, mine && { color: color.onInk + 'AA' }]}>{REFERENCE_COPY}</Text>
        <Pressable
          style={[card.actionBtn, mine && card.actionBtnMine]}
          testID="discovery-card-view"
          onPress={() => router.push(`/(tabs)/discovery?placeId=${encodeURIComponent(payload.sourceId)}` as Href)}
        >
          <ExternalLink size={11} color={mine ? color.onInk : color.signal} />
          <Text style={[card.actionLabel, mine && card.actionLabelMine]}>View</Text>
        </Pressable>
      </View>
    );
  }

  // `live`: the server's projection for THIS viewer, now. `legacy`: no resolve
  // was possible (no thread, or a source type with no §5 family) — the pre-§5
  // card, offering View only because there is no capability to derive more from.
  const live = mode === 'live' && revocation.resolved?.available ? revocation.resolved : null;
  const projection = live ? live.projection : null;
  const offered = offeredCardActions(mode, live ? live.actions : []);
  const shownTitle = projection ? projection.title : payload.title;
  const shownPlace = projection ? projection.subtitle : payload.city;
  const shownImage = projection ? projection.imageUrl : payload.imageUrl;
  const shownBlurb = projection ? null : payload.blurb;
  const shownPrice = projection ? null : payload.priceLevel;
  const chipLabel = projection ? objectKindLabel(projection.objectType) : payload.category;
  const accentColor = CATEGORY_COLORS[payload.category.toLowerCase()] ?? CATEGORY_COLORS.place;

  const addPayload: AddToTripPayload = {
    id:       payload.sourceId,
    name:     shownTitle,
    category: payload.category,
    lat:      null,
    lng:      null,
  };

  const proposeMeetHere = async () => {
    if (!threadId || !projection) return;
    const r = await postCoordinationKind(threadId, 'ACTION_PROPOSAL', {
      action: 'MEET_HERE',
      title: `Meet at ${projection.title}`.slice(0, 200),
      objectType: projection.objectType,
      objectId: projection.objectId,
    });
    if (r.ok) Alert.alert('Proposed', `You suggested meeting at ${projection.title}.`);
    else Alert.alert('Could not propose', 'That suggestion did not reach the conversation. Please try again.');
  };

  // The three offered actions. Kept at the indentation they had inside the
  // action row: census-discovery cites lines inside the Add and Save buttons.
  const addToPlanButton = (
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            testID="discovery-card-add-to-plan"
            onPress={() => setPickerVisible(true)}
          >
            <CalendarPlus size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>Add to Plan</Text>
          </Pressable>
  );
  const meetHereButton = (
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            testID="discovery-card-meet-here"
            accessibilityRole="button"
            accessibilityLabel={`Suggest meeting at ${shownTitle}`}
            onPress={() => { void proposeMeetHere(); }}
          >
            <MapPin size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>Meet here</Text>
          </Pressable>
  );
  const saveButton = (
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            testID="discovery-card-save" onPress={async () => {
              const viaTelegraph = await saveDiscoveryCardViaTelegraph(payload); if (viaTelegraph.kind === 'saved') { Alert.alert('Saved', viaTelegraph.message); return; } if (viaTelegraph.kind !== 'fallback') { Alert.alert('Could not save', viaTelegraph.message); return; }  // census-discovery §95 (A21, §81.4 R1): a Telegraph command first; with the server's telegraph_discovery_actions_enabled off it answers feature_disabled and the real save via discovery bookmarks below runs, unchanged (no fake success alerts)
              try {
                const res = await toggleSave({
                  id: payload.sourceId,
                  name: shownTitle,
                  category: payload.category,
                  type: payload.sourceType ?? null,
                  address: payload.city ?? null,
                  savedAt: Date.now(),
                });
                Alert.alert(
                  res.added ? 'Saved' : 'Removed',
                  res.added
                    ? `"${shownTitle}" was added to your saved places.`
                    : `"${shownTitle}" was removed from your saved places.`,
                );
              } catch {
                Alert.alert('Could not save', 'Please try again.');
              }
            }}
          >
            <Bookmark size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>Save</Text>
          </Pressable>
  );

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
              {chipLabel}
            </Text>
          </View>
        </View>

        {/* Thumbnail — may be a post-media reference for community photos,
            so it hydrates and shows a visible state when it cannot load. */}
        {shownImage ? (
          <DisplayMediaImage
            uri={shownImage}
            width={CARD_MAX_WIDTH}
            height={THUMBNAIL_HEIGHT}
            resizeMode="cover"
            style={card.thumbnail}
            alt={shownTitle}
          />
        ) : null}

        {/* Title */}
        <Text style={[card.title, mine && card.titleMine]} numberOfLines={2}>
          {shownTitle}
        </Text>

        {/* Location */}
        <View style={card.locRow}>
          <MapPin size={11} color={mine ? color.onInk + 'AA' : color.mute} />
          <Text style={[card.loc, mine && card.locMine]} numberOfLines={1}>{shownPlace ?? ''}</Text>
          {shownPrice ? (
            <Text style={[card.price, mine && card.priceMine]}> · {shownPrice}</Text>
          ) : null}
        </View>

        {/* Blurb */}
        {shownBlurb ? (
          <Text style={[card.blurb, mine && card.blurbMine]} numberOfLines={2}>
            {shownBlurb}
          </Text>
        ) : null}

        {/* Caption from sender */}
        {payload.caption ? (
          <Text style={[card.caption, mine && card.captionMine]} numberOfLines={2}>
            "{payload.caption}"
          </Text>
        ) : null}

        {/* Action row — derived from the server's CURRENT actions for this viewer
            (legacyCardView.offeredCardActions), never from the frozen payload. */}
        <View style={card.actions}>
          <Pressable
            style={[card.actionBtn, mine && card.actionBtnMine]}
            testID="discovery-card-view"
            onPress={() => router.push(
              projection
                ? (projection.deepLink as Href)
                : payload.sourceId
                  ? (`/(tabs)/discovery?placeId=${encodeURIComponent(payload.sourceId)}` as Href)
                  : ('/(tabs)/discovery' as Href)
            )}
          >
            <ExternalLink size={11} color={mine ? color.onInk : color.signal} />
            <Text style={[card.actionLabel, mine && card.actionLabelMine]}>View</Text>
          </Pressable>
          {offered.addToTrip ? <><View style={[card.divider, mine && card.dividerMine]} />{addToPlanButton}</> : null}
          {offered.meetHere ? <><View style={[card.divider, mine && card.dividerMine]} />{meetHereButton}</> : null}
          {offered.save ? <><View style={[card.divider, mine && card.dividerMine]} />{saveButton}</> : null}
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
    maxWidth: CARD_MAX_WIDTH,
  },
  wrapMine: {
    backgroundColor: color.signal,
    borderColor: color.signal,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: 4,
  },
  /** §5.3 revoked state — dashed, unfilled, carrying nothing from the source. */
  wrapRevoked: {
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  fallback: { ...t.small, color: color.mute, fontStyle: 'italic' },
  thumbnail: {
    width: '100%',
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
