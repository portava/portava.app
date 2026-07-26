import React, { useCallback } from 'react';
import { useFocusEffect, router } from 'expo-router';
import { TelegraphInboxScreen } from '../../src/components/TelegraphInboxScreen';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { postCompassFrontloadEvent } from '../../src/services/compass';

export default function MessagesTab() {
  useFocusEffect(useCallback(() => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen: 'messages' }).catch(() => {});
  }, []));

  return (
    <>
      <AppHeader variant="detail" title="Messages" onBack={router.back} />
      <TelegraphInboxScreen topInset={0} />
    </>
  );
}
