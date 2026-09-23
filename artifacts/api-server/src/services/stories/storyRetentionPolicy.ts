/**
 * Story retention policy — the published numbers, and the single place an
 * environment variable is allowed to disagree with them.
 *
 * ── WHAT THE NUMBERS ARE ─────────────────────────────────────────────────────
 * Owner decisions, 2026-09-22:
 *
 *   24 hours   a Story is visible to its audience
 *   365 days   an expired Story stays in the owner's private archive, from expires_at
 *    30 days   an owner-deleted Story stays recoverable, from deleted_at
 *    30 days   viewer lists, reactions and story replies survive, from expires_at
 *
 * These are not internal tuning knobs. They are the sentences the privacy
 * policy makes to users (`privacy-policy-draft.md`), so a deployment whose
 * behaviour differs from them is a deployment that is lying to its users.
 *
 * ── WHY AN OVERRIDE CANNOT JUST WIN ──────────────────────────────────────────
 * The decision says retention configuration must stay consistent with the
 * published policy and that an *unchecked* environment override must not
 * silently change that promise. Three shapes of failure follow from that, and
 * they need three different answers:
 *
 *   UNPARSEABLE   `STORY_ARCHIVE_RETENTION_DAYS=thirty`. The operator meant
 *                 something and got nothing. Falling back silently is how a
 *                 typo becomes a year of unintended retention.
 *   DIVERGENT     a valid number that is not the published one, with no
 *                 acknowledgement. Honouring it would make the policy text
 *                 wrong with nobody having decided that.
 *   ACKNOWLEDGED  the same, with STORY_RETENTION_POLICY_ACK set to the token
 *                 below. Somebody has said out loud that the published text is
 *                 about to be out of date. Now it is a decision, not an accident.
 *
 * The first two resolve to the PUBLISHED value and record a divergence. They do
 * not throw, because a retention job that refuses to start is a job that retains
 * everything forever — the exact outcome the whole decision exists to prevent.
 * They are loud instead: the divergence list is logged as an error on every run
 * and surfaced on the health endpoint, so "the config is being ignored" is
 * visible rather than inferred.
 *
 * This module is pure. It reads an env object passed to it, never
 * `process.env` directly, so the tests can drive every branch.
 */

/** The days the published policy promises. Tests assert these, not re-typed numbers. */
export const PUBLISHED_STORY_RETENTION = {
  /** Hours a Story is visible to its audience. Set at creation, routes/stories.ts:354. */
  audienceWindowHours: 24,
  /** Days an expired Story stays in the owner's archive, measured from expires_at. */
  archiveRetentionDays: 365,
  /** Days an owner-deleted Story stays recoverable, measured from deleted_at. */
  deletedRecoveryDays: 30,
  /** Days viewers/reactions/replies survive, measured from expires_at. */
  engagementRetentionDays: 30,
} as const;

/**
 * The literal an operator must set in STORY_RETENTION_POLICY_ACK before any
 * override is honoured. It is deliberately a sentence about consequences rather
 * than "true" or "1": the value is the acknowledgement.
 */
export const POLICY_ACK_TOKEN = "i-will-update-the-published-retention-policy";

/** The env keys this module reads, so a test cannot drift from the parser. */
export const RETENTION_ENV_KEYS = {
  archiveRetentionDays: "STORY_ARCHIVE_RETENTION_DAYS",
  deletedRecoveryDays: "STORY_DELETED_RECOVERY_DAYS",
  engagementRetentionDays: "STORY_ENGAGEMENT_RETENTION_DAYS",
} as const;

export type RetentionWindowKey = keyof typeof RETENTION_ENV_KEYS;

export type DivergenceReason =
  /** The value could not be read as a positive number of days. */
  | "unparseable"
  /** A valid number that differs from the published policy, with no acknowledgement. */
  | "override_refused_no_ack"
  /** A valid, acknowledged override. The published policy text is now stale. */
  | "override_accepted";

