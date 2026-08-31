/**
 * LensStateView — shared loading / empty / error surface for lens screens.
 *
 * Central to graceful degradation (task requirement): when a projection
 * endpoint is absent (parallel backend PR not deployed) or returns nothing, the
 * lens renders a CLEAN empty state — never a crash, never a blank screen, never
 * a fake-live placeholder (§46.2). Cached/absent data is labeled honestly (§39).
 */
import React from 'react';
import { View, Text, ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { LoadStatus } from '../state/worldState.ts';

export interface LensStateViewProps {
  status: LoadStatus;
  /** Title for the empty/error surface. */
  title?: string;
  /** Supporting copy for the empty/error surface. */
  message?: string;
  onRetry?: () => void;
}

export function LensStateView({ status, title, message, onRetry }: LensStateViewProps) {
  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.onInkMute} />
      </View>
    );
  }

  const isError = status === 'error';
  const heading = title ?? (isError ? 'Could not load this view' : 'Nothing here yet');
  const body =
    message ??
    (isError
      ? 'We could not reach the intelligence network. Your other lenses still work.'
      : 'As people contribute perspectives, this lens will fill in. Check back shortly.');

  return (
    <View style={styles.center}>
      <Text style={styles.heading}>{heading}</Text>
      <Text style={styles.body}>{body}</Text>
      {onRetry ? (
        <Pressable style={styles.retry} onPress={onRetry} accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxxl,
    gap: space.sm,
  },
  heading: { color: color.onInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  body: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  retry: {
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
  },
  retryText: { color: color.onInk, fontSize: 13, fontWeight: '700' },
});
