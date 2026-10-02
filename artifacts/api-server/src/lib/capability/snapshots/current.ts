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
/**
 * REFRESH OF 2026-09-22 16:07 UTC, the current one, taken after 2971 seeded the
 * feature_flags row `layover_discovery_mode_enabled` FALSE on production. The
 * delta from the 09-21 capture is THREE objects and one flag row, and it covers
 * more than 2971: 2400 and 2966 had been applied to production at 05:42:29 that
 * morning and 2970 at some point before this capture, and none of the three was
 * recorded in production-applied-migrations.json. So the capture had to account
 * for `message_thread_members.visible_from_at` and
 * `public.telegraph_member_visibility_window` (2400/2966) and
 * `stamp_definitions.evidences_presence` (2970) as well as the flag row.
 *
 * The delta was PROVEN complete, not assumed. The tables digest did not match
 * after the message_thread_members change alone, so rather than guess at the
 * remainder the formula itself was validated first — it reproduced the 09-21
 * snapshot's own recorded digest from the 09-21 snapshot's own data, exactly —
 * which established that the formula was right and the delta was short. Table
 * NAMES were then digested and matched, ruling out any add, remove or rename,
 * and per-table COLUMN COUNTS were diffed, which named stamp_definitions as the
 * one remaining difference. All three digests then matched production's own.
 *
 * The flag is seeded OFF and this refresh does not turn it on. 2971 exists to
 * make the gate REACHABLE through the audited toggle path; enabling it narrows
 * what a traveller is shown and is an owner decision with a deployed consumer to
 * verify first.
 *
 * The 09-21 capture was NOT overwritten, for the reason the notes below give: a
 * capture describes one instant, a new instant gets a new file, and this
 * constant moves. That is the whole refresh.
 */
/**
 * REFRESH OF 2026-10-02 18:01 UTC, the current one, taken in the same change
 * that finally records 2998_story_retention in production-applied-migrations.json
 * -- applied to production 2026-09-25 07:54:12 UTC and recorded by nothing in
 * this repository for a week. Read-only; this session applied nothing.
 *
 * The delta from the 09-22 capture is SIX tables, TWO functions and ONE flag,
 * and only three of those objects are 2998's: `stories.deleted_at`, the table
 * `story_purge_queue`, `job_health.last_success_at` and the function
 * `stories_freeze_deleted_at`.
 *
 * THE REST IS SOMEBODY ELSE'S WORK AND THIS REPOSITORY HAS NO FILE FOR IT.
 * `media_assets` gained `hls_path`, `subtitle_paths` and
 * `subtitle_processing_status`; `media_upload_sessions`, `media_upload_chunks`
 * and `commit_media_upload_chunk` appeared; production's
 * supabase_migrations.schema_migrations carries `20260925140702 media_video_hls`
 * and `20260925140705 resumable_video_uploads` for them, with no ledger row and
 * no file in src/migrations/. They are NOT listed in the applied-migrations
 * record, for the reason that file gives for dead_check_vocabularies_2298 and
 * 2970 -- naming a file this repository does not have would be worse than the
 * gap. The capture records the objects regardless, because it reads production.
 *
 * ONE FLAG MOVED AND IT IS A BEHAVIOUR CHANGE, not a seeding:
 * `media_canonical_enabled` TRUE -> FALSE. public.feature_flag_audit_log holds
 * the sequence, all three rows with a NULL actor: 2026-09-25 15:37:08 metadata
 * set to a video-upload rollout block at percent 0 naming one user, 15:37:09
 * enabled false -> true, 15:39:58 enabled true -> false. The canonical media
 * write path that schemaRequirement.ts's header is about is OFF in production.
 *
 * The delta was PROVEN complete rather than assumed, by the method the notes
 * below describe: production located it with per-initial-letter digests over its
 * own catalogue (only `j`, `m` and `s` disagreed), and then recomputed all five
 * digests and all five counts, which match this file's exactly. 500 tables, 166
 * functions, 69 enums, 201 flags, 106 enabled.
 *
 * The 09-22 capture was NOT overwritten, for the reason the notes below give: a
 * capture describes one instant, a new instant gets a new file, and this
 * constant moves. That is the whole refresh.
 */
/** The capture every reader should grade against. Change this on a refresh. */
export const PRODUCTION_SNAPSHOT_FILENAME = "20261002-production-schema.json";

/** Resolved against this directory, which is where the captures live. */
export const PRODUCTION_SNAPSHOT_URL = new URL(
  PRODUCTION_SNAPSHOT_FILENAME,
  import.meta.url,
);
