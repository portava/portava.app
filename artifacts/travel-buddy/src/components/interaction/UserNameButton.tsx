import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { color, type as t } from '../../theme/tokens.ts';
import { primaryIdentityText } from '../../lib/displayIdentity.ts';
import { navigateToProfile } from '../../lib/navigateToProfile.ts';

interface Props {
  userId: string;
  handle: string | null | undefined;
  displayName: string | null | undefined;
  style?: object;
  numberOfLines?: number;
  disabled?: boolean;
  /** Pass the signed-in user's UUID so self-taps route to the own Passport tab. */
  currentUserId?: string | null;
}

export function UserNameButton({ userId, handle, displayName, style, numberOfLines = 1, disabled, currentUserId }: Props) {
  const { blockedIds, blockerIds, isLoading } = useBlockedIds();
  const isBlocked = blockedIds.has(userId) || blockerIds.has(userId);

  function handlePress() {
    if (disabled || isBlocked || !handle) return;
    navigateToProfile(handle, userId, currentUserId);
  }

  if (isBlocked) {
    return (
      <Text style={[styles.name, styles.blockedName, style]} numberOfLines={numberOfLines}>
        Unavailable user
      </Text>
    );
  }

  return (
    <Pressable onPress={handlePress} disabled={disabled || !handle}>
      <Text style={[styles.name, style]} numberOfLines={numberOfLines}>
        {primaryIdentityText({ displayName, handle })}
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
