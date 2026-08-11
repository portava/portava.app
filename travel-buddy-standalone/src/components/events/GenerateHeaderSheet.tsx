/**
 * GenerateHeaderSheet — slide-up sheet for AI-generated event/place header images.
 *
 * Flow for events (no config phase):
 *   1. Mount: trigger POST /api/visuals/generate immediately.
 *   2. Poll GET /api/visuals/:id every 3 s until status is terminal
 *      (ready | failed | blocked).
 *   3. Show the preview image.
 *   4. Host taps "Use this image" → POST /api/visuals/:id/accept → onAccepted(url).
 *   5. Host taps "Regenerate" → POST /api/visuals/:id/regenerate → poll again.
 *
 * Flow for places (with config phase):
 *   1. Mount: show optional style controls (style, time of day, render mode).
 *   2. Admin taps "Generate now" (with or without choosing preferences).
 *   3. Continue as above from step 1 of the events flow.
 *
 * Mirrors the generate + review flow used for stamp artwork.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
import { RefreshCw, Sparkles, X, Check } from 'lucide-react-native';
import {
  generateVisual,
  getVisual,
  acceptVisual,
  regenerateVisual,
  type VisualStatus,
} from '../../services/visuals.ts';
import { color, radius, space, type as t } from '../../theme/tokens.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES: VisualStatus[] = ['ready', 'failed', 'blocked', 'replaced'];

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  /** Entity kind — determines the purpose sent to the API. */
  entityType: 'event' | 'place';
  /** ID of the event or place to generate a header for. */
  entityId: string;
  onDismiss: () => void;
  /** Called with the accepted hero image URL so the parent can update its state. */
  onAccepted: (imageUrl: string) => void;
}

type Phase =
  | 'config'       // Place-only: preference controls shown before generation starts
  | 'generating'   // Requesting + waiting for the worker
  | 'ready'        // Image available for review
  | 'accepting'    // POST /accept in-flight
  | 'error';       // Unrecoverable failure

type TimeOfDay = 'morning' | 'afternoon' | 'sunset' | 'evening' | 'night';
type RenderMode = 'realistic' | 'illustrated';

interface PlacePreferences {
  style?: string;
  timeOfDay?: TimeOfDay;
  renderMode?: RenderMode;
}

// ── Style presets ─────────────────────────────────────────────────────────────

const STYLE_PRESETS: { label: string; value: string }[] = [
  { label: 'Cinematic', value: 'cinematic' },
  { label: 'Watercolour', value: 'watercolor' },
  { label: 'Minimalist', value: 'minimalist' },
  { label: 'Vibrant', value: 'vibrant' },
];

const TIME_OPTIONS: { label: string; value: TimeOfDay }[] = [
  { label: 'Morning', value: 'morning' },
  { label: 'Afternoon', value: 'afternoon' },
  { label: 'Sunset', value: 'sunset' },
  { label: 'Evening', value: 'evening' },
  { label: 'Night', value: 'night' },
];

const RENDER_OPTIONS: { label: string; value: RenderMode }[] = [
  { label: 'Realistic', value: 'realistic' },
  { label: 'Illustrated', value: 'illustrated' },
];

// ── Sub-components ────────────────────────────────────────────────────────────

interface ChipGroupProps<T extends string> {
  label: string;
  options: { label: string; value: T }[];
  selected: T | undefined;
  onSelect: (v: T | undefined) => void;
}

