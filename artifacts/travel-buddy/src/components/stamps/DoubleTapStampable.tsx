/**
 * DoubleTapStampable — wrapper that fires `onDoubleTap` with screen coordinates.
 *
 * Use this to add double-tap-to-stamp to any content area.
 * Wire it to a shared useStamp + useStampAnimationContext instance:
 *
 * @example
 * const { triggerStamp } = useStampAnimationContext();
 * const { isStamped, toggle } = useStamp({ entityType, entityId, ... });
 *
 * <DoubleTapStampable
 *   onDoubleTap={(tapX, tapY) => {
 *     if (isStamped) return; // optionally guard re-stamps
 *     void toggle();
 *     triggerStamp({
 *       launchX: tapX,
 *       launchY: tapY,
 *       theme: post.theme,
 *       onImpact: () => { /* flip local visual state *\/ },
 *     });
 *   }}
 * >
 *   <PostImage ... />
 * </DoubleTapStampable>
 *
 * Requires GestureHandlerRootView to be an ancestor (already present in
 * _layout.tsx).
 */
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DoubleTapStampableProps {
  children: React.ReactNode;
  /**
   * Called on the JS thread with the absolute screen coordinates of the
   * double-tap. Use these as `launchX`/`launchY` in triggerStamp().
   */
  onDoubleTap: (tapX: number, tapY: number) => void;
  /** When true, the double-tap gesture is disabled (passes touches through). */
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DoubleTapStampable({
  children,
  onDoubleTap,
  disabled = false,
  style,
}: DoubleTapStampableProps) {
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(300)
    .enabled(!disabled)
    .onEnd((event) => {
      'worklet';
      runOnJS(onDoubleTap)(event.absoluteX, event.absoluteY);
    });

  return (
    <GestureDetector gesture={doubleTap}>
      <View style={style}>{children}</View>
    </GestureDetector>
  );
}
