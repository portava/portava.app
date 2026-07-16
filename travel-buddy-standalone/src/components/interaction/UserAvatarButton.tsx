import React, { useState } from 'react';
import { Pressable, Image, View, Text, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { color } from '../../theme/tokens.ts';

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
  const [imgFailed, setImgFailed] = useState(false);

  function handlePress() {
    if (disabled || isBlocked || isLoading || !handle) return;
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
    <Pressable onPress={handlePress} disabled={disabled || isLoading || !handle}>
      {children ?? (
        avatarUrl && !imgFailed ? (
          <Image
            source={{ uri: avatarUrl }}
            style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <View style={[styles.avatar, styles.avatarEmpty, { width: size, height: size, borderRadius: size / 2 }]}>
            <Text style={{ fontSize: size * 0.45 }}>👤</Text>
          </View>
        )
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
