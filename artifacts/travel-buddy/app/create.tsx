import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { UnifiedPostComposer } from '../src/components/PulseCreate';

/**
 * /create — thin modal wrapper around UnifiedPostComposer.
 * Opened by the center POST stamp button in the tab bar (and the desktop
 * sidebar compose button). Renders the same bottom-sheet composer as the
 * "Post" pill in PulseHeader so all creation entry-points behave identically.
 */
export default function Create() {
  function dismiss() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)' as any);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <UnifiedPostComposer
        visible
        onClose={dismiss}
        onSuccess={dismiss}
      />
    </View>
  );
}
