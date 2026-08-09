/**
 * EmptyState — shared empty-state component used across all feeds and lists.
 * Renders a centered icon, title, description, and an optional primary action.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { color, space, radius, typography, layout, avatar } from '../../theme/tokens.ts';

interface EmptyStateProps {
  /** Lucide icon component (outline style preferred). */
  icon: LucideIcon;
  title: string;
  description?: string;
  primaryAction?: {
    label: string;
    onPress: () => void;
  };
}

export function EmptyState({ icon: Icon, title, description, primaryAction }: EmptyStateProps) {
  return (
    <View style={styles.container} accessibilityRole="none" accessibilityLabel={`${title}${description ? `. ${description}` : ''}`}>
      <View style={styles.iconWrap}>
        <Icon size={36} color={color.faint} strokeWidth={1.5} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {primaryAction ? (
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={primaryAction.onPress}
          accessibilityRole="button"
          accessibilityLabel={primaryAction.label}
        >
          <Text style={styles.btnText}>{primaryAction.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    gap: space.sm,
  },
  iconWrap: {
    width: avatar.xxxxl,
    height: avatar.xxxxl,
    borderRadius: avatar.xxxxl / 2,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: {
    ...typography.sectionTitle,
    color: color.ink,
    textAlign: 'center',
  },
  description: {
    ...typography.body,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 280,
  },
  btn: {
    marginTop: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm + 2,
  },
  btnText: {
    ...typography.button,
    color: color.onInk,
  },
});
