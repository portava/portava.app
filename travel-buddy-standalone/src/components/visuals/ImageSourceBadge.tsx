/**
 * ImageSourceBadge — compact image-source label overlay for place image cards.
 *
 * Renders a small pill showing the source category. When `disclaimerRequired`
 * is true the pill uses a warning-style treatment with an info icon. Tapping
 * opens `ImageInfoSheet` which shows the full disclosure text and (for place
 * images) a "Report image" entry that leads to `ImageReportSheet`.
 *
 * Usage on compact cards:
 *   <ImageSourceBadge
 *     sourceLabel={placeImage.sourceLabel}
 *     disclaimerRequired={placeImage.disclaimerRequired}
 *     disclaimerText={placeImage.disclaimerText}
 *     placeId={place.id}
 *     imageUrl={placeImage.url}
 *     style={styles.badgePosition}
 *   />
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { Info, CheckCircle, Camera, User, Sparkles, TriangleAlert, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { IMAGE_LABEL_STRINGS, shortLabelText, type PlaceImageSourceLabel } from '../../lib/imageLabelUtils.ts';
import { ImageReportSheet } from './ImageReportSheet.tsx';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ImageSourceBadgeProps {
  sourceLabel: PlaceImageSourceLabel;
  disclaimerRequired: boolean;
  disclaimerText: string | null;
  /** Place ID — required to enable the "Report image" action. Omit for non-place images. */
  placeId?: string | null;
  /** The image URL being shown — passed to the report flow. */
  imageUrl?: string | null;
  /** Extra style for positioning the badge (e.g. absolute placement). */
  style?: object;
  testID?: string;
}

// ── Icon per label category ───────────────────────────────────────────────────

function LabelIcon({ label, size, col }: { label: PlaceImageSourceLabel; size: number; col: string }) {
  switch (label) {
    case 'official_photo':
    case 'venue_provided':
      return <CheckCircle size={size} color={col} />;
    case 'traveler_photo':
      return <Camera size={size} color={col} />;
    case 'reference_ai':
      return <Sparkles size={size} color={col} />;
    case 'illustrative':
      return <TriangleAlert size={size} color={col} />;
    default:
      return <Info size={size} color={col} />;
  }
}

// ── Pill colour scheme ────────────────────────────────────────────────────────

interface Scheme { pill: string; border: string; text: string }

function pillScheme(label: PlaceImageSourceLabel, disclaimerRequired: boolean): Scheme {
  if (label === 'illustrative' || (disclaimerRequired && label !== null)) {
    // Warning treatment for illustrative / generic fallback images
    return {
      pill:   'rgba(180, 83, 9, 0.14)',
      border: 'rgba(180, 83, 9, 0.35)',
      text:   '#92400E',
    };
  }
  // Neutral informational treatment for trusted sources
  return {
    pill:   'rgba(10, 61, 74, 0.10)',
    border: 'rgba(10, 61, 74, 0.25)',
    text:   '#0A3D4A',
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ImageSourceBadge({
  sourceLabel,
  disclaimerRequired,
  disclaimerText,
  placeId,
  imageUrl,
  style,
  testID,
}: ImageSourceBadgeProps) {
  const [infoOpen, setInfoOpen]     = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const labelText = shortLabelText(sourceLabel);

  // Render nothing when there's no label and no disclaimer to surface.
  if (!labelText && !disclaimerRequired) return null;

  const scheme = pillScheme(sourceLabel, disclaimerRequired);
  const displayText = labelText ?? IMAGE_LABEL_STRINGS.illustrative_short;

  return (
    <>
      <Pressable
        onPress={() => setInfoOpen(true)}
        style={[
          bs.pill,
          {
            backgroundColor: scheme.pill,
            borderColor: scheme.border,
          },
          style,
        ]}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Image source: ${displayText}. Tap for details.`}
        testID={testID ?? 'image-source-badge'}
      >
        <LabelIcon label={sourceLabel} size={10} col={scheme.text} />
        <Text style={[bs.pillText, { color: scheme.text }]} numberOfLines={1}>
          {displayText}
        </Text>
        {disclaimerRequired && (
          <Info size={9} color={scheme.text} />
        )}
      </Pressable>

      {/* Info sheet */}
      <Modal
        visible={infoOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setInfoOpen(false)}
      >
        <Pressable style={bs.backdrop} onPress={() => setInfoOpen(false)} />
        <View style={bs.sheet} testID="image-info-sheet">
          {/* Header */}
          <View style={bs.sheetHead}>
            <LabelIcon label={sourceLabel} size={18} col={color.ink} />
            <Text style={bs.sheetTitle}>{IMAGE_LABEL_STRINGS.info_sheet_title}</Text>
            <Pressable onPress={() => setInfoOpen(false)} hitSlop={8} testID="image-info-close">
              <X size={18} color={color.mute} />
            </Pressable>
          </View>

          {/* Source label */}
          <Text style={bs.sheetLabel}>{displayText}</Text>

          {/* Full disclaimer text (when present) */}
          {disclaimerText ? (
            <Text style={bs.sheetBody}>{disclaimerText}</Text>
          ) : null}

          {/* Report action — only when a place ID is provided */}
          {placeId && imageUrl ? (
            <Pressable
              style={bs.reportBtn}
              onPress={() => {
                setInfoOpen(false);
                // Small delay so the info sheet closes first
                setTimeout(() => setReportOpen(true), 150);
              }}
              testID="image-info-report-btn"
            >
              <TriangleAlert size={14} color={color.mute} />
              <Text style={bs.reportBtnText}>{IMAGE_LABEL_STRINGS.report_action_label}</Text>
            </Pressable>
          ) : null}
        </View>
      </Modal>

      {/* Report sheet */}
      {placeId && imageUrl ? (
        <ImageReportSheet
          visible={reportOpen}
          onClose={() => setReportOpen(false)}
          placeId={placeId}
          imageUrl={imageUrl}
        />
      ) : null}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const bs = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
    flexShrink: 1,
  },

  // ── Info sheet ──────────────────────────────────────────────────────────────
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 60,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  sheetTitle: {
    ...t.bodyStrong,
    color: color.ink,
    flex: 1,
  },
  sheetLabel: {
    ...t.body,
    color: color.ink,
    fontWeight: '600',
  },
  sheetBody: {
    ...t.body,
    color: color.mute,
    lineHeight: 20,
  },
  reportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.haze,
  },
  reportBtnText: {
    ...t.small,
    color: color.mute,
  },
});
