/**
 * Telegraph reactions under a message, and the picker in the message's long-press sheet (census T370).
 *
 * The chips draw exactly what the server served for the message — each emoji, how many, and whether one
 * of them is the viewer's — and never who reacted. Tapping a chip adds the viewer's reaction or takes it
 * back; the screen re-reads, so the count shown is always the server's. A message whose reactions could
 * not be read (`reactions: null`) draws nothing at all: "unreadable" is not "nobody reacted".
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { REACTION_CHOICES, type MessageReaction } from './reactionsApi.ts';

export function ReactionChips({
  reactions,
  onToggle,
  disabled = false,
}: {
  reactions: readonly MessageReaction[] | null | undefined;
  onToggle?: (emoji: string, mine: boolean) => void;
  disabled?: boolean;
}) {
  const { styles } = useTelegraphTheme(makeStyles);
  if (!Array.isArray(reactions) || reactions.length === 0) return null;
  return (
    <View style={styles.row} testID="telegraph-reactions">
      {reactions.map((r) => (
        <Pressable
          key={r.emoji}
          testID={`telegraph-reaction-${r.emoji}`}
          accessibilityRole="button"
          accessibilityState={{ selected: r.mine, disabled: disabled || !onToggle }}
          accessibilityLabel={`${r.emoji} ${r.count}${r.mine ? ', including yours. Tap to take yours back.' : '. Tap to add yours.'}`}
          disabled={disabled || !onToggle}
          onPress={() => onToggle?.(r.emoji, r.mine)}
          style={[styles.chip, r.mine && styles.chipMine]}
        >
          <Text style={styles.label}>{r.emoji} {r.count}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The long-press picker: the bounded set, each marked when it is already the viewer's. */
export function ReactionPicker({
  reactions,
  onPick,
}: {
  reactions: readonly MessageReaction[];
  onPick: (emoji: string, mine: boolean) => void;
}) {
  const { styles } = useTelegraphTheme(makeStyles);
  const mineSet = new Set(reactions.filter((r) => r.mine).map((r) => r.emoji));
  return (
    <View style={styles.picker} testID="telegraph-reaction-picker">
      {REACTION_CHOICES.map((e) => (
        <Pressable
          key={e}
          testID={`telegraph-react-${e}`}
          accessibilityRole="button"
          accessibilityState={{ selected: mineSet.has(e) }}
          accessibilityLabel={mineSet.has(e) ? `Take back ${e}` : `React ${e}`}
          onPress={() => onPick(e, mineSet.has(e))}
          style={[styles.pick, mineSet.has(e) && styles.chipMine]}
        >
          <Text style={styles.pickLabel}>{e}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({ // census T123/T124: the scheme's palette
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  chip: { paddingHorizontal: space.sm, minHeight: 28, justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: p.haze },
  chipMine: { borderColor: p.operational },
  label: { ...t.small, color: p.recvText },
  picker: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm },
  pick: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent' },
  pickLabel: { fontSize: 24 },
});

export default ReactionChips;
