/**
 * CaughtUpState — the end-of-feed state (Wall spec §27/§32).
 *
 * Following is a predictable catch-up mode, so reaching the end of eligible
 * followed content is a real, positive state ("You're all caught up"), not an
 * error or an empty void. For You is exploratory and effectively endless, so
 * this is used mainly for Following, but it also covers the safe empty-feed
 * case (degraded / disabled) with a calm, non-alarming message.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { CheckCircle2, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../../theme/tokens.ts';

export function CaughtUpState({
  variant = 'caught_up',
  onRefresh,
}: {
  /** 'caught_up' = reached end of Following; 'empty' = nothing to show yet. */
  variant?: 'caught_up' | 'empty';
  onRefresh?: () => void;
}) {
  const title = variant === 'caught_up' ? "You're all caught up" : 'Nothing here yet';
  const subtitle =
    variant === 'caught_up'
      ? 'You have seen every new post from people you follow.'
      : 'When there is something to see, it will show up here.';
  return (
    <View style={s.container} testID={`wall-caught-up-${variant}`}>
      <CheckCircle2 size={icon.s26} color={color.success} />
      <Text style={s.title}>{title}</Text>
      <Text style={s.subtitle}>{subtitle}</Text>
      {onRefresh ? (
        <Pressable
          style={s.refresh}
          onPress={onRefresh}
          accessibilityRole="button"
          accessibilityLabel="Refresh feed"
        >
          <RefreshCw size={icon.s16} color={color.ink} />
          <Text style={s.refreshText}>Refresh</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  title: { ...t.heading, color: color.ink, marginTop: space.sm },
  subtitle: { ...t.small, color: color.mute, textAlign: 'center' },
  refresh: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  refreshText: { ...t.small, color: color.ink, fontWeight: '700' },
});
