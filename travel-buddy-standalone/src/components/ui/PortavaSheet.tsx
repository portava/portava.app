/**
 * PortavaSheet — the bottom-sheet container.
 *
 * Extracted rather than written fresh. Four sheets hand-rolled this shell —
 * ShareSheet, DiscoveryShareSheet, TripInviteSheet, TagPreviewSheet — and each
 * had a piece the others lacked:
 *
 *   Modal transparent + animationType="slide"   all four
 *   statusBarTranslucent                        ShareSheet only
 *   styled backdrop (rgba(17,17,15,0.45))       ShareSheet, TagPreviewSheet
 *   grab handle                                 Discovery, TripInvite, TagPreview
 *   safe-area bottom padding                    ShareSheet, TagPreviewSheet
 *   maxHeight so tall content scrolls           ShareSheet only
 *   keyboard avoidance                          Discovery, TripInvite
 *   gesture dismiss                             NONE of them
 *
 * This is the union of the best of each, so no sheet has to give anything up
 * to adopt it. `animationType="slide"` is kept rather than a hand-rolled
 * Animated/PanResponder implementation: none of the four had gesture dismiss,
 * so building one here would be inventing behaviour under the banner of
 * extracting it. When a drag-to-dismiss is actually specced it belongs in this
 * one file, which is the point.
 *
 * Accessibility (§23) is built in, not retrofitted: the backdrop is a labelled
 * button rather than a bare Pressable, and nothing here sets a fixed height on
 * text, so the container grows with the OS text-size setting instead of
 * clipping.
 *
 * One thing deliberately NOT set: `accessibilityViewIsModal` on the sheet view.
 * It looks like the right flag, but it hides the sheet's SIBLINGS from
 * assistive tech — and the backdrop is a sibling, so setting it makes the
 * labelled "close" affordance unreachable to exactly the users the label is
 * for. RN's <Modal> already traps accessibility focus, so the flag buys
 * nothing and costs the dismiss button. A test asserts the backdrop stays
 * reachable, which is what caught this.
 */
import React from 'react';
import {
  Modal, View, Pressable, StyleSheet, type ViewStyle, type StyleProp,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeScrollView } from './KeyboardSafeView.tsx';
import { color, space, shadow } from '../../theme/tokens.ts';

/**
 * Minimum touch target. 44pt is Apple's HIG floor and 48dp is Android's; 44 is
 * used for both because RN's density-independent units make them equivalent
 * enough here and a single number is easier to hold to.
 */
export const MIN_TOUCH_TARGET = 44;

export interface PortavaSheetProps {
  visible: boolean;
  /** Backdrop tap, hardware back, and Escape all route here. */
  onClose: () => void;
  children: React.ReactNode;
  /** Grab handle at the top edge. Three of the four sheets had one. */
  showHandle?: boolean;
  /**
   * Wrap the sheet so a focused TextInput is not covered by the keyboard.
   * Off by default — it changes layout, so a sheet opts in when it has an input.
   */
  avoidKeyboard?: boolean;
  /** Fraction of screen height the sheet may occupy. */
  maxHeightPercent?: number;
  /** What the backdrop announces to a screen reader. */
  closeAccessibilityLabel?: string;
  /** Announced when the sheet opens. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PortavaSheet({
  visible,
  onClose,
  children,
  showHandle = true,
  avoidKeyboard = false,
  maxHeightPercent = 80,
  closeAccessibilityLabel = 'Close',
  accessibilityLabel,
  style,
  testID,
}: PortavaSheetProps) {
  const insets = useSafeAreaInsets();

  const sheet = (
    <View
      testID={testID}
      accessible={false}
      accessibilityLabel={accessibilityLabel}
      style={[
        s.sheet,
        { paddingBottom: insets.bottom + space.md, maxHeight: `${maxHeightPercent}%` },
        style,
      ]}
    >
      {showHandle && <View style={s.handle} accessibilityElementsHidden importantForAccessibility="no" />}
      {children}
    </View>
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={closeAccessibilityLabel}
        testID={testID ? `${testID}-backdrop` : undefined}
      />
      {avoidKeyboard
        ? <KeyboardSafeScrollView style={s.keyboardWrap}>{sheet}</KeyboardSafeScrollView>
        : sheet}
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  keyboardWrap: { justifyContent: 'flex-end' },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.md,
    ...shadow.card,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginBottom: space.sm,
  },
});

export default PortavaSheet;
