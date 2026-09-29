/**
 * Safe Return live share — /safe-return/:shareId (TRUST-F10)
 *
 * Where a trusted contact lands from the `location.live_share_started`
 * notification (in-app row and push both carry actionUrl
 * `/safe-return/<shareId>`, api-server NotificationTemplateService) or a shared
 * link. Mounts LiveShareRecipientView, which reads
 * GET /api/safe-return/live-share/:shareId — recipient-only on the server
 * (requireSafeReturnRecipient), approximate area only, never exact GPS.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppHeader } from '../../src/components/ui/AppHeader.tsx';
import { LiveShareRecipientView } from '../../src/components/safeReturn/LiveShareRecipientView.tsx';
import { color, space, type as t } from '../../src/theme/tokens.ts';

export default function SafeReturnLiveShareScreen() {
  const insets = useSafeAreaInsets();
  const { shareId } = useLocalSearchParams<{ shareId: string }>();
  const id = typeof shareId === 'string' ? shareId.trim() : '';

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <AppHeader variant="detail" title="Live location" onBack={router.back} />
      {id ? (
        <LiveShareRecipientView shareId={id} />
      ) : (
        <View style={styles.center} testID="live-share-bad-link">
          <Text style={styles.text}>This link is incomplete. Open the live share from your notification again.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  text: { ...t.body, color: color.mute, textAlign: 'center' },
});
