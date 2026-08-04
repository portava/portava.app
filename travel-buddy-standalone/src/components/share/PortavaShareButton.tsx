/**
 * PortavaShareButton — the single reusable control for triggering a genuine
 * content-share action (native share, copy link, send-in-chat entry points).
 *
 * Wraps PortavaShareIcon in a Pressable with a consistent >=44x44 touch
 * target (via hitSlop when the visual icon is smaller), pressed feedback, and
 * accessibility wiring, so every surface gets the same feel without each
 * screen re-implementing padding/hitSlop/opacity by hand.
 *
 * This component owns presentation only — it never decides *what* sharing
 * does. Pass the existing `onPress` handler from the surface (native
 * Share.share(), opening ShareSheet, etc.) unchanged; only the icon and
 * touch-target chrome are standardized here.
 *
 * `accessibilityLabel` must describe the shared item ("Share this post",
 * "Share trip", "Share stamp"), not the icon itself.
 */
import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { PortavaShareIcon } from '../icons/PortavaShareIcon.tsx';

const MIN_HIT_TARGET = 44;

export interface PortavaShareButtonProps {
  onPress?: () => void;
  /** Visual icon size in px. Touch target is padded up to 44x44 via hitSlop. */
  iconSize?: number;
  color?: string;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

function PortavaShareButtonComponent({
  onPress,
  iconSize = 20,
  color = '#11110F',
  accessibilityLabel,
  accessibilityHint,
  disabled,
  testID,
  style,
}: PortavaShareButtonProps) {
  const pad = Math.max(0, (MIN_HIT_TARGET - iconSize) / 2);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={pad}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => [
        styles.hitArea,
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <PortavaShareIcon size={iconSize} color={color} />
    </Pressable>
  );
}

export const PortavaShareButton = React.memo(PortavaShareButtonComponent);

const styles = StyleSheet.create({
  hitArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.4,
  },
});
