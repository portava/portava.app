/**
 * ClaimConfirmBar — independent agree / disagree / unsure on a live claim.
 *
 * This is the confirm half of the Structured Moment flow (POST /claims/:id/
 * confirm). It is NOT authoring: it lets a second traveler corroborate or
 * contest a claim someone else made, which is what turns a lone report into
 * consensus (or conflict). One tap per stance; the chosen stance stays
 * highlighted after it lands.
 */
import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { ThumbsUp, ThumbsDown, Meh } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { color, space, radius, typography } from '../../theme/tokens.ts';
import { CONFIRM_STANCES, type ConfirmStance } from '../../lib/intel/contracts.ts';

const META: Record<ConfirmStance, { label: string; Icon: React.ComponentType<{ size?: number; color?: string }>; tint: string }> = {
  agree: { label: 'Still true', Icon: ThumbsUp, tint: color.success },
  disagree: { label: 'Not now', Icon: ThumbsDown, tint: color.signal },
  unsure: { label: 'Not sure', Icon: Meh, tint: color.mute },
};

export interface ClaimConfirmBarProps {
  onConfirm: (stance: ConfirmStance) => void;
  /** The stance whose write is in flight. */
  busy?: ConfirmStance | null;
  /** The stance already recorded this session (stays highlighted). */
  selected?: ConfirmStance | null;
  disabled?: boolean;
}

export function ClaimConfirmBar({ onConfirm, busy, selected, disabled }: ClaimConfirmBarProps) {
  const anyBusy = !!busy;
  return (
    <View style={styles.row}>
      {CONFIRM_STANCES.map((stance) => {
        const { label, Icon, tint } = META[stance];
        const isBusy = busy === stance;
        const isSelected = selected === stance;
        const isDisabled = disabled || (anyBusy && !isBusy);
        return (
          <Pressable
            key={stance}
            testID={`intel-confirm-${stance}`}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isSelected, disabled: isDisabled, busy: isBusy }}
            disabled={isDisabled}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
              onConfirm(stance);
            }}
            style={({ pressed }) => [
              styles.btn,
              isSelected && { borderColor: tint, backgroundColor: tint + '14' },
              isDisabled && !isBusy && styles.btnDisabled,
              pressed && !isDisabled && styles.btnPressed,
            ]}
          >
            {isBusy ? (
              <ActivityIndicator size="small" color={tint} />
            ) : (
              <Icon size={18} color={isSelected ? tint : color.mute} />
            )}
            <Text style={[styles.label, isSelected && { color: tint }]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm },
  btn: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    minHeight: 60,
  },
  btnPressed: { opacity: 0.85 },
  btnDisabled: { opacity: 0.4 },
  label: { ...typography.label, color: color.mute },
});
