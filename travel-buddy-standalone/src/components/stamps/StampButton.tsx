/**
 * StampButton — Portava's primary stamp interaction.
 *
 * Visual architecture (post Batch-7 animation upgrade)
 * ─────────────────────────────────────────────────────
 *   - StampIcon renders the rubber-stamp glyph in idle/active state.
 *   - The heavy animation (stamp travels to content center, shadow,
 *     haptic at impact, ink impression) is owned by StampAnimationProvider
 *     in _layout.tsx.  StampButton only supplies the launch coordinates
 *     and receives `onImpact` to flip its local visual state.
 *   - useStampAnimation provides a subtle local press-bounce and count pop.
 *
 * State separation
 * ─────────────────
 *   `visualIsStamped` / `visualCount` are DISPLAY state — they lag the API
 *   by ~TRAVEL_MS (≈400 ms) so the hollow→filled flip happens exactly at
 *   the stamp impact, not on press-down.
 *
 *   `useStamp` manages the optimistic API call + rollback as before.  When
 *   `useStamp`'s resolved state differs from the optimistic prediction
 *   (i.e. a rollback occurred), the correction is applied in `onComplete`
 *   so it always lands AFTER the animation finishes.
 *
 * Usage
 * ──────
 *   <StampButton
 *     entityType="post"
 *     entityId={post.id}
 *     initialCount={post.stampCount}
 *     initialIsStamped={post.isStamped}
 *     theme="Beach"
 *   />
 *
 * Double-tap
 * ───────────
 *   For double-tap-to-stamp on a content area, use DoubleTapStampable.
 *   It calls triggerStamp() directly from the context with the tap
 *   coordinates; pair it with a shared useStamp instance.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Dimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { color, layout, type as typeTokens } from '../../theme/tokens.ts';
import { StampIcon } from './StampIcon.tsx';
import { useStampAnimation } from '../../hooks/useStampAnimation.ts';
import { useStamp, type UseStampReturn } from '../../hooks/useStamp.ts';
import { useStampAnimationContext } from '../../context/StampAnimationContext.tsx';
import type { StampTheme } from './PortavaInkStamp.tsx';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StampButtonProps {
  entityType: string;
  entityId: string;
  initialCount?: number;
  initialIsStamped?: boolean;
  /**
   * Thematic variant passed through to the ink-stamp overlay seal rendered by
   * StampAnimationProvider.  Controls the center icon and ring text.
   */
  theme?: StampTheme;
  /** Size of the StampIcon glyph in px (default 22). */
  iconSize?: number;
  /**
   * Pins the icon's layout box independently of `iconSize`. Only needed in an
   * action row, where the stamp must be scaled past its nominal size to reach
   * the same *visible* size as the lucide icons beside it (see
   * components/ui/ActionRowIcon.tsx) without that larger viewport widening or
   * heightening the row. Defaults to `iconSize`, i.e. no change.
   */
  iconBoxSize?: number;
  /** Extra styles for the outer wrapper View. */
  style?: StyleProp<ViewStyle>;
  /**
   * Share a single useStamp instance with a sibling surface (e.g. a
   * card-level double-tap handler) instead of instantiating a private one.
   * When provided, `initialCount`/`initialIsStamped` are ignored — the
   * controlled instance is the sole source of truth for count/isStamped.
   */
  controlledStamp?: UseStampReturn;
  /**
   * When true, skip the screen-level traveling-stamp animation
   * (StampAnimationProvider) entirely and call `onLocalBurst` instead. Use
   * this inside any container that must keep all stamp visuals within its
   * own bounds (e.g. an `overflow: hidden` post card) — the screen-level
   * overlay is positioned in screen coordinates and would otherwise paint
   * outside the card.
   */
  localBurst?: boolean;
  /** Fired (in localBurst mode) at the moment a stamp is added. */
  onLocalBurst?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StampButton({
  entityType,
  entityId,
  initialCount = 0,
  initialIsStamped = false,
  theme = 'Default',
  iconSize = 22,
  iconBoxSize,
  style,
  controlledStamp,
  localBurst = false,
  onLocalBurst,
}: StampButtonProps) {
  // ── API state (optimistic + rollback via useStamp) ───────────────────────
  // A private useStamp instance is always created (hooks can't be
  // conditional), but its state is only used when the caller doesn't supply
  // a shared `controlledStamp` instance (e.g. so a card-level double-tap
  // handler and this button stay in sync off ONE source of truth).
  const privateStamp = useStamp({
    entityType,
    entityId,
    initialCount,
    initialIsStamped,
  });
  const { count: apiCount, isStamped: apiIsStamped, isLoading, toggle } = controlledStamp ?? privateStamp;

  // ── Visual state (delayed — flips at stamp impact, not on press) ─────────
  // Seed from the resolved API source so that when a shared `controlledStamp`
  // is provided the visual state reflects its current values, not the
  // initialIsStamped/initialCount defaults (which default to false/0).
  const [visualIsStamped, setVisualIsStamped] = useState(apiIsStamped);
  const [visualCount,     setVisualCount    ] = useState(apiCount);

  // Keep a ref to the latest API state so `onComplete` can apply rollbacks
  // without stale closure values.
  const apiStateRef = useRef({ isStamped: apiIsStamped, count: apiCount });
  useEffect(() => {
    apiStateRef.current = { isStamped: apiIsStamped, count: apiCount };
  }, [apiIsStamped, apiCount]);

  // ── Animation guard ───────────────────────────────────────────────────────
  /** True while the screen-level animation is in flight. */
  const animatingRef = useRef(false);

  // Sync visual ← API whenever the API state changes and no animation is live.
  // This handles external state updates (e.g. server-push, prop refresh).
  const prevApiIsStamped = useRef(apiIsStamped);
  const prevApiCount     = useRef(apiCount);
  useEffect(() => {
    if (
      (apiIsStamped !== prevApiIsStamped.current || apiCount !== prevApiCount.current) &&
      !animatingRef.current
    ) {
      setVisualIsStamped(apiIsStamped);
      setVisualCount(apiCount);
    }
    prevApiIsStamped.current = apiIsStamped;
    prevApiCount.current     = apiCount;
  }, [apiIsStamped, apiCount]);

  // ── Local button animation (press bounce + count pop) ────────────────────
  const { buttonStyle, countStyle, playStamp, playUnstamp } = useStampAnimation();

  // ── Screen-level animation (traveling stamp) ──────────────────────────────
  const { triggerStamp, isAnimating } = useStampAnimationContext();

  // ── Wrapper ref for position measurement ─────────────────────────────────
  const wrapperRef = useRef<View>(null);

  // ── Press handler ─────────────────────────────────────────────────────────
  const handlePress = useCallback(() => {
    if (isLoading || animatingRef.current || isAnimating) return;

    const wasStamped  = visualIsStamped;
    const nextStamped = !wasStamped;

    // Play local press bounce immediately.
    nextStamped ? playStamp() : playUnstamp();

    // Fire the API call concurrently — useStamp manages rollback.
    void toggle();

    if (localBurst) {
      // Card-local mode: no screen-level travel — flip state immediately
      // and let the caller play its own contained burst animation.
      setVisualIsStamped(nextStamped);
      setVisualCount(prev => nextStamped ? prev + 1 : Math.max(0, prev - 1));
      if (nextStamped) onLocalBurst?.();
      return;
    }

    // Measure button center in screen coordinates, then launch animation.
    wrapperRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
      animatingRef.current = true;

      const { width: W, height: H } = Dimensions.get('window');
      const launchX  = pageX + width  / 2;
      const launchY  = pageY + height / 2;

      triggerStamp({
        launchX,
        launchY,
        contentX: W / 2,
        contentY: H * 0.42,
        theme,

        onImpact: () => {
          // Visual state flips HERE — at the moment of stamp impact.
          setVisualIsStamped(nextStamped);
          setVisualCount(prev => nextStamped ? prev + 1 : Math.max(0, prev - 1));
        },

        onComplete: () => {
          animatingRef.current = false;
          // Apply API truth (handles rollback that arrived during animation).
          const { isStamped: srv, count: srvCount } = apiStateRef.current;
          setVisualIsStamped(srv);
          setVisualCount(srvCount);
        },
      });
    });
  }, [
    isLoading,
    isAnimating,
    visualIsStamped,
    toggle,
    playStamp,
    playUnstamp,
    triggerStamp,
    theme,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View ref={wrapperRef} style={[s.wrapper, style]}>
      <Pressable
        onPress={handlePress}
        hitSlop={layout.hitSlop}
        accessibilityRole="button"
        accessibilityLabel={visualIsStamped ? 'Remove stamp' : 'Stamp'}
        accessibilityState={{ selected: visualIsStamped }}
        disabled={isLoading || isAnimating}
      >
        <Animated.View style={[s.row, buttonStyle as AnimatedStyle<ViewStyle>]}>
          {/* Box defaults to iconSize, so the layout is unchanged unless a
              caller explicitly pins it (action rows — see iconBoxSize). */}
          <View
            style={{
              width: iconBoxSize ?? iconSize,
              height: iconBoxSize ?? iconSize,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <StampIcon size={iconSize} active={visualIsStamped} />
          </View>

          {visualCount > 0 && (
            <Animated.View style={countStyle as AnimatedStyle<ViewStyle>}>
              <Text
                style={[s.count, visualIsStamped && s.countActive]}
                numberOfLines={1}
              >
                {visualCount}
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
