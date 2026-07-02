import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  createReview,
  createEventReview,
  updateReview,
  getMyReview,
  REVIEW_TAGS,
  type ReviewEntityType,
} from '../../../src/services/reviews';
import { useSession } from '../../../src/context/SessionContext';

// ── Star rating ───────────────────────────────────────────────────────────────

function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <View style={s.stars}>
      {[1, 2, 3, 4, 5].map((star) => (
        <TouchableOpacity key={star} onPress={() => onChange(star)} style={s.starBtn}>
          <Text style={[s.star, star <= value && s.starFilled]}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── Tag chip ──────────────────────────────────────────────────────────────────

function TagChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[s.chip, selected && s.chipSelected]}
      onPress={onPress}
    >
      <Text style={[s.chipText, selected && s.chipTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function ReviewComposerScreen() {
  const { entityType, entityId, entityName } = useLocalSearchParams<{
    entityType: string;
    entityId: string;
    entityName?: string;
  }>();
  const { isAuthed } = useSession();

  const [rating, setRating]           = useState(0);
  const [body, setBody]               = useState('');
  const [tags, setTags]               = useState<string[]>([]);
  const [anonymous, setAnonymous]     = useState(false);
  const [saving, setSaving]           = useState(false);
  const [loading, setLoading]         = useState(false);

  // Edit-mode state
  const [existingReviewId, setExistingReviewId] = useState<string | null>(null);
  const isEditing = existingReviewId !== null;

  // On mount: check if the user has already reviewed this entity.
  // If so, pre-fill the form fields for editing.
  useEffect(() => {
    if (!isAuthed || !entityId || entityType === 'event') return;
    const validType = ['trip', 'rent_buddy_booking', 'place'].includes(entityType ?? '');
    if (!validType) return;

    setLoading(true);
    getMyReview(entityType as ReviewEntityType, entityId)
      .then((result) => {
        if (result.exists && result.reviewId) {
          setExistingReviewId(result.reviewId);
          if (result.rating)    setRating(result.rating);
          if (result.body)      setBody(result.body);
          if (result.tags)      setTags(result.tags);
          if (result.anonymous !== undefined) setAnonymous(result.anonymous);
        }
      })
      .catch(() => {
        // Fail open — let the user try; server will catch any actual duplicate
      })
      .finally(() => setLoading(false));
  }, [isAuthed, entityType, entityId]);

  const toggleTag = (value: string) => {
    setTags((prev) =>
      prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value],
    );
  };

  const submit = async () => {
    if (rating === 0) {
      Alert.alert('Rating required', 'Please select a star rating before submitting.');
      return;
    }

    const validType = ['event', 'trip', 'rent_buddy_booking', 'place'].includes(entityType ?? '');
    if (!validType || !entityId) {
      Alert.alert('Error', 'Invalid review target. Please go back and try again.');
      return;
    }

    setSaving(true);
    try {
      if (isEditing && existingReviewId) {
        await updateReview(existingReviewId, {
          rating,
          body:      body.trim() || null,
          tags,
          anonymous,
        });
        Alert.alert('Review updated', 'Your review has been updated.', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else if (entityType === 'event') {
        await createEventReview({
          eventId:   entityId,
          rating,
          body:      body.trim() || undefined,
          anonymous,
        });
        Alert.alert('Review submitted', 'Thank you for your review!', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else {
        await createReview({
          entityType: entityType as ReviewEntityType,
          entityId,
          rating,
          body:      body.trim() || undefined,
          tags,
          anonymous,
        });
        Alert.alert('Review submitted', 'Thank you for your review!', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    } catch (e: any) {
      const code = (e as any).code;
      if (code === 'duplicate_review') {
        Alert.alert('Already reviewed', 'You have already submitted a review for this.');
      } else if (code === 'review_not_eligible') {
        Alert.alert('Not eligible', 'You need confirmed attendance to leave a review.');
      } else {
        Alert.alert('Error', e?.message ?? 'Could not submit review. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  const displayName = entityName ?? 'this experience';
  const entityLabel =
    entityType === 'event'
      ? 'Event'
      : entityType === 'trip'
      ? 'Trip'
      : entityType === 'place'
      ? 'Place'
      : 'Booking';

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color="#11110F" />
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>
          {isEditing ? 'Edit Your Review' : 'Leave a Review'}
        </Text>
        <Text style={s.subtitle} numberOfLines={2}>
          {entityLabel}: {displayName}
        </Text>
        {isEditing && (
          <Text style={s.editNote}>
            Your previous rating and comments are pre-filled below. Make any changes and tap "Update Review".
          </Text>
        )}
      </View>

      {/* Star rating */}
      <View style={s.section}>
        <Text style={s.label}>Overall Rating *</Text>
        <StarRating value={rating} onChange={setRating} />
        {rating > 0 && (
          <Text style={s.ratingHint}>
            {['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'][rating]}
          </Text>
        )}
      </View>

      {/* Written review */}
      <View style={s.section}>
        <Text style={s.label}>Your Review (optional)</Text>
        <TextInput
          style={s.textArea}
          value={body}
          onChangeText={setBody}
          multiline
          numberOfLines={5}
          maxLength={2000}
          placeholder="Share what made this experience memorable…"
          placeholderTextColor="#9CA3AF"
          textAlignVertical="top"
        />
        <Text style={s.charCount}>{body.length}/2000</Text>
      </View>

      {/* Tags (not shown for events) */}
      {entityType !== 'event' && (
        <View style={s.section}>
          <Text style={s.label}>Tags (optional)</Text>
          <View style={s.chipRow}>
            {REVIEW_TAGS.map((tag) => (
              <TagChip
                key={tag.value}
                label={tag.label}
                selected={tags.includes(tag.value)}
                onPress={() => toggleTag(tag.value)}
              />
            ))}
          </View>
        </View>
      )}

      {/* Anonymous toggle */}
      <View style={s.section}>
        <Pressable style={s.toggleRow} onPress={() => setAnonymous((v) => !v)}>
          <View style={[s.toggle, anonymous && s.toggleOn]}>
            <View style={[s.toggleThumb, anonymous && s.toggleThumbOn]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>Post anonymously</Text>
            <Text style={s.toggleSub}>Your name won't appear on the review</Text>
          </View>
        </Pressable>
      </View>

      {/* Submit */}
      <TouchableOpacity
        style={[s.submitBtn, (saving || rating === 0) && s.submitBtnDisabled]}
        onPress={submit}
        disabled={saving || rating === 0}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={s.submitBtnText}>
            {isEditing ? 'Update Review' : 'Submit Review'}
          </Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={s.cancelBtn} onPress={() => router.back()}>
        <Text style={s.cancelBtnText}>Go back</Text>
      </TouchableOpacity>

    </ScrollView>
  );
}

const s = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FAF9F6',
  },

  container:    { flex: 1, backgroundColor: '#FAF9F6' },
  content:      { padding: 20, paddingBottom: 48 },

  header:   { marginBottom: 24 },
  title:    { fontSize: 22, fontWeight: '700', color: '#11110F', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6B7280' },
  editNote: {
    fontSize: 13,
    color: '#1D4ED8',
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    lineHeight: 18,
  },

  section:  { marginBottom: 20 },
  label:    { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 8 },

  stars:      { flexDirection: 'row', gap: 6 },
  starBtn:    { padding: 4 },
  star:       { fontSize: 36, color: '#E8E5DE' },
  starFilled: { color: '#F59E0B' },
  ratingHint: { fontSize: 13, color: '#6B7280', marginTop: 6 },

  textArea: {
    borderWidth: 1,
    borderColor: '#E8E5DE',
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    color: '#11110F',
    minHeight: 120,
    backgroundColor: '#fff',
  },
  charCount: { fontSize: 11, color: '#9CA3AF', textAlign: 'right', marginTop: 4 },

  chipRow:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:             {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E8E5DE',
    backgroundColor: '#fff',
  },
  chipSelected:     { borderColor: '#11110F', backgroundColor: '#11110F' },
  chipText:         { fontSize: 13, color: '#374151' },
  chipTextSelected: { color: '#fff', fontWeight: '600' },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggle:    {
    width: 44,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#E8E5DE',
    justifyContent: 'center',
    padding: 2,
  },
  toggleOn:      { backgroundColor: '#11110F' },
  toggleThumb:   {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 2,
  },
  toggleThumbOn:  { alignSelf: 'flex-end' },
  toggleLabel:    { fontSize: 14, color: '#11110F', fontWeight: '600' },
  toggleSub:      { fontSize: 12, color: '#6B7280', marginTop: 1 },

  submitBtn:         {
    backgroundColor: '#11110F',
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: 'center',
    marginBottom: 12,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText:     { color: '#FAF9F6', fontSize: 16, fontWeight: '700' },

  cancelBtn:     { alignItems: 'center', paddingVertical: 10 },
  cancelBtnText: { fontSize: 15, color: '#6B7280' },
});
