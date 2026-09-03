/**
 * MapEntityActionRow — horizontal action row rendered below the per-type card
 * body in MapEntityPreviewCard and MapCarousel cards.
 *
 * Driven entirely by `entity.actionCapabilities` (populated by Phase 1 store).
 * Each button delegates to an existing canonical flow — no save/share/report/
 * block logic is re-implemented here.
 *
 * People-actions (message / follow / report / block) additionally respect
 * `entity.permissions`.  Block is never rendered for venue/place/gem/trip/
 * event entities even if the capability is present.
 *
 * After a mutating action (join, save, follow) the component dispatches
 * to the map store so the card reflects the new state on remount (e.g. after
 * a camera pan).  For follow, the store persists the toggled state so
 * useFollow can seed the icon instantly before the getFollowStatus fetch
 * completes.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Share,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import {
  Navigation,
  CalendarPlus,
  CalendarCheck,
  UserPlus,
  UserMinus,
  Briefcase,
  MessageCircle,
  Flag,
  Ban,
} from 'lucide-react-native';
import { StampIcon } from '../stamps/StampIcon.tsx';
import { PortavaShareIcon } from '../icons/PortavaShareIcon.tsx';
import { canonicalUrl } from '../../constants/canonicalUrl.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { MapEntity, MapEntityType } from '../../types/mapTypes.ts';
import type { ModerationSubjectType } from '../../services/moderation.ts';
import { openInMaps } from '../../lib/openInMaps.ts';
import { openDirectThread } from '../../services/messaging.ts';
import { rsvpEvent } from '../../services/events.ts';
import { useFollow } from '../../hooks/useFollow.ts';
import { useBlockUser } from '../../hooks/useBlockUser.ts';
import { usePlanPicker } from '../PlanPickerController.tsx';
import { useOptionalMapStore } from '../../stores/mapStore.tsx';
import { TripWishlistPicker } from '../discovery/TripWishlistPicker.tsx';
import type { AddToTripPayload } from '../discovery/TripWishlistPicker.tsx';
import { ReportSheet } from '../ReportSheet.tsx';
import {
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../types/mapObjects.ts';
import {
  buddyCardPayload,
  friendCardPayload,
  gemCardPayload,
  isMapObject,
  objectOf,
  tripCardPayload,
} from '../../types/mapCardPayloads.ts';
import {
  countBucket,
  currentDecisionId,
  describeMapObject,
  distanceBucket,
  emitMapEvent,
  type MapObjectRef,
} from '../../features/map/telemetry/mapTelemetry.ts';

// ── §35 telemetry: recovering a contract object from the legacy envelope ──────
//
// `describeMapObject` is the ONLY sanctioned way to put an object into a §35
// payload — it coarsens geometry to a ~4.9 km cell, withholds identity-bearing
// kinds and drops title/contributor. It takes a `MapObject`, and this component
// is on the LEGACY `MapEntity` path, so the object has to be recovered first.
//
// Two cases:
//   • Projection path — `mapObjectToEntity` keeps the whole `MapObject` on
//     `payload`. Describe THAT: privacyClass, freshness and confidence are then
//     the projection's own recorded values rather than a guess here.
//   • Legacy producers — the envelope carries no §23 rung at all, so one is
//     derived from the layer below, conservatively, and documented as derived.
//
// NOTE: this helper is duplicated in MapCarousel.tsx and MapEntityPreviewCard.tsx
// rather than shared. Every candidate host module is wholesale `jest.mock`ed by
// one of the existing component tests (a mocked module would export `undefined`
// for it), and this lane may not add files. It should move to
// features/map/telemetry/ when that constraint lifts.

/** Legacy layer → §18 contract kind. */
const TELEMETRY_KIND_BY_TYPE: Record<MapEntityType, MapObjectKind> = {
  places: 'place',
  events: 'event',
  gems: 'hidden_gem',
  trips: 'trip_stop',
  friends: 'crew_member',
  buddies: 'buddy_zone',
  travelers: 'social_zone',
  stamps: 'memory',
};

