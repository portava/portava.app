/**
 * HostReviewsSummary — the host reviews on a person's profile (About tab):
 * GET /api/users/:id/reviews, the trips and events they hosted.
 * Moved out of app/u/[username].tsx (TM-social, TRUST-F13) so it can be tested.
 *
 * A host with no reviews renders nothing, as before. A read that FAILED used
 * to render the same nothing, so an outage read as "never reviewed"; it now
 * says it could not load, with a retry (DV-83).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { getUserReviews, type Review } from '../../services/reviews.ts';
import { color, space, type as t } from '../../theme/tokens.ts';

function StarLine({ rating }: { rating: number }) {
  const full = Math.round(rating);
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Text key={s} style={{ fontSize: 11, color: s <= full ? '#F59E0B' : '#D1D5DB' }}>★</Text>
      ))}
    </View>
  );
}

export function HostReviewsSummary({ userId }: { userId: string }) {
  const [data, setData]     = useState<{ avgRating: number | null; reviewCount: number; reviews: Review[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    getUserReviews(userId, 3)
      .then((d) => { if (active) setData(d as any); })
      .catch(() => { if (active) setFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, reloadKey]);

  if (!loading && failed) {
    return (
      <View style={{ marginTop: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
        <Text style={{ ...t.small, color: color.mute }}>Couldn't load host reviews.</Text>
        <Pressable onPress={() => setReloadKey((k) => k + 1)} accessibilityRole="button" testID="host-reviews-retry" hitSlop={8}>
          <Text style={{ ...t.small, color: color.signal, fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (loading || !data || data.reviewCount === 0) return null;

  return (
    <View style={{ marginTop: space.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
        <Text style={{ ...t.bodyStrong, color: color.ink, fontSize: 14 }}>Host Reviews</Text>
        {data.avgRating !== null && (
          <>
            <StarLine rating={data.avgRating} />
            <Text style={{ ...t.small, color: color.mute }}>
              {data.avgRating.toFixed(1)} ({data.reviewCount})
            </Text>
          </>
        )}
      </View>
      {data.reviews.slice(0, 3).map((r) => (
        <View
          key={r.id}
          style={{
            backgroundColor: color.paperRaised,
            borderRadius: 10,
            padding: space.md,
            marginBottom: space.sm,
            borderWidth: 1,
            borderColor: color.haze,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 4 }}>
            <StarLine rating={r.rating} />
            {r.reviewer && (
              <Text style={{ ...t.small, color: color.mute }}>@{r.reviewer.handle ?? r.reviewer.displayName ?? 'traveler'}</Text>
            )}
          </View>
          {r.body ? (
            <Text style={{ ...t.body, color: color.ink, fontSize: 13 }} numberOfLines={3}>
              {r.body}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
