/**
 * SectionErrorBoundary — isolates render failures to a single Discovery section.
 *
 * A throwing section (Hidden Gems, Compass Picks, Trending strip, a category
 * tab, …) renders an inline "Couldn't load this section" fallback with a Retry
 * button instead of taking down the whole screen. The real error + component
 * stack is logged once per failure in development (never re-logged on
 * subsequent renders), so the console shows the root cause without spam.
 *
 * With `fullScreen`, the fallback fills the screen — used as the top-level
 * boundary around the Discovery hub (the "Recoverable Error" screen state).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  /** Section name used in the dev log, e.g. "ForYouTab". */
  label: string;
  /** Render the fallback as a full-screen state instead of an inline strip. */
  fullScreen?: boolean;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export class SectionErrorBoundary extends React.Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    // Log the real error once per failure — componentDidCatch only fires when
    // a render throws, not on every re-render, so this cannot spam.
    if (__DEV__) {
      console.error(
        `[Discovery] section "${this.props.label}" crashed:`,
        error,
        info?.componentStack ?? '',
      );
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false });
  };

  override render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <View
        style={[s.wrap, this.props.fullScreen && s.fullScreen]}
        testID={`section-error-${this.props.label}`}
      >
        <Text style={s.title}>Couldn't load this section</Text>
        <Text style={s.desc}>Something went wrong here — the rest of Discover still works.</Text>
        <Pressable style={s.retryBtn} onPress={this.handleRetry} accessibilityRole="button">
          <Text style={s.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    alignItems: 'center',
    gap: space.xs,
  },
  fullScreen: {
    flex: 1,
    justifyContent: 'center',
    marginVertical: 0,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    textAlign: 'center',
  },
  desc: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 18,
  },
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 13,
  },
});

export default SectionErrorBoundary;
