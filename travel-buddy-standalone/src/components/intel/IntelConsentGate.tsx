/**
 * IntelConsentGate — the first-use Intelligence Contributions disclosure + consent
 * surface (D4).
 *
 * Shown on the Quick Signal screen when capture is enabled but the traveler has
 * not granted consent. Consent is an EXPLICIT affirmative action ("Allow & Share")
 * — never pre-checked, never implied by opening the screen or continuing. The
 * button records consent server-side (which stamps the version + timestamp); only
 * on success does the composer proceed. "Not Now" leaves without capturing.
 */
import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import { setIntelConsent, type IntelConsentState } from '../../services/intelConsent.ts';

export interface IntelConsentGateProps {
  onAllow: (state: IntelConsentState) => void;
  onNotNow: () => void;
}

export function IntelConsentGate({ onAllow, onNotNow }: IntelConsentGateProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allow = useCallback(async () => {
    setBusy(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const state = await setIntelConsent(true);
    setBusy(false);
    if (state && state.enabled && !state.withdrawnAt) {
      onAllow(state);
    } else {
      setError('Could not save that just now — please try again.');
    }
  }, [onAllow]);

  return (
    <View style={styles.card} testID="intel-consent-gate">
      <Text style={styles.title}>Help improve live place intelligence</Text>
      <Text style={styles.body}>
        Your Quick Signals can be combined with reports from other travelers to show what a place is
        like right now.
      </Text>
      <Text style={styles.body}>
        Your identity and exact location aren&apos;t shown publicly with the signal. Portava uses your
        contribution to generate aggregated place intelligence.
      </Text>
      <Text style={styles.muted}>You can turn Intelligence Contributions off anytime in Privacy settings.</Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        testID="intel-consent-allow"
        accessibilityRole="button"
        accessibilityLabel="Allow and share"
        disabled={busy}
        onPress={allow}
        style={({ pressed }) => [styles.primary, pressed && !busy && styles.primaryPressed, busy && styles.primaryBusy]}
      >
        {busy ? <ActivityIndicator size="small" color={color.onInk} /> : null}
        <Text style={styles.primaryText}>Allow &amp; Share</Text>
      </Pressable>

      <Pressable
        testID="intel-consent-notnow"
        accessibilityRole="button"
        accessibilityLabel="Not now"
        disabled={busy}
        onPress={() => { if (!busy) onNotNow(); }}
        style={({ pressed }) => [styles.ghost, pressed && !busy && styles.ghostPressed]}
      >
        <Text style={styles.ghostText}>Not Now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: space.sm,
  },
  title: { ...typography.cardTitle, color: color.ink },
  body: { ...typography.caption, color: color.mute, lineHeight: 20 },
  muted: { ...typography.caption, color: color.faint, lineHeight: 18 },
  error: { ...typography.caption, color: color.signal },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: space.sm,
    paddingVertical: 13,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
    minHeight: 48,
  },
  primaryPressed: { backgroundColor: color.signalDim },
  primaryBusy: { opacity: 0.7 },
  primaryText: { ...typography.button, color: color.onInk },
  ghost: { alignItems: 'center', justifyContent: 'center', paddingVertical: 11, minHeight: 44 },
  ghostPressed: { opacity: 0.6 },
  ghostText: { ...typography.button, color: color.mute },
});
