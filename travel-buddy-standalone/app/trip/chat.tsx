import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { GroupChatScreen } from '../../src/components/GroupChatScreen';
import { DailyBriefCard } from '../../src/components/DailyBriefCard';

export default function TripChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tripId = id ?? '';

  // The chat is the route's root and the brief rides INSIDE it, under its header. Drawn above the chat, the brief
  // sat behind the status bar / Dynamic Island and pushed the chat's keyboard wrapper down by its own height, so on
  // an iPhone the composer and the send button stayed under the keyboard ("Ask locals" from the layover lands here).
  return (
    <GroupChatScreen
      type="trip"
      id={tripId}
      title="Trip Chat"
      memberLabel="Trip members only"
      banner={<DailyBriefCard tripId={tripId} compact />}
    />
  );
}
