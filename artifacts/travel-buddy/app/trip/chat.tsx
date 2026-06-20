import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { GroupChatScreen } from '../../src/components/GroupChatScreen';

export default function TripChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <GroupChatScreen
      type="trip"
      id={id ?? ''}
      title="Trip Chat"
      memberLabel="Trip members only"
    />
  );
}
