/**
 * CheckpointPin — the §6 semantic markers for Locate My Friends.
 *
 * Spec §6's "Map Zones and Semantic Visual Language" table assigns exactly one
 * meaning to each mark. Three rows matter here:
 *
 *     Checkpoint pin  →  Meeting point
 *     Ring            →  Approximate location
 *     Avatar          →  Permitted identified presence ONLY
 *
 * The last row is the one worth encoding rather than trusting. §23 says
 * identity may render only at `approximate` or above, and §37 forbids a public
 * real-time people tracker — so `MemberPresenceMarker` asks
 * `mayRenderIdentity()` and there is NO prop that overrides the answer. A member
 * whose rung forbids identity gets a ring, and cannot be made to render an
 * avatar by a caller who passes the wrong flag, because there is no such flag.
 *
 * Dark-mode first (§4): near-black chrome, bright semantic overlay above it.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';

import { color, radius, space, typography, avatar, icon } from '../../theme/tokens.ts';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';
import { mayRenderIdentity, type PrivacyClass } from '../../types/mapObjects.ts';
import type { LocateMemberState } from '../../features/map/presence/locateFriends.ts';

/** §4: the map chrome is near-black/navy so Portava overlays read above it. */
const CHROME = '#0B1017';
const CHROME_EDGE = 'rgba(250,249,246,0.16)';

// ── Checkpoint pin (§6 "Checkpoint pin → Meeting point") ──────────────────────

export interface CheckpointPinProps {
  label: string;
  /** Marks the checkpoint the group is currently heading for. */
  active?: boolean;
  /** Hides the label when the map is zoomed out and the pin must stay small. */
  compact?: boolean;
  onPress?: () => void;
  testID?: string;
}

/**
 * A meeting point the group published on purpose. It is a PLACE, not a person:
 * it carries no freshness decay, no ring, and no identity — which is exactly
 * why it is safe to draw at full precision when nobody's position is.
 */
export function CheckpointPin({
  label,
  active = false,
  compact = false,
  onPress,
  testID,
}: CheckpointPinProps) {
  const body = (
    <View style={s.checkpointWrap} testID={testID}>
      <View style={[s.checkpointHead, active && s.checkpointHeadActive]}>
        <MapPin
          size={icon.s16}
          color={active ? color.ink : color.onInk}
          strokeWidth={2.4}
        />
      </View>
      <View style={[s.checkpointStem, active && s.checkpointStemActive]} />
      {!compact && (
        <View style={s.checkpointLabelWrap}>
          <Text style={s.checkpointLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={space.md}
      accessibilityRole="button"
      accessibilityLabel={`Checkpoint: ${label}`}
    >
      {body}
    </Pressable>
  );
}

// ── Ring (§6 "Ring → Approximate location") ───────────────────────────────────

export interface ApproximateRingProps {
  /**
   * Diameter in points. The ring is intentionally larger than an avatar: its
   * whole job is to look like an AREA rather than a point, so that a viewer
   * never reads it as a fix.
   */
  size?: number;
  /** Dimmed treatment for a last-known / stale position (§7, §37). */
  stale?: boolean;
  /** Optional initial shown inside the ring — never a photo (§23). */
  initial?: string | null;
  testID?: string;
}

/**
 * The §6 ring. Deliberately hollow: an outline reads as "somewhere in here",
 * where a filled dot reads as "here". At most a single initial goes inside, and
 * only when the caller already established that the member is nameable — a
 * photo would be identity, which is what the ring exists instead of.
 */
export function ApproximateRing({
  size = avatar.s44,
  stale = false,
  initial = null,
  testID,
}: ApproximateRingProps) {
  return (
    <View
      testID={testID}
      accessibilityLabel="Approximate location"
      style={[
        s.ring,
        {
          width: size,
          height: size,
          borderColor: stale ? 'rgba(250,249,246,0.34)' : color.signal,
        },
        stale && s.ringStale,
      ]}
    >
      <View
        style={[
          s.ringCore,
          { backgroundColor: stale ? 'rgba(250,249,246,0.10)' : 'rgba(255,77,46,0.16)' },
        ]}
      />
      {initial ? <Text style={s.ringInitial}>{initial}</Text> : null}
    </View>
  );
}

// ── The marker that chooses between them ──────────────────────────────────────

export interface MemberPresenceMarkerProps {
  member: LocateMemberState;
  size?: number;
  onPress?: () => void;
  testID?: string;
}

/**
 * §23, made structural: `mayRenderIdentity(privacyClass)` decides, and nothing
 * else can. At `approximate` or below the member is a ring; at `place_level` or
 * above, and only there, an avatar.
 *
 * Note the asymmetry with `mayRenderIdentity` itself, which permits identity
 * from `approximate` upward — a NAME may appear next to an approximate member
 * (§12's "Nearby ~40-80m" is attached to someone), but the §6 table reserves
 * the AVATAR mark for identified presence at a place. Drawing a face on an
 * approximate ring would claim a precision the geometry does not have, so the
 * marker is stricter than the label.
 */
export function MemberPresenceMarker({
  member,
  size = avatar.s44,
  onPress,
  testID,
}: MemberPresenceMarkerProps) {
  const cls: PrivacyClass = member.resolved.privacyClass;
  const nameable = mayRenderIdentity(cls);
  const initial =
    nameable && member.displayName ? member.displayName.trim().charAt(0).toUpperCase() : null;
  const stale = member.resolved.freshness !== 'live' && member.resolved.freshness !== 'recent';

  const asAvatar = renderAsAvatar(cls) && !!member.avatarUrl;

  const body = asAvatar ? (
    <View style={[s.avatarWrap, stale && s.avatarStale]} testID={testID}>
      <AvatarImage uri={member.avatarUrl ?? undefined} size={size} />
    </View>
  ) : (
    <ApproximateRing size={size} stale={stale} initial={initial} testID={testID} />
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      hitSlop={space.sm}
      accessibilityRole="button"
      accessibilityLabel={member.displayName ?? 'Group member'}
    >
      {body}
    </Pressable>
  );
}

/**
 * The §6 avatar mark is for "permitted identified presence" — a member pinned
 * at a place. Anything at `approximate` or below is a ring.
 *
 * Exported so the rule is testable and so no other component re-derives it.
 */
export function renderAsAvatar(cls: PrivacyClass): boolean {
  return cls === 'place_level' || cls === 'precise_temporary';
}

const s = StyleSheet.create({
  // Checkpoint
  checkpointWrap: { alignItems: 'center' },
  checkpointHead: {
    width: icon.s26,
    height: icon.s26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: CHROME,
    borderWidth: 1.5,
    borderColor: color.onInkMute,
  },
  checkpointHeadActive: {
    backgroundColor: color.signal,
    borderColor: color.signal,
  },
  checkpointStem: {
    width: 2,
    height: space.sm,
    backgroundColor: color.onInkMute,
  },
  checkpointStemActive: { backgroundColor: color.signal },
  checkpointLabelWrap: {
    marginTop: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(11,16,23,0.86)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHROME_EDGE,
    maxWidth: 140,
  },
  checkpointLabel: { ...typography.metadata, color: color.onInk },

  // Ring
  ring: {
    borderRadius: radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringStale: { borderStyle: 'dashed' },
  ringCore: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.pill,
  },
  ringInitial: { ...typography.label, color: color.onInk },

  // Avatar
  avatarWrap: {
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.signal,
    padding: 1,
  },
  avatarStale: { borderColor: 'rgba(250,249,246,0.34)' },
});
