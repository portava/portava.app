/**
 * IntentSheet — the Intent Mode surface (Map spec §13, sheet mechanics §32).
 *
 * "Tell Portava what you want right now": the nine primary intents as a
 * tappable grid, the Energy (Low ↔ High) and Novelty (Familiar ↔ Adventurous)
 * controls, a VISIBLE countdown to expiry, and an explicit Clear.
 *
 * WHY THE COUNTDOWN IS ON SCREEN
 * ==============================
 * §13's constraint is that an intent is temporary context, not a preference
 * rewrite. That is enforced in the model (features/map/intent/intentModel.ts),
 * but it also has to be VISIBLE — from the user's side of the glass, an
 * invisible expiry is indistinguishable from a settings change. So the sheet
 * always shows "Clears in 1h 58m" next to a plain statement that the intent
 * does not touch saved preferences, and the countdown ticks while the sheet is
 * open rather than freezing at whatever it read on mount.
 *
 * WHAT THIS COMPONENT DOES NOT DO
 * ===============================
 * No API calls, no AsyncStorage, no store access. It is a controlled component:
 * it receives the current intent and emits `onChange` / `onClear`. Persisting
 * the intent — and, crucially, persisting it somewhere OTHER than the user's
 * preference record — is the map screen's job. All intent construction goes
 * through `createIntent` / `withScales` so the TTL policy has exactly one home.
 *
 * STYLING
 * =======
 * Map chrome, so dark-first per §4 ("near-black/navy interface chrome"),
 * matching the dark treatment AskCompassBar already uses for bottom-anchored
 * map surfaces — while keeping MapFilterSheet's sheet skeleton (transparent
 * Modal + backdrop Pressable + grab handle + token spacing/radii) so the two
 * sheets feel like one system.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { X, Timer, RotateCcw } from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  MAP_INTENT_KINDS,
  MAP_INTENT_LABELS,
  MAP_INTENT_HINTS,
  INTENT_SCALE_MIN,
  INTENT_SCALE_MAX,
  INTENT_SCALE_DEFAULT,
  activeIntent,
  createIntent,
  energyLabel,
  formatRemaining,
  noveltyLabel,
  remainingMs,
  ttlMinutesFor,
  withScales,
  type MapIntentKind,
  type TemporaryIntent,
} from '../../features/map/intent/intentModel.ts';

// ── Dark map-chrome palette (§4) ──────────────────────────────────────────────

const SHEET_BG = '#0E1A1F';                        // near-black navy
const SURFACE = 'rgba(255,255,255,0.07)';          // tile / control ground
const SURFACE_BORDER = 'rgba(255,255,255,0.14)';
const SELECTED_BORDER = color.signal;
const SELECTED_BG = 'rgba(255,77,46,0.16)';
const TRACK_INACTIVE = 'rgba(255,255,255,0.22)';
const ON_DARK = color.onInk;
const ON_DARK_MUTE = color.onInkMute;

/** How often the "clears in …" countdown re-renders while the sheet is open. */
const TICK_MS = 30_000;

// ── Props ─────────────────────────────────────────────────────────────────────

