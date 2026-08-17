import React, { useState, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, TextInput, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, Star, Lock } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../../src/theme/tokens';
import { Stamp } from '../../src/components/ui';
import { submitReview, bookingErrorCopy } from '../../src/services/rentABuddy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';

const CATEGORY_RATINGS = [
  { id: 'onTime', label: 'On time' },
  { id: 'respectful', label: 'Respectful' },
  { id: 'helpful', label: 'Helpful' },
  { id: 'localKnowledge', label: 'Local knowledge' },
  { id: 'communication', label: 'Communication' },
  { id: 'safety', label: 'Safety-conscious' },
  { id: 'matchedProfile', label: 'Matched their profile' },
  { id: 'worthPrice', label: 'Worth the price' },
  { id: 'wouldBook', label: 'Would book again' },
];

function StarPicker({ value, onChange, size = 22 }: { value: number; onChange: (v: number) => void; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Pressable key={i} hitSlop={layout.hitSlop} onPress={() => onChange(i)}>
          <Star size={size} color={color.warn} fill={i <= value ? color.warn : 'none'} />
        </Pressable>
      ))}
    </View>
  );
}

export default function RentABuddyReview() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = params.bookingId ?? '';

  const [overallRating, setOverallRating] = useState(0);
  const [categoryRatings, setCategoryRatings] = useState<Record<string, number>>({});
  const [publicBody, setPublicBody] = useState('');
  const [privateNote, setPrivateNote] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const [submitted, setSubmitted] = useState(false);

  const setCategoryRating = (id: string, val: number) => {
    setCategoryRatings(prev => ({ ...prev, [id]: val }));
  };

  const canSubmit = overallRating > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      // Send everything the form collects — category stars, the private
      // safety note (admin-only), and the three server-native scores.
      const ratedCategories = Object.fromEntries(
        Object.entries(categoryRatings).filter(([, v]) => v > 0),
      );
      const res = await submitReview(bookingId, {
        rating: overallRating,
        body: publicBody || undefined,
        isPublic,
        categoryRatings: Object.keys(ratedCategories).length ? ratedCategories : undefined,
        privateNote: privateNote.trim() || undefined,
        safetyScore: categoryRatings.safety || undefined,
        communicationScore: categoryRatings.communication || undefined,
        punctualityScore: categoryRatings.onTime || undefined,
      });
      if (!res.ok) {
        Alert.alert('Error', bookingErrorCopy(res.error));
        return;
      }
      setSubmitted(true);
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <View style={[styles.page, styles.center]}>
        <View style={styles.successStamp}>
          <Stamp label="Review submitted" tone="signal" rotate={-2} />
        </View>
        <Text style={styles.successTitle}>Thank you for your review!</Text>
        <Text style={styles.successSub}>
          Your feedback helps build a safer, better community for all travelers. Reviews are double-blind — your Buddy sees it after they review you.
        </Text>
        <Pressable
          style={styles.doneBtn}
          onPress={() => router.push('/(rent-a-buddy)/' as any)}
        >
          <Text style={styles.doneBtnText}>Back to Rent a Buddy</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={styles.page}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}
        >
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Leave a Review</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Double-blind notice */}
        <View style={styles.blindNotice}>
          <Lock size={14} color={color.deep} />
          <Text style={styles.blindText}>
            Reviews are double-blind. Your Buddy won't see your review until they've reviewed you (or 7 days have passed).
          </Text>
        </View>

        {/* Overall rating */}
        <View style={styles.overallBlock}>
          <Text style={styles.overallLabel}>OVERALL RATING</Text>
          <StarPicker value={overallRating} onChange={setOverallRating} size={36} />
          <Text style={styles.overallHint}>
            {overallRating === 0 ? 'Tap to rate' :
              overallRating === 1 ? 'Poor' :
                overallRating === 2 ? 'Fair' :
                  overallRating === 3 ? 'Good' :
                    overallRating === 4 ? 'Great' : 'Excellent'}
          </Text>
        </View>

        {/* Category ratings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Detailed ratings</Text>
          {CATEGORY_RATINGS.map(cat => (
            <View key={cat.id} style={styles.catRatingRow}>
              <Text style={styles.catRatingLabel}>{cat.label}</Text>
              <StarPicker
                value={categoryRatings[cat.id] ?? 0}
                onChange={v => setCategoryRating(cat.id, v)}
                size={18}
              />
            </View>
          ))}
        </View>

        {/* Public review */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Public review</Text>
          <Text style={styles.sectionSub}>Share your experience — visible to other travelers once both reviews are published.</Text>
          <TextInput
            style={styles.textArea}
            value={publicBody}
            onChangeText={setPublicBody}
            placeholder="What was your meetup like? What made your Buddy stand out?"
            placeholderTextColor={color.haze}
            multiline
            numberOfLines={4}
          />
          <View style={styles.visibilityRow}>
            <Pressable
              style={[styles.visPill, isPublic && styles.visPillActive]}
              onPress={() => setIsPublic(true)}
            >
              <Text style={[styles.visPillText, isPublic && styles.visPillTextActive]}>Public</Text>
            </Pressable>
            <Pressable
              style={[styles.visPill, !isPublic && styles.visPillActive]}
              onPress={() => setIsPublic(false)}
            >
              <Text style={[styles.visPillText, !isPublic && styles.visPillTextActive]}>Anonymous</Text>
            </Pressable>
          </View>
        </View>

        {/* Private note */}
        <View style={styles.section}>
          <View style={styles.privateHeader}>
            <Lock size={13} color={color.deep} />
            <Text style={styles.sectionTitle}>Private note</Text>
          </View>
          <Text style={styles.sectionSub}>Admin-only — never shared with your Buddy. Use this to flag safety concerns or provide additional context.</Text>
          <TextInput
            style={[styles.textArea, { borderColor: color.deep, borderWidth: 1.5 }]}
            value={privateNote}
            onChangeText={setPrivateNote}
            placeholder="Any concerns or feedback for the Portava team only…"
            placeholderTextColor={color.haze}
            multiline
            numberOfLines={3}
          />
        </View>

        <View style={{ height: 120 + insets.bottom }} />
      </ScrollView>

      {/* Submit */}
      <View style={[styles.stickyBottom, { paddingBottom: insets.bottom + space.md }]}>
        <Pressable
          style={({ pressed }) => [
            styles.submitBtn,
            !canSubmit && styles.submitBtnDisabled,
            pressed && canSubmit && { opacity: layout.pressedOpacity },
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          <Text style={styles.submitBtnText}>
            {submitting ? 'Submitting…' : overallRating === 0 ? 'Select a rating to continue' : 'Submit review'}
          </Text>
        </Pressable>
      </View>
    </KeyboardSafeScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  center: { alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.lg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: color.ink },
  scroll: { paddingBottom: 20 },
  blindNotice: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    marginHorizontal: space.lg, marginTop: space.lg,
    backgroundColor: '#EAF2F5', borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.deep,
  },
  blindText: { ...t.small, color: color.deep, flex: 1, lineHeight: 18 },
  overallBlock: {
    alignItems: 'center', paddingVertical: space.xxl,
    borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.md,
  },
  overallLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2 },
  overallHint: { ...t.body, color: color.mute, height: 22 },
  section: { paddingHorizontal: space.lg, marginTop: space.xl, gap: space.sm },
  sectionTitle: { ...t.bodyStrong, color: color.ink },
  sectionSub: { ...t.small, color: color.mute, lineHeight: 18 },
  catRatingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  catRatingLabel: { ...t.body, color: color.ink, flex: 1 },
  textArea: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.md, ...t.body, color: color.ink,
    height: 100, textAlignVertical: 'top',
  },
  visibilityRow: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  visPill: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  visPillActive: { backgroundColor: color.ink, borderColor: color.ink },
  visPillText: { ...t.small, fontWeight: '600', color: color.ink },
  visPillTextActive: { color: color.onInk },
  privateHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  stickyBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze,
    paddingHorizontal: space.lg, paddingTop: space.md,
    ...shadow.float,
  },
  submitBtn: {
    backgroundColor: color.signal, borderRadius: radius.md,
    paddingVertical: space.md, alignItems: 'center',
  },
  submitBtnDisabled: { backgroundColor: color.haze },
  submitBtnText: { ...t.bodyStrong, color: color.onInk },
  successStamp: { marginBottom: space.sm },
  successTitle: { ...t.title, color: color.ink, textAlign: 'center' },
  successSub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  doneBtn: { backgroundColor: color.ink, borderRadius: radius.md, paddingHorizontal: space.xl, paddingVertical: space.md },
  doneBtnText: { ...t.bodyStrong, color: color.onInk },
});
