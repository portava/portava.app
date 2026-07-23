/**
 * E-2: E2eeBadge
 *
 * Small lock-chip rendered in the Telegraph thread header (and the tag row
 * beneath the thread name) whenever the thread has an active MLS E2EE session.
 *
 * Tapping the badge is a deliberate no-op in the header: the lock is
 * informational. Verification is reached via ThreadSafetySheet → "Verify
 * safety number". This keeps the header tap-target clean for navigation.
 *
 * Design doc §10, Phase E-2.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Lock } from 'lucide-react-native';
import { radius, type as t } from '../theme/tokens.ts';

// E2EE green — distinct from Portava signal colour to signal a security context.
const E2EE_GREEN = '#2A7A4B';
const E2EE_TEXT  = '#FFFFFF';

interface Props {
  /** Size variant: 'sm' (thread header tag row) | 'md' (message bubble). Defaults to 'sm'. */
  size?: 'sm' | 'md';
}

export function E2eeBadge({ size = 'sm' }: Props) {
  const iconSize  = size === 'md' ? 11 : 9;
  const textStyle = size === 'md' ? styles.labelMd : styles.labelSm;
  const wrapStyle = size === 'md' ? styles.wrapMd  : styles.wrapSm;

  return (
    <View
      style={[styles.base, wrapStyle]}
      accessibilityLabel="End-to-end encrypted"
      accessibilityRole="text"
    >
      <Lock size={iconSize} color={E2EE_TEXT} strokeWidth={2.5} />
      <Text style={[styles.label, textStyle]}>E2EE</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: E2EE_GREEN,
    borderRadius: radius.sm,
    gap: 2,
  },
  wrapSm: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  wrapMd: {
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  label: {
    ...t.stamp,
    color: E2EE_TEXT,
    fontFamily: 'Courier',
    letterSpacing: 0.4,
    fontWeight: '700',
  },
  labelSm: {
    fontSize: 9,
  },
  labelMd: {
    fontSize: 11,
  },
});
