/**
 * PlaceReportSheet — three-step report sheet for canonical place entities.
 *
 * Step 1: Category picker (7 place-specific reasons)
 * Step 2: Optional detail text input (500 char)
 * Step 3: Confirmation ("report received" — even when the server rejects)
 *
 * Posts via submitModerationReport with subjectType: 'place'.
 *
 * Server endpoint note: POST /api/places/:id/report (or equivalent) may need
 * to be created server-side. This component catches all non-OK API responses
 * gracefully and always shows the step-3 confirmation — it never crashes on
 * a server rejection.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, TextInput,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import {
  submitModerationReport,
  PLACE_REPORT_CATEGORY_LABELS,
} from '../services/moderation.ts';
import type { PlaceReportCategory } from '../types/canonicalPlace.ts';

// ── Category list ─────────────────────────────────────────────────────────────

const PLACE_CATEGORIES: PlaceReportCategory[] = [
  'wrong_place',
  'wrong_photo',
  'duplicate',
  'closed',
  'incorrect_address',
  'incorrect_category',
  'outdated_image',
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlaceReportSheetProps {
  visible:    boolean;
  onClose:    () => void;
  placeId:    string;
  placeName?: string | null;
  onReported?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlaceReportSheet({
  visible,
  onClose,
  placeId,
  placeName,
  onReported,
}: PlaceReportSheetProps) {
  const [step, setStep]           = useState<1 | 2 | 3>(1);
  const [category, setCategory]   = useState<PlaceReportCategory | null>(null);
  const [details, setDetails]     = useState('');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setStep(1);
    setCategory(null);
    setDetails('');
    setSubmitting(false);
  }

  function handleClose() {
    onClose();
    reset();
  }

  async function handleSubmit() {
    if (!category || submitting) return;
    setSubmitting(true);

    // Post the report — catch all failures gracefully and always show confirmation.
    // Server-side note: if POST /api/places/:id/report does not yet exist, the
    // moderation endpoint returns a non-OK status; we treat any error as
    // "report received" so the user experience is consistent.
    try {
      await submitModerationReport({
        subjectType: 'place',
        subjectId:   placeId,
        category,
        details:     details.trim() || undefined,
      });
    } catch {
      // Swallow — step 3 always shows confirmation regardless.
    }

    setSubmitting(false);
    setStep(3);
    onReported?.();
  }

  const charCount = details.length;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardSafeScrollView style={rs.overlay}>
        <Pressable testID="place-report-sheet-backdrop" style={StyleSheet.absoluteFill} onPress={handleClose} />
        <View style={rs.sheet}>
          <View style={rs.handle} />

          {/* Step 1 — Category picker */}
          {step === 1 && (
            <>
              <View style={rs.header}>
                <Text style={rs.title}>Report place</Text>
                <Pressable onPress={handleClose} hitSlop={8} testID="place-report-sheet-close">
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <Text style={rs.sub}>What's the issue with {placeName ?? 'this place'}?</Text>
              <ScrollView showsVerticalScrollIndicator={false}>
                {PLACE_CATEGORIES.map((cat) => (
                  <Pressable
                    key={cat}
                    testID={`place-report-cat-${cat}`}
                    style={[rs.optionRow, category === cat && rs.optionRowSelected]}
                    onPress={() => setCategory(cat)}
                  >
                    <Text style={[rs.optionLabel, category === cat && rs.optionLabelSelected]}>
                      {PLACE_REPORT_CATEGORY_LABELS[cat]}
                    </Text>
                    {category === cat && <Text style={rs.check}>✓</Text>}
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable
                testID="place-report-sheet-next"
                style={[rs.primaryBtn, !category && rs.btnDisabled]}
                onPress={() => setStep(2)}
                disabled={!category}
              >
                <Text style={rs.primaryBtnLabel}>Next</Text>
              </Pressable>
            </>
          )}

          {/* Step 2 — Optional details */}
          {step === 2 && (
            <>
              <View style={rs.header}>
                <Pressable onPress={() => setStep(1)} hitSlop={8}>
                  <Text style={rs.backLabel}>← Back</Text>
                </Pressable>
                <Pressable onPress={handleClose} hitSlop={8} testID="place-report-sheet-close-2">
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <Text style={rs.title}>Additional details</Text>
              <Text style={rs.sub}>Optional — helps us fix the listing faster.</Text>
              <TextInput
                testID="place-report-sheet-details"
                style={rs.detailInput}
                placeholder="Describe the issue…"
                placeholderTextColor={color.mute}
                value={details}
                onChangeText={setDetails}
                multiline
                maxLength={500}
                textAlignVertical="top"
              />
              <Text style={rs.charCount}>{charCount}/500</Text>
              <Pressable
                testID="place-report-sheet-submit"
                style={[rs.primaryBtn, submitting && rs.btnDisabled]}
                onPress={handleSubmit}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={rs.primaryBtnLabel}>Submit report</Text>}
              </Pressable>
            </>
          )}

          {/* Step 3 — Confirmation (always shown, even on API error) */}
          {step === 3 && (
            <>
              <View style={rs.header}>
                <Text style={rs.title}>Report received</Text>
                <Pressable onPress={handleClose} hitSlop={8} testID="place-report-sheet-done-close">
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <View style={rs.doneRow}>
                <Text style={rs.doneIcon}>✓</Text>
                <Text style={rs.doneSub}>
                  Thanks — our team will review this and update the listing if needed.
                </Text>
              </View>
              <Pressable style={rs.doneBtn} onPress={handleClose} testID="place-report-sheet-done-btn">
                <Text style={rs.doneBtnLabel}>Done</Text>
              </Pressable>
            </>
          )}
        </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const rs = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: space.lg,
    paddingBottom: 40,
    paddingTop: space.sm,
    maxHeight: '85%',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center', marginBottom: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },
  sub:   { ...t.small, color: color.mute, marginBottom: space.md },

  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: 6,
  },
  optionRowSelected: { borderColor: color.signal, backgroundColor: color.signal + '0A' },
  optionLabel:         { ...t.body, color: color.ink },
  optionLabelSelected: { color: color.signal, fontWeight: '700' },
  check: { fontSize: 14, color: color.signal, fontWeight: '700' },

  detailInput: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    ...t.body,
    color: color.ink,
    minHeight: 96,
    marginBottom: 4,
  },
  charCount: { ...t.small, color: color.faint, textAlign: 'right', marginBottom: space.sm },

  primaryBtn: {
    marginTop: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  btnDisabled:    { opacity: 0.45 },
  primaryBtnLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },

  backLabel: { ...t.body, color: color.signal },

  doneRow:  { alignItems: 'center', paddingVertical: space.md },
  doneIcon: { fontSize: 38, marginBottom: space.sm },
  doneSub:  { ...t.body, color: color.mute, textAlign: 'center' },

  doneBtn: {
    marginTop: space.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  doneBtnLabel: { ...t.body, color: color.mute },
});
