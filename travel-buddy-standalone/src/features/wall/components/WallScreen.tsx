/**
 * WallScreen — the Wall's top-level composition (Wall spec §3/§29/§40).
 *
 * Wires the three data hooks (feed, live strip, session intent) to the
 * presentational pieces and enforces the product architecture:
 *   Header → Quick media → Live For You → Feed mode → Social feed.
 *
 * The design keeps the non-negotiables true (spec §40):
 *   1. It is a plain scrollable social feed first — WallFeed renders with no
 *      dependency on the live strip or context threads.
 *   2. Live For You is a header strip that renders nothing when empty/stale, so
 *      it is always ignorable.
 *   3. The For You / Following switch is persistent chrome, so strict
 *      chronology is always one tap away.
 *   7. Every intelligence hook fails soft, so a safe social feed always remains.
 *
 * Kept free of navigation-context and safe-area dependencies (the route passes
 * `city` and `topInset`) so it is straightforward to mount in a component test.
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { color } from '../../../theme/tokens.ts';
import { WallHeader } from './WallHeader.tsx';
import { FeedModeSwitcher } from './FeedModeSwitcher.tsx';
import { WallFeed } from './WallFeed.tsx';
import { LiveForYouStrip } from './LiveForYouStrip.tsx';
import { QuickMediaRow, type QuickMediaEntry } from './QuickMediaRow.tsx';
import { useWallFeed } from '../hooks/useWallFeed.ts';
import { useLiveForYou } from '../hooks/useLiveForYou.ts';
import { useWallSessionIntent } from '../hooks/useWallSessionIntent.ts';
import { useQuickMedia } from '../hooks/useQuickMedia.ts';
import { trackFeedOpen, trackModeSelect } from '../services/wallAnalytics.ts';
import type { ResolvedWallIntent } from '../services/wallSessionIntent.ts';
import type { StructuredIntent, WallMode } from '../types/wallProjection.ts';

function intentLabelOf(intent: StructuredIntent | null, fallback: string | null): string | null {
  if (!intent) return fallback;
  const parts = [...intent.filters.map((f) => f.label), ...intent.keywords];
  return parts.length > 0 ? parts.join(', ') : fallback;
}

export interface WallScreenProps {
  city?: string | null;
  topInset?: number;
  /** Live For You feature gate — the strip idles when false (spec §4/§34). */
  liveEnabled?: boolean;
  /**
   * Optional quick-media (stories) OVERRIDE. When omitted the row is fed by
   * useQuickMedia (GET /wall/quick-media, spec §18); empty renders nothing.
   */
  quickMedia?: QuickMediaEntry[];
}

export function WallScreen({
  city,
  topInset = 0,
  liveEnabled = true,
  quickMedia,
}: WallScreenProps) {
  const [mode, setMode] = React.useState<WallMode>('for_you');

  const intent = useWallSessionIntent();
  const feed = useWallFeed(mode, intent.intentText);
  const live = useLiveForYou({ enabled: liveEnabled });
  const quick = useQuickMedia({ enabled: quickMedia === undefined });
  const quickEntries = quickMedia ?? quick.entries;

  // Feed open (once).
  React.useEffect(() => {
    trackFeedOpen('for_you');
  }, []);

  const handleMode = React.useCallback(
    (next: WallMode) => {
      setMode((prev) => {
        if (prev === next) return prev;
        trackModeSelect(next);
        return next;
      });
    },
    [],
  );

  const handleSetIntent = React.useCallback(
    (resolved: ResolvedWallIntent) => {
      // Steer with the resolved text; a canonical entity seeds a structured
      // filter client-side so the chip is structured, not a raw string (§17).
      void intent.setIntent(resolved.text, resolved.filter);
    },
    [intent],
  );

  const header = (
    <>
      <QuickMediaRow
        entries={quickEntries}
        // Open lands in the canonical media viewer for the person's newest
        // item (the projection is never the object, spec §24); an entry with
        // no canonical post falls back to the media home.
        onOpen={(entry) =>
          router.push((entry.postId ? `/media-viewer/${entry.postId}` : '/media') as never)
        }
      />
      <LiveForYouStrip
        items={live.items}
        // §35 entry: the Wall is not a member of MapEntryPoint, so the origin is
        // stated as unknown rather than mislabelled as a tab or a deep link.
        onSeeLive={() => router.push('/map?entry=unknown' as never)}
      />
    </>
  );

  return (
    <View style={[s.root, { paddingTop: topInset }]} testID="wall-screen">
      <WallHeader
        city={city}
        intentActive={intent.active}
        intentLabel={intentLabelOf(intent.intent, intent.intentText)}
        intentPending={intent.pending}
        onSetIntent={handleSetIntent}
        onClearIntent={intent.clearIntent}
        onOpenNotifications={() => router.push('/notifications' as never)}
        onOpenTelegraph={() => router.push('/messages' as never)}
      />
      <FeedModeSwitcher mode={mode} onChange={handleMode} />
      <WallFeed
        items={feed.items}
        mode={feed.mode}
        loading={feed.loading}
        refreshing={feed.refreshing}
        loadingMore={feed.loadingMore}
        caughtUp={feed.caughtUp}
        stale={feed.stale}
        cachedAt={feed.cachedAt}
        onEndReached={feed.loadMore}
        onRefresh={feed.refresh}
        onHide={feed.hide}
        ListHeaderComponent={header}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
});