export interface IntentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The current intent, or null when none is set. May be expired — the sheet
   *  routes it through `activeIntent` and treats an expired one as none. */
  intent: TemporaryIntent | null;
  /** Emitted whenever the user picks an intent or moves a slider. */
  onChange: (intent: TemporaryIntent) => void;
  /** Emitted by the explicit Clear action and by de-selecting the active tile. */
  onClear: () => void;
  /** Bottom safe-area inset, forwarded by the map screen. */
  bottomInset?: number;
  /**
   * Clock injection point. Defaults to the real clock; tests and Time Machine
   * (§15) can drive the sheet from a supplied instant.
   */
  now?: () => Date;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function IntentSheet({
  visible,
  onClose,
  intent,
  onChange,
  onClear,
  bottomInset = 0,
  now = () => new Date(),
}: IntentSheetProps) {
  // Re-render on a timer so the countdown is honest while the sheet is open.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [visible]);

  const current = useMemo(
    () => activeIntent(intent, now()),
    // `tick` is a deliberate dependency: it is what re-evaluates expiry while
    // the sheet sits open, so an intent that dies on screen disappears on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [intent, tick, visible],
  );

  /**
   * Slider draft. Seeded from the live intent so re-opening the sheet shows
   * what is actually in force; kept locally so the two sliders still work
   * before any intent has been picked (the values are then used as the initial
   * energy/novelty of whichever tile the user taps).
   */
  const [energy, setEnergy] = useState<number>(current?.energy ?? INTENT_SCALE_DEFAULT);
  const [novelty, setNovelty] = useState<number>(current?.novelty ?? INTENT_SCALE_DEFAULT);

  useEffect(() => {
    if (!visible) return;
    setEnergy(current?.energy ?? INTENT_SCALE_DEFAULT);
    setNovelty(current?.novelty ?? INTENT_SCALE_DEFAULT);
  }, [visible, current?.kind, current?.energy, current?.novelty]);

  const handlePickIntent = useCallback(
    (kind: MapIntentKind) => {
      // Tapping the tile that is already active de-selects it. This is the
      // second explicit-clear path §13 asks for, alongside the Clear button.
      if (current?.kind === kind) {
        onClear();
        return;
      }
      onChange(createIntent(kind, { energy, novelty }, now()));
    },
    [current?.kind, energy, novelty, onChange, onClear, now],
  );

  /**
   * Commit a slider. When an intent is live this REFINES it via `withScales`,
   * which deliberately does not restart the TTL — nudging a slider is not a new
   * intent, and letting it renew the clock would be a slow route back to the
   * permanence §13 forbids. With no intent live there is nothing to refine, so
   * the value is just held as the draft for the next tile tap.
   */
  const commitEnergy = useCallback(
    (value: number) => {
      setEnergy(value);
      if (current) onChange(withScales(current, { energy: value }));
    },
    [current, onChange],
  );

  const commitNovelty = useCallback(
    (value: number) => {
      setNovelty(value);
      if (current) onChange(withScales(current, { novelty: value }));
    },
    [current, onChange],
  );

  const countdown = current ? formatRemaining(remainingMs(current, now())) : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close intent mode" />

      <View style={[s.sheet, { paddingBottom: Math.max(bottomInset, space.xl) }]} pointerEvents="box-none">
        <View style={s.handle} />

        {/* Header */}
        <View style={s.header}>
          <View style={s.headerText}>
            <Text style={s.title}>What do you want right now?</Text>
            <Text style={s.subtitle}>
              Intent is temporary. It shapes today&apos;s map and never changes your saved
              preferences.
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={s.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <X size={icon.s18} color={ON_DARK_MUTE} />
          </Pressable>
        </View>

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Nine primary intents */}
          <View style={s.grid} testID="intent-grid">
            {MAP_INTENT_KINDS.map((kind) => {
              const selected = current?.kind === kind;
              return (
                <Pressable
                  key={kind}
                  testID={`intent-tile-${kind}`}
                  onPress={() => handlePickIntent(kind)}
                  style={({ pressed }) => [
                    s.tile,
                    selected && s.tileSelected,
                    pressed && s.tilePressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={MAP_INTENT_LABELS[kind]}
                  accessibilityHint={
                    selected
                      ? 'Currently active. Tap to clear this intent.'
                      : `${MAP_INTENT_HINTS[kind]}. Clears after ${formatRemaining(
                          ttlMinutesFor(kind) * 60_000,
                        )}.`
                  }
                >
                  <Text style={[s.tileLabel, selected && s.tileLabelSelected]} numberOfLines={1}>
                    {MAP_INTENT_LABELS[kind]}
                  </Text>
                  <Text style={s.tileHint} numberOfLines={2}>
                    {MAP_INTENT_HINTS[kind]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Energy — Low ↔ High */}
          <ScaleControl
            testID="intent-energy"
            title="Energy"
            minLabel="Low"
            maxLabel="High"
            valueLabel={energyLabel(energy)}
            value={energy}
            onValueChange={setEnergy}
            onSlidingComplete={commitEnergy}
          />

          {/* Novelty — Familiar ↔ Adventurous */}
          <ScaleControl
            testID="intent-novelty"
            title="Novelty"
            minLabel="Familiar"
            maxLabel="Adventurous"
            valueLabel={noveltyLabel(novelty)}
            value={novelty}
            onValueChange={setNovelty}
            onSlidingComplete={commitNovelty}
          />
        </ScrollView>

        {/* TTL affordance + explicit clear */}
        <View style={s.footer}>
          <View style={s.ttlRow}>
            <Timer size={icon.s14} color={current ? color.signal : ON_DARK_MUTE} />
            <Text style={s.ttlText} testID="intent-ttl" numberOfLines={1}>
              {current ? `Clears in ${countdown}` : 'No intent set'}
            </Text>
          </View>

          <Pressable
            testID="intent-clear"
            onPress={onClear}
            disabled={!current}
            style={({ pressed }) => [
              s.clearBtn,
              !current && s.clearBtnDisabled,
              pressed && current && s.tilePressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Clear intent"
            accessibilityState={{ disabled: !current }}
            accessibilityHint="Removes the temporary intent immediately."
          >
            <RotateCcw size={icon.s14} color={current ? ON_DARK : ON_DARK_MUTE} />
            <Text style={[s.clearLabel, !current && s.clearLabelDisabled]}>Clear</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// ── Sub-component: one labelled 0…1 slider ────────────────────────────────────

interface ScaleControlProps {
  testID: string;
  title: string;
  minLabel: string;
  maxLabel: string;
  valueLabel: string;
  value: number;
  onValueChange: (value: number) => void;
  onSlidingComplete: (value: number) => void;
}

function ScaleControl({
  testID,
  title,
  minLabel,
  maxLabel,
  valueLabel,
  value,
  onValueChange,
  onSlidingComplete,
}: ScaleControlProps) {
  return (
    <View style={s.control} testID={testID}>
      <View style={s.controlHead}>
        <Text style={s.controlTitle}>{title}</Text>
        <Text style={s.controlValue}>{valueLabel}</Text>
      </View>
      <Slider
        style={s.slider}
        minimumValue={INTENT_SCALE_MIN}
        maximumValue={INTENT_SCALE_MAX}
        step={0.05}
        value={value}
        // Continuous updates keep the band label live under the thumb; the
        // committed change is emitted once, on release, so a drag is one event.
        onValueChange={onValueChange}
        onSlidingComplete={onSlidingComplete}
        minimumTrackTintColor={color.signal}
        maximumTrackTintColor={TRACK_INACTIVE}
        thumbTintColor={ON_DARK}
        accessibilityLabel={`${title}: ${valueLabel}`}
      />
      <View style={s.controlEnds}>
        <Text style={s.endLabel}>{minLabel}</Text>
        <Text style={s.endLabel}>{maxLabel}</Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // §32: Half snap point — the map must stay visible behind the sheet.
    maxHeight: '78%',
    backgroundColor: SHEET_BG,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 16,
  },
  handle: {
    alignSelf: 'center',
    marginTop: 10,
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.28)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...t.title,
    fontSize: 18,
    color: ON_DARK,
  },
  subtitle: {
    ...t.small,
    fontSize: 12,
    lineHeight: 17,
    color: ON_DARK_MUTE,
    marginTop: 3,
  },
  closeBtn: {
    width: avatar.s32,
    height: avatar.s32,
    borderRadius: avatar.s32 / 2,
    backgroundColor: SURFACE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  // Intent grid — three per row on a phone, wrapping gracefully when wider.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  tile: {
    flexBasis: '30%',
    flexGrow: 1,
    minHeight: 64,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: SURFACE_BORDER,
    justifyContent: 'center',
  },
  tileSelected: {
    backgroundColor: SELECTED_BG,
    borderColor: SELECTED_BORDER,
  },
  tilePressed: {
    opacity: 0.7,
  },
  tileLabel: {
    ...t.bodyStrong,
    fontSize: 13,
    color: ON_DARK,
  },
  tileLabelSelected: {
    color: color.signal,
  },
  tileHint: {
    ...t.small,
    fontSize: 10,
    lineHeight: 13,
    color: ON_DARK_MUTE,
    marginTop: 2,
  },
  // Sliders
  control: {
    marginTop: space.lg,
  },
  controlHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  controlTitle: {
    ...t.bodyStrong,
    fontSize: 13,
    color: ON_DARK,
  },
  controlValue: {
    ...t.stamp,
    fontSize: 10,
    color: color.signal,
  },
  slider: {
    width: '100%',
    height: 36,
  },
  controlEnds: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -4,
  },
  endLabel: {
    ...t.small,
    fontSize: 11,
    color: ON_DARK_MUTE,
  },
  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: SURFACE_BORDER,
  },
  ttlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    minWidth: 0,
  },
  ttlText: {
    ...t.small,
    fontSize: 12,
    fontWeight: '600',
    color: ON_DARK,
    flexShrink: 1,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: SURFACE,
    borderWidth: 1,
    borderColor: SURFACE_BORDER,
  },
  clearBtnDisabled: {
    opacity: 0.45,
  },
  clearLabel: {
    ...t.small,
    fontSize: 12,
    fontWeight: '700',
    color: ON_DARK,
  },
  clearLabelDisabled: {
    color: ON_DARK_MUTE,
  },
});
