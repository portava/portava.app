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
 * updateEntityCapabilities to the map store so the card reflects the new state
 * on remount (e.g. after a camera pan).  For follow, useFollow already
 * re-fetches from the server on mount, so the icon is correct without a
 * capability change; the store dispatch is omitted for that case.
 */
import React, { useState, useCallback } from 'react';
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
  Heart,
  Share2,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the userId from person-type entities; null otherwise. */
function getEntityUserId(entity: MapEntity): string | null {
  const p = entity.payload as any;
  switch (entity.type) {
    case 'buddies': return p.userId ?? null;
    case 'friends': return p.userId ?? null;
    default: return null;
  }
}

/** Human-readable display name for the entity. */
function getEntityName(entity: MapEntity): string {
  const p = entity.payload as any;
  switch (entity.type) {
    case 'buddies': return p.displayName ?? 'Local Buddy';
    case 'events':  return p.title ?? 'Event';
    case 'gems':    return p.name ?? 'Hidden Gem';
    case 'trips':   return p.title ?? 'Trip';
    case 'friends': return p.name ?? 'Friend';
    default:        return 'Place';
  }
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
  const p = entity.payload as any;
  return {
    id: p.id ?? entity.id,
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
}

export function MapEntityActionRow({ entity }: MapEntityActionRowProps) {
  const caps = entity.actionCapabilities ?? [];

  // Render nothing when there are no capabilities.
  if (caps.length === 0) return null;

  return <ActionRowInner entity={entity} />;
}

/**
 * Inner component so hooks are always called in the same order (the outer
 * early-return guard cannot be above hook calls in React).
 */
function ActionRowInner({ entity }: { entity: MapEntity }) {
  const baseCaps = entity.actionCapabilities ?? [];
  const perms = entity.permissions;
  const isPersonEntity = PERSON_TYPES.includes(entity.type);

  // Extract derived values from the payload.
  const entityPayload = entity.payload as any;
  const rawEntityId: string = entityPayload.id ?? entity.id;
  const entityName = getEntityName(entity);
  const userId = getEntityUserId(entity);

  // ── Hooks (unconditional) ─────────────────────────────────────────────────
  const followState = useFollow(userId);
  const { doBlock, loading: blockLoading } = useBlockUser();
  const { open: openPlanPicker } = usePlanPicker();

  // Map store — may be null when the component is rendered outside a map
  // session (e.g. in unit tests or non-map surfaces).
  const mapStore = useOptionalMapStore();

  // Effective capabilities: store patch wins over entity's initial caps so
  // post-mutation state survives card unmount/remount (e.g. camera pan).
  const caps: typeof baseCaps =
    (mapStore?.entityCapabilityPatches[entity.id]) ?? baseCaps;

  // Sheet visibility — only business state that lives here.
  const [wishlistOpen, setWishlistOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // Optimistic RSVP state — flips to true after a successful rsvpEvent call.
  // Resets when the component unmounts (user navigated away); server is source
  // of truth on re-mount.
  const [rsvpDone, setRsvpDone] = useState(false);

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
        message: `Check out ${entityName} on Travel Buddy!\nhttps://travelbuddy.app${detailPath}`,
      });
    } catch {
      // User cancelled or share unavailable — silent.
    }
  }, [entity, entityName]);

  const handleMessage = useCallback(async () => {
    if (!userId) return;
    const res = await openDirectThread(userId);
    if (res.ok && res.data?.threadId) {
      router.push(
        `/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(userId)}` as any,
      );
    } else {
      Alert.alert('Could not open conversation', 'Please try again.');
    }
  }, [userId]);

  const handleJoin = useCallback(async () => {
    const res = await rsvpEvent(rawEntityId, 'going');
    if (!res.ok) {
      Alert.alert('Could not RSVP', (res as any).message ?? 'Please try again.');
    } else {
      setRsvpDone(true);
      Alert.alert("You're going!", 'Your RSVP has been confirmed.');
      // Remove 'join' from capabilities so the button is hidden on remount
      // (the user has already RSVPed and shouldn't see the button again).
      mapStore?.updateEntityCapabilities(
        entity.id,
        caps.filter((c) => c !== 'join'),
      );
    }
  }, [rawEntityId, mapStore, entity.id, caps]);

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

  const savePayload = buildSavePayload(entity);
  const subjectType = getModerationSubjectType(entity.type);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <View style={s.row} testID="map-action-row">
        {showSave && (
          <ActionBtn
            testID="map-action-save"
            icon={<Heart size={15} color={color.signal} />}
            label="Save"
            onPress={() => setWishlistOpen(true)}
          />
        )}
        {showShare && (
          <ActionBtn
            testID="map-action-share"
            icon={<Share2 size={15} color={color.mute} />}
            label="Share"
            onPress={handleShare}
          />
        )}
        {showDirections && (
          <ActionBtn
            testID="map-action-directions"
            icon={<Navigation size={15} color={color.mute} />}
            label="Directions"
            onPress={() => openInMaps(entity.lat, entity.lng)}
          />
        )}
        {showAddToTrip && (
          <ActionBtn
            testID="map-action-add-to-trip"
            icon={<CalendarPlus size={15} color={color.mute} />}
            label="Add to plan"
            onPress={() =>
              openPlanPicker({
                id: rawEntityId,
                type: entity.type,
                title: entityName,
                city: entityPayload.city ?? entityPayload.destinationCity,
                category: entity.type,
              })
            }
          />
        )}
        {showJoin && (
          <ActionBtn
            testID="map-action-join"
            icon={
              rsvpDone
                ? <CalendarCheck size={15} color={color.signal} />
                : <CalendarPlus size={15} color={color.mute} />
            }
            label={rsvpDone ? 'Going' : 'Join'}
            onPress={handleJoin}
            disabled={rsvpDone}
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
            onPress={followState.toggle}
            disabled={followState.toggling}
          />
        )}
        {showBook && (
          <ActionBtn
            testID="map-action-book"
            icon={<Briefcase size={15} color={color.signal} />}
            label="Book"
            onPress={() => router.push(`/(rent-a-buddy)/buddy/${entityPayload.id}` as any)}
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
