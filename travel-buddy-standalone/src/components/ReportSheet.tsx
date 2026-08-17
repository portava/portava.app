/**
 * ReportSheet — unified 3-step report+block bottom sheet.
 *
 * Step 1: Category picker (8 options)
 * Step 2: Optional detail text input (500 char)
 * Step 3: Confirmation + optional "Also block" CTA
 *
 * For safety_concern: step 3 shows emergency-resource pointer.
 * "Block" is only available when subjectUserId is provided.
 * If the subject is already blocked (BlockedIdsContext), shows "Unblock".
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, TextInput,
  ActivityIndicator, ScrollView, Alert, Linking,
} from 'react-native';
import { X, ShieldAlert } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import {
  submitModerationReport,
  MODERATION_CATEGORY_LABELS,
  type ModerationSubjectType,
  type ModerationCategory,
} from '../services/moderation.ts';
import { blockUser, unblockUser } from '../services/blocks.ts';
import { useBlockedIds } from '../context/BlockedIdsContext.tsx';
import { useMediaComposer } from '../hooks/useMediaComposer.ts';
import { MediaPickerButton } from './ui/MediaPickerButton.tsx';
import { MediaAttachmentTray } from './ui/MediaAttachmentTray.tsx';
import { errorCopy } from '../lib/errorCopy.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: ModerationCategory[] = [
  'impersonation',
  'harassment',
  'scam_fraud',
  'inappropriate_content',
  'safety_concern',
  'underage',
  'spam',
  'other',
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ReportSheetProps {
  visible:        boolean;
  onClose:        () => void;
  subjectType:    ModerationSubjectType;
  subjectId:      string;
  subjectUserId?: string | null;
  subjectName?:   string | null;
  /** Only for message reports */
  threadId?:      string | null;
  onReported?:    () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReportSheet({
  visible,
  onClose,
  subjectType,
  subjectId,
  subjectUserId,
  subjectName,
  threadId,
  onReported,
}: ReportSheetProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [category, setCategory] = useState<ModerationCategory | null>(null);
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);

  const { blockedIds, addBlock, removeBlock } = useBlockedIds();
  const isBlocked = subjectUserId ? blockedIds.has(subjectUserId) : false;

  // Optional photo evidence — only surfaced when the user picks 'safety_concern'.
  const safetyPhotoComposer = useMediaComposer('safetyReport');

  function reset() {
    setStep(1);
    setCategory(null);
    setDetails('');
    setSubmitting(false);
    setBlockBusy(false);
    safetyPhotoComposer.clearAll();
  }

  function handleClose() {
    onClose();
    reset();
  }

  async function handleSubmit() {
    if (!category || submitting) return;
    setSubmitting(true);

    // For safety concerns, ensure the attached photo URL is included even on retry
    // (uploadAll only uploads idle items; already-uploaded items carry uploadedUrl).
    let imageUrl: string | undefined;
    if (category === 'safety_concern' && safetyPhotoComposer.items.length > 0) {
      // Check for an already-uploaded item first (retry path).
      const doneItem = safetyPhotoComposer.items.find(
        (i) => i.uploadState === 'done' && i.uploadedUrl,
      );
      if (doneItem?.uploadedUrl) {
        imageUrl = doneItem.uploadedUrl;
      } else {
        // Upload idle item (first attempt).
        const uploadResults = await safetyPhotoComposer.uploadAll();
        for (const res of uploadResults.values()) {
          if (res?.ok && res.url) { imageUrl = res.url; break; }
        }
      }
    }

    const res = await submitModerationReport({
      subjectType,
      subjectId,
      category,
      details: details.trim() || undefined,
      threadId: threadId ?? undefined,
      imageUrl,
    });
    setSubmitting(false);
    if (res.ok) {
      setStep(3);
      onReported?.();
    } else {
      Alert.alert('Error', errorCopy(res.error, 'Could not submit report'));
    }
  }

  async function handleBlock() {
    if (!subjectUserId || blockBusy) return;
    setBlockBusy(true);
    if (isBlocked) {
      const res = await unblockUser(subjectUserId);
      setBlockBusy(false);
      if (res.ok) {
        removeBlock(subjectUserId);
      } else {
        Alert.alert('Error', errorCopy(res.error, 'Could not unblock user'));
      }
    } else {
      const res = await blockUser(subjectUserId);
      setBlockBusy(false);
      if (res.ok) {
        addBlock(subjectUserId);
      } else {
        Alert.alert('Error', errorCopy(res.error, 'Could not block user'));
      }
    }
  }

  const charCount = details.length;
  const displayName = subjectName ?? 'this person';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardSafeScrollView style={rs.overlay}>
        <Pressable testID="report-sheet-backdrop" style={StyleSheet.absoluteFill} onPress={handleClose} />
        <View style={rs.sheet}>
          <View style={rs.handle} />

          {/* Step 1 — Category picker */}
          {step === 1 && (
            <>
              <View style={rs.header}>
                <Text style={rs.title}>Report</Text>
                <Pressable onPress={handleClose} hitSlop={8} testID="report-sheet-close">
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <Text style={rs.sub}>What's the issue?</Text>
              <ScrollView showsVerticalScrollIndicator={false}>
                {CATEGORIES.map((cat) => (
                  <Pressable
                    key={cat}
                    testID={`report-cat-${cat}`}
                    style={[rs.optionRow, category === cat && rs.optionRowSelected]}
                    onPress={() => setCategory(cat)}
                  >
                    <Text style={[rs.optionLabel, category === cat && rs.optionLabelSelected]}>
                      {MODERATION_CATEGORY_LABELS[cat]}
                    </Text>
                    {category === cat && <Text style={rs.check}>✓</Text>}
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable
                testID="report-sheet-next"
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
                <Pressable onPress={() => setStep(1)} hitSlop={8} style={rs.backBtn}>
                  <Text style={rs.backLabel}>← Back</Text>
                </Pressable>
                <Pressable onPress={handleClose} hitSlop={8} testID="report-sheet-close-2">
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <Text style={rs.title}>Additional details</Text>
              <Text style={rs.sub}>Optional — helps our team understand the issue.</Text>
              <TextInput
                testID="report-sheet-details"
                style={rs.detailInput}
                placeholder="Describe what happened…"
                placeholderTextColor={color.mute}
                value={details}
                onChangeText={setDetails}
                multiline
                maxLength={500}
                textAlignVertical="top"
              />
              <Text style={rs.charCount}>{charCount}/500</Text>

              {/* Optional photo evidence — shown only for safety concerns */}
              {category === 'safety_concern' && (
                <View style={rs.photoRow}>
                  <Text style={rs.photoLabel}>Photo evidence (optional)</Text>
                  <MediaPickerButton
                    composer={safetyPhotoComposer}
                    label={safetyPhotoComposer.items.length > 0 ? 'Replace photo' : 'Add photo'}
                  />
                  <MediaAttachmentTray composer={safetyPhotoComposer} testID="safety-photo-tray" />
                </View>
              )}

              <Pressable
                testID="report-sheet-submit"
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

          {/* Step 3 — Confirmation */}
          {step === 3 && (
            <>
              <View style={rs.header}>
                <Text style={rs.title}>Report submitted</Text>
                <Pressable onPress={handleClose} hitSlop={8} testID="report-sheet-done-close">
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <View style={rs.doneRow}>
                <Text style={rs.doneIcon}>✓</Text>
                <Text style={rs.doneSub}>
                  Thanks — our team will review this.
                </Text>
              </View>

              {/* Safety concern: show emergency resource pointer */}
              {category === 'safety_concern' && (
                <View style={rs.safetyBanner}>
                  <ShieldAlert size={16} color="#B45309" />
                  <View style={{ flex: 1 }}>
                    <Text style={rs.safetyTitle}>If you or someone is in immediate danger</Text>
                    <Text style={rs.safetySub}>
                      Contact local emergency services (911 / 999 / 112) or reach out via Safe Return in your settings.
                    </Text>
                    <Pressable onPress={() => Linking.openURL('https://www.travel.state.gov/content/travel/en/international-travel/emergencies.html')}>
                      <Text style={rs.safetyLink}>Emergency resources →</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {/* Block / Unblock CTA — only when subject is a user */}
              {subjectUserId && (
                <Pressable
                  testID="report-sheet-block-cta"
                  style={[rs.blockBtn, blockBusy && rs.btnDisabled]}
                  onPress={handleBlock}
                  disabled={blockBusy}
                >
                  {blockBusy
                    ? <ActivityIndicator size="small" color={color.signal} />
                    : <Text style={rs.blockBtnLabel}>
                        {isBlocked ? `Unblock ${displayName}` : `Also block ${displayName}`}
                      </Text>}
                </Pressable>
              )}

              <Pressable style={rs.doneBtn} onPress={handleClose}>
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

  backBtn:  {},
  backLabel: { ...t.body, color: color.signal },

  doneRow:  { alignItems: 'center', paddingVertical: space.md },
  doneIcon: { fontSize: 38, marginBottom: space.sm },
  doneSub:  { ...t.body, color: color.mute, textAlign: 'center' },

  photoRow: {
    marginTop: space.sm,
    marginBottom: space.xs,
    gap: 4,
  },
  photoLabel: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 2 },
  photoPickerBtn: {},

  safetyBanner: {
    flexDirection: 'row',
    gap: space.sm,
    backgroundColor: '#FEF3C7',
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.md,
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  safetyTitle: { ...t.small, fontWeight: '700', color: '#92400E', marginBottom: 2 },
  safetySub:   { ...t.small, color: '#92400E', lineHeight: 16 },
  safetyLink:  { ...t.small, color: '#92400E', fontWeight: '700', textDecorationLine: 'underline', marginTop: 4 },

  blockBtn: {
    marginTop: space.lg,
    borderWidth: 1,
    borderColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  blockBtnLabel: { ...t.bodyStrong, color: color.signal, fontWeight: '700' },

  doneBtn: {
    marginTop: space.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  doneBtnLabel: { ...t.body, color: color.mute },
});
