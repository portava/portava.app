/**
 * KeyboardSafeView / KeyboardSafeScrollView — canonical keyboard-avoidance
 * wrappers for the whole app.
 *
 * Every screen or sheet that contains a TextInput should use one of these
 * instead of hand-rolling a KeyboardAvoidingView, so behavior/offset handling
 * stays consistent:
 *
 *   - `KeyboardSafeView` — KeyboardAvoidingView + its own inner ScrollView
 *     (keyboardShouldPersistTaps="handled", no scroll indicator). Use for
 *     simple forms that don't already have a scroll container.
 *
 *   - `KeyboardSafeScrollView` — bare KeyboardAvoidingView wrapper for
 *     screens/sheets that already render their own ScrollView/FlatList.
 *
 * Both use `behavior="padding"` on iOS and `"height"` on Android, and accept
 * an `offset` prop (→ keyboardVerticalOffset) for content rendered behind a
 * header or inside a pageSheet modal.
 *
 * Tapping outside an input dismisses the keyboard: the inner ScrollView uses
 * keyboardShouldPersistTaps="handled", which lets non-input taps collapse the
 * keyboard while taps on buttons still register on the first touch.
 */
import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

const BEHAVIOR = Platform.OS === 'ios' ? 'padding' : 'height';

export interface KeyboardSafeScrollViewProps {
  children: React.ReactNode;
  /** Extra keyboardVerticalOffset, e.g. header height or pageSheet inset. */
  offset?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Bare keyboard-avoiding wrapper — for screens/sheets that already have their
 * own scroll container (ScrollView / FlatList). Defaults to flex: 1.
 *
 * ⚠️  Do NOT nest a plain <ScrollView> as the immediate child of this
 * component — that creates a double-scroll-container anti-pattern. If your
 * screen only needs a single scroll container, use <KeyboardSafeView> instead:
 * it already includes a built-in ScrollView with the correct keyboard settings.
 *
 * This constraint is enforced by scripts/check-ksv-inner-scroll.mjs
 * (run via `pnpm lint:ksv`).
 */
export function KeyboardSafeScrollView({
  children,
  offset = 0,
  style,
}: KeyboardSafeScrollViewProps) {
  return (
    <KeyboardAvoidingView
      behavior={BEHAVIOR}
      keyboardVerticalOffset={offset}
      style={[{ flex: 1 }, style]}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

export interface KeyboardSafeViewProps extends KeyboardSafeScrollViewProps {
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  /** Extra props forwarded to the inner ScrollView. */
  scrollViewProps?: Omit<ScrollViewProps, 'children'>;
  /** Ref forwarded to the inner ScrollView, for programmatic scrolling. */
  scrollViewRef?: React.Ref<ScrollView>;
}

/**
 * Keyboard-avoiding wrapper with a built-in ScrollView, so the focused input
 * (and any submit button below it) can always be scrolled above the keyboard.
 */
export function KeyboardSafeView({
  children,
  offset = 0,
  style,
  contentContainerStyle,
  scrollViewProps,
  scrollViewRef,
}: KeyboardSafeViewProps) {
  return (
    <KeyboardAvoidingView
      behavior={BEHAVIOR}
      keyboardVerticalOffset={offset}
      style={[{ flex: 1 }, style]}
    >
      <ScrollView
        ref={scrollViewRef}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={contentContainerStyle}
        {...scrollViewProps}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
