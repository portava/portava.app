import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { useBlockedIds } from '../../context/BlockedIdsContext.tsx';
import { useUserInteractionContext } from '../../hooks/useUserInteractionContext.ts';
import { useRelationshipLabel } from '../../hooks/useRelationshipLabel.ts';
import { UserAvatarButton } from './UserAvatarButton.tsx';
import { UserNameButton } from './UserNameButton.tsx';
import { RelationshipBadge } from './RelationshipBadge.tsx';
import { KnownFromRow } from './KnownFromRow.tsx';
import { UserOverflowMenu } from './UserOverflowMenu.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  userId: string;
  handle: string | null | undefined;
  displayName: string | null | undefined;
  avatarUrl?: string | null;
  bio?: string | null;
  verified?: boolean;
  showOverflow?: boolean;
  onBlockSuccess?: (userId: string) => void;
}

export function UserMiniProfileCard({
  userId,
  handle,
  displayName,
  avatarUrl,
  bio,
  verified,
  showOverflow = true,
  onBlockSuccess,
}: Props) {
  const { blockedIds } = useBlockedIds();
  const { context } = useUserInteractionContext(userId);
  const label = useRelationshipLabel(userId, context);

  if (blockedIds.has(userId)) return null;
  if (context?.theyBlockedMe) return null;

  const name = displayName ?? handle ?? 'Traveler';

  return (
    <View style={s.card}>
      <UserAvatarButton userId={userId} handle={handle} avatarUrl={avatarUrl} size={52} />
      <View style={s.body}>
        <View style={s.nameRow}>
          <UserNameButton userId={userId} handle={handle} displayName={name} verified={verified} style={s.name} />
          <RelationshipBadge label={label} />
          {showOverflow && (
            <UserOverflowMenu userId={userId} displayName={name} onBlockSuccess={onBlockSuccess} />
          )}
        </View>
        {handle ? <Text style={s.handle}>@{handle}</Text> : null}
        {bio ? <Text style={s.bio} numberOfLines={2}>{bio}</Text> : null}
        {context?.context ? <KnownFromRow context={context.context} /> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    alignItems: 'flex-start',
  },
  body: { flex: 1, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1 },
  handle: { fontSize: 12, color: color.mute, fontFamily: 'Courier' },
  bio: { fontSize: 13, color: color.faint, lineHeight: 18 },
});
