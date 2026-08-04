/**
 * CompassFeedbackMenu — ⋯ feedback menu for Compass-backed cards.
 *
 * Action list (per spec):
 *   Why am I seeing this? · Not Now · More Like This · Not Interested ·
 *   Hide This · Wrong City · Already Went · Not Safe · Too Expensive ·
 *   Wrong Vibe · Report
 *
 * Optimistic UX: dismissing actions call onDismiss() IMMEDIATELY (before API)
 * so the card vanishes at once. If the API fails, onRestore?() is called to
 * put the card back. Toast appears after menu closes regardless of API result.
 *
 * "Report" routes to the existing moderation endpoint (reportContent) AND
 * logs the action to the Compass feedback endpoint.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, Platform, Animated,
} from 'react-native';
import {
  MoreHorizontal, HelpCircle, ThumbsUp, XCircle, EyeOff,
  MapPin, CheckCircle, ShieldOff, DollarSign, Meh, Flag, Clock,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useCompassFeedback } from '../../hooks/compass/useCompassFeedback.ts';
import { postCompassAnalyticsEvent, COMPASS_ENGINE_VERSION } from '../../services/compass.ts';
import { reportContent } from '../../services/reports.ts';
import type { CompassFeedbackAction } from '../../services/compass.ts';

// Matches the post-action-row spec: 20px icon, 44x44 min touch target via
// hitSlop rather than inflating the visual chrome (see PostActionRow.tsx).
const MORE_ICON_SIZE = 20;
const MORE_HIT_PAD = 12;

interface Props {
  recommendationId: string;
  /** Underlying entity ID (place/event/user) for moderation reports.
   *  Distinct from the recommendation token; decoded from the token at
   *  the call site when available. Falls back to recommendationId if absent. */
  itemId?:          string;
  itemType:         string;
  category?:        string;
  city?:            string;
  topic?:           string;
  targetUserId?:    string;
  sectionName?:     string;
  onWhyPress?:      () => void;
  onDismiss?:       () => void;
  onRestore?:       () => void;
  onTagShowMore?:   () => void;
}

interface ActionItem {
  key:        CompassFeedbackAction | 'why';
  label:      string;
  Icon:       React.ComponentType<{ size: number; color: string }>;
  iconColor?: string;
  dismisses?: boolean;
  tags?:      boolean;
}

const ACTIONS: ActionItem[] = [
  { key: 'why',            label: 'Why am I seeing this?', Icon: HelpCircle                                },
  { key: 'not_now',        label: 'Not now',               Icon: Clock,       dismisses: true              },
  { key: 'show_more',      label: 'More like this',        Icon: ThumbsUp,    tags: true                   },
  { key: 'not_interested', label: 'Not interested',        Icon: XCircle,     dismisses: true              },
  { key: 'hide_this',      label: 'Hide this',             Icon: EyeOff,      dismisses: true              },
  { key: 'wrong_city',     label: 'Wrong city',            Icon: MapPin,      iconColor: color.warn        },
  { key: 'already_went',   label: 'Already went',          Icon: CheckCircle, dismisses: true              },
  { key: 'not_safe',       label: 'Not safe',              Icon: ShieldOff,   iconColor: color.warn        },
  { key: 'too_expensive',  label: 'Too expensive',         Icon: DollarSign                                },
  { key: 'not_my_vibe',    label: 'Wrong vibe',            Icon: Meh                                       },
  { key: 'report',         label: 'Report',                Icon: Flag,        iconColor: '#E53935',
                            dismisses: true                                                                 },
];

const TOAST_LABELS: Partial<Record<CompassFeedbackAction | 'why', string>> = {
  not_now:        'Dismissed for now',
  show_more:      'Got it — showing more like this',
  not_interested: 'Got it — fewer like this',
  hide_this:      'This item will be hidden',
  wrong_city:     'Noted — adjusting city picks',
  already_went:   'Marked as visited',
  not_safe:       'Feedback noted — thank you',
  too_expensive:  'Got it — adjusting picks',
  not_my_vibe:    'Got it — adjusting picks',
  report:         'Reported — thank you',
};

// ── Inline toast ──────────────────────────────────────────────────────────────

function FeedbackToast({ message, onHide }: { message: string; onHide: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(1800),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) onHide(); });
  }, []);
  return (
    <Animated.View style={[toast.wrap, { opacity }]} pointerEvents="none">
      <Text style={toast.text}>{message}</Text>
    </Animated.View>
  );
}

const toast = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 12,
    left: 16,
    right: 16,
    backgroundColor: color.ink + 'EE',
    borderRadius: radius.md,
    paddingVertical: 9,
    paddingHorizontal: 14,
    alignItems: 'center',
    zIndex: 10,
  },
  text: {
    ...t.small,
    color: color.onInk,
    fontSize: 12,
    fontWeight: '600' as const,
    textAlign: 'center',
  },
});

// ── Menu component ────────────────────────────────────────────────────────────

export function CompassFeedbackMenu({
  recommendationId,
  itemId,
  itemType,
  category,
  city,
  topic,
  targetUserId,
  sectionName,
  onWhyPress,
  onDismiss,
  onRestore,
  onTagShowMore,
}: Props) {
  const [open,     setOpen]     = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const { sendFeedback } = useCompassFeedback();

  const visibleActions = ACTIONS.filter(
    (a) => a.key !== 'why' || onWhyPress !== undefined,
  );

  const handleAction = async (key: CompassFeedbackAction | 'why') => {
    setOpen(false);

    if (key === 'why') {
      onWhyPress?.();
      return;
    }

    const actionDef = visibleActions.find((a) => a.key === key);
    const toastLabel = TOAST_LABELS[key];
    if (toastLabel) setToastMsg(toastLabel);

    // ── Optimistic dismiss BEFORE the API call ────────────────────────────────
    if (actionDef?.dismisses) {
      onDismiss?.();
    } else if (actionDef?.tags) {
      onTagShowMore?.();
    }

    // ── Background API call ───────────────────────────────────────────────────
    const ok = await sendFeedback(key, {
      recommendationId, itemType, category, topic, targetUserId,
    });

    // ── Rollback if the API failed for a dismiss action ───────────────────────
    if (!ok && actionDef?.dismisses) {
      onRestore?.();
    }

    // ── Report action also routes to the moderation endpoint ──────────────────
    // Use the actual entity ID (itemId), not the recommendation token, so the
    // moderation system can look up the underlying content correctly.
    if (key === 'report') {
      reportContent({
        target_type:  itemType,
        target_id:    itemId ?? recommendationId,
        reason_code:  'inappropriate_content',
        reason_detail: `Compass card report — section: ${sectionName ?? 'unknown'}`,
      }).catch(() => {});
    }

    // ── Analytics event ───────────────────────────────────────────────────────
    postCompassAnalyticsEvent({
      event_name:             'compass_feedback_submitted',
      compass_engine_version: COMPASS_ENGINE_VERSION,
      item_type:              itemType,
      section_name:           sectionName,
      city,
      metadata:               { action: key, category },
    });
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={MORE_HIT_PAD}
        style={styles.trigger}
        accessibilityLabel="More options"
      >
        <MoreHorizontal size={MORE_ICON_SIZE} color={color.faint} />
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
                <a.Icon size={18} color={a.iconColor ?? color.deep} />
                <Text style={[styles.rowLabel, a.iconColor ? { color: a.iconColor } : undefined]}>
                  {a.key === 'wrong_city' && city
                    ? `Wrong city — not in ${city}`
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

      {toastMsg && (
        <FeedbackToast message={toastMsg} onHide={() => setToastMsg(null)} />
      )}
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
