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
import { color, space, radius, shadow, avatar } from '../theme/tokens.ts';
import { useBottomInset } from '../hooks/useBottomInset.ts';

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
  // Pill clearance + breathing room: the picker can open over tab surfaces
  // where the floating nav pill sits, so anchor it safely above it.
  const bottomInset = useBottomInset();
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
      <View style={[s.pickerWrap, { paddingBottom: bottomInset + space.xl }]} pointerEvents="box-none">
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

/**
 * Compact row showing grouped reaction counts (e.g. "❤️ 3  👍 2").
 *
 * When `onChipPress` is provided, tapping a specific emoji chip calls it with that emoji
 * (e.g. to open the likers sheet filtered to that reaction).
 * Otherwise, tapping any chip falls back to `onPress` (e.g. opens the reaction picker).
 */
export function ReactionSummary({
  reactions,
  myReaction,
  onPress,
  onChipPress,
}: {
  reactions: ReactionCount[];
  myReaction: string | null;
  onPress: () => void;
  onChipPress?: (emoji: string) => void;
}) {
  if (reactions.length === 0) return null;
  const sorted = [...reactions].sort((a, b) => b.count - a.count).slice(0, 4);
  return (
    <View style={s.summary}>
      {sorted.map(({ emoji, count }) => (
        <Pressable
          key={emoji}
          style={[s.reactionChip, myReaction === emoji && s.reactionChipActive]}
          onPress={() => (onChipPress ? onChipPress(emoji) : onPress())}
        >
          <Text style={s.reactionEmoji}>{emoji}</Text>
          {count > 1 && <Text style={[s.reactionCount, myReaction === emoji && s.reactionCountActive]}>{count}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  pickerWrap: {
    flex: 1,
    justifyContent: 'flex-end',
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
    width: avatar.s40, height: avatar.s40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: avatar.s40 / 2,
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
