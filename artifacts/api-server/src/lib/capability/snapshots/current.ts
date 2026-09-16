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

/**
 * REFRESH OF 2026-09-16 17:43 UTC, the FOURTH capture dated 09-16 and the current
 * one, taken after the MEDIA_CANONICAL (2470) and Sensing Option B (2315/2340/2480)
 * owner decisions were applied. The notes below are kept as written because the
 * same argument produced `d`.
 *
 * REFRESH OF 2026-09-16 15:43 UTC, then the THIRD capture dated 09-16 and the current
 * one, taken right after the port's four-migration production apply set. The
 * note below is kept as written because its argument is what produced `c` too.
 *
 * REFRESH OF 2026-09-16 15:13 UTC. There were then TWO captures dated 09-16 and the
 * `b` one is current. The 12:14 capture was NOT overwritten: it is a counted
 * subject of census-highlights-memories and §O.3 reads column anchors out of its
 * bytes, so replacing it in place would move the evidence under verdicts already
 * derived from it. A capture describes one instant; a new instant gets a new file
 * and this constant moves. That is the whole refresh.
 */
/** The capture every reader should grade against. Change this on a refresh. */
export const PRODUCTION_SNAPSHOT_FILENAME = "20260916d-production-schema.json";

/** Resolved against this directory, which is where the captures live. */
export const PRODUCTION_SNAPSHOT_URL = new URL(
  PRODUCTION_SNAPSHOT_FILENAME,
  import.meta.url,
);
