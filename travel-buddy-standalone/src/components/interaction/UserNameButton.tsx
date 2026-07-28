import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { color, type as t } from '../../theme/tokens.ts';
import { primaryIdentityText } from '../../lib/displayIdentity.ts';
import { navigateToProfile } from '../../lib/navigateToProfile.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import { OfficialBadge } from '../OfficialBadge.tsx';

interface Props {
  userId: string;
  handle: string | null | undefined;
  displayName: string | null | undefined;
  style?: object;
  numberOfLines?: number;
  disabled?: boolean;
  /** Pass the signed-in user's UUID so self-taps route to the own Passport tab. */
  currentUserId?: string | null;
  /** When true, renders an inline verified stamp badge after the name. */
  verified?: boolean;
  /** When true, renders the Portava Official gold-shield badge after the name. */
  isOfficial?: boolean;
}

export function UserNameButton({ userId, handle, displayName, style, numberOfLines = 1, disabled, currentUserId, verified, isOfficial }: Props) {
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
    <Pressable onPress={handlePress} disabled={disabled || !handle} style={styles.row}>
      <Text style={[styles.name, style]} numberOfLines={numberOfLines}>
        {primaryIdentityText({ displayName, handle })}
      </Text>
      {isOfficial ? <OfficialBadge size="sm" /> : verified ? <VerifiedStamp size="sm" /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  name: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 14,
    flexShrink: 1,
  },
  blockedName: {
    color: color.mute,
    fontStyle: 'italic',
  },
});
