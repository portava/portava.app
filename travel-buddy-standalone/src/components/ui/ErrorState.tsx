/**
 * ErrorState — shared error-state component used across all feeds and lists.
 * Never surfaces raw server error text; always shows a friendly message.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import { color, space, radius, typography, layout, avatar } from '../../theme/tokens.ts';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <View style={styles.container} accessibilityRole="none" accessibilityLabel={`Error: ${message}`}>
      <View style={styles.iconWrap}>
        <AlertTriangle size={32} color={color.warn} strokeWidth={1.5} />
      </View>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.message}>{message}</Text>
      {onRetry ? (
        <Pressable
          style={({ pressed }) => [styles.btn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry"
        >
          <Text style={styles.btnText}>Try again</Text>
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
    width: avatar.xxxl,
    height: avatar.xxxl,
    borderRadius: avatar.xxxl / 2,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: {
    ...typography.sectionTitle,
    color: color.ink,
    textAlign: 'center',
  },
  message: {
    ...typography.body,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 280,
  },
  btn: {
    marginTop: space.sm,
    borderWidth: 1.5,
    borderColor: color.ink,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm + 2,
  },
  btnText: {
    ...typography.button,
    color: color.ink,
  },
});