/**
 * DERIVED §23 rung for legacy envelopes, which record none. Chosen as the
 * coarsest rung the layer's own UI already claims: places/events/gems/trips
 * publish the venue's real coordinate, the Friends card states "area level
 * only", travelers and passport pins are aggregates.
 */
const TELEMETRY_PRIVACY_BY_TYPE: Record<MapEntityType, PrivacyClass> = {
  places: 'place_level',
  events: 'place_level',
  gems: 'place_level',
  trips: 'place_level',
  friends: 'approximate',
  buddies: 'approximate',
  travelers: 'aggregate_only',
  stamps: 'aggregate_only',
};

function entityTelemetryRef(entity: MapEntity): MapObjectRef {
  if (isMapObject(entity.payload)) return describeMapObject(entity.payload);
  return describeMapObject({
    id: entity.id,
    kind: TELEMETRY_KIND_BY_TYPE[entity.type],
    geometry: { type: 'Point', coordinates: [entity.lng, entity.lat] },
    // Never a real name: describeMapObject drops title, and supplying one here
    // would put a place name one refactor away from a payload.
    title: '',
    privacyClass: TELEMETRY_PRIVACY_BY_TYPE[entity.type],
    renderingPriority: 0,
  });
}

/** Distance the projection already computed, when there is one. */
function entityDistanceKm(entity: MapEntity): number | null {
  if (!isMapObject(entity.payload)) return null;
  const d = entity.payload.distanceKm;
  return typeof d === 'number' ? d : null;
}

