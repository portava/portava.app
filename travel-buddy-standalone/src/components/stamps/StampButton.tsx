/**
 * StampButton — Portava's primary stamp interaction.
 *
 * Composes:
 *   - StampIcon  (rubber-stamp glyph, idle/active states)
 *   - PortavaInkStamp overlay (passport-seal SVG, absolutely positioned)
 *   - useStampAnimation (Reanimated sequence)
 *   - useStamp (optimistic API call + rollback)
 *
 * Usage:
 *   <StampButton
 *     entityType="post"
 *     entityId={post.id}
 *     initialCount={post.stampCount}
 *     initialIsStamped={post.isStamped}
 *     theme="Beach"
 *   />
 *
 * The ink-stamp overlay appears centered over the button itself. To render
 * the overlay over a larger parent area, wrap both the content and
 * `<PortavaInkStamp animatedStyle={overlayStyle} ... />` at the parent level
 * and use the exported `useStampAnimation` hook directly.
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { color, layout, type as typeTokens } from '../../theme/tokens.ts';
import { StampIcon } from './StampIcon.tsx';
import { PortavaInkStamp, type StampTheme } from './PortavaInkStamp.tsx';
import { useStampAnimation } from '../../hooks/useStampAnimation.ts';
import { useStamp } from '../../hooks/useStamp.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StampButtonProps {
  entityType: string;
  entityId: string;
  initialCount: number;
  initialIsStamped: boolean;
  /**
   * Thematic variant for the ink-stamp overlay seal.
   * Controls the center icon and ring text.
   */
  theme?: StampTheme;
  /** Size of the StampIcon glyph in px (default 22). */
  iconSize?: number;
  /** Extra styles for the outer wrapper View. */
  style?: StyleProp<ViewStyle>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StampButton({
  entityType,
  entityId,
  initialCount,
  initialIsStamped,
  theme = 'Default',
  iconSize = 22,
  style,
}: StampButtonProps) {
  const { count, isStamped, isLoading, toggle } = useStamp({
    entityType,
    entityId,
    initialCount,
    initialIsStamped,
  });

  const { buttonStyle, overlayStyle, countStyle, playStamp, playUnstamp } =
    useStampAnimation();

  const handlePress = useCallback(() => {
    if (isLoading) return;

    if (!isStamped) {
      playStamp(() => {
        if (Platform.OS !== 'web') {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        }
      });
    } else {
      playUnstamp();
    }

    // Fire the API call concurrently with the animation — no need to await.
    toggle();
  }, [isLoading, isStamped, playStamp, playUnstamp, toggle]);

  return (
    <View style={[s.wrapper, style]}>
      {/* Ink-stamp overlay — positioned over the button center */}
      <PortavaInkStamp
        animatedStyle={overlayStyle}
        theme={theme}
        size={120}
        style={s.overlay}
      />

      <Pressable
        onPress={handlePress}
        hitSlop={layout.hitSlop}
        accessibilityRole="button"
        accessibilityLabel={isStamped ? 'Remove stamp' : 'Stamp'}
        accessibilityState={{ selected: isStamped }}
        disabled={isLoading}
      >
        <Animated.View style={[s.row, buttonStyle as AnimatedStyle<ViewStyle>]}>
          <StampIcon size={iconSize} active={isStamped} />

          {count > 0 && (
            <Animated.View style={countStyle as AnimatedStyle<ViewStyle>}>
              <Text
                style={[s.count, isStamped && s.countActive]}
                numberOfLines={1}
              >
                {count}
              </Text>
            </Animated.View>
          )}
        </Animated.View>
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    position: 'absolute',
    alignSelf: 'center',
    // Pointer events are disabled inside PortavaInkStamp itself.
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
    minWidth: 36,
    justifyContent: 'center',
  },
  count: {
    ...typeTokens.stamp,
    color: color.mute,
    minWidth: 16,
  },
  countActive: {
    color: color.signal,
  },
});
