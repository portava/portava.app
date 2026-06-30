/**
 * ReviewsSection — embeddable reviews panel for event/trip detail screens.
 *
 * Shows aggregate rating (stars + count) + recent reviews.
 * Shows "Write a Review" CTA if the current user hasn't reviewed yet.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import {
  getTripReviews,
  type Review,
  type ReviewsResponse,
  type ReviewEntityType,
} from '../services/reviews';

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
        <Text style={s.reviewerName}>
          {review.reviewer.displayName ?? review.reviewer.handle ?? 'Traveler'}
        </Text>
      ) : (
        <Text style={s.reviewerName}>Anonymous</Text>
      )}
      {review.body ? (
        <Text style={s.reviewBody} numberOfLines={4}>{review.body}</Text>
      ) : null}
      {review.tags.length > 0 && (
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
  const [data, setData]       = useState<ReviewsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        let resp: ReviewsResponse | null = null;
        if (entityType === 'trip') {
          resp = await getTripReviews(entityId, 1, 5);
        }
        if (active && resp) setData(resp);
      } catch {
        // silent — don't block the parent screen
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [entityType, entityId]);

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

  const reviews  = data?.reviews ?? [];
  const avg      = data?.avgRating ?? null;
  const total    = data?.total ?? reviews.length;

  return (
    <View style={s.container}>
      {/* Header row */}
      <View style={s.headerRow}>
        <Text style={s.sectionTitle}>Reviews</Text>
        {avg !== null && (
          <View style={s.avgRow}>
            <Stars rating={avg} size={13} />
            <Text style={s.avgText}>{avg.toFixed(1)} ({total})</Text>
          </View>
        )}
      </View>

      {/* Write a review CTA */}
      {canReview && (
        <TouchableOpacity style={s.writeBtn} onPress={openComposer}>
          <Text style={s.writeBtnText}>★ Write a Review</Text>
        </TouchableOpacity>
      )}

      {/* Review list */}
      {reviews.length === 0 ? (
        <Text style={s.emptyText}>
          No reviews yet.{canReview ? ' Be the first to share your experience.' : ''}
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

  writeBtn: {
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignSelf: 'flex-start',
    marginBottom: 14,
  },
  writeBtnText: { fontSize: 13, fontWeight: '600', color: '#92400E' },

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
  reviewerName: { fontSize: 12, fontWeight: '600', color: '#6B7280', marginBottom: 4 },
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
