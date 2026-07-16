/**
 * TelegraphFeedbackMenu — feedback controls for recommendation cards.
 * "More like this", "Less like this", "Not for me", "Save", "Dismiss"
 *
 * Auth token is obtained internally by the intelligence service.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet,
} from 'react-native';
import { MoreHorizontal, ThumbsUp, ThumbsDown, X, Heart, EyeOff } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import { sendFeedback, type FeedbackSignal } from '../services/intelligence';

interface FeedbackMenuProps {
  recommendationId: string;
  category: string;
  tripId?: string;
  onDismiss?: () => void;
  onSave?: () => void;
}

interface FeedbackOption {
  label: string;
  signal: FeedbackSignal;
  icon: React.ComponentType<any>;
  tint: string;
}

const OPTIONS: FeedbackOption[] = [
  { label: 'More like this', signal: 'more_like_this', icon: ThumbsUp, tint: color.deep },
  { label: 'Less like this', signal: 'less_like_this', icon: ThumbsDown, tint: color.mute },
  { label: 'Not for me', signal: 'not_for_me', icon: X, tint: color.signal },
  { label: 'Save', signal: 'save', icon: Heart, tint: color.success ?? color.deep },
  { label: 'Dismiss', signal: 'dismiss', icon: EyeOff, tint: color.mute },
];

export function TelegraphFeedbackMenu({
  recommendationId, category, tripId, onDismiss, onSave,
}: FeedbackMenuProps) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<FeedbackSignal | null>(null);

  async function handleSelect(option: FeedbackOption) {
    setOpen(false);
    setSent(option.signal);
    await sendFeedback(recommendationId, category, option.signal, tripId);
    if (option.signal === 'dismiss' || option.signal === 'not_for_me') {
      onDismiss?.();
    }
    if (option.signal === 'save') {
      onSave?.();
    }
  }

  if (sent && (sent === 'dismiss' || sent === 'not_for_me')) return null;

  return (
    <View>
      <Pressable style={s.trigger} onPress={() => setOpen(true)} hitSlop={8}>
        <MoreHorizontal size={16} color={sent ? color.signal : color.mute} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.overlay} onPress={() => setOpen(false)}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>Feedback</Text>
            {OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <Pressable
                  key={opt.signal}
                  style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
                  onPress={() => handleSelect(opt)}
                >
                  <Icon size={15} color={opt.tint} />
                  <Text style={[s.rowLabel, { color: opt.tint }]}>{opt.label}</Text>
                </Pressable>
              );
            })}
            <Pressable style={s.cancelBtn} onPress={() => setOpen(false)}>
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  trigger: { padding: 4 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.xl,
    paddingBottom: space.xxxl,
    gap: space.xs,
  },
  sheetTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm, fontSize: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  rowLabel: { ...t.body, fontSize: 15 },
  cancelBtn: { marginTop: space.md, alignItems: 'center', paddingVertical: space.md },
  cancelText: { ...t.body, color: color.mute },
});
