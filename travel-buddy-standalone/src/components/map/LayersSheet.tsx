/**
 * LayersSheet — Map spec §16 "Layers and Progressive Disclosure", and the
 * legend half of §2's ninth surface, "Layers / Legend".
 *
 * Two jobs, one sheet:
 *
 *  1. LAYERS — a tri-state control per layer: Auto / On / Off. "Auto" is the
 *     §16 behaviour ("explicit layers PLUS automatic relevance") — the layer
 *     follows its suggested default, and for People / Trip / Crowd Flow that
 *     default is *contextual*, resolved from zoom, mode, trip state and
 *     density. Each row shows the resolved outcome and the reason for it, so
 *     an automatic layer is never mysteriously absent. Choosing On or Off
 *     stores an explicit override that outranks the automatic resolution and
 *     survives every context change.
 *
 *     Safety has no control. §5 and §24 put safety above activity ranking, so
 *     `layerModel` makes it inexpressible in `LayerPreferences`; this sheet
 *     renders it as a locked row rather than a disabled switch, because a
 *     greyed-out switch still reads as "a thing you might be allowed to press".
 *
 *  2. LEGEND — §6's semantic visual language, drawn rather than described:
 *     soft fill, pulsing outline, dashed boundary, arrows, marker, star, gem,
 *     event icon, group icon, avatar, ring, checkpoint pin, shield, gold
 *     marker, blue dot. A user who cannot decode the map cannot trust it.
 *
 * Dark-mode-first (§4): near-black chrome, low-saturation surfaces, bright
 * semantic accents. All decisions live in `features/map/layers/layerModel.ts`;
 * this file only renders them and owns the AsyncStorage round-trip.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CalendarDays,
  Gem,
  Lock,
  MapPin,
  MoveRight,
  RotateCcw,
  Shield,
  Star,
  User,
  Users,
  X,
} from 'lucide-react-native';
import { avatar, dot, icon, radius, space, type as t } from '../../theme/tokens.ts';
import {
  DEFAULT_LAYER_CONTEXT,
  EMPTY_LAYER_PREFERENCES,
  LAYER_META,
  LAYER_PREFERENCES_STORAGE_KEY,
  LEGEND_MEANINGS,
  MAP_LAYER_IDS,
  clearLayerChoice,
  isAlwaysOnLayer,
  layerControlValue,
  parseLayerPreferences,
  resolveLayers,
  serializeLayerPreferences,
  setLayerChoice,
  type LayerContext,
  type LayerControlValue,
  type LayerPreferences,
  type LegendGlyph,
  type MapLayerId,
  type ToggleableLayerId,
} from '../../features/map/layers/layerModel.ts';

// ── Dark-mode-first palette (§4) ──────────────────────────────────────────────
//
// The shared tokens are a light/editorial palette; the map chrome is near-black
// by spec. These are the map surface's own values, named so a future dark theme
// in tokens.ts can replace them in one place.
const dark = {
  sheet: '#0E1216',
  raised: '#171C22',
  raisedAlt: '#1F262E',
  hairline: '#2A323B',
  text: '#F2F5F7',
  textMute: 'rgba(242,245,247,0.62)',
  textFaint: 'rgba(242,245,247,0.40)',
  backdrop: 'rgba(4,6,8,0.62)',
  onAccent: '#0E1216',
  blueDot: '#3B82F6',
  gold: '#D4A017',
} as const;

// ── Persistence (the sheet owns the I/O; the model owns the shape) ────────────

export async function loadLayerPreferences(): Promise<LayerPreferences> {
  try {
    return parseLayerPreferences(await AsyncStorage.getItem(LAYER_PREFERENCES_STORAGE_KEY));
  } catch {
    return EMPTY_LAYER_PREFERENCES;
  }
}

export async function saveLayerPreferences(prefs: LayerPreferences): Promise<void> {
  try {
    await AsyncStorage.setItem(LAYER_PREFERENCES_STORAGE_KEY, serializeLayerPreferences(prefs));
  } catch {
    // Non-fatal: preferences fall back to the §16 defaults on next mount.
  }
}

// ── §6 legend glyphs, drawn ───────────────────────────────────────────────────

function Glyph({ glyph, accent }: { glyph: LegendGlyph; accent: string }) {
  switch (glyph) {
    case 'soft_fill':
      return <View style={[g.box, { backgroundColor: accent + '3D', borderColor: accent + '55' }]} />;
    case 'pulsing_outline':
      return (
        <View style={[g.box, g.transparent, { borderColor: accent, borderWidth: 2 }]}>
          <View style={[g.pulseCore, { backgroundColor: accent }]} />
        </View>
      );
    case 'dashed_boundary':
      return (
        <View
          style={[g.box, g.transparent, { borderColor: accent, borderWidth: 2, borderStyle: 'dashed' }]}
        />
      );
    case 'arrows':
      return (
        <View style={g.row}>
          <MoveRight size={12} color={accent} />
          <MoveRight size={14} color={accent} />
        </View>
      );
    case 'marker':
      return <MapPin size={16} color={accent} />;
    case 'star':
      return <Star size={16} color={accent} fill={accent} />;
    case 'gem':
      return <Gem size={16} color={accent} />;
    case 'event_icon':
      return <CalendarDays size={16} color={accent} />;
    case 'group_icon':
      return <Users size={16} color={accent} />;
    case 'avatar':
      return (
        <View style={[g.avatar, { borderColor: accent }]}>
          <User size={11} color={accent} />
        </View>
      );
    case 'ring':
      return <View style={[g.ring, { borderColor: accent, backgroundColor: accent + '22' }]} />;
    case 'checkpoint_pin':
      return (
        <View style={g.checkpoint}>
          <MapPin size={16} color={accent} />
          <View style={[g.checkpointDot, { backgroundColor: accent }]} />
        </View>
      );
    case 'shield':
      return <Shield size={16} color={accent} />;
    case 'gold_marker':
      return <MapPin size={16} color={dark.gold} fill={dark.gold + '55'} />;
    case 'blue_dot':
      return (
        <View style={[g.ring, { borderColor: dark.blueDot + '55', backgroundColor: dark.blueDot + '22' }]}>
          <View style={[g.blueDot, { backgroundColor: dark.blueDot }]} />
        </View>
      );
    default:
      return <View style={g.box} />;
  }
}

/**
 * The legend, in §6's own order. Kept as a literal list rather than derived
 * from LAYER_META so every §6 row appears exactly once, including the ones that
 * belong to no single layer (star, avatar, ring, blue dot).
 */
