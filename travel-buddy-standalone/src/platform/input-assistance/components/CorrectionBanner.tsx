/**
 * CorrectionBanner — "Did you mean …?" / validation notice (spec §23, §27
 * "Correction banner", §46).
 *
 * Non-blocking by contract: it never prevents submission, it only offers a
 * canonical correction the user can accept or dismiss (§2 preserve user
 * control). Used for §23 cases: "Did you mean Phu Quoc?", city/country mismatch,
 * username unavailable + alternatives.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { AlertCircle, X } from 'lucide-react-native';
import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';

export interface CorrectionBannerProps {
  /** The message, e.g. "Did you mean Phu Quoc?" or "Username unavailable". */
  message: string;
  /** Optional accept affordance (e.g. apply the corrected spelling). */
  onAccept?: () => void;
  /** Accept button label. Default "Use this". */
  acceptLabel?: string;
  /** Dismiss the banner (keep the user's original input). */
  onDismiss?: () => void;
  /** 'warning' (default) or 'error' — non-color-only cue via the leading icon + label. */
  tone?: 'warning' | 'error';
  testID?: string;
}

function CorrectionBannerBase({
  message,
  onAccept,
  acceptLabel = 'Use this',
  onDismiss,
  tone = 'warning',
  testID,
}: CorrectionBannerProps) {
  const accent = tone === 'error' ? color.signal : color.warn;
  return (
    <View
      style={[styles.banner, { borderColor: accent }]}
      accessibilityRole="alert"
      accessibilityLabel={message}
      testID={testID ?? 'ia-correction-banner'}
    >
      <AlertCircle size={iconToken.s16} color={accent} />
      <Text style={styles.message} numberOfLines={2}>
        {message}
      </Text>
      {onAccept ? (
        <Pressable
          onPress={onAccept}
          style={styles.accept}
          accessibilityRole="button"
          accessibilityLabel={acceptLabel}
        >
          <Text style={[styles.acceptText, { color: accent }]}>{acceptLabel}</Text>
        </Pressable>
      ) : null}
      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          style={styles.dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          hitSlop={8}
        >
          <X size={iconToken.s16} color={color.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

export const CorrectionBanner = React.memo(CorrectionBannerBase);

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: color.paperRaised,
  },
  message: {
    ...t.small,
    color: color.ink,
    flex: 1,
    minWidth: 0,
  },
  accept: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  acceptText: {
    ...t.small,
    fontWeight: '700',
  },
  dismiss: {
    padding: space.xs,
  },
});
