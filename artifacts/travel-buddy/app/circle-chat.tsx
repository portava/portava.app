import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { GroupChatScreen } from '../src/components/GroupChatScreen';

export default function CircleChatScreen() {
  const { ownerId } = useLocalSearchParams<{ ownerId: string }>();
  return (
    <GroupChatScreen
      type="circle"
      id={ownerId ?? ''}
      title="Trusted Circle"
      memberLabel="Circle members only"
    />
  );
}