/** Telemetry is fire-and-forget: it may never block or break a user action. */
function fireAndForget(emit: () => void): void {
  try {
    emit();
  } catch {
    // Deliberately swallowed.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Reading the entity ────────────────────────────────────────────────────────
//
// These used to read `entity.payload.userId` / `.displayName` / `.title` / `.name`
// through `as any`. Once the producers switched to emitting `MapObject`, none of
// those fields existed any more: every buddy was "Local Buddy", every gem was
// "Hidden Gem", and `userId` was undefined — so Message, Follow and Block acted
// on a null user. Nothing threw and nothing failed to compile, which is exactly
// why it survived. Everything below now comes from the projection.

/** Extract the userId from person-type entities; null otherwise. */
function getEntityUserId(entity: MapEntity): string | null {
  const obj = objectOf(entity);
  if (!obj) return null;
  if (obj.kind === 'buddy_zone') return buddyCardPayload(obj)?.userId ?? null;
  if (obj.kind === 'crew_member') return friendCardPayload(obj)?.userId ?? null;
  return null;
}

/** Human-readable display name for the entity. */
function getEntityName(entity: MapEntity): string {
  const obj = objectOf(entity);
  // Every projected object carries a non-empty title (isRenderable enforces it).
  if (obj) return obj.title;
  const p = entity.payload;
  if (p != null && typeof p === 'object') {
    const name = (p as { name?: unknown }).name;
    if (typeof name === 'string' && name !== '') return name;
    const country = (p as { country?: unknown }).country;
    if (typeof country === 'string' && country !== '') return country;
  }
  return 'Place';
}

/**
 * The DOMAIN id an action acts on — the buddy listing, the gem, the trip, the
 * place. NOT the map object's id: a projected object's id is namespaced
 * (`gem:abc`, `trip:t1`) so two sources can never collide, and passing that to
 * a save or a report addresses a row that does not exist.
 */
function getEntitySubjectId(entity: MapEntity): string {
  const obj = objectOf(entity);
  if (obj) {
    switch (obj.kind) {
      case 'buddy_zone': {
        const p = buddyCardPayload(obj);
        if (p) return p.buddyId;
        break;
      }
      case 'trip_stop': {
        const p = tripCardPayload(obj);
        if (p) return p.tripId;
        break;
      }
      case 'crew_member': {
        const p = friendCardPayload(obj);
        if (p) return p.userId;
        break;
      }
      default:
        break;
    }
    // Gems and events do not carry a bare id on `payload`, but the namespaced
    // object id is `<source>:<domain id>` by construction — see the projectors.
    const sep = obj.id.indexOf(':');
    return sep >= 0 ? obj.id.slice(sep + 1) : obj.id;
  }
  const p = entity.payload;
  const raw = p != null && typeof p === 'object' ? (p as { id?: unknown }).id : undefined;
  return typeof raw === 'string' && raw !== '' ? raw : entity.id;
}

/** The city an action should file this entity under, when the projection has one. */
function entityCity(entity: MapEntity): string | undefined {
  const obj = objectOf(entity);
  if (obj) {
    if (obj.kind === 'buddy_zone') return buddyCardPayload(obj)?.city ?? undefined;
    if (obj.kind === 'trip_stop') return tripCardPayload(obj)?.destinationCity ?? undefined;
    if (obj.kind === 'hidden_gem') return gemCardPayload(obj)?.city ?? undefined;
    if (obj.kind === 'crew_member') return friendCardPayload(obj)?.city ?? undefined;
    return undefined;
  }
  const p = entity.payload;
  if (p != null && typeof p === 'object') {
    const city = (p as { city?: unknown }).city;
    if (typeof city === 'string' && city !== '') return city;
  }
  return undefined;
}

/** Map entity type to moderation subject type for ReportSheet. */
function getModerationSubjectType(entityType: MapEntityType): ModerationSubjectType {
  switch (entityType) {
    case 'events':  return 'event';
    case 'buddies': return 'buddy_listing';
    case 'friends': return 'user';
    default:        return 'post'; // gems/trips don't have report by default
  }
}

/** Build the AddToTripPayload needed by TripWishlistPicker. */
function buildSavePayload(entity: MapEntity): AddToTripPayload {
  return {
    id: getEntitySubjectId(entity),
    name: getEntityName(entity),
    category: entity.type === 'gems' ? 'hidden_gem' : entity.type,
    lat: entity.lat,
    lng: entity.lng,
  };
}

/** Entity types that represent a real person (user-level actions apply). */
const PERSON_TYPES: MapEntityType[] = ['buddies', 'friends'];

// ── Sub-component: individual action button ───────────────────────────────────

interface ActionBtnProps {
  testID?: string;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

function ActionBtn({ testID, icon, label, onPress, disabled, destructive }: ActionBtnProps) {
  return (
    <Pressable
      testID={testID}
      style={({ pressed }) => [
        s.btn,
        pressed && s.btnPressed,
        disabled && s.btnDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon}
      <Text style={[s.btnLabel, destructive && s.destructiveLabel]}>{label}</Text>
    </Pressable>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface MapEntityActionRowProps {
  entity: MapEntity;
  /** Called immediately before any detail push so the map screen can record
   *  the navigation origin and restore state correctly on back-nav. */
  onBeforeNavigate?: () => void;
  /**
   * True when this card is one of the options an active Compass decision
   * offered (§35). ONLY then may an action here also count as
   * `recommendation_accepted` — without it there is no honest way to tell a
   * recommendation the user took from an unrelated place they happened to act
   * on while a decision was still open. MapCarousel threads it down from its
   * own `compassResults` prop.
   */
  isRecommendation?: boolean;
}

export function MapEntityActionRow({ entity, onBeforeNavigate, isRecommendation }: MapEntityActionRowProps) {
  const caps = entity.actionCapabilities ?? [];

  // Render nothing when there are no capabilities.
  if (caps.length === 0) return null;

  return (
    <ActionRowInner
      entity={entity}
      onBeforeNavigate={onBeforeNavigate}
      isRecommendation={isRecommendation}
    />
  );
}

/**
 * Inner component so hooks are always called in the same order (the outer
 * early-return guard cannot be above hook calls in React).
 */
function ActionRowInner({
  entity,
  onBeforeNavigate,
  isRecommendation,
}: {
  entity: MapEntity;
  onBeforeNavigate?: () => void;
  isRecommendation?: boolean;
}) {
  const baseCaps = entity.actionCapabilities ?? [];
  const perms = entity.permissions;
  const isPersonEntity = PERSON_TYPES.includes(entity.type);

  // Derived from the projection — never from a raw row.
  const rawEntityId: string = getEntitySubjectId(entity);
  const entityName = getEntityName(entity);
  const userId = getEntityUserId(entity);

  // ── Hooks (unconditional) ─────────────────────────────────────────────────

  // Map store — may be null when the component is rendered outside a map
  // session (e.g. in unit tests or non-map surfaces).
  const mapStore = useOptionalMapStore();

  // Seed from the store so the icon is correct instantly on remount, before
  // the getFollowStatus round-trip completes.
  const storedFollowState: boolean | undefined = mapStore?.entityFollowState[entity.id];
  const followState = useFollow(userId, {
    initialIsFollowing: storedFollowState,
  });

  const { doBlock, loading: blockLoading } = useBlockUser();
  const { open: openPlanPicker, isAdded } = usePlanPicker();

  // ── §35 decision outcomes ─────────────────────────────────────────────────
  //
  // `recommendation_accepted` is emitted ALONGSIDE the concrete action, never
  // instead of it, and only when BOTH are true: this card was a Compass option
  // (isRecommendation) and a decision is still active in the emitter. The
  // decisionId is auto-attached, so the accept, the route and any later
  // contribution all land on the id `compass_requested` minted.
  const emitAccepted = useCallback(
    (via: 'route' | 'trip_stop' | 'meet_here' | 'save' | 'plan_join' | 'open') => {
      if (!isRecommendation) return;
      if (currentDecisionId() === null) return;
      emitMapEvent('recommendation_accepted', { ref: entityTelemetryRef(entity), via });
    },
    [entity, isRecommendation],
  );

  // Effective capabilities: store patch wins over entity's initial caps so
  // post-mutation state survives card unmount/remount (e.g. camera pan).
  const caps: typeof baseCaps =
    (mapStore?.entityCapabilityPatches[entity.id]) ?? baseCaps;

  // Sheet visibility — only business state that lives here.
  const [wishlistOpen, setWishlistOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // Optimistic RSVP state, set when the user RSVPs during this session so the
  // button still reads 'Going' / 'Waitlisted' if the card is re-opened.
  //
  // It is no longer SEEDED from the payload: this used to read
  // `payload.myRsvp` / `payload.myWaitlistPosition` off a raw EventListItem, and
  // the event projection emits neither — so the seed had been silently dead
  // since the producers switched to MapObject. Restoring it means adding the
  // viewer's RSVP to `projectEvent`; see docs/map-card-projection-gaps.md.
  const [rsvpState, setRsvpState] = useState<'going' | 'waitlisted' | null>(null);

  // ── Button visibility ─────────────────────────────────────────────────────
  const showSave       = caps.includes('save');
  const showShare      = caps.includes('share');
  const showDirections = caps.includes('directions');
  const showAddToTrip  = caps.includes('add_to_trip');
  const showJoin       = caps.includes('join');
  const showFollow     = caps.includes('follow') && (perms?.canFollow !== false);
  const showBook       = caps.includes('book');
  const showMessage    = caps.includes('message') && (perms?.canMessage !== false);
  const showReport     = caps.includes('report') && (perms?.canReport !== false);
  // Block requires explicit permission AND a person entity.
  const showBlock      = caps.includes('block') && isPersonEntity && (perms?.canBlock === true);

  // ── Action handlers ───────────────────────────────────────────────────────

  const handleShare = useCallback(async () => {
    const detailPath = (entity as any).detailRoute ?? '';
    try {
      await Share.share({
        message: `Check out ${entityName} on Portava!\n${canonicalUrl(detailPath)}`,
      });
    } catch {
      // User cancelled or share unavailable — silent.
    }
  }, [entity, entityName]);

  const handleMessage = useCallback(async () => {
    if (!userId) return;
    const res = await openDirectThread(userId);
    if (res.ok && res.data?.threadId) {
      // Call only when push is confirmed — a failed lookup must not set the
      // back-nav flag and cause the next tab-switch to skip stale-selection clearing.
      onBeforeNavigate?.();
      router.push(
        `/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(userId)}` as any,
      );
    } else {
      Alert.alert('Could not open conversation', 'Please try again.');
    }
  }, [userId, onBeforeNavigate]);

  const handleJoin = useCallback(async () => {
    const res = await rsvpEvent(rawEntityId, 'going');
    if (!res.ok) {
      Alert.alert('Could not RSVP', (res as any).message ?? 'Please try again.');
    } else if ((res.data as any)?.status === 'waitlisted') {
      // Event is full — user was placed on the waitlist instead of confirmed.
      setRsvpState('waitlisted');
      const pos: number | undefined = (res.data as any)?.position ?? (res.data as any)?.myWaitlistPosition;
      const posText = pos != null ? ` You are #${pos} on the waitlist.` : '';
      Alert.alert("You're on the waitlist", `The event is full.${posText} We'll notify you if a spot opens up.`);
      // Remove 'join' from capabilities so the button is hidden on remount.
      mapStore?.updateEntityCapabilities(
        entity.id,
        caps.filter((c) => c !== 'join'),
      );
    } else {
      setRsvpState('going');
      // §35 `plan_joined` — emitted only on the CONFIRMED branch. A waitlist
      // placement is not a join, so it deliberately does not fire above.
      fireAndForget(() => {
        emitAccepted('plan_join');
        emitMapEvent('plan_joined', {
          ref: entityTelemetryRef(entity),
          planKind: 'event',
          // The event projection carries no attendee count, so the only
          // participant this card can honestly attest to is the joiner. A
          // floor of 1, never an invented total.
          participants: countBucket(1),
          discovery: isRecommendation ? 'compass' : 'map',
        });
      });
      Alert.alert("You're going!", 'Your RSVP has been confirmed.');
      // Remove 'join' from capabilities so the button is hidden on remount
      // (the user has already RSVPed and shouldn't see the button again).
      mapStore?.updateEntityCapabilities(
        entity.id,
        caps.filter((c) => c !== 'join'),
      );
    }
  }, [rawEntityId, mapStore, entity, caps, emitAccepted, isRecommendation]);

  const handleFollowToggle = useCallback(async () => {
    const succeeded = await followState.toggle();
    if (succeeded && mapStore) {
      // Persist the new follow state so the icon is correct on remount without
      // waiting for a getFollowStatus round-trip.
      mapStore.setEntityFollowState(entity.id, !followState.isFollowing);
    }
  }, [followState, mapStore, entity.id]);

  const handleBlock = useCallback(() => {
    if (!userId) return;
    Alert.alert('Block user?', 'They will no longer be able to contact you.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Block',
        style: 'destructive',
        onPress: () => { doBlock(userId); },
      },
    ]);
  }, [userId, doBlock]);

  // ── §35 `trip_stop_added` ─────────────────────────────────────────────────
  //
  // The Add-to-plan button OPENS a picker; it does not add anything. Emitting
  // on the press would record an add for every user who opened the sheet and
  // cancelled. PlanPickerController marks a source id added only after the
  // write succeeds, so the honest signal is that flag flipping true — and only
  // while THIS row is the one waiting on the picker it opened, so an add made
  // later from another surface is not claimed by the map.
  const awaitingPlanAddRef = useRef(false);
  const planAdded = isAdded(rawEntityId);
  const lastPlanAddedRef = useRef(planAdded);
  useEffect(() => {
    const wasAdded = lastPlanAddedRef.current;
    lastPlanAddedRef.current = planAdded;
    if (!planAdded || wasAdded || !awaitingPlanAddRef.current) return;
    awaitingPlanAddRef.current = false;
    fireAndForget(() => {
      emitAccepted('trip_stop');
      emitMapEvent('trip_stop_added', {
        ref: entityTelemetryRef(entity),
        // dayIndex / slotIndex are the picker's, not this row's — omitted
        // rather than defaulted to a zero nobody chose.
        source: isRecommendation ? 'compass_pick' : 'action_rail',
      });
    });
  }, [planAdded, entity, emitAccepted, isRecommendation]);

  const savePayload = buildSavePayload(entity);
  const subjectType = getModerationSubjectType(entity.type);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <View style={s.row} testID="map-action-row">
        {showSave && (
          <ActionBtn
            testID="map-action-save"
            icon={<StampIcon size={15} color={color.signal} />}
            label="Save"
            onPress={() => setWishlistOpen(true)}
          />
        )}
        {showShare && (
          <ActionBtn
            testID="map-action-share"
            icon={<PortavaShareIcon size={15} color={color.mute} />}
            label="Share"
            onPress={handleShare}
          />
        )}
        {showDirections && (
          <ActionBtn
            testID="map-action-directions"
            icon={<Navigation size={15} color={color.mute} />}
            label="Directions"
            onPress={() => {
              // §35 `route_started`, emitted BEFORE the handoff. openInMaps
              // hands the route to the platform maps app, so `external` is
              // genuinely true here; travelMode is the external app's to choose
              // and eta is unknown, so neither is invented.
              fireAndForget(() => {
                emitAccepted('route');
                emitMapEvent('route_started', {
                  ref: entityTelemetryRef(entity),
                  travelMode: 'unknown',
                  distance: distanceBucket(entityDistanceKm(entity)),
                  external: true,
                });
              });
              openInMaps(entity.lat, entity.lng);
            }}
          />
        )}
        {showAddToTrip && (
          <ActionBtn
            testID="map-action-add-to-trip"
            icon={<CalendarPlus size={15} color={color.mute} />}
            label="Add to plan"
            onPress={() => {
              // Arm the confirmation watcher above; the event fires only if the
              // picker actually adds the stop.
              awaitingPlanAddRef.current = true;
              openPlanPicker({
                id: rawEntityId,
                type: entity.type,
                title: entityName,
                city: entityCity(entity),
                category: entity.type,
              });
            }}
          />
        )}
        {showJoin && (
          <ActionBtn
            testID="map-action-join"
            icon={
              rsvpState === 'going'
                ? <CalendarCheck size={15} color={color.signal} />
                : rsvpState === 'waitlisted'
                  ? <CalendarCheck size={15} color={color.mute} />
                  : <CalendarPlus size={15} color={color.mute} />
            }
            label={
              rsvpState === 'going'
                ? 'Going'
                : rsvpState === 'waitlisted'
                  ? 'Waitlisted'
                  : 'Join'
            }
            onPress={handleJoin}
            disabled={rsvpState != null}
          />
        )}
        {showFollow && (
          <ActionBtn
            testID="map-action-follow"
            icon={
              followState.isFollowing
                ? <UserMinus size={15} color={color.mute} />
                : <UserPlus size={15} color={color.mute} />
            }
            label={followState.isFollowing ? 'Unfollow' : 'Follow'}
            onPress={handleFollowToggle}
            disabled={followState.toggling}
          />
        )}
        {showBook && (
          <ActionBtn
            testID="map-action-book"
            icon={<Briefcase size={15} color={color.signal} />}
            label="Book"
            onPress={() => { onBeforeNavigate?.(); router.push(`/(rent-a-buddy)/buddy/${rawEntityId}` as any); }}
          />
        )}
        {showMessage && (
          <ActionBtn
            testID="map-action-message"
            icon={<MessageCircle size={15} color={color.mute} />}
            label="Message"
            onPress={handleMessage}
          />
        )}
        {showReport && (
          <ActionBtn
            testID="map-action-report"
            icon={<Flag size={15} color={color.mute} />}
            label="Report"
            onPress={() => setReportOpen(true)}
          />
        )}
        {showBlock && (
          <ActionBtn
            testID="map-action-block"
            icon={<Ban size={15} color="#DC2626" />}
            label="Block"
            onPress={handleBlock}
            destructive
          />
        )}
      </View>

      {/* Sheets — mount unconditionally; visibility controlled by state */}
      <TripWishlistPicker
        visible={wishlistOpen}
        place={wishlistOpen ? savePayload : null}
        onClose={() => setWishlistOpen(false)}
      />
      <ReportSheet
        visible={reportOpen}
        subjectType={subjectType}
        subjectId={rawEntityId}
        subjectUserId={userId}
        subjectName={entityName}
        onClose={() => setReportOpen(false)}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: space.xs,
    paddingTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  btnPressed: {
    opacity: 0.7,
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnLabel: {
    ...t.small,
    fontSize: 12,
    fontWeight: '600',
    color: color.ink,
  },
  destructiveLabel: {
    color: '#DC2626',
  },
});