const LEGEND_ROWS: { glyph: LegendGlyph; accent: string }[] = [
  { glyph: 'soft_fill', accent: LAYER_META.live_activity.accent },
  { glyph: 'pulsing_outline', accent: LAYER_META.live_activity.accent },
  { glyph: 'dashed_boundary', accent: LAYER_META.live_activity.accent },
  { glyph: 'arrows', accent: LAYER_META.crowd_flow.accent },
  { glyph: 'marker', accent: LAYER_META.relevant_places.accent },
  { glyph: 'star', accent: LAYER_META.relevant_places.accent },
  { glyph: 'gem', accent: LAYER_META.hidden_gems.accent },
  { glyph: 'event_icon', accent: LAYER_META.events.accent },
  { glyph: 'group_icon', accent: LAYER_META.people.accent },
  { glyph: 'avatar', accent: LAYER_META.people.accent },
  { glyph: 'ring', accent: LAYER_META.people.accent },
  { glyph: 'checkpoint_pin', accent: LAYER_META.trip.accent },
  { glyph: 'shield', accent: LAYER_META.safety.accent },
  { glyph: 'gold_marker', accent: LAYER_META.saved.accent },
  { glyph: 'blue_dot', accent: dark.blueDot },
];

// ── Tri-state control ─────────────────────────────────────────────────────────

