/**
 * GeneratedHeaderPicker — self-contained AI header image picker for events.
 *
 * Renders the current header image (or a shimmer skeleton while generating),
 * a source badge (Upload / AI / Fallback), and a context-sensitive action row.
 *
 * State machine:
 *   not_requested → queued → generating → ready / failed / blocked
 *   replaced       → resets to not_requested
 *
 * A user upload always wins — when currentImageUri is set, the upload is shown
 * and AI generation is suppressed from auto-triggering. The user can still
 * manually regenerate; the upload will continue to take display priority via
 * the parent's cover state.
 *
 * When entityId is null (event not yet created), the "Generate" button is
 * hidden; the component calls onRequestEntityId() to obtain one, then retries
 * the pending generation automatically.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Image, Animated, ActivityIndicator,
} from 'react-native';
import {
  Sparkles, RefreshCw, Check, Trash2, Upload, Palette, AlertCircle,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useVisualGeneration } from '../../hooks/useVisualGeneration.ts';
import type { VisualStyle, VisualEntityType, VisualPurpose, GeneratedVisual, GenerationStatus } from '../../hooks/useVisualGeneration.ts';
import { useVisualStatusChannel } from '../../hooks/useVisualStatusChannel.ts';
import { StylePickerSheet } from './StylePickerSheet.tsx';

// ── Shimmer skeleton ──────────────────────────────────────────────────────────

function GeneratingSkeleton() {
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.9, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.View style={[s.skeleton, { opacity }]}>
      <View style={s.skeletonInner}>
        <Sparkles size={22} color={color.mute} />
        <Text style={s.skeletonText}>Generating AI header…</Text>
      </View>
    </Animated.View>
  );
}

// ── Source badge ──────────────────────────────────────────────────────────────

type BadgeSource = 'upload' | 'ai' | 'fallback';

function SourceBadge({ source }: { source: BadgeSource }) {
  const labels: Record<BadgeSource, string> = {
    upload: '📷 Upload',
    ai:     '✨ AI',
    fallback: '🖼️ Fallback',
  };
  const bgColors: Record<BadgeSource, string> = {
    upload:   'rgba(8,145,178,0.12)',
    ai:       'rgba(109,40,217,0.12)',
    fallback: 'rgba(100,116,139,0.12)',
  };
  const textColors: Record<BadgeSource, string> = {
    upload:   '#0891B2',
    ai:       '#6D28D9',
    fallback: '#64748B',
  };
  return (
    <View style={[s.badge, { backgroundColor: bgColors[source] }]}>
      <Text style={[s.badgeText, { color: textColors[source] }]}>{labels[source]}</Text>
    </View>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  entityType: VisualEntityType;
  /** Pass null in create-form flows before the entity is persisted. */
  entityId: string | null;
  purpose: VisualPurpose;
  /** User-uploaded cover URI. When set, upload takes display priority. */
  currentImageUri?: string | null;
  /** Triggers the parent's media picker for user uploads. */
  onUpload: () => void;
  /**
   * Called when the user clicks "Generate" but entityId is null.
   * Should create a draft entity and return its ID (or null on failure).
   * The picker will then fire the generation automatically.
   */
  onRequestEntityId?: () => Promise<string | null>;
  /**
   * Increment this number to externally trigger a regeneration (e.g. from
   * the "Your details changed — update header?" edit-mode banner).
   */
  regenerateTrigger?: number;
  style?: object;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GeneratedHeaderPicker({
  entityType,
  entityId,
  purpose,
  currentImageUri,
  onUpload,
  onRequestEntityId,
  regenerateTrigger,
  style: containerStyle,
}: Props) {
  const gen = useVisualGeneration(entityType, entityId, purpose);
  const genRef = useRef(gen);
  genRef.current = gen;

  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [currentStyle, setCurrentStyle]       = useState<VisualStyle>('portava_editorial');

  // ── Realtime status channel — auto-resolves queued/generating → ready ──────
  // These local overrides take effect the moment the realtime payload arrives,
  // eliminating the need to wait for the next poll cycle.
  const [rtVisual, setRtVisual]   = useState<GeneratedVisual | null>(null);
  const [rtStatus, setRtStatus]   = useState<GenerationStatus | null>(null);

  useVisualStatusChannel({
    entityType,
    entityId,
    // Picker manages generation directly — no competing higher-priority source.
    currentSource: null,
    onReady: (payload) => {
      setRtStatus('ready');
      setRtVisual({
        id:       payload.id,
        imageUrl: payload.imageUrl,
        style:    payload.style,
        status:   'ready',
      });
    },
  });

  // Clear rt overrides whenever the entity changes (matches gen hook reset).
  useEffect(() => {
    setRtVisual(null);
    setRtStatus(null);
  }, [entityId]);

  // Clear rt overrides whenever the poll-driven status moves away from 'ready'
  // (e.g. the user taps Remove → not_requested, or Regenerate → queued).
  // This ensures Remove and subsequent generation cycles are never masked by
  // a stale realtime snapshot.
  useEffect(() => {
    if (gen.status !== 'ready') {
      setRtVisual(null);
      setRtStatus(null);
    }
  }, [gen.status]);

  /**
   * pendingStyle: set when the user clicked Generate but entityId was null.
   * Once entityId becomes non-null the effect below fires the deferred request.
   */
  const [pendingStyle, setPendingStyle] = useState<VisualStyle | null>(null);

  // Fire deferred generation once entityId arrives.
  useEffect(() => {
    if (entityId && pendingStyle !== null) {
      const style = pendingStyle;
      setPendingStyle(null);
      void genRef.current.requestGeneration(style);
    }
  }, [entityId, pendingStyle]);

  // External regenerate trigger — fired by the "details changed" banner in edit mode.
  // Initialise to the *current* prop value so the effect does NOT fire on mount —
  // it only fires when the parent increments the number post-mount.
  const lastTriggerRef = useRef<number | undefined>(regenerateTrigger);
  useEffect(() => {
    if (regenerateTrigger === undefined) return;
    if (lastTriggerRef.current === regenerateTrigger) return;
    lastTriggerRef.current = regenerateTrigger;
    if (entityId) {
      void genRef.current.regenerate(currentStyle);
    } else {
      // No entity yet — defer via the same pending-style mechanism.
      setPendingStyle(currentStyle);
      if (onRequestEntityId) void onRequestEntityId();
    }
  }, [regenerateTrigger, entityId, currentStyle, onRequestEntityId]);

  // ── Action handlers ─────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async (style?: VisualStyle) => {
    const s = style ?? currentStyle;
    if (entityId) {
      void gen.requestGeneration(s);
      return;
    }
    // No entity yet — defer.
    setPendingStyle(s);
    if (onRequestEntityId) {
      void onRequestEntityId();
    }
  }, [entityId, currentStyle, gen, onRequestEntityId]);

  const handleRegenerate = useCallback(async (style?: VisualStyle) => {
    const s = style ?? currentStyle;
    if (entityId) {
      void gen.regenerate(s);
      return;
    }
    setPendingStyle(s);
    if (onRequestEntityId) {
      void onRequestEntityId();
    }
  }, [entityId, currentStyle, gen, onRequestEntityId]);

  const handleStyleSelect = useCallback((style: VisualStyle) => {
    setCurrentStyle(style);
    void handleRegenerate(style);
  }, [handleRegenerate]);

  // ── Derived state ───────────────────────────────────────────────────────────

  const { error, isLoading, generationEnabled } = gen;
  // rtStatus/rtVisual override the poll-driven values the moment a realtime
  // event arrives — eliminating the need to wait for the next poll cycle.
  const status         = rtStatus ?? gen.status;
  const generatedVisual = rtVisual ?? gen.generatedVisual;
  const hasUpload  = !!(currentImageUri);
  const isInFlight = status === 'queued' || status === 'generating' || isLoading || pendingStyle !== null;
  const isReady    = status === 'ready';
  const isFailed   = status === 'failed';
  const isBlocked  = status === 'blocked';
  // "Generate" label becomes "Regenerate" once the user has uploaded (or a
  // prior generation exists) so the button accurately reflects state.
  const hasHadPriorGeneration = generatedVisual !== null || hasUpload;

  // What image to display in the picker preview area:
  //   upload > ai_generated > nothing
  const displayUri = currentImageUri ?? (isReady ? generatedVisual?.imageUrl : null) ?? null;
  const badgeSource: BadgeSource | null =
    currentImageUri  ? 'upload' :
    isReady          ? 'ai'     :
    null;

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!generationEnabled) {
    // Feature is disabled — just show the upload button as the only action.
    return (
      <View style={[s.root, containerStyle]}>
        <Pressable
          style={({ pressed }) => [s.uploadOnlyBtn, pressed && { opacity: 0.7 }]}
          onPress={onUpload}
          accessibilityRole="button"
          accessibilityLabel="Upload cover image"
        >
          <Upload size={14} color={color.mute} />
          <Text style={s.uploadOnlyText}>Upload cover image</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[s.root, containerStyle]}>

      {/* ── Preview area ── */}
      {isInFlight && !displayUri ? (
        <GeneratingSkeleton />
      ) : displayUri ? (
        <View style={s.previewWrap}>
          <Image source={{ uri: displayUri }} style={s.preview} resizeMode="cover" />
          {badgeSource && (
            <View style={s.badgeOverlay}>
              <SourceBadge source={badgeSource} />
            </View>
          )}
          {isInFlight && (
            <View style={s.regeneratingOverlay}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={s.regeneratingText}>Updating…</Text>
            </View>
          )}
        </View>
      ) : (
        <View style={s.emptyPreview}>
          <Sparkles size={24} color={color.mute} />
          <Text style={s.emptyText}>AI header image</Text>
          <Text style={s.emptySubtext}>Generate a header image for your event</Text>
        </View>
      )}

      {/* ── Error / blocked messages ── */}
      {isFailed && error && (
        <View style={s.errorRow}>
          <AlertCircle size={13} color="#DC2626" />
          <Text style={s.errorText} numberOfLines={2}>{error}</Text>
        </View>
      )}
      {isBlocked && (
        <View style={s.errorRow}>
          <AlertCircle size={13} color="#D97706" />
          <Text style={[s.errorText, { color: '#D97706' }]}>
            Image generation was blocked by content policy.
          </Text>
        </View>
      )}

      {/* ── Action row ── */}
      <View style={s.actionRow}>
        {/* Upload — always present */}
        <Pressable
          style={({ pressed }) => [s.actionBtn, pressed && { opacity: 0.7 }]}
          onPress={onUpload}
          disabled={isInFlight}
          accessibilityRole="button"
          accessibilityLabel="Upload image"
        >
          <Upload size={13} color={color.deep} />
          <Text style={s.actionBtnText}>Upload</Text>
        </Pressable>

        {/* Generate / Regenerate.
            Hidden only when the user has an active upload AND has never generated
            before (there's no AI image to compete with). Once any generation has
            occurred the button stays visible as "Regenerate" even with an upload.
            Renders exactly once — no duplicate branch. */}
        {(!hasUpload || hasHadPriorGeneration) &&
          (isReady || isFailed || isBlocked || status === 'not_requested') && (
          <Pressable
            style={({ pressed }) => [
              s.actionBtn, s.actionBtnPrimary,
              pressed && { opacity: 0.7 },
            ]}
            onPress={() => {
              // First-time: Generate. Subsequent (or after upload): Regenerate.
              if (hasHadPriorGeneration) {
                void handleRegenerate();
              } else {
                void handleGenerate();
              }
            }}
            disabled={isInFlight}
            accessibilityRole="button"
            accessibilityLabel={hasHadPriorGeneration ? 'Regenerate AI header' : 'Generate AI header'}
          >
            <Sparkles size={13} color={color.onInk} />
            <Text style={[s.actionBtnText, s.actionBtnTextPrimary]}>
              {hasHadPriorGeneration ? 'Regenerate' : 'Generate'}
            </Text>
          </Pressable>
        )}

        {/* Change style — only when ready */}
        {isReady && (
          <Pressable
            style={({ pressed }) => [s.actionBtn, pressed && { opacity: 0.7 }]}
            onPress={() => setStylePickerOpen(true)}
            disabled={isInFlight}
            accessibilityRole="button"
            accessibilityLabel="Change visual style"
          >
            <Palette size={13} color={color.deep} />
            <Text style={s.actionBtnText}>Style</Text>
          </Pressable>
        )}

        {/* Accept — only when ready */}
        {isReady && (
          <Pressable
            style={({ pressed }) => [s.actionBtn, s.actionBtnAccept, pressed && { opacity: 0.7 }]}
            onPress={() => void gen.accept()}
            disabled={isInFlight}
            accessibilityRole="button"
            accessibilityLabel="Accept AI header"
          >
            <Check size={13} color="#047857" />
            <Text style={[s.actionBtnText, { color: '#047857' }]}>Accept</Text>
          </Pressable>
        )}

        {/* Remove — only when ready */}
        {isReady && (
          <Pressable
            style={({ pressed }) => [s.actionBtn, pressed && { opacity: 0.7 }]}
            onPress={() => void gen.remove()}
            disabled={isInFlight}
            accessibilityRole="button"
            accessibilityLabel="Remove AI header"
          >
            <Trash2 size={13} color={color.mute} />
            <Text style={[s.actionBtnText, { color: color.mute }]}>Remove</Text>
          </Pressable>
        )}
      </View>

      {/* ── Style picker sheet ── */}
      <StylePickerSheet
        visible={stylePickerOpen}
        currentStyle={currentStyle}
        onSelect={handleStyleSelect}
        onClose={() => setStylePickerOpen(false)}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PREVIEW_HEIGHT = 140;

const s = StyleSheet.create({
  root: {
    gap: space.sm,
  },

  // ── Skeleton ────────────────────────────────────────────────────────────────
  skeleton: {
    height: PREVIEW_HEIGHT,
    borderRadius: radius.md,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  skeletonInner: {
    alignItems: 'center',
    gap: space.sm,
  },
  skeletonText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },

  // ── Preview ─────────────────────────────────────────────────────────────────
  previewWrap: {
    height: PREVIEW_HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: color.haze,
  },
  preview: {
    width: '100%',
    height: PREVIEW_HEIGHT,
  },
  badgeOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
  },
  regeneratingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  regeneratingText: {
    color: '#fff',
    ...t.small,
    fontWeight: '600',
  },

  // ── Empty state ─────────────────────────────────────────────────────────────
  emptyPreview: {
    height: 90,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: color.paper,
  },
  emptyText: {
    ...t.small,
    color: color.mute,
    fontWeight: '600',
  },
  emptySubtext: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
  },

  // ── Error ───────────────────────────────────────────────────────────────────
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 5,
    paddingHorizontal: space.xs,
  },
  errorText: {
    ...t.small,
    color: '#DC2626',
    flex: 1,
    fontSize: 12,
  },

  // ── Action row ──────────────────────────────────────────────────────────────
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    flexWrap: 'wrap',
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  actionBtnPrimary: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  actionBtnAccept: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  actionBtnText: {
    ...t.small,
    color: color.deep,
    fontWeight: '600',
    fontSize: 12,
  },
  actionBtnTextPrimary: {
    color: color.onInk,
  },

  // ── Badge ────────────────────────────────────────────────────────────────────
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
  },

  // ── Upload-only fallback (flags disabled) ─────────────────────────────────
  uploadOnlyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  uploadOnlyText: {
    ...t.body,
    color: color.mute,
  },
});
