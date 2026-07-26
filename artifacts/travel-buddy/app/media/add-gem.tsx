/**
 * /media/add-gem — dedicated Add a Gem creation screen.
 *
 * Mounted as a modal route (presentationStyle: modal / transparent overlay).
 * The AddGemForm component handles the two-step flow:
 *   Step 1 — Media pick (photo/video, gated by upload flags)
 *   Step 2 — Place + details form with canonical place picker
 *
 * Opened from:
 *   - The Media tab FAB when in Gems mode
 *   - The MediaQuickCreateSheet "Add a Gem" row
 *   - GemsItemOverlay "Add a Gem" entry point (Gems mode overlay)
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, shadow } from '../../src/theme/tokens';
import { AddGemForm } from '../../src/components/media/AddGemForm';

export default function AddGemScreen() {
  const insets = useSafeAreaInsets();

  const dismissed = React.useRef(false);
  function dismiss() {
    if (dismissed.current) return;
    dismissed.current = true;
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)/media' as any);
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.sheet}>
        <AddGemForm
          onClose={dismiss}
          onSuccess={() => {
            // Stay on the processing/done screen; dismiss handled inside form
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '95%',
    flex: 1,
    ...shadow.float,
  },
});
