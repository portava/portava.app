import React, { useState, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ArrowRight, CheckCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { saveMatchPreferences, bookingErrorCopy } from '../../src/services/rentABuddy';

interface QuizStep {
  id: string;
  question: string;
  options: Array<{ label: string; value: string; emoji?: string }>;
  multi?: boolean;
}

const STEPS: QuizStep[] = [
  {
    id: 'need',
    question: "What do you need a Buddy for?",
    options: [
      { label: 'City exploration', value: 'city', emoji: '🗺️' },
      { label: 'Language help', value: 'language', emoji: '🗣️' },
      { label: 'Nightlife guide', value: 'nightlife', emoji: '🌃' },
      { label: 'Content & photos', value: 'content', emoji: '📸' },
      { label: 'Airport arrival', value: 'arrival', emoji: '✈️' },
      { label: 'Group adventure', value: 'group', emoji: '👥' },
      { label: 'Custom request', value: 'custom', emoji: '✨' },
    ],
  },
  {
    id: 'vibe',
    question: "What's your travel vibe?",
    options: [
      { label: 'Chill & relaxed', value: 'chill', emoji: '😌' },
      { label: 'Social & outgoing', value: 'social', emoji: '🎉' },
      { label: 'Adventurous', value: 'adventurous', emoji: '🏄' },
      { label: 'Professional', value: 'professional', emoji: '💼' },
      { label: 'Flexible', value: 'flexible', emoji: '🌊' },
    ],
  },
  {
    id: 'energy',
    question: "What Buddy energy do you prefer?",
    options: [
      { label: 'Low-key & calm', value: 'low', emoji: '🌿' },
      { label: 'Balanced', value: 'medium', emoji: '☯️' },
      { label: 'High energy', value: 'high', emoji: '⚡' },
    ],
  },
  {
    id: 'language',
    question: "Do you need a specific language?",
    options: [
      { label: 'English only', value: 'English', emoji: '🇬🇧' },
      { label: 'Spanish', value: 'Spanish', emoji: '🇪🇸' },
      { label: 'Japanese', value: 'Japanese', emoji: '🇯🇵' },
      { label: 'French', value: 'French', emoji: '🇫🇷' },
      { label: 'Mandarin', value: 'Mandarin', emoji: '🇨🇳' },
      { label: 'Any language is fine', value: '', emoji: '🌍' },
    ],
  },
  {
    id: 'budget',
    question: "What's your hourly budget?",
    options: [
      { label: 'Under $20/hr', value: '0-20', emoji: '💚' },
      { label: '$20–$40/hr', value: '20-40', emoji: '💛' },
      { label: '$40–$70/hr', value: '40-70', emoji: '🧡' },
      { label: 'Flexible', value: 'flexible', emoji: '💸' },
    ],
  },
  {
    id: 'bookingLength',
    question: "How long will you need them?",
    options: [
      { label: 'Under 2 hours', value: 'under_2h', emoji: '⏱️' },
      { label: 'Half day (3–5h)', value: 'half_day', emoji: '🌅' },
      { label: 'Full day', value: 'full_day', emoji: '☀️' },
    ],
  },
  {
    id: 'safety',
    question: "Any safety preferences?",
    options: [
      { label: 'Public meetups only', value: 'public_only', emoji: '🏙️' },
      { label: 'Verified Buddies only', value: 'verified_only', emoji: '✅' },
      { label: 'Female Buddy only', value: 'female_only', emoji: '👩' },
      { label: 'No specific preferences', value: 'none', emoji: '🤝' },
    ],
    multi: true,
  },
];

function parseBudget(val: string): { min: number | undefined; max: number | undefined } {
  if (val === 'flexible' || !val) return { min: undefined, max: undefined };
  const [minStr, maxStr] = val.split('-');
  return { min: Number(minStr) || undefined, max: Number(maxStr) || undefined };
}

export default function MatchQuiz() {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [loading, setLoading] = useState(false);

  const currentStep = STEPS[step];
  const currentAnswer = answers[currentStep.id];

  function select(value: string) {
    if (currentStep.multi) {
      const prev = (currentAnswer as string[] | undefined) ?? [];
      if (value === 'none') {
        setAnswers((a) => ({ ...a, [currentStep.id]: ['none'] }));
      } else {
        const without = prev.filter((v) => v !== 'none');
        const toggled = without.includes(value) ? without.filter((v) => v !== value) : [...without, value];
        setAnswers((a) => ({ ...a, [currentStep.id]: toggled }));
      }
    } else {
      setAnswers((a) => ({ ...a, [currentStep.id]: value }));
    }
  }

  function isSelected(value: string): boolean {
    if (currentStep.multi) {
      return ((currentAnswer as string[] | undefined) ?? []).includes(value);
    }
    return currentAnswer === value;
  }

  const hasAnswer = currentStep.multi
    ? ((currentAnswer as string[] | undefined) ?? []).length > 0
    : currentAnswer !== undefined;

  const next = useCallback(async () => {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      setLoading(true);
      try {
        const safetyArr = (answers.safety as string[] | undefined) ?? [];
        const budgetStr = answers.budget as string | undefined;
        const { min: budgetMinUsd, max: budgetMaxUsd } = budgetStr ? parseBudget(budgetStr) : { min: undefined, max: undefined };

        const prefs = {
          need: (answers.need as string) || null,
          vibe: (answers.vibe as string) || null,
          energy: (answers.energy as string) || null,
          language: (answers.language as string) || null,
          budgetMinUsd: budgetMinUsd ?? null,
          budgetMaxUsd: budgetMaxUsd ?? null,
          bookingLength: (answers.bookingLength as string) || null,
          femaleOnly: safetyArr.includes('female_only'),
          publicOnly: safetyArr.includes('public_only'),
          safetyPrefs: { verifiedOnly: safetyArr.includes('verified_only') },
          rawAnswers: Object.fromEntries(
            Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])
          ),
        };

        await saveMatchPreferences(prefs);
        router.replace({ pathname: '/(rent-a-buddy)/marketplace', params: { fromQuiz: '1' } } as any);
      } catch (err: any) {
        Alert.alert('Error', bookingErrorCopy(err?.message, 'Something went wrong'));
      } finally {
        setLoading(false);
      }
    }
  }, [step, answers]);

  const progress = (step + 1) / STEPS.length;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => step > 0 ? setStep((prev) => prev - 1) : router.back()}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.stepLabel}>Step {step + 1} of {STEPS.length}</Text>
      </View>

      <View style={s.progressBar}>
        <View style={[s.progressFill, { width: `${progress * 100}%` as any }]} />
      </View>

      <ScrollView style={s.body} contentContainerStyle={s.bodyContent} showsVerticalScrollIndicator={false}>
        <Text style={s.question}>{currentStep.question}</Text>

        <View style={s.options}>
          {currentStep.options.map((opt) => (
            <Pressable
              key={opt.value}
              style={[s.option, isSelected(opt.value) && s.optionSelected]}
              onPress={() => select(opt.value)}
            >
              {opt.emoji ? <Text style={s.emoji}>{opt.emoji}</Text> : null}
              <Text style={[s.optionLabel, isSelected(opt.value) && s.optionLabelSelected]}>
                {opt.label}
              </Text>
              {isSelected(opt.value) && (
                <CheckCircle size={18} color={color.deep} />
              )}
            </Pressable>
          ))}
        </View>
      </ScrollView>

      <View style={[s.footer, { paddingBottom: insets.bottom + space.md }]}>
        <Pressable
          style={[s.continueBtn, (!hasAnswer || loading) && s.continueBtnDisabled]}
          onPress={next}
          disabled={!hasAnswer || loading}
        >
          <Text style={s.continueBtnLabel}>
            {loading ? 'Saving…' : step < STEPS.length - 1 ? 'Continue' : 'Find My Buddy'}
          </Text>
          {!loading && <ArrowRight size={18} color="#fff" />}
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md },
  backBtn: { padding: space.sm, marginRight: space.md },
  stepLabel: { ...t.small, color: color.mute },
  progressBar: { height: 4, backgroundColor: color.haze, marginHorizontal: space.lg },
  progressFill: { height: 4, backgroundColor: color.deep, borderRadius: 2 },
  body: { flex: 1 },
  bodyContent: { padding: space.xl, paddingBottom: space.xxxl },
  question: { ...t.heading, color: color.ink, marginBottom: space.xl },
  options: { gap: space.md },
  option: {
    flexDirection: 'row', alignItems: 'center', padding: space.lg,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: color.haze,
    backgroundColor: color.paper,
  },
  optionSelected: { borderColor: color.deep, backgroundColor: `${color.deep}12` },
  emoji: { fontSize: 22, marginRight: space.md },
  optionLabel: { ...t.body, color: color.ink, flex: 1 },
  optionLabelSelected: { color: color.deep, fontWeight: '600' },
  footer: { padding: space.lg, backgroundColor: color.paper },
  continueBtn: { backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  continueBtnDisabled: { opacity: 0.4 },
  continueBtnLabel: { ...t.body, color: '#fff', fontWeight: '700' },
});