const SEGMENTS: { value: LayerControlValue; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

function TriStateControl({
  value,
  accent,
  label,
  onSelect,
}: {
  value: LayerControlValue;
  accent: string;
  label: string;
  onSelect: (next: LayerControlValue) => void;
}) {
  return (
    <View style={s.segments} accessibilityRole="radiogroup">
      {SEGMENTS.map((seg) => {
        const active = seg.value === value;
        return (
          <Pressable
            key={seg.value}
            onPress={() => onSelect(seg.value)}
            hitSlop={4}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${label}: ${seg.label}`}
            style={[
              s.segment,
              active && { backgroundColor: seg.value === 'off' ? dark.raisedAlt : accent },
            ]}
          >
            <Text
              style={[
                s.segmentText,
                active && { color: seg.value === 'off' ? dark.text : dark.onAccent, fontWeight: '700' },
              ]}
            >
              {seg.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface LayersSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Stored explicit choices. Absence of a key means "automatic". */
  preferences: LayerPreferences;
  /**
   * Called with the next preferences whenever the user changes a row. The
   * sheet also persists them itself, so the parent only needs to hold state.
   */
  onChangePreferences: (next: LayerPreferences) => void;
  /**
   * Current map context, so contextual layers can show what they resolve to
   * right now. Defaults to a neutral context when the caller has none yet.
   */
  context?: LayerContext;
}

export function LayersSheet({
  visible,
  onClose,
  preferences,
  onChangePreferences,
  context = DEFAULT_LAYER_CONTEXT,
}: LayersSheetProps) {
  const [local, setLocal] = useState<LayerPreferences>(preferences);

  useEffect(() => {
    setLocal(preferences);
  }, [preferences]);

  const resolved = useMemo(() => resolveLayers(local, context), [local, context]);

  const commit = useCallback(
    (next: LayerPreferences) => {
      setLocal(next);
      onChangePreferences(next);
      void saveLayerPreferences(next);
    },
    [onChangePreferences],
  );

  const select = useCallback(
    (layerId: ToggleableLayerId, next: LayerControlValue) => {
      commit(next === 'auto' ? clearLayerChoice(local, layerId) : setLayerChoice(local, layerId, next));
    },
    [commit, local],
  );

  const resetAll = useCallback(() => commit(EMPTY_LAYER_PREFERENCES), [commit]);

  const overrideCount = Object.keys(local).length;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close layers" />

      <View style={s.sheet}>
        <View style={s.handle} />

        <View style={s.header}>
          <Text style={s.title}>Layers &amp; Legend</Text>
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn} accessibilityLabel="Close">
            <X size={18} color={dark.textMute} />
          </Pressable>
        </View>

        <Text style={s.subtitle}>
          Portava keeps the map readable by showing only what is relevant. Leave a layer on Auto and
          it follows context; choose On or Off and your choice sticks.
        </Text>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Layers ── */}
          <View style={s.sectionHead}>
            <Text style={s.sectionTitle}>LAYERS</Text>
            {overrideCount > 0 ? (
              <Pressable onPress={resetAll} hitSlop={8} style={s.resetBtn} accessibilityRole="button">
                <RotateCcw size={12} color={dark.textMute} />
                <Text style={s.resetText}>Reset {overrideCount}</Text>
              </Pressable>
            ) : null}
          </View>

          {MAP_LAYER_IDS.map((layerId: MapLayerId) => {
            const meta = LAYER_META[layerId];
            const state = resolved[layerId];
            const control = layerControlValue(local, layerId);
            const locked = isAlwaysOnLayer(layerId);

            return (
              <View key={layerId} style={s.layerRow}>
                <View style={s.layerHead}>
                  <View style={[s.swatch, { backgroundColor: meta.accent }]} />
                  <View style={s.layerText}>
                    <Text style={s.layerLabel}>{meta.label}</Text>
                    <Text style={s.layerDesc} numberOfLines={2}>
                      {meta.description}
                    </Text>
                  </View>
                  {locked ? (
                    <View style={s.lockPill}>
                      <Lock size={11} color={meta.accent} />
                      <Text style={[s.lockText, { color: meta.accent }]}>Always on</Text>
                    </View>
                  ) : (
                    <TriStateControl
                      value={control === 'locked' ? 'on' : control}
                      accent={meta.accent}
                      label={meta.label}
                      onSelect={(next) => select(layerId as ToggleableLayerId, next)}
                    />
                  )}
                </View>

                <View style={s.statusRow}>
                  <View
                    style={[
                      s.statusDot,
                      { backgroundColor: state.visible ? meta.accent : dark.hairline },
                    ]}
                  />
                  <Text style={s.statusText} numberOfLines={1}>
                    {state.visible ? 'Showing' : 'Hidden'} — {state.reason}
                  </Text>
                </View>
              </View>
            );
          })}

          {/* ── Legend ── */}
          <View style={[s.sectionHead, s.legendHead]}>
            <Text style={s.sectionTitle}>LEGEND</Text>
          </View>
          <Text style={s.legendIntro}>
            Zones show aggregate state. They are deliberately soft-edged — they do not claim exact
            borders.
          </Text>

          <View style={s.legendCard}>
            {LEGEND_ROWS.map((row) => (
              <View key={row.glyph} style={s.legendRow}>
                <View style={s.legendGlyph}>
                  <Glyph glyph={row.glyph} accent={row.accent} />
                </View>
                <Text style={s.legendText}>{LEGEND_MEANINGS[row.glyph]}</Text>
              </View>
            ))}
          </View>

          <Text style={s.footnote}>
            A ring means an approximate area, never an exact position. Dashed edges mean a forecast,
            not something anyone has seen.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const g = StyleSheet.create({
  box: {
    width: 22,
    height: 16,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transparent: { backgroundColor: 'transparent' },
  pulseCore: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  avatar: {
    width: icon.s18,
    height: icon.s18,
    borderRadius: icon.s18 / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: icon.s20,
    height: icon.s20,
    borderRadius: icon.s20 / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  blueDot: { width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2 },
  checkpoint: { alignItems: 'center', justifyContent: 'center' },
  checkpointDot: {
    position: 'absolute',
    bottom: -2,
    width: dot.s5,
    height: dot.s5,
    borderRadius: dot.s5 / 2,
  },
});

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: dark.backdrop,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    backgroundColor: dark.sheet,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderColor: dark.hairline,
  },
  handle: {
    alignSelf: 'center',
    marginTop: 10,
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: dark.hairline,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  title: { ...t.title, fontSize: 18, color: dark.text },
  closeBtn: {
    width: avatar.s32,
    height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: dark.raised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: {
    ...t.small,
    fontSize: 12,
    lineHeight: 17,
    color: dark.textMute,
    paddingHorizontal: space.lg,
    paddingTop: 6,
    paddingBottom: space.sm,
  },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingHorizontal: space.lg, paddingBottom: space.lg },

  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.sm,
    paddingBottom: 6,
  },
  legendHead: { paddingTop: space.xl },
  sectionTitle: {
    ...t.stamp,
    fontSize: 11,
    letterSpacing: 1.2,
    color: dark.textFaint,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: dark.raised,
  },
  resetText: { ...t.small, fontSize: 11, color: dark.textMute },

  layerRow: {
    backgroundColor: dark.raised,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 8,
  },
  layerHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  swatch: { width: dot.s10, height: dot.s10, borderRadius: dot.s10 / 2, flexShrink: 0 },
  layerText: { flex: 1, minWidth: 0 },
  layerLabel: { ...t.bodyStrong, fontSize: 14, color: dark.text },
  layerDesc: { ...t.small, fontSize: 11, lineHeight: 15, color: dark.textMute, marginTop: 1 },

  segments: {
    flexDirection: 'row',
    backgroundColor: dark.sheet,
    borderRadius: radius.pill,
    padding: 2,
    gap: 2,
  },
  segment: {
    minWidth: 40,
    minHeight: 28,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: { ...t.small, fontSize: 11, color: dark.textMute },

  lockPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: dark.raisedAlt,
  },
  lockText: { ...t.small, fontSize: 11, fontWeight: '700' },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9 },
  statusDot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
  statusText: { ...t.small, fontSize: 11, color: dark.textFaint, flex: 1 },

  legendIntro: { ...t.small, fontSize: 11, lineHeight: 16, color: dark.textMute, paddingBottom: 8 },
  legendCard: {
    backgroundColor: dark.raised,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: dark.hairline,
  },
  legendGlyph: { width: 26, alignItems: 'center', justifyContent: 'center' },
  legendText: { ...t.small, fontSize: 12, color: dark.text, flex: 1 },

  footnote: {
    ...t.small,
    fontSize: 11,
    lineHeight: 16,
    color: dark.textFaint,
    paddingTop: space.md,
  },
});
