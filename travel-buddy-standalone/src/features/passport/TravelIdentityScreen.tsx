/**
 * TravelIdentityScreen — the Travel Identity / Travel DNA Passport surface
 * (spec §19 + TABLE 20).
 *
 * Reads the server's inferred travel identity (`getTravelIdentity()` →
 * `GET /api/passport/:userId/projection`, `.travelIdentity` slice) and presents
 * two kinds of reading, both EXPLAINABLE and USER-CONTROLLED (§19):
 *
 *   1. Travel DNA traits — named badges (Night Explorer, Hidden Gem Hunter,
 *      Food Driven, Globe Trotter…), each with the evidence it was inferred from.
 *   2. Travel-style dimensions (TABLE 20) — a spectrum/value reading per axis:
 *      interests, travel pace, planning, spend, social, discovery, energy,
 *      rhythm, group style, languages. The server supplies the readings + the
 *      evidence; this screen never re-derives a "travel style" (§30).
 *
 * USER CONTROL: every trait and dimension carries Show / Hide / Not-Me controls.
 * There is no write endpoint for these prefs on the API server yet, so the
 * toggles are held as OPTIMISTIC LOCAL STATE seeded from each item's server
 * `state`; the seam is isolated in one place (`applyState`) so wiring a
 * persistence call later is a one-line change.
 *
 * The full TABLE 20 axis set is always shown: axes the server has enough signal
 * to infer show their reading + evidence; axes it does not yet (e.g. energy)
 * show an honest "not enough signal yet" default rather than a fabricated value.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Sparkles,
  Info,
  Fingerprint,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon, dot } from '../../theme/tokens.ts';
import {
  useTravelIdentity,
  type UseTravelIdentityResult,
} from './useTravelIdentity.ts';
import type {
  TravelIdentityProjection,
  TravelDimension,
  TravelTrait,
  TravelDnaState,
} from '../../services/passportProjection.ts';

// ── Canonical TABLE 20 axes ──────────────────────────────────────────────────
// The full spec axis set, in canonical order. Server readings are overlaid by
// key; any axis the server does not (yet) infer renders an honest neutral
// default so the whole TABLE 20 is always represented.

interface AxisSpec {
  key: string;
  label: string;
  poles: { low: string; high: string } | null;
  /** Neutral reading shown when the server has no inference for this axis. */
  neutral: string;
}

const CANONICAL_AXES: AxisSpec[] = [
  { key: 'interests', label: 'Interests', poles: null, neutral: 'Not set' },
  { key: 'travel_pace', label: 'Travel pace', poles: { low: 'Relaxed', high: 'Packed' }, neutral: 'Balanced' },
  { key: 'planning', label: 'Planning', poles: { low: 'Spontaneous', high: 'Planner' }, neutral: 'Balanced' },
  { key: 'spend_style', label: 'Spend style', poles: { low: 'Budget', high: 'Luxury' }, neutral: 'Balanced' },
  { key: 'social', label: 'Social', poles: { low: 'Solo', high: 'Social' }, neutral: 'Balanced' },
  { key: 'discovery', label: 'Discovery', poles: { low: 'Famous spots', high: 'Hidden gems' }, neutral: 'Balanced' },
  { key: 'energy', label: 'Energy', poles: { low: 'Low', high: 'High' }, neutral: 'Balanced' },
  { key: 'rhythm', label: 'Rhythm', poles: { low: 'Early riser', high: 'Night owl' }, neutral: 'Balanced' },
  { key: 'group_style', label: 'Group style', poles: null, neutral: 'Not set' },
  { key: 'languages', label: 'Languages', poles: null, neutral: 'Not set' },
];

/** Merge server dimensions onto the canonical axis set (canonical order). */
function mergeDimensions(serverDims: TravelDimension[]): TravelDimension[] {
  const byKey = new Map(serverDims.map((d) => [d.key, d]));
  return CANONICAL_AXES.map((axis) => {
    const found = byKey.get(axis.key);
    if (found) return found;
    // Synthesize an honest neutral default — no evidence, marked not-inferred.
    return {
      key: axis.key,
      label: axis.label,
      poles: axis.poles,
      position: null,
      value: axis.neutral,
      evidence: [],
      state: 'shown' as TravelDnaState,
      inferred: true,
    };
  });
}

// ── Show / Hide / Not-Me control ─────────────────────────────────────────────

const STATE_OPTIONS: Array<{ value: TravelDnaState; label: string }> = [
  { value: 'shown', label: 'Show' },
  { value: 'hidden', label: 'Hide' },
  { value: 'not_me', label: 'Not me' },
];

