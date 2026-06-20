import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { GroupChatScreen } from '../../src/components/GroupChatScreen';
import { DailyBriefCard } from '../../src/components/DailyBriefCard';

export default function TripChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tripId = id ?? '';

  return (
    <View style={s.root}>
      <DailyBriefCard tripId={tripId} compact />
      <View style={s.chat}>
        <GroupChatScreen
          type="trip"
          id={tripId}
          title="Trip Chat"
          memberLabel="Trip members only"
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  chat: { flex: 1 },
});
