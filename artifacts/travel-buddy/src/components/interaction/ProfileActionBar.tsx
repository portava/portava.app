import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MessageCircle, UserPlus, UserMinus, Bookmark, BookmarkCheck } from 'lucide-react-native';
import type { InteractionContext } from '../../services/interactionContext';
import { useSavedProfileActions } from '../../hooks/useSavedProfileActions';
import { color, space, radius, type as t } from '../../theme/tokens';

interface Props {
  userId: string;
  context: InteractionContext | null;
  onMessage?: () => void;
  onFollow?: () => void;
  onUnfollow?: () => void;
}

export function ProfileActionBar({ userId, context, onMessage, onFollow, onUnfollow }: Props) {
  const { saved, loading: saveLoading, toggle: toggleSave } = useSavedProfileActions(userId);
  const canMessage = context?.canMessage ?? false;
  const canFollow = context?.canFollow ?? false;
  const isFollowing = context ? !context.canFollow && context.canViewProfile : false;

  return (
    <View style={s.row}>
      {canMessage && (
        <Pressable style={[s.btn, s.primary]} onPress={onMessage}>
          <MessageCircle size={16} color={color.onInk} />
          <Text style={s.primaryText}>Message</Text>
        </Pressable>
      )}
      {canFollow && (
        <Pressable style={[s.btn, s.secondary]} onPress={onFollow}>
          <UserPlus size={16} color={color.signal} />
          <Text style={s.secondaryText}>Follow</Text>
        </Pressable>
      )}
      {isFollowing && (
        <Pressable style={[s.btn, s.secondary]} onPress={onUnfollow}>
          <UserMinus size={16} color={color.mute} />
          <Text style={[s.secondaryText, { color: color.mute }]}>Unfollow</Text>
        </Pressable>
      )}
      <Pressable style={[s.btn, s.icon]} onPress={toggleSave} disabled={saveLoading}>
        {saved
          ? <BookmarkCheck size={18} color={color.signal} />
          : <Bookmark size={18} color={color.mute} />}
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  btn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  primary: { backgroundColor: color.signal, flex: 1, justifyContent: 'center' },
  secondary: { backgroundColor: color.haze, flex: 1, justifyContent: 'center', borderWidth: 1, borderColor: color.haze },
  icon: { backgroundColor: color.haze },
  primaryText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  secondaryText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
});
