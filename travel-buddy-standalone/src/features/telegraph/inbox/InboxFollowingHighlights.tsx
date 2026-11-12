import React, { useEffect, useMemo, useState } from 'react';
import { FollowingHighlightsStrip } from '../../../components/FollowingHighlightsStrip.tsx';
import { useFollowingHighlights } from '../../../hooks/useFollowingHighlights.ts';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import type { HighlightFeedUser } from '../../../services/highlights.ts';

function visibleFeed(users: HighlightFeedUser[], viewerId: string, excluded: ReadonlySet<string>, now: number) {
  return users.flatMap(user => {
    if (user.userId === viewerId || excluded.has(user.userId)) return [];
    const highlights = user.highlights.filter(h => !h.deletedAt && !h.archivedAt && (h.expiresAt === null || Date.parse(h.expiresAt) > now));
    return highlights.length ? [{ ...user, highlights }] : [];
  });
}
function ActiveHighlights({viewerId, excluded}: {viewerId: string; excluded: ReadonlySet<string>}) {
  const feed = useFollowingHighlights();
  const [now, setNow] = useState(Date.now);
  const users = useMemo(() => visibleFeed(feed.users, viewerId, excluded, Math.max(now, Date.now())), [feed.users, viewerId, excluded, now]);
  useEffect(() => {
    const ends = users.flatMap(user => user.highlights.flatMap(h => h.expiresAt ? [Date.parse(h.expiresAt)] : []));
    if (!ends.length) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(2_147_483_647, Math.min(...ends) - Date.now())));
    return () => clearTimeout(timer);
  }, [users]);
  return <FollowingHighlightsStrip users={users} sessionViewedIds={feed.sessionViewedIds} onMarkViewed={feed.markSessionViewed}
    unreadable={feed.unreadable} onRetry={feed.refresh} onViewerClose={feed.refresh} />;
}
export function InboxFollowingHighlights({viewerId, excluded}: {viewerId: string; excluded: ReadonlySet<string>}) {
  const activity = useMediaSurfaceActivity(() => {});
  const scope = usePrivateSurfaceKey();
  return activity.active ? <ActiveHighlights key={`${scope}:${viewerId}:${activity.epoch}`} viewerId={viewerId} excluded={excluded} /> : null;
}
