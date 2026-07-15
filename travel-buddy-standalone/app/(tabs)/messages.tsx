import React, { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { TelegraphInboxScreen } from '../../src/components/TelegraphInboxScreen';
import { postCompassFrontloadEvent } from '../../src/services/compass';

export default function MessagesTab() {
  useFocusEffect(useCallback(() => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen: 'messages' }).catch(() => {});
  }, []));

  return <TelegraphInboxScreen />;
}