export interface RetentionDivergence {
  key: RetentionWindowKey;
  envKey: string;
  /** Exactly what the environment said, uninterpreted. */
  requested: string;
  /** The number the job will actually use. */
  effective: number;
  /** The number the published policy promises. */
  published: number;
  reason: DivergenceReason;
}

export interface StoryRetentionConfig {
  archiveRetentionDays: number;
  deletedRecoveryDays: number;
  engagementRetentionDays: number;
  /**
   * Empty when the running configuration matches the published policy exactly.
   * Non-empty is not a warning to be collapsed into a boolean — each entry says
   * which promise is affected and whether the divergence was authorised.
   */
  divergences: RetentionDivergence[];
}

/**
 * Days must be a positive integer. `30.5` and `-1` and `0` are all refusals
 * rather than coercions: a retention window of zero days deletes the archive on
 * the job's next pass, which nobody would mean to type.
 */
function parseDays(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve the windows this process will actually enforce.
 *
 * Never throws and never returns a window the published policy does not name
 * unless the override was acknowledged. Read `divergences` to find out whether
 * what came back is the promise or a deliberate departure from it.
 */
export function resolveStoryRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): StoryRetentionConfig {
  const acknowledged = env.STORY_RETENTION_POLICY_ACK?.trim() === POLICY_ACK_TOKEN;
  const divergences: RetentionDivergence[] = [];

  const resolveOne = (key: RetentionWindowKey): number => {
    const envKey = RETENTION_ENV_KEYS[key];
    const raw = env[envKey];
    const published = PUBLISHED_STORY_RETENTION[key];
    if (raw === undefined || raw === null || raw.trim() === "") return published;

    const parsed = parseDays(raw);
    if (parsed === null) {
      divergences.push({ key, envKey, requested: raw, effective: published, published, reason: "unparseable" });
      return published;
    }
    if (parsed === published) return published;
    if (!acknowledged) {
      divergences.push({
        key, envKey, requested: raw, effective: published, published,
        reason: "override_refused_no_ack",
      });
      return published;
    }
    divergences.push({
      key, envKey, requested: raw, effective: parsed, published,
      reason: "override_accepted",
    });
    return parsed;
  };

  return {
    archiveRetentionDays: resolveOne("archiveRetentionDays"),
    deletedRecoveryDays: resolveOne("deletedRecoveryDays"),
    engagementRetentionDays: resolveOne("engagementRetentionDays"),
    divergences,
  };
}

/**
 * True when this process is enforcing something the published policy does not
 * say. Health surfaces report the divergence list itself; this is for the one
 * place that only needs the bit.
 */
export function isPolicyDivergent(cfg: StoryRetentionConfig): boolean {
  return cfg.divergences.some((d) => d.reason === "override_accepted");
}

/** One line per divergence, for the log and for the health payload. */
export function describeDivergence(d: RetentionDivergence): string {
  switch (d.reason) {
    case "unparseable":
      return `${d.envKey}="${d.requested}" is not a positive whole number of days — ignored, enforcing the published ${d.published}`;
    case "override_refused_no_ack":
      return `${d.envKey}="${d.requested}" differs from the published ${d.published} and STORY_RETENTION_POLICY_ACK is not set to "${POLICY_ACK_TOKEN}" — ignored, enforcing ${d.published}`;
    case "override_accepted":
      return `${d.envKey}=${d.effective} is being enforced in place of the published ${d.published}; the published retention policy is now out of date and must be updated`;
  }
}


// ── The dates the archive, the recovery route and the media relay share ─────

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoryRetentionDates {
  /** When the audience stopped being able to see it. */
  audienceEndedAt: string | null;
  /** When viewers, reactions and replies are purged. */
  engagementPurgeAt: string | null;
  /** When the Story and its media are permanently purged. Null when it has no clock yet. */
  purgeAt: string | null;
  /** For a deleted Story: the last moment the owner can recover it. */
  recoverableUntil: string | null;
  /** True when the Story is in its owner-only recovery window right now. */
  recoverable: boolean;
  /**
   * True when the Story's archive deadline has already passed, so recovering it
   * restores it into the next purge pass rather than into a lasting archive.
   */
  purgeImminent: boolean;
}

