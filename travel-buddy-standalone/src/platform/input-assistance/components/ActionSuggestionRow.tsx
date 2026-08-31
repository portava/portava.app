/**
 * ActionSuggestionRow — a suggestion that produces an ACTION, not text
 * (spec §21, §43, §54). e.g. "Share meeting point", "Add Bangkok to my trip".
 *
 * Every action routes through the canonical SuggestionAction contract; the
 * actual dispatch + authorization (§47 "same authorization gate as the target
 * action") is the consumer's responsibility — this row only presents the action
 * and invokes `onAction` with the suggestion. Accessible as a button.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { AssistanceTypeIcon } from './entityIcon.tsx';
import { color, space, radius, type as t, avatar, icon as iconToken } from '../../../theme/tokens.ts';

export interface ActionSuggestionRowProps {
  suggestion: InputSuggestion;
  onAction: (s: InputSuggestion) => void;
  active?: boolean;
  testID?: string;
}

function ActionSuggestionRowBase({ suggestion, onAction, active, testID }: ActionSuggestionRowProps) {
  return (
    <Pressable
      onPress={() => onAction(suggestion)}
      style={[styles.row, active && styles.rowActive]}
      accessibilityRole="button"
      accessibilityLabel={suggestion.label}
      accessibilityHint={suggestion.subtitle ?? suggestion.reason ?? undefined}
      accessibilityState={{ selected: !!active }}
      testID={testID ?? `ia-action-row-${suggestion.id}`}
    >
      <View style={styles.leading}>
        <AssistanceTypeIcon assistanceType="action" tint={color.signal} />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {suggestion.label}
        </Text>
        {suggestion.subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {suggestion.subtitle}
          </Text>
        ) : null}
      </View>
      <ChevronRight size={iconToken.s16} color={color.faint} />
    </Pressable>
  );
}

export const ActionSuggestionRow = React.memo(ActionSuggestionRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    gap: space.md,
    borderRadius: radius.md,
  },
  rowActive: {
    backgroundColor: color.haze,
  },
  leading: {
    width: avatar.s32,
    height: avatar.s32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  body: { flex: 1, minWidth: 0 },
  title: {
    ...t.bodyStrong,
    color: color.ink,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    marginTop: 1,
  },
});
