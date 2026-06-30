/**
 * ReactionPicker — floating emoji picker for post reactions.
 *
 * Opens as a small modal row of emoji options above the trigger point.
 * Long-pressing the like/reaction area opens the picker; tapping an
 * emoji upserts the reaction (or removes it if it was already selected).
 */
import React, { useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';
import { color, space, radius, shadow } from '../theme/tokens';

export const REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍', '🔥', '✈️'] as const;
export type ReactionEmoji = typeof REACTION_EMOJIS[number];

export interface ReactionCount {
  emoji: string;
  count: number;
}

interface Props {
  visible: boolean;
  myReaction: string | null;
  onSelect: (emoji: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function ReactionPicker({ visible, myReaction, onSelect, onRemove, onClose }: Props) {
  const handlePress = useCallback(
    (emoji: string) => {
      if (emoji === myReaction) {
        onRemove();
      } else {
        onSelect(emoji);
      }
      onClose();
    },
    [myReaction, onSelect, onRemove, onClose],
  );

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.pickerWrap} pointerEvents="box-none">
        <View style={s.picker}>
          {REACTION_EMOJIS.map((emoji) => (
            <Pressable
              key={emoji}
              style={[s.emojiBtn, myReaction === emoji && s.emojiBtnSelected]}
              onPress={() => handlePress(emoji)}
              hitSlop={6}
            >
              <Text style={s.emoji}>{emoji}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

/** Compact row showing grouped reaction counts (e.g. "❤️ 3  👍 2"). */
export function ReactionSummary({
  reactions,
  myReaction,
  onPress,
}: {
  reactions: ReactionCount[];
  myReaction: string | null;
  onPress: () => void;
}) {
  if (reactions.length === 0) return null;
  const sorted = [...reactions].sort((a, b) => b.count - a.count).slice(0, 4);
  return (
    <Pressable style={s.summary} onPress={onPress}>
      {sorted.map(({ emoji, count }) => (
        <View
          key={emoji}
          style={[s.reactionChip, myReaction === emoji && s.reactionChipActive]}
        >
          <Text style={s.reactionEmoji}>{emoji}</Text>
          {count > 1 && <Text style={[s.reactionCount, myReaction === emoji && s.reactionCountActive]}>{count}</Text>}
        </View>
      ))}
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  pickerWrap: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: 160,
    paddingHorizontal: space.lg,
  },
  picker: {
    flexDirection: 'row',
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    gap: 2,
    alignSelf: 'flex-start',
    ...shadow.card,
  },
  emojiBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  emojiBtnSelected: {
    backgroundColor: color.signal + '18',
  },
  emoji: {
    fontSize: 22,
  },
  summary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  reactionChipActive: {
    borderColor: color.signal,
    backgroundColor: color.signal + '10',
  },
  reactionEmoji: {
    fontSize: 14,
  },
  reactionCount: {
    fontSize: 12,
    fontWeight: '600',
    color: color.mute,
  },
  reactionCountActive: {
    color: color.signal,
  },
});
