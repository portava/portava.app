/**
 * AiSuggestionRow — an OPT-IN, provenance-marked AI writing proposal
 * (spec §22, §8, §2).
 *
 * Renders one `ai_suggestion` (`source:'ai'`) row as a TAP-TO-INSERT proposal:
 * the whole row is a button that, on press, hands the suggestion to `onInsert`
 * so the CONSUMER places `replacementText` into an EDITABLE field. This row
 * NEVER inserts on its own and NEVER submits — it is a proposal the user accepts
 * with a tap and can then edit. It is clearly marked as AI (a "Wand" glyph + an
 * "AI" provenance pill + an "AI-suggested" reason) so it can never be mistaken
 * for a canonical suggestion, and it carries a dismiss control (§22 dismissible).
 *
 * Placement makes it SECONDARY (§2/§9): consumers render it BELOW canonical
 * suggestions. Accessible as a button whose hint states it inserts editable text.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Wand2, CornerDownLeft, X } from 'lucide-react-native';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import { color, space, radius, type as t, avatar, icon as iconToken } from '../../../theme/tokens.ts';

export interface AiSuggestionRowProps {
  suggestion: InputSuggestion;
  /** User TAPPED to accept — the consumer inserts the text into the editable field (§22). */
  onInsert: (s: InputSuggestion) => void;
  /** User dismissed the proposal. Optional — when omitted, no dismiss control shows. */
  onDismiss?: (s: InputSuggestion) => void;
  active?: boolean;
  testID?: string;
}

function AiSuggestionRowBase({ suggestion, onInsert, onDismiss, active, testID }: AiSuggestionRowProps) {
  const text = suggestion.label ?? suggestion.replacementText ?? '';
  const reason = suggestion.reason ?? 'AI-suggested draft';

  return (
    <View style={[styles.row, active && styles.rowActive]}>
      <Pressable
        onPress={() => onInsert(suggestion)}
        style={styles.main}
        accessibilityRole="button"
        accessibilityLabel={`AI suggestion: ${text}`}
        accessibilityHint="Inserts this editable text into the field. You can change it before sending; nothing is sent automatically."
        accessibilityState={{ selected: !!active }}
        testID={testID ?? `ia-ai-row-${suggestion.id}`}
      >
        <View style={styles.leading}>
          <Wand2 size={iconToken.s18} color={color.signal} />
        </View>
        <View style={styles.body}>
          <View style={styles.tagLine}>
            <View style={styles.aiPill}>
              <Text style={styles.aiPillText}>AI</Text>
            </View>
            <Text style={styles.reason} numberOfLines={1}>
              {reason}
            </Text>
          </View>
          <Text style={styles.text} numberOfLines={3}>
            {text}
          </Text>
          <View style={styles.insertHint}>
            <CornerDownLeft size={iconToken.s14} color={color.deep} />
            <Text style={styles.insertHintText}>Tap to insert · editable</Text>
          </View>
        </View>
      </Pressable>

      {onDismiss ? (
        <Pressable
          onPress={() => onDismiss(suggestion)}
          style={styles.dismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss AI suggestion"
          hitSlop={8}
          testID={`ia-ai-dismiss-${suggestion.id}`}
        >
          <X size={iconToken.s16} color={color.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

export const AiSuggestionRow = React.memo(AiSuggestionRowBase);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  rowActive: {
    borderColor: color.deep,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
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
  tagLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginBottom: 2,
  },
  aiPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: color.deep,
  },
  aiPillText: {
    ...t.stamp,
    color: color.onInk,
  },
  reason: {
    ...t.stamp,
    color: color.mute,
    flexShrink: 1,
  },
  text: {
    ...t.body,
    color: color.ink,
  },
  insertHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  insertHintText: {
    ...t.small,
    color: color.deep,
  },
  dismiss: {
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
  },
});
