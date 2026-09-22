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
 * An earlier version of this module returned `null` and the composer showed
 * nothing. That was wrong, and the owner said so on 2026-09-22: "Do not
 * silently omit retention information when the policy endpoint fails. Show an
 * explicit unavailable state. If no valid policy can be established, preserve
 * the draft and offer retry before accepting publication under undisclosed
 * terms."
 *
 * Both failure modes are real and they are not the same failure, so this module
 * reports which one happened rather than collapsing them into an absence:
 *
 *   { status: 'ok', policy }            the windows this deployment enforces
 *   { status: 'unavailable', reason }   no valid policy could be established
 *
 * There is deliberately no fallback to the published numbers. Printing 24/365/30
 * from a request that failed would re-introduce the hard-coding this module
 * exists to remove, and would state a retention promise on the strength of a
 * lookup that never happened. Showing the failure lets the user retry; inventing
 * an answer does not.
 *
 * A failure is NOT cached. A cached failure would turn one bad moment of
 * connectivity into a composer that refuses to publish for the rest of the
 * process's life, and the whole point of the unavailable state is that retry
 * reaches the server again.
 */
/**
 * `apiToken` is loaded lazily, the way pushTokenService.ts:52 and
 * useActiveLocation.ts:127 already do it, because a static import pulls
 * supabase.ts -> SecureStoreAdapter -> react-native into every module that
 * touches this one. Under node:test that chain is the esbuild "Unexpected
 * typeof" wall the repo keeps a KNOWN_BROKEN list for, and a module whose
 * failure states cannot be tested is the wrong module to put a publication
 * gate behind.
 *
 * `deps` is the seam the tests use. Nothing in the app passes it.
 */
export interface RetentionPolicyDeps {
  token: () => Promise<string | null>;
  fetchImpl: typeof fetch;
}

async function defaultToken(): Promise<string | null> {
  const { freshToken } = await import('./apiToken.ts');
  return freshToken();
}

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

/**
 * Why no policy could be established. The caller renders one sentence for all
 * of them, but they are kept apart because 'unauthenticated' is the one case
 * that retrying will not fix on its own, and a future screen may want to say so.
 */
export type RetentionUnavailableReason =
  | 'unauthenticated'
  | 'network'
  | 'server_error'
  | 'malformed';

export type StoryRetentionResult =
  | { status: 'ok'; policy: StoryRetentionPolicy }
  | { status: 'unavailable'; reason: RetentionUnavailableReason };

let cached: StoryRetentionPolicy | null = null;
let inflight: Promise<StoryRetentionResult> | null = null;

/** Test seam, and the way a sign-out drops another account's policy. */
export function _resetStoryRetentionPolicyCache(): void {
  cached = null;
  inflight = null;
}

/**
 * The windows this deployment enforces, or an explicit statement that they
 * could not be established.
 *
 * Successes are cached for the process: the numbers change on a deploy, not on
 * a screen, and re-fetching them per composer open would put a network round
 * trip in front of a button that must feel instant. Failures are not cached —
 * see the docblock.
 */
export async function fetchStoryRetentionPolicy(
  deps?: RetentionPolicyDeps,
): Promise<StoryRetentionResult> {
  if (cached) return { status: 'ok', policy: cached };
  if (inflight) return inflight;

  const getToken = deps?.token ?? defaultToken;
  const doFetch = deps?.fetchImpl ?? fetch;

  inflight = (async (): Promise<StoryRetentionResult> => {
    try {
      const token = await getToken();
      if (!token) return { status: 'unavailable', reason: 'unauthenticated' };

      const res = await doFetch(`${apiBase()}/api/stories/retention-policy`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return {
          status: 'unavailable',
          reason: res.status === 401 || res.status === 403 ? 'unauthenticated' : 'server_error',
        };
      }

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
        return { status: 'unavailable', reason: 'malformed' };
      }

      cached = {
        audienceWindowHours: e.audienceWindowHours,
        archiveRetentionDays: e.archiveRetentionDays,
        deletedRecoveryDays: e.deletedRecoveryDays,
        engagementRetentionDays: e.engagementRetentionDays,
      };
      return { status: 'ok', policy: cached };
    } catch {
      return { status: 'unavailable', reason: 'network' };
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

/**
 * The line shown in place of the retention copy when no policy could be read.
 *
 * It states the two things the user needs: that this is a failure rather than a
 * story with no retention, and that publishing is held until it is resolved. It
 * does not name a window, because none was established.
 */
export function retentionUnavailableLine(_reason: RetentionUnavailableReason): string {
  return "We couldn't load how long this story is kept. You can't post until we can tell you.";
}

/** The line shown when the user deletes a story. */
export function deleteRecoveryLine(p: StoryRetentionPolicy): string {
  return `You can restore this from your archive for ${days(p.deletedRecoveryDays)}, after which it is permanently deleted.`;
}

/** The line shown on an archived story, above its retention date. */
export function archiveRetentionLine(p: StoryRetentionPolicy): string {
  return `Only you can see this. It is kept for ${days(p.archiveRetentionDays)} after it expired, then permanently deleted.`;
}

/**
 * The line shown after recovering a story whose archive deadline has already
 * passed (`purgeImminent` on the recovery response).
 *
 * Recovery does not restart the archive clock — a story the owner deleted and
 * undeleted is not a newer story — so what comes back is already due. Saying
 * "Restored" and nothing else tells the owner something that stops being true
 * within the hour.
 */
export function recoveryImminentPurgeLine(): string {
  return 'Restored, but this story had already reached the end of its archive, so it will be permanently deleted shortly.';
}
