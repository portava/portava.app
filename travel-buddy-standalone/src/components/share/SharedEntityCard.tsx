/**
 * SharedEntityCard (§19) — the canonical in-message card.
 *
 * One card for a shared entity, wherever it appears: a Telegraph thread, a
 * notification row, an activity feed. Tapping it opens that entity's canonical
 * in-app route.
 *
 * ## Why it takes a ShareableEntity
 *
 * The three surfaces above have nothing in common except the thing being
 * shown, so the card's input has to be the normalized entity rather than any
 * one surface's payload. Telegraph stores a JSON blob on a message, a
 * notification carries an id and a type, an activity row carries a joined row
 * — all three can produce a ShareableEntity, and none of them should have to
 * teach this component about their storage.
 *
 * ## Routing
 *
 * `appRouteFor()` in shareAdapters.ts, which mirrors canonicalUrl exactly:
 * a postcard opens its post, a compass recommendation opens the item it wraps.
 * A card and the link inside it must never land in different places.
 *
 * When there is no route — a handle-less profile, a compass recommendation
 * wrapping a booking — the card renders as static content rather than a
 * pressable that does nothing. A button that silently no-ops is worse than no
 * button, and a screen reader announcing "button" for it is worse still.
 *
 * ## Not a replacement for the existing message cards
 *
 * PostCardMessage and DiscoveryCardMessage still render post_card and
 * discovery_card subtypes in Telegraph today. This does not touch them. See
 * the step 16d notes for what would break if they became wrappers over this.
 */
import React, { useCallback } from 'react';
import { View, Pressable, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { router } from 'expo-router';
import type { ShareableEntity } from '../../types/models.ts';
import { appRouteFor } from '../../services/shareAdapters.ts';
import { ShareEntityPreview } from './ShareEntityPreview.tsx';
import { MIN_TOUCH_TARGET } from '../ui/PortavaSheet.tsx';
import { color, space, radius } from '../../theme/tokens.ts';

/** Human wording for the "opens…" hint a screen reader reads out. */
const OPENS: Record<string, string> = {
  postcard: 'post',
  trip: 'trip',
  place: 'place',
  profile: 'profile',
  event: 'event',
  memory: 'memory',
  stamp: 'stamp',
  shared_moment: 'shared moment',
  compass_recommendation: 'recommendation',
  buddy_profile: 'buddy profile',
};

export interface SharedEntityCardProps {
  entity: ShareableEntity;
  /** Third preview line — "★ 4.7", "Aug 18–27". Surface-specific. */
  meta?: string | null;
  /**
   * Telegraph renders the sender's own messages inverted. Other surfaces leave
   * this false. It only swaps the card's own chrome; the preview is unchanged.
   */
  mine?: boolean;
  /** Overrides navigation. Given one, the card calls this instead of routing. */
  onPress?: (entity: ShareableEntity) => void;
  /** Action row rendered under the preview — the caller owns its contents. */
  footer?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SharedEntityCard({
  entity,
  meta,
  mine = false,
  onPress,
  footer,
  style,
  testID,
}: SharedEntityCardProps) {
  const route = appRouteFor(entity);
  const interactive = Boolean(onPress) || route !== null;

  const handlePress = useCallback(() => {
    if (onPress) { onPress(entity); return; }
    if (route) router.push(route as never);
  }, [onPress, route, entity]);

  const noun = OPENS[entity.entityType] ?? 'item';
  const body = (
    <>
      <ShareEntityPreview
        entity={entity}
        meta={meta}
        style={s.preview}
        testID={testID ? `${testID}-preview` : undefined}
      />
      {footer ? <View style={s.footer}>{footer}</View> : null}
    </>
  );

  if (!interactive) {
    // Static: no accessibilityRole="button", no press feedback, no lie.
    return (
      <View style={[s.card, mine && s.cardMine, style]} testID={testID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [s.card, mine && s.cardMine, pressed && s.cardPressed, style]}
      accessibilityRole="button"
      // The preview already speaks the content; this adds only the affordance.
      accessibilityHint={`Opens this ${noun}`}
      testID={testID}
    >
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    minHeight: MIN_TOUCH_TARGET,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    overflow: 'hidden',
  },
  cardMine: { backgroundColor: color.deep, borderColor: color.deep },
  cardPressed: { opacity: 0.85 },
  // The preview's own horizontal padding is sized for a full-width sheet row;
  // inside a chat bubble it needs to be tighter.
  preview: { paddingHorizontal: space.md, paddingVertical: space.sm },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingHorizontal: space.md,
    minHeight: MIN_TOUCH_TARGET,
  },
});

export default SharedEntityCard;
