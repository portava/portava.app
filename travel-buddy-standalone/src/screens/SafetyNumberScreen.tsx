/**
 * E-2: Safety Number Screen.
 *
 * Displays the 60-digit safety number for a 1:1 E2EE thread, derived from
 * both users' Ed25519 identity public keys.
 *
 * The safety number is shown in six groups of 10 digits. If it matches on
 * both devices (compare out-of-band), the conversation is authenticated.
 *
 * Route: pushed as a modal from the E2EE thread header lock badge.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getIdentityPublicKey } from '../lib/cryptoIdentity.ts';
import { deriveSafetyNumberForThread } from '../lib/mlsSession.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  /** The peer's display name (shown in the header). */
  peerName: string;
  /**
   * Thread whose live MLS group the number is derived from.
   *
   * Was the peer's identity public key fetched from the server — but the MLS
   * session never used that key, so the number it produced verified nothing.
   */
  threadId: string;
  onDismiss: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a 60-digit string as six rows of 10 digits for readability. */
function formatSafetyNumber(raw: string): string[] {
  const cleaned = raw.replace(/\D/g, '');
  const chunks: string[] = [];
  for (let i = 0; i < cleaned.length; i += 10) {
    chunks.push(cleaned.slice(i, i + 10));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SafetyNumberScreen({ peerName, threadId, onDismiss }: Props) {
  const insets = useSafeAreaInsets();
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Derived from the live MLS group, not from identity keys fetched from
        // the server — see deriveSafetyNumberForThread.
        const num = await deriveSafetyNumberForThread(threadId);
        if (!num) {
          setError('This conversation is not encrypted yet, so there is nothing to verify.');
          return;
        }
        if (!cancelled) setSafetyNumber(num);
      } catch (err) {
        if (!cancelled) setError('Could not compute safety number. Please try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [threadId]);

  const handleShare = useCallback(async () => {
    if (!safetyNumber) return;
    await Share.share({
      message: `Safety number with ${peerName} (Portava):\n${formatSafetyNumber(safetyNumber).join('\n')}`,
    });
  }, [safetyNumber, peerName]);

  const rows = safetyNumber ? formatSafetyNumber(safetyNumber) : [];

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onDismiss} accessibilityLabel="Close safety number screen">
          <Text style={styles.closeBtn}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Safety Number</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.subtitle}>
          Your chat with <Text style={styles.peerName}>{peerName}</Text> is end-to-end encrypted.
        </Text>

        <Text style={styles.instructions}>
          Compare this number with {peerName} in person or via a trusted channel. If it matches on both devices, your conversation is private and has not been tampered with.
        </Text>

        {loading && (
          <ActivityIndicator style={styles.spinner} size="large" color="#4A90E2" />
        )}

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && !error && rows.length > 0 && (
          <View style={styles.numberGrid} accessibilityLabel={`Safety number: ${rows.join(' ')}`}>
            {rows.map((chunk, idx) => (
              <Text key={idx} style={styles.numberRow} selectable>
                {chunk.match(/.{1,5}/g)?.join(' ') ?? chunk}
              </Text>
            ))}
          </View>
        )}

        {!loading && !error && safetyNumber && (
          <TouchableOpacity
            style={styles.shareBtn}
            onPress={handleShare}
            accessibilityLabel="Share safety number"
          >
            <Text style={styles.shareBtnText}>Share Safety Number</Text>
          </TouchableOpacity>
        )}

        <View style={styles.disclaimer}>
          <Text style={styles.disclaimerText}>
            This number changes if either party reinstalls the app or sets up a new device. Previous messages are not affected.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E0E0E0',
  },
  closeBtn: {
    fontSize: 18,
    color: '#666',
    padding: 4,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  headerSpacer: {
    width: 26,
  },
  content: {
    padding: 24,
    alignItems: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#333',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 22,
  },
  peerName: {
    fontWeight: '600',
  },
  instructions: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },
  spinner: {
    marginVertical: 32,
  },
  errorBox: {
    backgroundColor: '#FFF3F3',
    borderRadius: 8,
    padding: 16,
    marginVertical: 16,
    width: '100%',
  },
  errorText: {
    color: '#CC0000',
    fontSize: 14,
    textAlign: 'center',
  },
  numberGrid: {
    backgroundColor: '#F7F7F7',
    borderRadius: 12,
    padding: 24,
    width: '100%',
    marginBottom: 24,
  },
  numberRow: {
    fontSize: 22,
    fontFamily: 'monospace',
    letterSpacing: 3,
    color: '#1A1A1A',
    textAlign: 'center',
    marginVertical: 4,
    fontWeight: '500',
  },
  shareBtn: {
    backgroundColor: '#4A90E2',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
    marginBottom: 24,
  },
  shareBtnText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
  disclaimer: {
    marginTop: 8,
    paddingHorizontal: 8,
  },
  disclaimerText: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    lineHeight: 17,
  },
});
