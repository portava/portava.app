/**
 * Story retention policy — read from the server, never hard-coded.
 *
 * Owner decision 8, 2026-09-22: user-facing copy explains the 24-hour audience
 * window, the 365-day private archive and the 30-day deleted-story recovery
 * window, AND retention configuration stays consistent with the published
 * policy.
 *
 * A screen that hard-codes "365 days" satisfies neither half. It would keep
 * saying 365 after a deployment changed the behaviour, which is the copy
 * telling users something the server is not doing — the exact drift the
 * decision is about. So the numbers come from
 * `GET /api/stories/retention-policy`, which reports what this deployment
 * actually enforces.
 *
 * ── WHAT HAPPENS WHEN THE FETCH FAILS ────────────────────────────────────────
 * `null`, and the caller shows NOTHING. Not a fallback to the published
 * numbers, which would quietly re-introduce the hard-coding this module exists
 * to remove, and would state a retention promise on the strength of a request
 * that failed. A composer with no retention line is a small loss; a composer
 * confidently naming the wrong window is a false statement about someone's
 * photos.
 */
import { freshToken } from './apiToken.ts';

/**
 * Read from the environment here rather than importing stories.ts's copy.
 * stories.ts is under edit on two other branches; this module deliberately
 * depends on nothing that is moving.
 */
function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface StoryRetentionPolicy {
  audienceWindowHours: number;
  archiveRetentionDays: number;
  deletedRecoveryDays: number;
  engagementRetentionDays: number;
}

let cached: StoryRetentionPolicy | null = null;
let inflight: Promise<StoryRetentionPolicy | null> | null = null;

/** Test seam, and the way a sign-out drops another account's policy. */
export function _resetStoryRetentionPolicyCache(): void {
  cached = null;
  inflight = null;
}

/**
 * The windows this deployment enforces, or null when they could not be read.
 *
 * Cached for the process: the numbers change on a deploy, not on a screen, and
 * re-fetching them per composer open would put a network round trip in front
 * of a button that must feel instant.
 */
export async function fetchStoryRetentionPolicy(): Promise<StoryRetentionPolicy | null> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const token = await freshToken();
      if (!token) return null;
      const res = await fetch(`${apiBase()}/api/stories/retention-policy`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const body = await res.json();
      const e = body?.effective;
      if (
        !e ||
        typeof e.audienceWindowHours !== 'number' ||
        typeof e.archiveRetentionDays !== 'number' ||
        typeof e.deletedRecoveryDays !== 'number' ||
        typeof e.engagementRetentionDays !== 'number'
      ) {
        // A malformed body is not a policy. Returning a partial object here
        // would render "kept for undefined days".
        return null;
      }
      cached = {
        audienceWindowHours: e.audienceWindowHours,
        archiveRetentionDays: e.archiveRetentionDays,
        deletedRecoveryDays: e.deletedRecoveryDays,
        engagementRetentionDays: e.engagementRetentionDays,
      };
      return cached;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** "365 days" / "about a year" — whichever reads better at this magnitude. */
function days(n: number): string {
  if (n === 365) return 'a year';
  if (n % 365 === 0) return `${n / 365} years`;
  if (n % 30 === 0 && n >= 60) return `${n / 30} months`;
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

function hours(n: number): string {
  if (n === 24) return '24 hours';
  return `${n} ${n === 1 ? 'hour' : 'hours'}`;
}

/**
 * The composer's line. Says what the audience gets and what the owner keeps,
 * in that order, because the first is what the user is deciding about right now.
 */
export function composerRetentionLine(p: StoryRetentionPolicy): string {
  return `Visible to your audience for ${hours(p.audienceWindowHours)}, then kept in your private archive for ${days(p.archiveRetentionDays)}.`;
}

/** The line shown when the user deletes a story. */
export function deleteRecoveryLine(p: StoryRetentionPolicy): string {
  return `You can restore this from your archive for ${days(p.deletedRecoveryDays)}, after which it is permanently deleted.`;
}

/** The line shown on an archived story, above its retention date. */
export function archiveRetentionLine(p: StoryRetentionPolicy): string {
  return `Only you can see this. It is kept for ${days(p.archiveRetentionDays)} after it expired, then permanently deleted.`;
}
