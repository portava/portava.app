/**
 * CompassFeedbackMenu — ⋯ / long-press feedback menu for Compass-backed cards.
 *
 * Renders an action sheet with: Why am I seeing this?, Show more like this,
 * Show less like this, Not interested, Hide [category], Hide this user,
 * Mute topic, and Report.
 *
 * Optimistically removes or tags the card on selection; posts to the
 * Compass feedback endpoint in the background.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, Platform,
} from 'react-native';
import {
  MoreHorizontal, HelpCircle, ThumbsUp, ThumbsDown,
  XCircle, EyeOff, UserX, Volume2, Flag,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { useCompassFeedback } from '../../hooks/compass/useCompassFeedback';
import type { CompassFeedbackAction } from '../../services/compass';

interface Props {
  recommendationId: string;
  itemType:         string;
  category?:        string;
  topic?:           string;
  targetUserId?:    string;
  onWhyPress?:      () => void;
  onDismiss?:       () => void;
  onTagShowMore?:   () => void;
}

interface ActionItem {
  key:    CompassFeedbackAction | 'why';
  label:  string;
  Icon:   React.ComponentType<{ size: number; color: string }>;
  color?: string;
}

const ACTIONS: ActionItem[] = [
  { key: 'why',           label: 'Why am I seeing this?',  Icon: HelpCircle },
  { key: 'show_more',     label: 'Show more like this',     Icon: ThumbsUp  },
  { key: 'show_less',     label: 'Show less like this',     Icon: ThumbsDown },
  { key: 'not_interested', label: 'Not interested',          Icon: XCircle   },
  { key: 'hide_category', label: 'Hide this category',      Icon: EyeOff    },
  { key: 'hide_user',     label: 'Hide this user',          Icon: UserX,  color: color.warn },
  { key: 'mute_topic',    label: 'Mute topic',              Icon: Volume2   },
  { key: 'report',        label: 'Report',                  Icon: Flag,   color: '#E53935' },
];

export function CompassFeedbackMenu({
  recommendationId,
  itemType,
  category,
  topic,
  targetUserId,
  onWhyPress,
  onDismiss,
  onTagShowMore,
}: Props) {
  const [open, setOpen] = useState(false);
  const { sendFeedback } = useCompassFeedback();

  // Only show "Why am I seeing this?" when a signed recommendation token
  // is available and a handler is wired. Plain entity IDs (non-Compass surfaces)
  // would fail the /why endpoint's token validation.
  const visibleActions = ACTIONS.filter(
    (a) => a.key !== 'why' || onWhyPress !== undefined,
  );

  const handleAction = async (key: CompassFeedbackAction | 'why') => {
    setOpen(false);
    if (key === 'why') {
      onWhyPress?.();
      return;
    }
    await sendFeedback(key, { recommendationId, itemType, category, topic, targetUserId });
    if (key === 'not_interested' || key === 'hide_user' || key === 'block') {
      onDismiss?.();
    } else if (key === 'show_more') {
      onTagShowMore?.();
    }
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={8}
        style={styles.trigger}
        accessibilityLabel="More options"
      >
        <MoreHorizontal size={18} color={color.faint} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType={Platform.OS === 'android' ? 'fade' : 'slide'}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Feedback</Text>
            {visibleActions.map((a, i) => (
              <Pressable
                key={a.key}
                style={[styles.row, i === visibleActions.length - 1 && styles.rowLast]}
                onPress={() => handleAction(a.key)}
              >
                <a.Icon size={18} color={a.color ?? color.deep} />
                <Text style={[styles.rowLabel, a.color ? { color: a.color } : undefined]}>
                  {a.key === 'hide_category' && category
                    ? `Hide "${category}" category`
                    : a.label}
                </Text>
              </Pressable>
            ))}
            <Pressable style={styles.cancel} onPress={() => setOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    padding: 4,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 32,
    paddingHorizontal: space.lg,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.md,
  },
  sheetTitle: {
    ...t.bodyStrong,
    color: color.ink,
    marginBottom: space.md,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowLabel: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  cancel: {
    marginTop: space.md,
    alignItems: 'center',
    paddingVertical: 12,
  },
  cancelText: {
    ...t.bodyStrong,
    color: color.mute,
  },
});