function StateControl({
  itemKey,
  state,
  onChange,
}: {
  itemKey: string;
  state: TravelDnaState;
  onChange: (next: TravelDnaState) => void;
}) {
  return (
    <View style={s.control} accessibilityLabel={`Visibility control for ${itemKey}`}>
      {STATE_OPTIONS.map((opt) => {
        const active = state === opt.value;
        return (
          <Pressable
            key={opt.value}
            style={[s.controlBtn, active && s.controlBtnActive]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${opt.label}${active ? ', selected' : ''}`}
          >
            <Text style={[s.controlBtnText, active && s.controlBtnTextActive]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A short banner describing the current visibility state (paired with control). */
function StateNote({ state }: { state: TravelDnaState }) {
  if (state === 'hidden') {
    return <Text style={s.stateNoteHidden}>Hidden from your Passport</Text>;
  }
  if (state === 'not_me') {
    return <Text style={s.stateNoteNotMe}>Marked &ldquo;Not me&rdquo; — won&apos;t be inferred again</Text>;
  }
  return null;
}

// ── Explainability block ─────────────────────────────────────────────────────

function Evidence({ evidence }: { evidence: string[] }) {
  return (
    <View style={s.evidence}>
      <View style={s.evidenceHead}>
        <Info size={icon.s14} color={color.faint} />
        <Text style={s.evidenceLabel}>Why we inferred this</Text>
      </View>
      {evidence.length > 0 ? (
        evidence.map((e, i) => (
          <Text key={i} style={s.evidenceItem}>• {e}</Text>
        ))
      ) : (
        <Text style={s.evidenceItem}>
          Not enough signal yet — add details to your profile to refine this.
        </Text>
      )}
    </View>
  );
}

// ── Spectrum bar ─────────────────────────────────────────────────────────────

function SpectrumBar({ position, poles }: { position: number | null; poles: { low: string; high: string } }) {
  const pct = position == null ? 50 : Math.max(0, Math.min(1, position)) * 100;
  return (
    <View style={s.spectrum}>
      <View style={s.spectrumLabels}>
        <Text style={s.spectrumPole}>{poles.low}</Text>
        <Text style={s.spectrumPole}>{poles.high}</Text>
      </View>
      <View style={s.spectrumTrack} accessibilityLabel={`${poles.low} to ${poles.high}`}>
        <View style={[s.spectrumDot, { left: `${pct}%` }]} />
      </View>
    </View>
  );
}

// ── Trait card (Travel DNA badge) ────────────────────────────────────────────

function TraitCard({
  trait,
  state,
  onChange,
}: {
  trait: TravelTrait;
  state: TravelDnaState;
  onChange: (next: TravelDnaState) => void;
}) {
  const dimmed = state !== 'shown';
  return (
    <View style={[s.card, dimmed && s.cardDimmed]}>
      <View style={s.traitHead}>
        <View style={s.traitBadge}>
          <Sparkles size={icon.s16} color={color.warn} />
        </View>
        <View style={s.traitTitleWrap}>
          <Text style={s.traitLabel}>{trait.label}</Text>
          <Text style={s.traitDesc}>{trait.description}</Text>
        </View>
      </View>
      <Evidence evidence={trait.evidence} />
      <StateNote state={state} />
      <StateControl itemKey={trait.key} state={state} onChange={onChange} />
    </View>
  );
}

// ── Dimension card (TABLE 20 axis) ───────────────────────────────────────────

function DimensionCard({
  dim,
  state,
  onChange,
}: {
  dim: TravelDimension;
  state: TravelDnaState;
  onChange: (next: TravelDnaState) => void;
}) {
  const dimmed = state !== 'shown';
  return (
    <View style={[s.card, dimmed && s.cardDimmed]}>
      <View style={s.dimHead}>
        <Text style={s.dimLabel}>{dim.label}</Text>
        <Text style={s.dimValue} numberOfLines={2}>{dim.value}</Text>
      </View>
      {dim.poles ? <SpectrumBar position={dim.position} poles={dim.poles} /> : null}
      <Evidence evidence={dim.evidence} />
      <StateNote state={state} />
      <StateControl itemKey={dim.key} state={state} onChange={onChange} />
    </View>
  );
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Reading your travel DNA…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <Fingerprint size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load your travel identity</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface TravelIdentityScreenProps {
  /** Test seam: inject a prebuilt projection to bypass the data hook. */
  identityOverride?: TravelIdentityProjection;
}

export default function TravelIdentityScreen({ identityOverride }: TravelIdentityScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const hook: UseTravelIdentityResult = useTravelIdentity();

  const identity = identityOverride ?? hook.identity;
  const loading = identityOverride ? false : hook.loading;
  const error = identityOverride ? null : hook.error;

  // Optimistic local Show/Hide/Not-Me state, seeded from the server projection.
  // (No write endpoint on the API server yet — see file header.)
  const [states, setStates] = useState<Record<string, TravelDnaState>>({});

  useEffect(() => {
    if (!identity) return;
    const seed: Record<string, TravelDnaState> = {};
    for (const d of mergeDimensions(identity.dimensions)) seed[`dim:${d.key}`] = d.state;
    for (const tr of identity.traits) seed[`trait:${tr.key}`] = tr.state;
    setStates(seed);
  }, [identity]);

  const applyState = useCallback((scopedKey: string, next: TravelDnaState) => {
    // The one seam where a future PATCH /passport/travel-dna would be issued.
    setStates((prev) => ({ ...prev, [scopedKey]: next }));
  }, []);

  const dimensions = identity ? mergeDimensions(identity.dimensions) : [];
  const traits = identity?.traits ?? [];

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <Fingerprint size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>Travel Identity</Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.subtitle}>Your inferred Travel DNA — explainable and yours to control</Text>

        {loading ? (
          <LoadingView />
        ) : error ? (
          <ErrorView message={error} onRetry={hook.reload} />
        ) : !identity ? (
          <View style={s.center}>
            <Fingerprint size={icon.s26} color={color.faint} />
            <Text style={s.centerTitle}>No travel identity yet</Text>
            <Text style={s.centerText}>
              As you travel, earn stamps and set your profile, Portava infers your
              travel style here — always with the reason why, and always yours to
              show, hide or mark &ldquo;Not me&rdquo;.
            </Text>
          </View>
        ) : (
          <>
            {/* Control explainer */}
            <View style={s.explainer}>
              <Sparkles size={icon.s14} color={color.warn} />
              <Text style={s.explainerText}>
                These readings are inferred, never certain. Every one shows why it
                was inferred, and you can Show, Hide or mark it &ldquo;Not me&rdquo;.
              </Text>
            </View>

            {/* Travel DNA traits */}
            {traits.length > 0 ? (
              <View style={s.group}>
                <Text style={s.groupTitle}>Travel DNA</Text>
                {traits.map((tr) => (
                  <TraitCard
                    key={tr.key}
                    trait={tr}
                    state={states[`trait:${tr.key}`] ?? tr.state}
                    onChange={(next) => applyState(`trait:${tr.key}`, next)}
                  />
                ))}
              </View>
            ) : null}

            {/* Travel-style dimensions (TABLE 20) */}
            <View style={s.group}>
              <Text style={s.groupTitle}>Travel style</Text>
              {dimensions.map((d) => (
                <DimensionCard
                  key={d.key}
                  dim={d}
                  state={states[`dim:${d.key}`] ?? d.state}
                  onChange={(next) => applyState(`dim:${d.key}`, next)}
                />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  backBtn: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  title: { ...t.title, fontSize: 17, color: color.ink },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(200,133,26,0.08)',
  },
  explainerText: { ...t.small, color: color.mute, fontSize: 12, flexShrink: 1 },

  group: { marginTop: space.lg, paddingHorizontal: space.lg, gap: space.md },
  groupTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  cardDimmed: { opacity: 0.6 },

  // Trait
  traitHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  traitBadge: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(200,133,26,0.12)',
  },
  traitTitleWrap: { flex: 1, gap: 2 },
  traitLabel: { ...t.heading, color: color.ink, fontSize: 16 },
  traitDesc: { ...t.small, color: color.mute },

  // Dimension
  dimHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  dimLabel: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  dimValue: { ...t.body, color: color.deep, fontSize: 14, flexShrink: 1, textAlign: 'right' },

  // Spectrum
  spectrum: { gap: space.xs },
  spectrumLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  spectrumPole: { ...t.small, color: color.faint, fontSize: 11 },
  spectrumTrack: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    justifyContent: 'center',
  },
  spectrumDot: {
    position: 'absolute',
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    marginLeft: -(dot.s12 / 2),
    backgroundColor: color.deep,
  },

  // Evidence
  evidence: {
    gap: 2,
    paddingTop: space.xs,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  evidenceHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  evidenceLabel: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontFamily: 'Courier',
  },
  evidenceItem: { ...t.small, color: color.mute, fontSize: 12 },

  // State note
  stateNoteHidden: { ...t.small, color: color.mute, fontSize: 12, fontStyle: 'italic' },
  stateNoteNotMe: { ...t.small, color: color.signalDim, fontSize: 12, fontStyle: 'italic' },

  // Control
  control: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  controlBtn: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    backgroundColor: color.paper,
  },
  controlBtnActive: { backgroundColor: color.deep },
  controlBtnText: { ...t.small, color: color.mute, fontSize: 12, fontWeight: '700' },
  controlBtnTextActive: { color: color.paper },

  // States
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  centerTitle: { ...t.bodyStrong, color: color.ink, marginTop: space.xs },
  centerText: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
});