/**
 * The dates the archive must show, from the row and the effective windows.
 *
 * ONE implementation, exported, because the archive listing and the recovery
 * route both have to say the same thing. A screen that shows "kept until March"
 * while the job purges in January is worse than a screen that shows nothing.
 *
 * A `saved` Story returns a null `purgeAt` rather than a computed one: its media
 * belongs to a Highlight and the retention job never queues it, so naming a
 * purge date would be a promise this system does not keep.
 */
export function retentionDatesFor(
  story: { state?: string | null; expires_at?: string | null; deleted_at?: string | null; saved_to_highlight_id?: string | null },
  cfg: { archiveRetentionDays: number; deletedRecoveryDays: number; engagementRetentionDays: number },
  nowMs: number = Date.now(),
): StoryRetentionDates {
  const expiresMs = story.expires_at ? Date.parse(story.expires_at) : NaN;
  const deletedMs = story.deleted_at ? Date.parse(story.deleted_at) : NaN;
  const hasExpiry = Number.isFinite(expiresMs);

  const audienceEndedAt = hasExpiry && expiresMs <= nowMs ? new Date(expiresMs).toISOString() : null;
  const engagementPurgeAt = hasExpiry
    ? new Date(expiresMs + cfg.engagementRetentionDays * DAY_MS).toISOString()
    : null;

  const isDeleted = story.state === "deleted";
  const archiveDeadlineMs = hasExpiry ? expiresMs + cfg.archiveRetentionDays * DAY_MS : null;

  /**
   * The recovery window closes at whichever comes FIRST: the recovery days
   * counted from `deleted_at`, or the archive deadline the Story already had.
   *
   * Deleting is a request to remove something SOONER. A window that ran past
   * the archive deadline would make deleting a way to keep a Story longer than
   * leaving it alone, and — because `deleted_at` is set afresh on each delete,
   * the 2998 trigger only refusing to move it while the row stays deleted — a
   * delete/recover/delete cycle would renew it indefinitely. The cap closes
   * that without touching the never-reset rule, which is still the database's
   * to enforce.
   *
   * The consequence is disclosed rather than hidden: a Story deleted close to
   * its archive deadline has a recovery window SHORTER than the published
   * number, and this is the value the archive shows, so the screen says the
   * real date rather than the nominal one.
   */
  const recoveryEndsMs = Number.isFinite(deletedMs)
    ? (archiveDeadlineMs === null
        ? deletedMs + cfg.deletedRecoveryDays * DAY_MS
        : Math.min(deletedMs + cfg.deletedRecoveryDays * DAY_MS, archiveDeadlineMs))
    : null;
  const recoverableUntil = recoveryEndsMs === null ? null : new Date(recoveryEndsMs).toISOString();

  let purgeAt: string | null = null;
  if (story.saved_to_highlight_id || story.state === "saved" || story.state === "removed") {
    purgeAt = null; // not this job's to purge — see the docblock
  } else if (isDeleted) {
    purgeAt = recoverableUntil;
  } else if (archiveDeadlineMs !== null) {
    purgeAt = new Date(archiveDeadlineMs).toISOString();
  }

  return {
    audienceEndedAt,
    engagementPurgeAt,
    purgeAt,
    recoverableUntil: isDeleted ? recoverableUntil : null,
    recoverable: isDeleted && recoverableUntil !== null && Date.parse(recoverableUntil) > nowMs,
    /**
     * True when recovering this Story would put it straight back into the next
     * purge pass, because its archive deadline has already passed.
     *
     * Recovery does NOT restart the archive clock — that clock runs from
     * `expires_at` and the owner deleting and undeleting a Story does not make
     * it newer. So a Story recovered after its deadline is due immediately, and
     * saying so is the difference between a considered policy and a Story that
     * silently disappears within the hour of being restored.
     */
    purgeImminent: archiveDeadlineMs !== null && archiveDeadlineMs <= nowMs,
  };
}
