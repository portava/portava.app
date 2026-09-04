/**
 * DiscoveryEventPostsRail — "Live from events" strip for the For You feed.
 *
 * This is the client caller for GET /api/discovery/feed (serve point 7). The
 * feed endpoint is the unified feed that merges places with the viewer's
 * "Live from events" posts; those posts had a ready-made card
 * (DiscoveryEventPostCard) but no surface rendered them and nothing called the
 * endpoint, so serve point 7 recorded no rank_events rows (see
 * docs/discovery/serve-point-report-20260828.md §"Serve point 7 has no
 * caller").
 *
 * This rail fetches ONLY the posts side (includePlaces=false) so the For You
 * places baseline — which comes from GET /discovery and still applies sort /
 * context filters the feed endpoint does not — is left untouched, and the
 * serve-point-7 impressions the server writes describe exactly what is shown.
 *
 * Outcome reporting: the feed returns a per-load `sessionId` (the served rank
 * context). Opening a post reports a 'discovery' tap outcome threaded with that
 * sessionId, so POST /rank-events/outcome upgrades the exact serve-point-7
 * impression this load wrote rather than the most-recent 'discovery' impression
 * across all serve points.
 *
 * Renders nothing when there are no posts (unauthenticated, or none nearby) —
 * absence of posts is not an error, so no skeleton and no empty state.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Radio } from 'lucide-react-native';
import { getDiscoveryFeed } from '../../services/discovery.ts';
import type { DiscoveryEventPost } from '../../types/discovery.ts';
import { DiscoveryEventPostCard } from './DiscoveryEventPostCard.tsx';
import { useRankOutcome } from '../../hooks/useRankOutcome.ts';
import { color, space, type as t } from '../../theme/tokens.ts';

interface Props {
  destination: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number;
}

export function DiscoveryEventPostsRail({ destination, lat, lng, radiusKm = 25 }: Props) {
  const [posts, setPosts] = useState<DiscoveryEventPost[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Feed posts are served under rank_events surface 'discovery' (serve point 7),
  // keyed to the returned sessionId — that pair is the served rank context.
  const { reportTap } = useRankOutcome({ surface: 'discovery', sessionId });

  // Monotonic guard so a slow response for a previous destination can't clobber
  // a newer one.
  const loadIdRef = useRef(0);

  useEffect(() => {
    if (!destination && (lat == null || lng == null)) {
      setPosts([]);
      setSessionId(null);
      return;
    }
    const myId = ++loadIdRef.current;
    let cancelled = false;
    getDiscoveryFeed({ destination, lat, lng, radiusKm, includePlaces: false, limit: 15 })
      .then((res) => {
        if (cancelled || loadIdRef.current !== myId) return;
        if (res.ok) {
          setPosts(res.data.posts);
          setSessionId(res.data.sessionId);
        } else {
          setPosts([]);
          setSessionId(null);
        }
      })
      .catch(() => {
        if (!cancelled && loadIdRef.current === myId) { setPosts([]); setSessionId(null); }
      });
    return () => { cancelled = true; };
  }, [destination, lat, lng, radiusKm]);

  if (posts.length === 0) return null;

  return (
    <View style={styles.section} testID="discovery-event-posts-rail">
      <View style={styles.header}>
        <Radio size={14} color={color.signal} />
        <Text style={styles.title}>Live from events</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rail}
      >
        {posts.map((post) => (
          <DiscoveryEventPostCard
            key={post.id}
            post={post}
            onOpen={() => reportTap(post.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
  },
  rail: {
    paddingHorizontal: space.lg,
    paddingRight: space.md,
  },
});

export default DiscoveryEventPostsRail;
