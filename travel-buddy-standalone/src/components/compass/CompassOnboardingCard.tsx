/**
 * CompassOnboardingCard — 3-step cold-start onboarding for new Compass users.
 *
 * Self-managing: fetches settings + preferences on mount.
 * Shown only when onboarding_completed !== true AND (no interests OR no city set).
 *
 * Step 1: Interests (multi-select chips — skip or pick ≥1)
 * Step 2: Travel style (Solo / Groups / Both — skip ok)
 * Step 3: Safety preference (verified users only toggle — skip ok)
 *
 * On finish:  writes selections to preferences, marks onboarding_completed=true.
 * On any skip: advances to next step, collecting partial answers as it goes.
 * On "Not now" header button: marks onboarding_completed=true + dismisses
 *   (so the card never reappears after full dismissal).
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Switch,
} from 'react-native';
import { Sparkles, ArrowRight, Check } from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t } from '../../theme/tokens';
import {
  fetchCompassSettings,
  patchCompassSettings,
  patchCompassPreferences,
  fetchCompassPreferences,
  postCompassAnalyticsEvent,
  COMPASS_ENGINE_VERSION,
} from '../../services/compass';

// ── Constants ──────────────────────────────────────────────────────────────────

const INTERESTS = [
  'beach', 'food', 'culture', 'adventure', 'nightlife',
  'wellness', 'photography', 'shopping', 'luxury', 'nature',
];

type TravelStyle = 'solo' | 'groups' | 'mixed';
const TRAVEL_STYLES: { value: TravelStyle; label: string }[] = [
  { value: 'solo',   label: 'Solo'   },
  { value: 'groups', label: 'Groups' },
  { value: 'mixed',  label: 'Both'   },
];

// ── Chip ──────────────────────────────────────────────────────────────────────

function Chip({
  label, selected, onPress,
}: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[s.chip, selected && s.chipSelected]}
      onPress={onPress}
    >
      {selected && <Check size={10} color={color.onInk} style={s.chipCheck} />}
      <Text style={[s.chipText, selected && s.chipTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  onDismiss?: () => void;
}

export function CompassOnboardingCard({ onDismiss }: Props) {
  const [checkingSettings, setCheckingSettings] = useState(true);
  const [show, setShow]                         = useState(false);
  const [step, setStep]                         = useState(0);
  const [saving, setSaving]                     = useState(false);

  // Collected answers (persisted on finish; partial skips are omitted)
  const [interests,    setInterests]    = useState<Set<string>>(new Set());
  const [travelStyle,  setTravelStyle]  = useState<TravelStyle | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchCompassSettings(),
      fetchCompassPreferences(),
    ]).then(([settings, prefs]) => {
      const alreadyCompleted = settings.data?.onboarding_completed === true;
      const hasInterests  = (prefs.data?.interests?.length ?? 0) > 0;
      // current_city is included in the settings response from user_location_state
      const hasChosenCity = Boolean((settings.data as any)?.current_city);
      // Show for genuine cold-start: not completed AND (no interests OR no city)
      if (!alreadyCompleted && (!hasInterests || !hasChosenCity)) setShow(true);
      setCheckingSettings(false);
    });
  }, []);

  if (checkingSettings || !show) return null;

  // ── Persist and dismiss ───────────────────────────────────────────────────────

  async function persist(skipped: boolean) {
    setSaving(true);
    await patchCompassSettings({ onboarding_completed: true });
    postCompassAnalyticsEvent({
      event_name:             skipped ? 'compass_onboarding_skipped' : 'compass_onboarding_completed',
      compass_engine_version: COMPASS_ENGINE_VERSION,
    });
    setSaving(false);
    setShow(false);
    onDismiss?.();
  }

  async function handleFinish() {
    setSaving(true);
    // Write whichever answers the user provided (skip = undefined)
    const patch: Parameters<typeof patchCompassPreferences>[0] = {};
    if (interests.size > 0)  patch.interests      = Array.from(interests);
    if (travelStyle)         patch.travel_styles  = [travelStyle];
    patch.safety_preference = verifiedOnly ? 'strict' : 'standard';
    await patchCompassPreferences(patch);
    await persist(false);
    router.push('/compass-preferences' as any);
  }

  // Skip current question and advance to next step (or finish)
  async function skipStep() {
    if (step < 2) {
      setStep((prev) => prev + 1);
    } else {
      await persist(true);
    }
  }

  // Full card dismissal — mark completed so it never reappears
  async function handleNotNow() {
    await persist(true);
  }

  // ── Step renderers ────────────────────────────────────────────────────────────

  function renderStep0() {
    return (
      <>
        <Text style={s.stepTitle}>What interests you?</Text>
        <Text style={s.stepDesc}>Pick at least one — Compass will prioritise these.</Text>
        <View style={s.chipGrid}>
          {INTERESTS.map((item) => (
            <Chip
              key={item}
              label={item}
              selected={interests.has(item)}
              onPress={() =>
                setInterests((prev) => {
                  const next = new Set(prev);
                  next.has(item) ? next.delete(item) : next.add(item);
                  return next;
                })
              }
            />
          ))}
        </View>
        <View style={s.footer}>
          <Pressable style={s.secondaryBtn} onPress={skipStep}>
            <Text style={s.secondaryText}>Skip</Text>
          </Pressable>
          <Pressable
            style={[s.nextBtn, interests.size === 0 && s.nextBtnDisabled]}
            onPress={() => interests.size > 0 ? setStep(1) : skipStep()}
          >
            <Text style={s.nextText}>{interests.size > 0 ? 'Next' : 'Skip'}</Text>
            <ArrowRight size={14} color={color.onInk} />
          </Pressable>
        </View>
      </>
    );
  }

  function renderStep1() {
    return (
      <>
        <Text style={s.stepTitle}>How do you travel?</Text>
        <Text style={s.stepDesc}>Choose your typical travel style.</Text>
        <View style={s.optionList}>
          {TRAVEL_STYLES.map(({ value, label }) => (
            <Pressable
              key={value}
              style={[s.optionRow, travelStyle === value && s.optionRowSelected]}
              onPress={() => setTravelStyle(value)}
            >
              {travelStyle === value
                ? <Check size={14} color={color.signal} />
                : <View style={s.optionDot} />}
              <Text style={[s.optionText, travelStyle === value && s.optionTextSelected]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={s.footer}>
          <Pressable style={s.secondaryBtn} onPress={() => setStep(0)}>
            <Text style={s.secondaryText}>Back</Text>
          </Pressable>
          <Pressable style={s.secondaryBtn} onPress={skipStep}>
            <Text style={s.secondaryText}>Skip</Text>
          </Pressable>
          <Pressable
            style={[s.nextBtn, !travelStyle && s.nextBtnMuted]}
            onPress={() => travelStyle ? setStep(2) : skipStep()}
          >
            <Text style={s.nextText}>{travelStyle ? 'Next' : 'Skip'}</Text>
            <ArrowRight size={14} color={color.onInk} />
          </Pressable>
        </View>
      </>
    );
  }

  function renderStep2() {
    return (
      <>
        <Text style={s.stepTitle}>Safety preference</Text>
        <Text style={s.stepDesc}>Should Compass only show verified travellers?</Text>
        <View style={s.toggleRow}>
          <View style={s.toggleText}>
            <Text style={s.toggleLabel}>Verified users only</Text>
            <Text style={s.toggleDesc}>Compass will prioritise ID-verified profiles in buddy and people suggestions.</Text>
          </View>
          <Switch
            value={verifiedOnly}
            onValueChange={setVerifiedOnly}
            trackColor={{ false: color.haze, true: color.signal + 'AA' }}
            thumbColor={color.paper}
          />
        </View>
        <View style={s.footer}>
          <Pressable style={s.secondaryBtn} onPress={() => setStep(1)}>
            <Text style={s.secondaryText}>Back</Text>
          </Pressable>
          <Pressable style={s.secondaryBtn} onPress={skipStep}>
            <Text style={s.secondaryText}>Skip</Text>
          </Pressable>
          <Pressable
            style={[s.nextBtn, saving && s.nextBtnDisabled]}
            onPress={handleFinish}
          >
            {saving
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Text style={s.nextText}>Done</Text>}
          </Pressable>
        </View>
      </>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const STEP_TOTAL = 3;
  return (
    <View style={s.card}>
      {/* Header */}
      <View style={s.cardHeader}>
        <View style={s.iconWrap}>
          <Sparkles size={16} color={color.signal} />
        </View>
        <Text style={s.cardTitle}>Personalise Compass</Text>
        <Pressable style={s.notNowBtn} onPress={handleNotNow} hitSlop={8}>
          <Text style={s.notNowText}>Not now</Text>
        </Pressable>
      </View>

      {/* Step indicators */}
      <View style={s.dots}>
        {Array.from({ length: STEP_TOTAL }).map((_, i) => (
          <View key={i} style={[s.dot, i === step && s.dotActive]} />
        ))}
      </View>

      {/* Step content */}
      {step === 0 && renderStep0()}
      {step === 1 && renderStep1()}
      {step === 2 && renderStep2()}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.signal + '25',
    padding: space.lg,
    gap: space.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    backgroundColor: color.signal + '12',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    ...t.bodyStrong,
    color: color.ink,
    flex: 1,
    fontSize: 14,
  },
  notNowBtn: {
    padding: 4,
  },
  notNowText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
    marginVertical: space.xs,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.haze,
  },
  dotActive: {
    backgroundColor: color.signal,
    width: 16,
  },
  stepTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
    marginTop: space.xs,
  },
  stepDesc: {
    ...t.body,
    color: color.mute,
    fontSize: 12,
    lineHeight: 16,
  },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: space.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipSelected: {
    backgroundColor: color.ink,
    borderColor: color.ink,
  },
  chipCheck: {
    marginRight: 1,
  },
  chipText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    textTransform: 'capitalize',
  },
  chipTextSelected: {
    color: color.onInk,
    fontWeight: '600' as const,
  },
  optionList: {
    gap: space.xs,
    marginTop: space.xs,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  optionRowSelected: {
    borderColor: color.signal + '60',
    backgroundColor: color.signal + '08',
  },
  optionDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: color.haze,
  },
  optionText: {
    ...t.body,
    color: color.mute,
    fontSize: 13,
  },
  optionTextSelected: {
    color: color.ink,
    fontWeight: '600' as const,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.haze + '60',
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.xs,
  },
  toggleText: {
    flex: 1,
    gap: 3,
  },
  toggleLabel: {
    ...t.body,
    color: color.ink,
    fontSize: 13,
    fontWeight: '600' as const,
  },
  toggleDesc: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 14,
  },
  footer: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.sm,
  },
  secondaryBtn: {
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: {
    ...t.body,
    color: color.mute,
    fontSize: 13,
  },
  nextBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 5,
    backgroundColor: color.ink,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextBtnDisabled: {
    opacity: 0.4,
  },
  nextBtnMuted: {
    backgroundColor: color.deep,
  },
  nextText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 13,
  },
});
