/**
 * PostActionRow / PostActionGroup — shared layout primitives for the post
 * action row (Stamp, Comment, Share, Save, More) per the icon-spacing spec.
 *
 * PostActionGroup treats an icon + optional counter as one pressable unit:
 * a fixed 4px internal gap, a single accessibility label (action name plus
 * the *exact* count, never the abbreviated one), and a >=44x44 touch target
 * via hitSlop (so the visual chrome stays compact while the tap area meets
 * the minimum).
 *
 * PostActionRow composes a left cluster (e.g. Stamp/Comment/Share) and a
 * right cluster (e.g. Save/More) around a flexible spacer, so the right
 * cluster always stays anchored to the trailing edge regardless of how wide
 * the left cluster's counters get. The gap *within* each cluster grows
 * proportionally with the widest counter in that cluster (14px baseline up
 * to 24px max — see `actionRowGap.ts`) instead of a single fixed margin.
 *
 * Some existing actions (e.g. StampButton) already manage their own
 * icon+counter rendering and animation and can't be re-parented into
 * PostActionGroup without touching their internals. `actionSlot()` covers
 * the common case (build a slot from a plain icon/count/handler); for a
 * self-managed control, build the `PostActionSlot` by hand — provide `node`
 * for the rendered control and `gapText` (its formatted counter, if any) so
 * the row's proportional spacing still accounts for it.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { color, icon as iconToken, type as t } from '../theme/tokens.ts';
import { formatCompactCount, actionAccessibilityLabel } from '../lib/counterFormat.ts';
import { computeActionGap } from '../lib/actionRowGap.ts';

/**
 * The canonical action-row icon size (spec §2), aliased from the design token
 * so there is exactly one number. This is the size lucide icons take directly;
 * the two custom icon families need `ActionStampIcon` / `ActionShareIcon` from
 * components/ui/ActionRowIcon.tsx to render at the same *visible* size.
 */
export const POST_ACTION_ICON_SIZE = iconToken.s20;
export const POST_ACTION_MIN_TOUCH = 44;
const INTERNAL_GAP = 4;
/**
 * hitSlop padding so a POST_ACTION_ICON_SIZE icon reaches the 44x44 minimum
 * touch target without inflating the visual layout box.
 *
 * Exported because ActionBar, cards/PostCard and HighlightViewer build their
 * action rows by hand rather than through PostActionGroup, and were each
 * carrying their own smaller number (8, 8, and nothing at all). Visible icon
 * size and touch size are independent: this is the ONLY dial that closes the
 * gap to 44. Do not reach it by growing the icon — see ui/ActionRowIcon.tsx,
 * which exists to hold every action-row icon at one visible size.
 */
export const POST_ACTION_TOUCH_PAD = (POST_ACTION_MIN_TOUCH - POST_ACTION_ICON_SIZE) / 2;
const TOUCH_PAD = POST_ACTION_TOUCH_PAD;

export interface PostActionItemConfig {
  key: string;
  icon: React.ReactNode;
  /** Raw count. Rendered compactly (K/M/B); omit or pass 0 to show no counter. */
  count?: number;
  /** Base action name for accessibility, e.g. "Comment", "Save" — the exact count is appended automatically. */
  accessibilityLabel: string;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  /** Counter text color; icon color is the caller's responsibility (passed via `icon`). */
  tint?: string;
}

export function PostActionGroup({
  icon,
  count,
  accessibilityLabel,
  onPress,
  disabled,
  testID,
  tint = color.mute,
}: Omit<PostActionItemConfig, 'key'>) {
  const showCount = !!count && count > 0;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={TOUCH_PAD}
      style={({ pressed }) => [styles.group, pressed && !disabled && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={actionAccessibilityLabel(accessibilityLabel, count)}
      testID={testID}
    >
      {icon}
      {showCount ? (
        <Text style={[styles.count, { color: tint }]}>{formatCompactCount(count as number)}</Text>
      ) : null}
    </Pressable>
  );
}

export interface PostActionSlot {
  key: string;
  node: React.ReactNode;
  /** Formatted counter text (if any), used only to size the proportional external gap next to this slot. */
  gapText?: string;
}

/** Convenience: wraps a PostActionItemConfig into a ready-to-use PostActionSlot for PostActionRow. */
export function actionSlot(config: PostActionItemConfig): PostActionSlot {
  // `key` is destructured OUT of the spread: React treats a spread `key` as the
  // element key and warns in dev ("A props object containing a 'key' prop is
  // being spread into JSX"). PostActionGroup never reads it; the slot key feeds
  // the <React.Fragment key> in PostActionRow instead.
  const { key, ...groupProps } = config;
  return {
    key,
    node: <PostActionGroup {...groupProps} />,
    gapText: config.count ? formatCompactCount(config.count) : undefined,
  };
}

export interface PostActionRowProps {
  /** Stamp/Comment/Share (or equivalent) — leading edge. */
  left: PostActionSlot[];
  /** Save/More (or equivalent) — always anchored to the trailing edge. */
  right: PostActionSlot[];
  style?: StyleProp<ViewStyle>;
}

export function PostActionRow({ left, right, style }: PostActionRowProps) {
  const leftGap = computeActionGap(left.map((slot) => slot.gapText));
  const rightGap = computeActionGap(right.map((slot) => slot.gapText));
  return (
    <View style={[styles.row, style]}>
      <View style={[styles.cluster, { gap: leftGap }]}>
        {left.map((slot) => (
          <React.Fragment key={slot.key}>{slot.node}</React.Fragment>
        ))}
      </View>
      <View style={styles.spacer} />
      <View style={[styles.cluster, { gap: rightGap }]}>
        {right.map((slot) => (
          <React.Fragment key={slot.key}>{slot.node}</React.Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  cluster: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  spacer: { flex: 1, minWidth: 8 },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: INTERNAL_GAP,
    minHeight: POST_ACTION_ICON_SIZE,
  },
  pressed: { opacity: 0.6 },
  count: { ...t.small, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
