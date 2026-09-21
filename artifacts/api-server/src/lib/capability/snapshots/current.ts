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
 * REFRESH OF 2026-09-20 20:03 UTC, the current one, taken after the five
 * migrations applied to production that day: 2996 and 2997 (the Compass
 * conversation/lineage columns), 2800 and 2840 (two flag rows seeded FALSE that
 * were previously ABSENT) and 2910 (the six Discovery Trails tables). Built as a
 * proven DELTA on 20260917 by the same argument as that capture -- production
 * located the delta itself with per-initial-letter digests over its own
 * catalogue, only the `c` and `t` buckets disagreed, and it then recomputed all
 * three checksums and returned exactly the three the new file records. 493
 * tables, 160 functions, 69 enums, 198 flags. The notes below are kept as
 * written because the same argument produced every capture before it.
 *
 * REFRESH OF 2026-09-17 04:17 UTC, then the current one, taken after the 37-migration
 * Trips chain landed on production (2450/2500/2590 and 2750-2796). This capture
 * was built as a proven DELTA rather than a full re-read -- 22 new tables, 8
 * changed, 0 removed, 16 new functions, 3 new flags -- and production then
 * recomputed all three digests over its own catalogue and returned exactly the
 * three this file records. A delta that missed anything could not produce the
 * same digest, so the shortcut is proven rather than trusted. The notes below
 * are kept as written because the same argument produced every capture before it.
 *
 * REFRESH OF 2026-09-16 17:43 UTC, then the FOURTH capture dated 09-16 and the current
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
/**
 * REFRESH OF 2026-09-21 07:55 UTC, taken right after 2963 and 2964 were applied
 * to production. Two objects moved and no others: the table
 * `map_telemetry_disabled_discards` and the function
 * `record_map_telemetry_disabled_discard`. 2963 replaces a function BODY, which
 * this file records nothing about — a capture of names cannot see a body, and
 * pretending otherwise is how a snapshot starts being believed for things it
 * never measured.
 *
 * The 09-20 capture was NOT overwritten, for the same reason the 09-16 note
 * below gives: a capture describes one instant, a new instant gets a new file,
 * and this constant moves. That is the whole refresh.
 */
/** The capture every reader should grade against. Change this on a refresh. */
export const PRODUCTION_SNAPSHOT_FILENAME = "20260921-production-schema.json";

/** Resolved against this directory, which is where the captures live. */
export const PRODUCTION_SNAPSHOT_URL = new URL(
  PRODUCTION_SNAPSHOT_FILENAME,
  import.meta.url,
);
