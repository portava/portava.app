import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { KeyboardSafeView } from '../../../src/components/ui/KeyboardSafeView';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useLocalSearchParams } from 'expo-router';
import {
  createReview,
  createEventReview,
  updateReview,
  getMyReview,
  REVIEW_TAGS,
  type ReviewEntityType,
} from '../../../src/services/reviews';
import {
  loadReviewDraft,
  saveReviewDraft,
  clearReviewDraft,
  isNetworkError,
} from '../../../src/services/reviewDraftStorage';
import { useSession } from '../../../src/context/SessionContext';
import { useNavBarScrollHandler } from '../../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../../src/hooks/useNavBarCollapse';
import { useMediaComposer } from '../../../src/hooks/useMediaComposer';
import { MediaPickerButton } from '../../../src/components/ui/MediaPickerButton';
import { MediaAttachmentTray } from '../../../src/components/ui/MediaAttachmentTray';

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
  const [hasDraft, setHasDraft]       = useState(false);

  // Photo attachments — only for non-event entity types (events have no photos column)
  const mediaComposer = useMediaComposer('review');

  const navBarScrollHandler = useNavBarScrollHandler();

  // Edit-mode state
  const [existingReviewId, setExistingReviewId] = useState<string | null>(null);
  const isEditing = existingReviewId !== null;

  // On mount for non-event types: check if the user already reviewed this
  // entity (edit mode) and, if not, load any saved offline draft.
  useEffect(() => {
    if (!isAuthed || !entityId || entityType === 'event') return;
    const validType = ['trip', 'rent_buddy_booking', 'place'].includes(entityType ?? '');
    if (!validType) return;

    setLoading(true);
    getMyReview(entityType as ReviewEntityType, entityId)
      .then((result) => {
        if (result.exists && result.reviewId) {
          setExistingReviewId(result.reviewId);
          // Even in edit mode, check for a draft saved after an offline
          // updateReview failure — the draft represents unsaved edits and
          // takes precedence over the server's last-saved values.
          return loadReviewDraft(AsyncStorage, entityType!, entityId).then((draft) => {
            if (draft) {
              setRating(draft.rating);
              setBody(draft.body);
              setTags(draft.tags);
              setAnonymous(draft.anonymous);
              setHasDraft(true);
            } else {
              // No draft — restore from the server's existing review.
              if (result.rating)                    setRating(result.rating);
              if (result.body)                      setBody(result.body);
              if (result.tags)                      setTags(result.tags);
              if (result.anonymous !== undefined)   setAnonymous(result.anonymous);
            }
          });
        } else {
          // Not editing an existing review — restore a saved offline draft if one exists.
          return loadReviewDraft(AsyncStorage, entityType!, entityId).then((draft) => {
            if (!draft) return;
            setRating(draft.rating);
            setBody(draft.body);
            setTags(draft.tags);
            setAnonymous(draft.anonymous);
            setHasDraft(true);
          });
        }
      })
      .catch(() => {
        // getMyReview failed (e.g. offline) — still try to restore a saved draft
        // so the user can retry from where they left off.
        return loadReviewDraft(AsyncStorage, entityType!, entityId!).then((draft) => {
          if (!draft) return;
          setRating(draft.rating);
          setBody(draft.body);
          setTags(draft.tags);
          setAnonymous(draft.anonymous);
          setHasDraft(true);
        });
      })
      .finally(() => setLoading(false));
  }, [isAuthed, entityType, entityId]);

  // On mount for events: restore any saved offline draft.
  useEffect(() => {
    if (!entityId || entityType !== 'event') return;
    loadReviewDraft(AsyncStorage, entityType, entityId).then((draft) => {
      if (!draft) return;
      setRating(draft.rating);
      setBody(draft.body);
      setTags(draft.tags);
      setAnonymous(draft.anonymous);
      setHasDraft(true);
    });
  }, [entityType, entityId]);

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
      // Upload any pending photos before submitting (non-event only).
      // Only computed when the user actually picked photos; omitted otherwise
      // so an edit that touches only rating/body/tags never clears existing photos.
      //
      // uploadAll() only processes `idle` items — it skips `done` and `error` ones.
      // We snapshot items BEFORE the upload to:
      //   1. Block immediately if any item is already in `error` (won't be retried)
      //   2. Capture already-done URLs (stable, won't change) to merge into payload
      //   3. Derive new URLs from the result map (avoids stale React state)
      let photosPayload: string[] | undefined;
      if (entityType !== 'event' && mediaComposer.items.length > 0) {
        const itemsBefore = mediaComposer.items;

        // Block if any item is already errored — uploadAll() won't retry them.
        const preExistingErrors = itemsBefore.filter((i) => i.uploadState === 'error');
        if (preExistingErrors.length > 0) {
          const n = preExistingErrors.length;
          Alert.alert(
            'Photo upload failed',
            `${n} photo${n > 1 ? 's' : ''} could not be uploaded. Remove ${n > 1 ? 'them' : 'it'} or retry before submitting.`,
          );
          setSaving(false);
          return;
        }

        // Capture already-uploaded URLs; uploadAll() won't touch done items.
        const alreadyDoneUrls = itemsBefore
          .filter((i) => i.uploadState === 'done' && i.uploadedUrl)
          .map((i) => i.uploadedUrl!);

        // Upload idle items; result map is keyed by item id.
        const uploadResults = await mediaComposer.uploadAll();

        // Gate on failures in newly uploaded items.
        const failCount = [...uploadResults.values()].filter(
          (r) => r === null || !r.ok,
        ).length;
        if (failCount > 0) {
          Alert.alert(
            'Photo upload failed',
            `${failCount} photo${failCount > 1 ? 's' : ''} could not be uploaded. Remove ${failCount > 1 ? 'them' : 'it'} or retry before submitting.`,
          );
          setSaving(false);
          return;
        }

        // Combine already-done URLs with newly uploaded ones.
        const newlyUploadedUrls = [...uploadResults.values()]
          .filter((r): r is NonNullable<typeof r> => r !== null && r.ok && r.url !== null)
          .map((r) => r.url!);

        photosPayload = [...alreadyDoneUrls, ...newlyUploadedUrls];
      }

      if (isEditing && existingReviewId) {
        await updateReview(existingReviewId, {
          rating,
          body:      body.trim() || null,
          tags,
          anonymous,
          ...(photosPayload !== undefined ? { photos: photosPayload } : {}),
        });
        clearReviewDraft(AsyncStorage, entityType!, entityId);
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
        clearReviewDraft(AsyncStorage, entityType!, entityId);
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
          ...(photosPayload !== undefined ? { photos: photosPayload } : {}),
        });
        clearReviewDraft(AsyncStorage, entityType!, entityId);
        Alert.alert('Review submitted', 'Thank you for your review!', [
          { text: 'OK', onPress: () => router.back() },
        ]);
      }
    } catch (e: any) {
      if (isNetworkError(e)) {
        saveReviewDraft(AsyncStorage, entityType!, entityId, {
          rating,
          body: body.trim(),
          tags,
          anonymous,
        });
        setHasDraft(true);
        // Stay on screen — the draft banner prompts the user to retry.
      } else {
        const code = (e as any).code;
        if (code === 'duplicate_review') {
          Alert.alert('Already reviewed', 'You have already submitted a review for this.');
        } else if (code === 'review_not_eligible') {
          Alert.alert('Not eligible', 'You need confirmed attendance to leave a review.');
        } else {
          Alert.alert('Error', e?.message ?? 'Could not submit review. Please try again.');
        }
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
    <KeyboardSafeView scrollViewProps={{ style: s.container, onScroll: navBarScrollHandler, scrollEventThrottle: 16 }} contentContainerStyle={s.content}>

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

      {/* Draft banner — shown when a draft was loaded from storage or just saved after a network error */}
      {hasDraft && (
        <View style={s.draftBanner}>
          <Text style={s.draftBannerText}>
            Saved as draft — tap Submit to retry
          </Text>
        </View>
      )}

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

      {/* Photo attachments (not shown for events) */}
      {entityType !== 'event' && (
        <View style={s.section}>
          <Text style={s.label}>Photos (optional, up to 3)</Text>
          {mediaComposer.items.length > 0 && (
            <MediaAttachmentTray composer={mediaComposer} />
          )}
          {mediaComposer.canAddMore && (
            <View style={s.photoPickerBtn}>
              <MediaPickerButton composer={mediaComposer} />
            </View>
          )}
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

      <NavBarFiller />

    </KeyboardSafeView>
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

  header:   { marginBottom: 16 },
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

  draftBanner: {
    backgroundColor: '#FEF3C7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  draftBannerText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#92400E',
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

  photoPickerBtn: { marginTop: 8 },
});
