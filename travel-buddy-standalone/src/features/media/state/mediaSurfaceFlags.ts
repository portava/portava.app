/**
 * mediaSurfaceFlags — the owner's two Media surface decisions as flags, each
 * seeded to TODAY's behaviour (census-media §34).
 *
 *   F1  Does the Media tab open on the World shell — a context-first surface —
 *       instead of Watch?
 *         MEDIA_TAB_WORLD_DEFAULT_ENABLED        (migration 3340; requires
 *                                                 MEDIA_WORLD_SHELL_ENABLED, 2300)
 *   F2  Do the Watch overlay's Stamp/count rail, autoplay-on-viewability and the
 *       legacy Watch ranker stop being primary?
 *         MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED    (3341) — Compass leads the rail,
 *                                                 no Stamp/comment/save counts,
 *                                                 the place leads the left column
 *         MEDIA_WATCH_TAP_TO_PLAY_ENABLED        (3342) — nothing plays without a tap
 *         MEDIA_WATCH_STAGE24_RANKING_ENABLED    (3343) — SERVER-side; the §24 stage
 *                                                 orders the Watch feed
 *                                                 (api-server services/media/
 *                                                 WatchStage24Ranking.ts)
 *
 * FAIL-CLOSED TO TODAY. The reader handed in is FeatureFlagsContext.isEnabled,
 * which is `flags[key] === true`: an absent row, an unfetched flag set and a
 * failed fetch all read false, and `false` is today's behaviour for every flag
 * here. `TODAY` below is what every caller sees until an owner flips a row.
 *
 * WORLD DEFAULT REQUIRES THE SHELL. MEDIA_WORLD_SHELL_ENABLED is the shell's own
 * capability flag; making the shell the tab's default is a decision on top of
 * it, so `worldDefault` is false whenever the shell is off, whatever 3340 says.
 *
 * Pure (no React, no React Native) so node:test can exercise it; the hook that
 * feeds it FeatureFlagsContext is ../hooks/useMediaSurfaceDecisions.ts.
 */

/** FeatureFlagsContext.isEnabled's shape. */
export type FlagReader = (key: string) => boolean;

export interface MediaSurfaceDecisions {
  /** F1: the Media tab lists World first and opens on it. */
  worldDefault: boolean;
  /** F2: the Watch overlay leads with Compass and shows no Stamp/comment/save counts. */
  contextOverlay: boolean;
  /** F2: the Watch feed never starts a video without a tap. */
  tapToPlay: boolean;
}

/** The seeded state of every flag above: exactly what ships today. */
export const TODAY: Readonly<MediaSurfaceDecisions> = Object.freeze({
  worldDefault: false,
  contextOverlay: false,
  tapToPlay: false,
});

export function resolveMediaSurfaceDecisions(reader: FlagReader): MediaSurfaceDecisions {
  // Named `isEnabled` and called with literals on purpose: check-flag-polarity
  // reads the app tree for `isEnabled('<name>')`, and that scan is what proves
  // each of these names is seeded (R9) and read (R6).
  const isEnabled = (key: string): boolean => {
    try {
      return reader(key) === true;
    } catch {
      return false; // a reader that throws is a reader that did not say yes
    }
  };
  return {
    worldDefault: isEnabled('MEDIA_WORLD_SHELL_ENABLED') && isEnabled('MEDIA_TAB_WORLD_DEFAULT_ENABLED'),
    contextOverlay: isEnabled('MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED'),
    tapToPlay: isEnabled('MEDIA_WATCH_TAP_TO_PLAY_ENABLED'),
  };
}
