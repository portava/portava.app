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
