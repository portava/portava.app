/**
 * ShareEntityPreview (§4) — "what am I sharing".
 *
 * One visual structure for every entity: a leading image, a title, a subtitle,
 * and an optional third line. The spec's four worked examples all fall out of
 * that structure with nothing but a shape change on the image:
 *
 *   Place     [image]   Shibuya Sky / Tokyo, Japan / ★ 4.7
 *   Trip      [cover]   Thailand 2026 / Bangkok • Phuket • Krabi / Aug 18–27
 *   Profile   [avatar]  Maya / @mayatravels / Canada • Bangkok now
 *   Postcard  [image]   @maya / Night market in Bangkok / Yaowarat
 *
 * ## What it does not do
 *
 * It fetches nothing. It takes a ShareableEntity — already normalized by
 * src/services/shareAdapters.ts — and renders it. That is the whole contract,
 * and it is why the four examples above need no per-entity data plumbing.
 *
 * The only entity-type branching is a LAYOUT VARIANT: a profile gets a round
 * avatar, everything else gets a rounded rectangle. That lives in one lookup
 * table below, not scattered through the render. Everything else — the title,
 * the subtitle, the third line — comes off the normalized fields, so adding an
 * eleventh entity type requires no change here at all.
 *
 * ## Degradation
 *
 * All three of these are normal, not edge cases, and each is tested:
 *   no imageUrl   — a kind-appropriate placeholder glyph, never a blank hole
 *   no subtitle   — the row collapses, the title is not left dangling
 *   long title    — two lines then ellipsis; never pushes the layout wider
 */
import React from 'react';
import { View, Text, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { MapPin, Route, Image as ImageIcon, Award, Users, Compass, Sparkles } from 'lucide-react-native';
import type { ShareableEntity, ShareEntityType } from '../../types/models.ts';
import { CachedImage } from '../CachedImage.tsx';
import { Avatar } from '../ui/Avatar.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

/** The one place entity type affects presentation. */
const MEDIA_SHAPE: Record<ShareEntityType, 'round' | 'rounded'> = {
  profile: 'round',
  buddy_profile: 'round',
  postcard: 'rounded',
  trip: 'rounded',
  place: 'rounded',
  event: 'rounded',
  memory: 'rounded',
  stamp: 'rounded',
  shared_moment: 'rounded',
  compass_recommendation: 'rounded',
};

/** Placeholder glyph when there is no image. Never a blank grey hole. */
const PLACEHOLDER: Record<ShareEntityType, React.ComponentType<{ size?: number; color?: string }>> = {
  place: MapPin,
  trip: Route,
  event: Users,
  memory: ImageIcon,
  postcard: ImageIcon,
  stamp: Award,
  shared_moment: ImageIcon,
  compass_recommendation: Compass,
  profile: Sparkles,       // unreachable — profiles render an Avatar
  buddy_profile: Sparkles, // unreachable — as above
};

const MEDIA_SIZE = 56;

export interface ShareEntityPreviewProps {
  entity: ShareableEntity;
  /**
   * Optional third line: "★ 4.7", "Aug 18–27", "Canada • Bangkok now". The
   * caller supplies it because it is surface-specific formatting, not a
   * property of the entity — the adapters deliberately do not invent it.
   */
  meta?: string | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function ShareEntityPreview({ entity, meta, style, testID }: ShareEntityPreviewProps) {
  const shape = MEDIA_SHAPE[entity.entityType] ?? 'rounded';
  const Placeholder = PLACEHOLDER[entity.entityType] ?? ImageIcon;

  // A profile's image IS an avatar — same round frame, same initials fallback,
  // same spoken label — so it reuses the primitive rather than restating it.
  const media = shape === 'round' ? (
    <Avatar
      uri={entity.imageUrl}
      name={entity.title}
      kind="person"
      size={MEDIA_SIZE}
      testID={testID ? `${testID}-media` : undefined}
    />
  ) : entity.imageUrl ? (
    <CachedImage
      source={{ uri: entity.imageUrl }}
      style={s.media}
      resizeMode="cover"
      testID={testID ? `${testID}-media` : undefined}
    />
  ) : (
    <View
      style={[s.media, s.mediaEmpty]}
      testID={testID ? `${testID}-media` : undefined}
    >
      <Placeholder size={22} color={color.mute} />
    </View>
  );

  // One spoken string for the whole card. A screen reader should hear
  // "Shibuya Sky, Tokyo Japan, 4.7 stars" as a unit, not three fragments —
  // which is also why the media carries no label of its own: `accessible` on
  // the row collapses its children into this one utterance.
  const spoken = [entity.title, entity.subtitle, meta].filter(Boolean).join(', ');

  return (
    <View
      style={[s.row, style]}
      testID={testID}
      accessible
      accessibilityLabel={spoken}
    >
      {media}
      {/* flexShrink + minWidth:0 is what stops a long title widening the row
          instead of wrapping — the usual cause of a preview blowing its bounds. */}
      <View style={s.text}>
        <Text style={s.title} numberOfLines={2} ellipsizeMode="tail">
          {entity.title}
        </Text>
        {entity.subtitle ? (
          <Text style={s.subtitle} numberOfLines={1} ellipsizeMode="tail">
            {entity.subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text style={s.meta} numberOfLines={1} ellipsizeMode="tail">
            {meta}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  media: {
    width: MEDIA_SIZE,
    height: MEDIA_SIZE,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  mediaEmpty: { alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, minWidth: 0 },
  title: { ...t.bodyStrong, color: color.ink },
  subtitle: { ...t.small, color: color.mute, marginTop: 1 },
  meta: { ...t.small, color: color.faint, marginTop: 1 },
});

export default ShareEntityPreview;
