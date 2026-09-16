/**
 * THE ONE PLACE THAT NAMES THE CURRENT PRODUCTION SNAPSHOT.
 *
 * WHY THIS FILE EXISTS, stated because the alternative looks cheaper and is not.
 * `snapshots/<date>-production-schema.json` is a frozen capture, so its FILENAME
 * changes every time production is re-read. Before this module the name was
 * written out as a literal in several places — the prerequisites guard, the
 * freshness guard's mutation target, the Highlights/Memories deployed-storage
 * test — and a refresh had to find all of them.
 *
 * It did not. On 2026-09-16 the guard was repointed at the new capture and
 * `highlightsMemoriesDeployedStorage.test.ts` was left reading the 09-15 one, so
 * it compared a NEW applied-migrations list against an OLD watermark and failed
 * with "snapshot watermark 20260915083533 is behind the applied list's newest
 * entry 20260916121304". The assertion was right; the file it was reading was
 * not the one the repository had moved to.
 *
 * So the filename is a constant now, and a refresh is one edit. Anything that
 * READS the snapshot imports this. Prose that describes what a PARTICULAR
 * capture showed on a particular day should keep naming that capture — those are
 * historical statements and are not supposed to move.
 */

/** The capture every reader should grade against. Change this on a refresh. */
export const PRODUCTION_SNAPSHOT_FILENAME = "20260916-production-schema.json";

/** Resolved against this directory, which is where the captures live. */
export const PRODUCTION_SNAPSHOT_URL = new URL(
  PRODUCTION_SNAPSHOT_FILENAME,
  import.meta.url,
);
