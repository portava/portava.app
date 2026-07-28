/**
 * PostWrongPlaceSheet — bottom sheet for reporting a bad place attachment on
 * a post. Presents three reason options; taps POST /api/posts/:id/wrong-place.
 * Shows a confirmation toast on success; dismisses on cancel.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, ActivityIndicator,
} from 'react-native';
import { X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { reportWrongPlace } from '../services/posts.ts';

// ── Reason options ─────────────────────────────────────────────────────────────

const REASONS: Array<{ value: string; label: string; sub: string }> = [
  {
    value: 'wrong_location',
    label: 'Wrong location',
    sub: 'The place shown is in a different area than this post.',
  },
  {
    value: 'not_the_same_place',
    label: 'Not the same place',
    sub: 'This tag links to a different venue with a similar name.',
  },
  {
    value: 'duplicate',
    label: 'Duplicate entry',
    sub: 'The same real place appears twice in the database.',
  },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface PostWrongPlaceSheetProps {
  postId: string;
  visible: boolean;
  onClose: () => void;
  onReported?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PostWrongPlaceSheet({
  postId,
  visible,
  onClose,
  onReported,
}: PostWrongPlaceSheetProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function reset() {
    setSelected(null);
    setSubmitting(false);
    setDone(false);
    setErrorMsg(null);
  }

  function handleClose() {
    onClose();
    // Defer reset so the modal exit animation isn't interrupted.
    setTimeout(reset, 400);
  }

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);

    const result = await reportWrongPlace(postId, selected);

    setSubmitting(false);
    if (result.ok) {
      setDone(true);
      onReported?.();
      setTimeout(handleClose, 2000);
    } else {
      setErrorMsg(result.message ?? 'Could not submit report. Please try again.');
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
      testID="post-wrong-place-modal"
    >
      <Pressable style={s.backdrop} onPress={handleClose} />
      <View style={s.sheet}>
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>Wrong place?</Text>
          <Pressable onPress={handleClose} hitSlop={8} testID="post-wrong-place-close">
            <X size={20} color={color.ink} />
          </Pressable>
        </View>
        <Text style={s.subtitle}>
          Let us know why this location tag seems incorrect. Our team will review it.
        </Text>

        {done ? (
          /* Success state */
          <View style={s.doneWrap} testID="post-wrong-place-done">
            <Text style={s.doneIcon}>✓</Text>
            <Text style={s.doneTitle}>Report submitted</Text>
            <Text style={s.doneSub}>Thank you — we'll look into this.</Text>
          </View>
        ) : (
          <>
            {/* Reason picker */}
            <View style={s.reasons}>
              {REASONS.map((r) => (
                <Pressable
                  key={r.value}
                  style={[s.reasonRow, selected === r.value && s.reasonRowSelected]}
                  onPress={() => setSelected(r.value)}
                  testID={`wrong-place-reason-${r.value}`}
                >
                  <View style={[s.radio, selected === r.value && s.radioSelected]}>
                    {selected === r.value && <View style={s.radioDot} />}
                  </View>
                  <View style={s.reasonText}>
                    <Text style={s.reasonLabel}>{r.label}</Text>
                    <Text style={s.reasonSub}>{r.sub}</Text>
                  </View>
                </Pressable>
              ))}
            </View>

            {/* Error */}
            {errorMsg ? (
              <Text style={s.error} testID="post-wrong-place-error">{errorMsg}</Text>
            ) : null}

            {/* Submit */}
            <Pressable
              style={[s.submitBtn, (!selected || submitting) && s.submitBtnDisabled]}
              onPress={submit}
              disabled={!selected || submitting}
              testID="post-wrong-place-submit"
            >
              {submitting ? (
                <ActivityIndicator size="small" color={color.onInk} />
              ) : (
                <Text style={s.submitText}>Submit report</Text>
              )}
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: space.xl,
    paddingHorizontal: space.lg,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  title: {
    ...t.bodyStrong,
    fontSize: 17,
    color: color.ink,
  },
  subtitle: {
    ...t.body,
    color: color.mute,
    fontSize: 13,
    marginBottom: space.md,
  },
  reasons: {
    gap: space.sm,
    marginBottom: space.md,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.haze,
  },
  reasonRowSelected: {
    borderColor: color.signal,
    backgroundColor: color.signal + '10',
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  radioSelected: {
    borderColor: color.signal,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: color.signal,
  },
  reasonText: {
    flex: 1,
    gap: 2,
  },
  reasonLabel: {
    ...t.bodyStrong,
    fontSize: 14,
    color: color.ink,
  },
  reasonSub: {
    ...t.body,
    fontSize: 12,
    color: color.mute,
    lineHeight: 17,
  },
  error: {
    ...t.body,
    fontSize: 13,
    color: '#B91C1C',
    marginBottom: space.sm,
    textAlign: 'center',
  },
  submitBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.45,
  },
  submitText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 15,
  },
  doneWrap: {
    alignItems: 'center',
    paddingVertical: space.xl,
    gap: space.sm,
  },
  doneIcon: {
    fontSize: 40,
    color: '#047857',
  },
  doneTitle: {
    ...t.bodyStrong,
    fontSize: 17,
    color: color.ink,
  },
  doneSub: {
    ...t.body,
    fontSize: 13,
    color: color.mute,
    textAlign: 'center',
  },
});
