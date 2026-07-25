import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { color } from '../../theme/tokens.ts';
import { AvatarImage } from '../ui/DisplayMediaImage.tsx';

interface Props {
  userId: string;
  handle: string | null | undefined;
  avatarUrl: string | null | undefined;
  size?: number;
  children?: React.ReactNode;
  disabled?: boolean;
}

export function UserAvatarButton({ userId, handle, avatarUrl, size = 40, children, disabled }: Props) {
  const { blockedIds, blockerIds, isLoading } = useBlockedIds();
  const isBlocked = blockedIds.has(userId) || blockerIds.has(userId);

  function handlePress() {
    if (disabled || isBlocked || !handle) return;
    // If the block list is still loading, navigate anyway — the block check
    // will be live on the profile screen itself.
    router.push(`/u/${handle}` as any);
  }

  if (isBlocked) {
    return (
      <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
        <Text style={styles.blockedIcon}>🚫</Text>
      </View>
    );
  }

  return (
    <Pressable onPress={handlePress} disabled={disabled || !handle}>
      {children ?? (
        <AvatarImage
          uri={avatarUrl}
          user={handle ? { handle } : undefined}
          size={size}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarEmpty: {
    backgroundColor: '#F0EDE8',
  },
  blockedIcon: {
    fontSize: 16,
  },
});
