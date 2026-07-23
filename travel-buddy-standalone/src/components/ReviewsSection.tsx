/**
 * ReviewsSection — embeddable reviews panel for event/trip/booking/place detail screens.
 *
 * Event reviews use the legacy GET /api/events/:id/reviews endpoint (event_reviews table).
 * Trip reviews use GET /api/trips/:id/reviews (reviews table).
 * Place reviews use GET /api/places/:id/reviews (reviews table).
 *
 * Shows aggregate rating (stars + count) + recent reviews.
 * Shows "Write a Review" CTA if canReview=true and the user has not yet reviewed.
 * Shows "Edit your review" + "Remove" CTAs if the user already has a review on file.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  getTripReviews,
  getEventReviews,
  getPlaceReviews,
  getMyReview,
  deleteReview,
  type Review,
  type ReviewsResponse,
  type EventReviewsResponse,
  type ReviewEntityType,
} from '../services/reviews.ts';
import { useSession } from '../context/SessionContext.tsx';
import { VerifiedBadge } from './VerifiedBadge.tsx';

// ── Star display ──────────────────────────────────────────────────────────────

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Text
          key={star}
          style={{ fontSize: size, color: star <= Math.round(rating) ? '#F59E0B' : '#E8E5DE' }}
        >
          ★
        </Text>
      ))}
    </View>
  );
}

// ── Review card ───────────────────────────────────────────────────────────────

function ReviewCard({ review }: { review: Review }) {
  return (
    <View style={s.reviewCard}>
      <View style={s.reviewHeader}>
        <Stars rating={review.rating} />
        <Text style={s.reviewDate}>{new Date(review.createdAt).toLocaleDateString()}</Text>
      </View>
      {!review.anonymous && review.reviewer ? (
        <View style={s.reviewerRow}>
          <Text style={s.reviewerName}>
            {review.reviewer.displayName ?? review.reviewer.handle ?? 'Traveler'}
          </Text>
          {(review.reviewer.verificationLevel === 'id_verified' || review.reviewer.verificationLevel === 'id_selfie_verified')
            ? <VerifiedBadge level={review.reviewer.verificationLevel} size={14} />
            : null}
        </View>
      ) : (
        <Text style={s.reviewerName}>Anonymous</Text>
      )}
      {review.body ? (
        <Text style={s.reviewBody} numberOfLines={4}>{review.body}</Text>
      ) : null}
      {review.tags && review.tags.length > 0 && (
        <View style={s.tagRow}>
          {review.tags.slice(0, 4).map((tag) => (
            <View key={tag} style={s.tag}>
              <Text style={s.tagText}>{tag.replace(/_/g, ' ')}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ReviewsSectionProps {
  entityType: ReviewEntityType;
  entityId: string;
  entityName?: string;
  canReview?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReviewsSection({
  entityType,
  entityId,
  entityName,
  canReview = false,
}: ReviewsSectionProps) {
  const { isAuthed } = useSession();

  const [reviews, setReviews]         = useState<Review[]>([]);
  const [total, setTotal]             = useState(0);
  const [avgRating, setAvg]           = useState<number | null>(null);
  const [loading, setLoading]         = useState(true);
  const [alreadyReviewed, setAlready] = useState(false);
  const [myReviewId, setMyReviewId]   = useState<string | null>(null);
  const [deleting, setDeleting]       = useState(false);

  // Refetch reviews and aggregate stats every time the screen comes into focus
  // so avgRating is fresh after the user writes or edits a review and returns.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        try {
          if (entityType === 'trip') {
            const resp: ReviewsResponse = await getTripReviews(entityId, 1, 5);
            if (active) {
              setReviews(resp.reviews);
              setTotal(resp.total);
              setAvg(resp.avgRating);
            }
          } else if (entityType === 'place') {
            const resp: ReviewsResponse = await getPlaceReviews(entityId, 1, 5);
            if (active) {
              setReviews(resp.reviews);
              setTotal(resp.total);
              setAvg(resp.avgRating);
            }
          } else if (entityType === 'event') {
            const resp: EventReviewsResponse = await getEventReviews(entityId, 1, 5);
            if (active) {
              setReviews(resp.reviews);
              setTotal(resp.reviews.length);
              setAvg(
                resp.reviews.length > 0
                  ? resp.reviews.reduce((sum, r) => sum + r.rating, 0) / resp.reviews.length
                  : null,
              );
            }
          }
        } catch {
          // silent — don't block the parent screen
        } finally {
          if (active) setLoading(false);
        }
      };
      load();
      return () => { active = false; };
    }, [entityType, entityId]),
  );

  // Separately check whether the current user has already submitted a review.
  // Only runs when the review CTA would otherwise be shown, and only for non-event
  // entities (event reviews don't use the my-review endpoint).
  useEffect(() => {
    if (!canReview || !isAuthed || entityType === 'event') return;
    let active = true;
    getMyReview(entityType, entityId)
      .then((result) => {
        if (!active) return;
        setAlready(result.exists);
        setMyReviewId(result.reviewId);
      })
      .catch(() => {
        // Fail open — don't prevent writing a review if the check fails
      });
    return () => { active = false; };
  }, [canReview, isAuthed, entityType, entityId]);

  const openComposer = () => {
    router.push({
      pathname: `/review/${entityType}/${entityId}` as any,
      params: { entityName: entityName ?? '' },
    });
  };

  if (loading) {
    return (
      <View style={s.container}>
        <Text style={s.sectionTitle}>Reviews</Text>
        <ActivityIndicator color="#9CA3AF" style={{ marginTop: 12 }} />
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Header row */}
      <View style={s.headerRow}>
        <Text style={s.sectionTitle}>Reviews</Text>
        {avgRating !== null && (
          <View style={s.avgRow}>
            <Stars rating={avgRating} size={13} />
            <Text style={s.avgText}>{avgRating.toFixed(1)} ({total})</Text>
          </View>
        )}
      </View>

      {/* Review CTA */}
      {canReview && (
        alreadyReviewed ? (
          <View style={s.ctaRow}>
            <TouchableOpacity style={[s.writeBtn, s.writeBtnEditing]} onPress={openComposer}>
              <Text style={s.writeBtnTextEditing}>✎ Edit your review</Text>
            </TouchableOpacity>
            {myReviewId && (
              <TouchableOpacity
                style={s.deleteBtn}
                disabled={deleting}
                onPress={() => {
                  Alert.alert(
                    'Remove review',
                    'Are you sure you want to delete your review?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: async () => {
                          const idToDelete = myReviewId;
                          setDeleting(true);
                          try {
                            await deleteReview(idToDelete);
                            // Optimistic update: remove the review and recompute aggregate
                            // from remaining local rows (full refresh on next focus via useFocusEffect).
                            const remaining = reviews.filter((r) => r.id !== idToDelete);
                            setReviews(remaining);
                            setTotal((t) => Math.max(0, t - 1));
                            setAvg(
                              remaining.length > 0
                                ? Math.round(
                                    (remaining.reduce((s, r) => s + r.rating, 0) / remaining.length) * 10,
                                  ) / 10
                                : null,
                            );
                            setAlready(false);
                            setMyReviewId(null);
                          } catch {
                            Alert.alert('Error', 'Could not delete your review. Please try again.');
                          } finally {
                            setDeleting(false);
                          }
                        },
                      },
                    ],
                  );
                }}
              >
                <Text style={s.deleteBtnText}>{deleting ? '…' : 'Remove'}</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <TouchableOpacity style={s.writeBtn} onPress={openComposer}>
            <Text style={s.writeBtnText}>★ Write a Review</Text>
          </TouchableOpacity>
        )
      )}

      {/* Review list */}
      {reviews.length === 0 ? (
        <Text style={s.emptyText}>
          No reviews yet.{canReview && !alreadyReviewed ? ' Be the first to share your experience.' : ''}
        </Text>
      ) : (
        reviews.map((r) => <ReviewCard key={r.id} review={r} />)
      )}

      {total > 5 && (
        <Text style={s.moreText}>+ {total - 5} more reviews</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { paddingVertical: 16 },
  headerRow:    {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#11110F' },
  avgRow:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  avgText:      { fontSize: 13, color: '#6B7280' },

  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  writeBtn: {
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginBottom: 0,
  },
  writeBtnEditing: {
    borderColor: '#9CA3AF',
    backgroundColor: '#F9FAFB',
  },
  writeBtnText:        { fontSize: 13, fontWeight: '600', color: '#92400E' },
  writeBtnTextEditing: { fontSize: 13, fontWeight: '600', color: '#6B7280' },
  deleteBtn: {
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    backgroundColor: '#FEF2F2',
  },
  deleteBtnText: { fontSize: 13, fontWeight: '600', color: '#DC2626' },

  reviewCard: {
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
    paddingBottom: 4,
    marginBottom: 8,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  reviewDate:   { fontSize: 11, color: '#9CA3AF' },
  reviewerRow:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  reviewerName: { fontSize: 12, fontWeight: '600', color: '#6B7280' },
  reviewBody:   { fontSize: 13, color: '#374151', lineHeight: 18 },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  tag:    {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
  },
  tagText: { fontSize: 11, color: '#6B7280', textTransform: 'capitalize' },

  emptyText: { fontSize: 13, color: '#9CA3AF', paddingVertical: 8 },
  moreText:  { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 6 },
});
