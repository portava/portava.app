import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useBlockedIds } from '../../context/BlockedIdsContext';
import { color, type as t } from '../../theme/tokens';

interface Props {
  userId: string;
  handle: string | null | undefined;
  displayName: string | null | undefined;
  style?: object;
  numberOfLines?: number;
  disabled?: boolean;
}

export function UserNameButton({ userId, handle, displayName, style, numberOfLines = 1, disabled }: Props) {
  const { blockedIds, blockerIds, isLoading } = useBlockedIds();
  const isBlocked = blockedIds.has(userId) || blockerIds.has(userId);

  function handlePress() {
    if (disabled || isBlocked || isLoading || !handle) return;
    router.push(`/u/${handle}` as any);
  }

  if (isBlocked) {
    return (
      <Text style={[styles.name, styles.blockedName, style]} numberOfLines={numberOfLines}>
        Unavailable user
      </Text>
    );
  }

  return (
    <Pressable onPress={handlePress} disabled={disabled || isLoading || !handle}>
      <Text style={[styles.name, style]} numberOfLines={numberOfLines}>
        {displayName ?? handle ?? 'Traveler'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  name: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
  },
  blockedName: {
    color: color.mute,
    fontStyle: 'italic',
  },
});