function ChipGroup<T extends string>({ label, options, selected, onSelect }: ChipGroupProps<T>) {
  return (
    <View style={cs.group}>
      <Text style={cs.groupLabel}>{label}</Text>
      <View style={cs.chips}>
        {options.map(opt => {
          const active = selected === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[cs.chip, active && cs.chipActive]}
              onPress={() => onSelect(active ? undefined : opt.value)}
            >
              <Text style={[cs.chipText, active && cs.chipTextActive]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function GenerateHeaderSheet({ visible, entityType, entityId, onDismiss, onAccepted }: Props) {
  const [phase, setPhase]       = useState<Phase>('generating');
  const [visualId, setVisualId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  // Place-specific preference state
  const [prefStyle, setPrefStyle]       = useState<string | undefined>(undefined);
  const [prefTime, setPrefTime]         = useState<TimeOfDay | undefined>(undefined);
  const [prefRender, setPrefRender]     = useState<RenderMode | undefined>(undefined);

  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountRef = useRef(false);

  // ── Polling ──────────────────────────────────────────────────────────────────

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPoll = useCallback(
    (id: string) => {
      stopPoll();
      pollRef.current = setInterval(async () => {
        const res = await getVisual(id);
        if (!mountRef.current) return;
        if (!res.ok || !res.data) return; // transient network error — keep polling
        const v = res.data.visual;
        if (!TERMINAL_STATUSES.includes(v.status)) return; // still in-flight

        stopPoll();

        if (v.status === 'ready' && v.source_image_url) {
          setImageUrl(v.source_image_url);
          setPhase('ready');
        } else if (v.status === 'failed') {
          setErrorMsg('Image generation failed. Tap Regenerate to try again.');
          setPhase('error');
        } else if (v.status === 'blocked') {
          setErrorMsg('The AI provider blocked this image (content policy). Try regenerating with different settings.');
          setPhase('error');
        } else {
          setErrorMsg('Generation was replaced by a newer request.');
          setPhase('error');
        }
      }, POLL_INTERVAL_MS);
    },
    [stopPoll],
  );

  // ── Trigger generation ────────────────────────────────────────────────────────

  const triggerGenerate = useCallback(async (prefs?: PlacePreferences) => {
    setPhase('generating');
    setImageUrl(null);
    setErrorMsg(null);
    setVisualId(null);

    const purpose = entityType === 'place' ? 'place_header' : 'event_header';
    const preferences: Record<string, string> = {};
    if (prefs?.timeOfDay) preferences.timeOfDay = prefs.timeOfDay;
    if (prefs?.renderMode) preferences.renderMode = prefs.renderMode;

    const res = await generateVisual({
      entityType,
      entityId,
      purpose,
      ...(prefs?.style ? { style: prefs.style } : {}),
      ...(Object.keys(preferences).length > 0 ? { preferences } : {}),
    });

    if (!mountRef.current) return;

    if (!res.ok || !res.data) {
      setErrorMsg(res.message ?? 'Failed to start image generation.');
      setPhase('error');
      return;
    }

    const vid = res.data.id;
    setVisualId(vid);

    // If the server returned a ready image immediately (cache hit), show it.
    if (res.data.status === 'ready' && res.data.imageUrl) {
      setImageUrl(res.data.imageUrl);
      setPhase('ready');
      return;
    }

    startPoll(vid);
  }, [entityType, entityId, startPoll]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    mountRef.current = true;

    if (entityType === 'place') {
      // Show preference controls before generating
      setPhase('config');
      setVisualId(null);
      setImageUrl(null);
      setErrorMsg(null);
      setPrefStyle(undefined);
      setPrefTime(undefined);
      setPrefRender(undefined);
    } else {
      triggerGenerate();
    }

    return () => {
      mountRef.current = false;
      stopPoll();
    };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps -- only trigger when sheet opens

  // ── Handlers ─────────────────────────────────────────────────────────────────

  function handleGenerateNow() {
    triggerGenerate({ style: prefStyle, timeOfDay: prefTime, renderMode: prefRender });
  }

  async function handleAccept() {
    if (!visualId || !imageUrl) return;
    setPhase('accepting');
    const res = await acceptVisual(visualId);
    if (!mountRef.current) return;
    if (res.ok) {
      onAccepted(imageUrl);
      onDismiss();
    } else {
      setPhase('ready'); // revert so they can retry
      Alert.alert('Could not apply', res.message ?? 'Something went wrong. Please try again.');
    }
  }

  async function handleRegenerate() {
    if (regenerating) return;
    setRegenerating(true);

    if (visualId) {
      const res = await regenerateVisual(visualId);
      setRegenerating(false);
      if (!mountRef.current) return;
      if (res.ok && res.data) {
        setVisualId(res.data.id);
        setPhase('generating');
        setImageUrl(null);
        setErrorMsg(null);
        startPoll(res.data.id);
        return;
      }
    }

    // Fallback: trigger a fresh generation with same preferences
    setRegenerating(false);
    if (mountRef.current) {
      triggerGenerate({ style: prefStyle, timeOfDay: prefTime, renderMode: prefRender });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={s.backdrop}>
        <View style={s.sheet}>
          {/* Handle */}
          <View style={s.handle} />

          {/* Header row */}
          <View style={s.head}>
            <View style={s.headLeft}>
              <Sparkles size={18} color={color.signal} />
              <Text style={s.headTitle}>Generate header image</Text>
            </View>
            <Pressable onPress={onDismiss} hitSlop={12} style={s.closeBtn}>
              <X size={20} color={color.mute} />
            </Pressable>
          </View>

          {/* Body */}
          <View style={s.body}>

            {/* Config state — place admins choose style before generating */}
            {phase === 'config' && (
              <ScrollView showsVerticalScrollIndicator={false} style={s.configScroll} contentContainerStyle={s.configContent}>
                <Text style={s.configIntro}>
                  Optionally fine-tune the style before generating. All controls are optional — tap{' '}
                  <Text style={s.configIntroEm}>Generate now</Text> to use defaults.
                </Text>

                <ChipGroup
                  label="Visual style"
                  options={STYLE_PRESETS}
                  selected={prefStyle}
                  onSelect={setPrefStyle}
                />

                <ChipGroup
                  label="Time of day"
                  options={TIME_OPTIONS}
                  selected={prefTime}
                  onSelect={setPrefTime}
                />

                <ChipGroup
                  label="Render mode"
                  options={RENDER_OPTIONS}
                  selected={prefRender}
                  onSelect={setPrefRender}
                />

                <Pressable style={s.generateBtn} onPress={handleGenerateNow}>
                  <Sparkles size={15} color={color.onInk} />
                  <Text style={s.generateBtnText}>Generate now</Text>
                </Pressable>
              </ScrollView>
            )}

            {/* Generating state */}
            {phase === 'generating' && (
              <View style={s.loadingContainer}>
                <ActivityIndicator size="large" color={color.signal} />
                <Text style={s.loadingTitle}>Creating your image…</Text>
                <Text style={s.loadingSubtitle}>
                  AI is generating a header image based on the{' '}
                  {entityType === 'place' ? 'place' : 'event'} details.{'\n'}
                  This usually takes 15–30 seconds.
                </Text>
              </View>
            )}

            {/* Ready state — preview */}
            {(phase === 'ready' || phase === 'accepting') && imageUrl && (
              <>
                <Text style={s.previewLabel}>Preview</Text>
                <CachedImage
                  source={{ uri: imageUrl }}
                  style={s.previewImage}
                  resizeMode="cover"
                />
                <Text style={s.previewNote}>
                  AI-generated from your {entityType === 'place' ? 'place' : 'event'} title, category, and location.
                </Text>

                <View style={s.actions}>
                  <Pressable
                    style={[s.regenBtn, (phase === 'accepting' || regenerating) && s.btnDisabled]}
                    onPress={handleRegenerate}
                    disabled={phase === 'accepting' || regenerating}
                  >
                    {regenerating
                      ? <ActivityIndicator size="small" color={color.mute} />
                      : <RefreshCw size={15} color={color.mute} />
                    }
                    <Text style={s.regenBtnText}>
                      {regenerating ? 'Requesting…' : 'Regenerate'}
                    </Text>
                  </Pressable>

                  <Pressable
                    style={[s.acceptBtn, phase === 'accepting' && s.btnDisabled]}
                    onPress={handleAccept}
                    disabled={phase === 'accepting'}
                  >
                    {phase === 'accepting'
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <Check size={15} color={color.onInk} />
                    }
                    <Text style={s.acceptBtnText}>
                      {phase === 'accepting' ? 'Applying…' : 'Use this image'}
                    </Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Error state */}
            {phase === 'error' && (
              <View style={s.errorContainer}>
                <Text style={s.errorTitle}>Generation failed</Text>
                <Text style={s.errorMsg}>{errorMsg ?? 'Something went wrong.'}</Text>
                <Pressable
                  style={[s.regenBtn, s.regenBtnFull, regenerating && s.btnDisabled]}
                  onPress={handleRegenerate}
                  disabled={regenerating}
                >
                  {regenerating
                    ? <ActivityIndicator size="small" color={color.mute} />
                    : <RefreshCw size={15} color={color.mute} />
                  }
                  <Text style={s.regenBtnText}>
                    {regenerating ? 'Requesting…' : 'Try again'}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet:           { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36 },
  handle:          { width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  head:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  headLeft:        { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headTitle:       { ...t.title, color: color.ink, fontWeight: '700' },
  closeBtn:        { padding: 4 },
  body:            { padding: space.lg, gap: space.md },

  // Config phase
  configScroll:    { maxHeight: 420 },
  configContent:   { gap: space.lg, paddingBottom: space.sm },
  configIntro:     { ...t.body, color: color.mute, lineHeight: 20 },
  configIntroEm:   { color: color.ink, fontWeight: '600' },
  generateBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, marginTop: space.sm },
  generateBtnText: { ...t.body, color: color.onInk, fontWeight: '700' },

  // Generating
  loadingContainer:{ alignItems: 'center', paddingVertical: space.xxl, gap: space.md },
  loadingTitle:    { ...t.title, color: color.ink, fontWeight: '700', marginTop: space.sm },
  loadingSubtitle: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },

  // Preview
  previewLabel:    { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  previewImage:    { width: '100%', height: 200, borderRadius: radius.md, backgroundColor: color.haze },
  previewNote:     { ...t.small, color: color.faint, textAlign: 'center' },

  // Actions
  actions:         { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  regenBtn:        { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, backgroundColor: color.haze, borderRadius: radius.pill, paddingVertical: space.md, borderWidth: 1, borderColor: color.haze },
  regenBtnFull:    { flex: 0, alignSelf: 'stretch' },
  regenBtnText:    { ...t.body, color: color.mute, fontWeight: '600' },
  acceptBtn:       { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md },
  acceptBtnText:   { ...t.body, color: color.onInk, fontWeight: '700' },
  btnDisabled:     { opacity: 0.6 },

  // Error
  errorContainer:  { alignItems: 'center', paddingVertical: space.xl, gap: space.md },
  errorTitle:      { ...t.title, color: color.ink, fontWeight: '700' },
  errorMsg:        { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },
});

// ── Chip group styles ──────────────────────────────────────────────────────────

const cs = StyleSheet.create({
  group:         { gap: space.sm },
  groupLabel:    { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  chips:         { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip:          { paddingHorizontal: space.md, paddingVertical: space.xs + 2, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.haze, backgroundColor: color.paper },
  chipActive:    { borderColor: color.signal, backgroundColor: '#FFF1EE' },
  chipText:      { ...t.body, color: color.mute, fontWeight: '500' },
  chipTextActive:{ color: color.signal, fontWeight: '700' },
});
