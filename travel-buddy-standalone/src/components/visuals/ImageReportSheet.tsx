/**
 * ImageReportSheet — "Report image" flow for real-place images.
 *
 * Presents a single reason: "This image does not match the place."
 * On confirm, calls POST /api/places/:id/image-report.
 * Shows a brief confirmation and disables the action for the session.
 *
 * The action is disabled for the same (placeId + imageUrl) combination once
 * a report has been submitted successfully, so the user cannot double-report.
 */
import React, { useState, useRef } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, ActivityIndicator,
} from 'react-native';
import { X, TriangleAlert, CircleCheckBig } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { IMAGE_LABEL_STRINGS } from '../../lib/imageLabelUtils.ts';
import { freshToken } from '../../services/apiToken.ts';

// ── Session-level dedup store ─────────────────────────────────────────────────

/** Tracks (placeId|imageUrl) combos that have already been reported this session. */
const _reported = new Set<string>();

function reportKey(placeId: string, imageUrl: string): string {
  return `${placeId}|${imageUrl}`;
}

// ── API call ──────────────────────────────────────────────────────────────────

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function submitImageReport(
  placeId: string,
  imageUrl: string,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'not_configured' };

  let token: string | null = null;
  try { token = await freshToken(); } catch { /* no-op */ }

  try {
    const res = await fetch(`${base}/api/places/${encodeURIComponent(placeId)}/image-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ imageUrl, reason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.error ?? `http_${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ImageReportSheetProps {
  visible: boolean;
  onClose: () => void;
  placeId: string;
  imageUrl: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImageReportSheet({
  visible,
  onClose,
  placeId,
  imageUrl,
}: ImageReportSheetProps) {
  const [step, setStep]           = useState<'choose' | 'done'>('choose');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  const key        = reportKey(placeId, imageUrl);
  const alreadyDone = _reported.has(key);

  function handleClose() {
    onClose();
    // Reset local state (but keep the session-level dedup intact)
    setTimeout(() => {
      setStep('choose');
      setError(null);
      setSubmitting(false);
    }, 300);
  }

  async function handleSubmit() {
    if (submitting || alreadyDone) return;
    setSubmitting(true);
    setError(null);

    const result = await submitImageReport(placeId, imageUrl, 'wrong_place');
    setSubmitting(false);

    if (result.ok) {
      _reported.add(key);
      setStep('done');
    } else {
      // Surface the error but keep the sheet open so the user can retry.
      setError('Could not submit — please try again.');
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={rs.backdrop} onPress={handleClose} />
      <View style={rs.sheet} testID="image-report-sheet">
        <View style={rs.handle} />

        {step === 'choose' ? (
          <>
            {/* Header */}
            <View style={rs.header}>
              <Text style={rs.title}>{IMAGE_LABEL_STRINGS.report_action_label}</Text>
              <Pressable onPress={handleClose} hitSlop={8} testID="image-report-close">
                <X size={20} color={color.ink} />
              </Pressable>
            </View>

            {/* Single reason option */}
            <Pressable
              style={rs.option}
              onPress={handleSubmit}
              disabled={submitting || alreadyDone}
              testID="image-report-reason-btn"
            >
              <TriangleAlert size={16} color={color.mute} style={rs.optionIcon} />
              <Text style={rs.optionText}>{IMAGE_LABEL_STRINGS.report_reason_label}</Text>
              {submitting ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : null}
            </Pressable>

            {error ? (
              <Text style={rs.errorText}>{error}</Text>
            ) : null}

            <Pressable style={rs.cancelBtn} onPress={handleClose} testID="image-report-cancel">
              <Text style={rs.cancelText}>{IMAGE_LABEL_STRINGS.report_cancel}</Text>
            </Pressable>
          </>
        ) : (
          /* Confirmation step */
          <>
            <View style={rs.doneWrap} testID="image-report-confirmation">
              <CircleCheckBig size={40} color={color.signal} />
              <Text style={rs.doneTitle}>{IMAGE_LABEL_STRINGS.report_confirm_title}</Text>
              <Text style={rs.doneBody}>{IMAGE_LABEL_STRINGS.report_confirm_body}</Text>
            </View>
            <Pressable style={rs.doneBtn} onPress={handleClose} testID="image-report-done">
              <Text style={rs.doneBtnText}>Done</Text>
            </Pressable>
          </>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const rs = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.lg,
    paddingBottom: 40,
    gap: space.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 12,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 14,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  optionIcon: {
    flexShrink: 0,
  },
  optionText: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  errorText: {
    ...t.small,
    color: '#DC2626',
    textAlign: 'center',
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  cancelText: {
    ...t.body,
    color: color.mute,
  },

  // ── Done state ──────────────────────────────────────────────────────────────
  doneWrap: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
  },
  doneTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 16,
    textAlign: 'center',
  },
  doneBody: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 20,
  },
  doneBtn: {
    backgroundColor: color.deep,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  doneBtnText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
});
