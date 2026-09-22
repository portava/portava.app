/**
 * Story archive — recovery, and the dates the archive has to show.
 *
 *   GET  /stories/archive           — owner-only; the expired stories it holds
 *   GET  /stories/archive/deleted   — owner-only; deletions still recoverable
 *   GET  /stories/retention-policy  — the windows this deployment enforces
 *   POST /stories/:id/recover       — owner-only; undo a deletion inside its window
 *   POST /stories/:id/repost        — owner-only; publish an archived story again
 *
 * ── WHY A SEPARATE FILE ──────────────────────────────────────────────────────
 * This is ONE archive, and this is its file. `GET /stories/archive` and
 * `POST /stories/:id/repost` were written on the #461 branch against a
 * routes/stories.ts that has since moved a long way — that branch still carries
 * the old inline block reads, which main has replaced with fail-closed guards.
 * Porting them into routes/stories.ts would mean re-resolving that file against
 * two other branches editing it, for no gain: these endpoints share nothing
 * with the audience-facing story routes except a URL prefix, and they share
 * `retentionDatesFor` with each other, which is the thing that actually matters.
 * One implementation of the dates means the listing, the recovery route and the
 * job cannot tell the owner three different stories about the same row.
 *
 * What #461's version of routes/stories.ts also carried — save-to-highlight
 * taking `expiresInHours: null` to mean permanent — is deliberately NOT here.
 * Main has grown an explicit Highlights archive since that branch was written
 * (`POST /highlights/:id/archive` and its pair), and the owner's ruling was to
 * preserve it rather than land a second, expiry-based permanence mechanism
 * beside it.
 *
 * ── WHY RECOVERY RESTORES TO `expired`, NOT `active` ─────────────────────────
 * The decision is that an owner-deleted Story is recoverable by its OWNER for
 * 30 days. It is not that deleting and undeleting re-publishes it. A Story
 * whose 24-hour window closed weeks ago has an audience that has moved on, and
 * restoring it to `active` would put it back in their feeds — a new
 * publication nobody asked for, performed by an undo button.
 *
 * So recovery returns the Story to the archive it came from. `expires_at` is
 * untouched, which means every audience-facing predicate
 * (routes/stories.ts:497-498, :600-601, migrations/0068_stories.sql:51-53,
 * lib/mediaAccess.ts:544-549) continues to withhold it exactly as before. The
 * owner gets their Story back; the audience is not re-served anything.
 *
 * Re-publishing an archived Story is a different act with a different name, and
 * it already exists: `POST /stories/:id/repost`.
 *
 * ── WHAT RECOVERY DOES TO THE PURGE DATE ─────────────────────────────────────
 * Nothing. The archive clock runs from `expires_at`, and a Story the owner
 * deleted and then undeleted is not a newer Story, so recovery restores it to
 * the archive with the deadline it already had. Two consequences follow and
 * both are reported rather than discovered:
 *
 *   - A Story recovered AFTER `expires_at + archiveRetentionDays` is due
 *     immediately, and the response says `purgeImminent: true` instead of a
 *     bare "restored" that stops being true within the hour.
 *   - A delete/recover/delete cycle cannot hold a Story open forever. The
 *     recovery window is capped at the archive deadline (see
 *     `retentionDatesFor`), so each cycle renews a window that can only shrink
 *     toward a fixed end. The 2998 trigger's never-reset rule stays exactly as
 *     it is: it governs repeat deletes of a row that stays deleted, which is
 *     the case the owner's decision names.
 *
 * ── WHY THE CLOCK IS NOT CLEARED HERE ────────────────────────────────────────
 * `deleted_at` is managed by migration 2998's trigger, not by this handler. The
 * trigger clears it when a row leaves `state='deleted'` and refuses to move it
 * while the row stays deleted, so a repeat delete cannot extend the window no
 * matter who writes the row. This route therefore writes `state` alone: naming
 * `deleted_at` here would be a second, weaker copy of a rule the database
 * already enforces.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  resolveStoryRetentionConfig,
  PUBLISHED_STORY_RETENTION,
  describeDivergence,
} from "../services/stories/storyRetentionPolicy.js";

const router = Router();

const UUID_RE = /^[0-9a-f-]{36}$/i;
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

/**
 * Columns the archive returns. Deliberately the same list `routes/stories.ts`
 * uses for a story, so an archived story and a live one render through the same
 * client code rather than through a second, thinner shape that drifts.
 */
const ARCHIVE_COLS =
  "id, owner_id, media_url, media_type, caption, visibility, close_friends_only, trip_id, event_id, place_id, expires_at, saved_to_highlight_id, state, hide_viewer_list, created_at, deleted_at";

function clampLimit(raw: unknown): number {
  const n = Number(raw ?? 50);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 100);
}

/**
 * GET /stories/archive
 *
 * The owner's own expired stories, with the dates that say what happens to each
 * one and when.
 *
 * Owner-only by construction: it filters on `owner_id = the caller` and takes no
 * target user, so there is no parameter to point at somebody else.
 *
 * `state IN ('expired','saved')` — not 'deleted', which is the point of
 * decision 2: a deleted story leaves normal access immediately. It is still
 * recoverable, and `/stories/archive/deleted` is where the owner goes to do
 * that. Listing the two together would make "deleted" a label rather than a
 * state.
 *
 * 'active' is excluded too: a story still inside its 24 hours is up, not
 * archived, and the feed is where it belongs.
 */
router.get("/stories/archive", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("stories")
    .select(ARCHIVE_COLS)
    .eq("owner_id", user.id)
    .in("state", ["expired", "saved"])
    .order("expires_at", { ascending: false })
    .limit(clampLimit(req.query.limit));

  if (error) {
    // A failed read is not an empty archive. Rendering one as the other tells
    // the owner their stories are gone.
    req.log.error({ err: error, ownerId: user.id }, "storyArchive: archive listing failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const cfg = resolveStoryRetentionConfig();
  const nowMs = Date.now();
  res.status(200).json({
    stories: (rows ?? []).map((r: any) => ({ ...r, retention: retentionDatesFor(r, cfg, nowMs) })),
  });
}));

/**
 * GET /stories/archive/deleted
 *
 * Deletions the owner can still undo, and nothing else.
 *
 * A story whose window has closed is filtered out HERE rather than left for the
 * purge to remove. The row survives until the hourly job reaches it, so listing
 * every `state='deleted'` row would offer a Recover button that answers 410 —
 * or worse, one that works and then loses the story within the hour. What the
 * screen shows and what the recovery route will accept have to be the same set,
 * and `retentionDatesFor` is what both of them ask.
 */
router.get("/stories/archive/deleted", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: rows, error } = await sc
    .from("stories")
    .select(ARCHIVE_COLS)
    .eq("owner_id", user.id)
    .eq("state", "deleted")
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false })
    .limit(clampLimit(req.query.limit));

  if (error) {
    req.log.error({ err: error, ownerId: user.id }, "storyArchive: deleted listing failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const cfg = resolveStoryRetentionConfig();
  const nowMs = Date.now();
  const stories = (rows ?? [])
    .map((r: any) => ({ ...r, retention: retentionDatesFor(r, cfg, nowMs) }))
    .filter((r: any) => r.retention.recoverable);

  res.status(200).json({ stories });
}));

/**
 * GET /stories/retention-policy
 *
 * The windows this deployment actually enforces, alongside the ones the
 * published policy promises.
 *
 * WHY THE CLIENT READS THIS RATHER THAN HARD-CODING 24/365/30. Decision 8 asks
 * that user-facing copy explain the three windows AND that configuration stay
 * consistent with the published policy. A client that hard-codes the numbers
 * satisfies neither: it would keep saying "365 days" after an acknowledged
 * override changed the behaviour, which is the copy telling users something the
 * server is not doing.
 *
 * `published` is returned alongside `effective` so a screen can show the real
 * number and an operator can see at a glance whether the two have parted.
 */
router.get("/stories/retention-policy", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const cfg = resolveStoryRetentionConfig();
  res.status(200).json({
    effective: {
      audienceWindowHours: PUBLISHED_STORY_RETENTION.audienceWindowHours,
      archiveRetentionDays: cfg.archiveRetentionDays,
      deletedRecoveryDays: cfg.deletedRecoveryDays,
      engagementRetentionDays: cfg.engagementRetentionDays,
    },
    published: PUBLISHED_STORY_RETENTION,
    // Empty on a deployment that matches the published policy. Non-empty is not
    // a warning to swallow: it names which promise is affected.
    divergences: cfg.divergences.map((d) => ({ setting: d.envKey, reason: d.reason, note: describeDivergence(d) })),
  });
}));

/**
 * POST /stories/:id/recover
 *
 * Put an owner-deleted Story back in its owner's archive, inside the recovery
 * window and not after it.
 */
router.post("/stories/:id/recover", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // An unreadable table is not a missing Story. supabase-js RESOLVES on a
  // database error, so binding `data` alone would answer an outage with
  // "not found" — a statement about the owner's content made from a lookup
  // that never happened.
  const { data: story, error: readErr } = await sc
    .from("stories")
    .select("id, owner_id, state, expires_at, deleted_at, saved_to_highlight_id")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    req.log.error({ err: readErr, storyId: id }, "storyArchive: recover pre-read failed");
    sendError(res, "db_error", readErr.message);
    return;
  }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }

  // Ownership before anything else. A non-owner gets the same answer for a
  // Story that exists and one that does not, so this route cannot be used to
  // probe for other people's deleted Stories.
  if ((story as any).owner_id !== user.id) { sendError(res, "not_found", "Story not found"); return; }

  const state = String((story as any).state);
  if (state !== "deleted") {
    sendError(res, "invalid_payload", `Only a deleted story can be recovered; this one is '${state}'.`);
    return;
  }

  const cfg = resolveStoryRetentionConfig();
  const dates = retentionDatesFor(story as any, cfg);
  if (!dates.recoverable) {
    // The window has lapsed. The row may still be here — the purge runs hourly
    // and this request may simply have arrived first — but it is no longer the
    // owner's to recover, and answering otherwise would promise a Story that
    // disappears again within the hour.
    res.status(410).json({
      error: "recovery_window_closed",
      message: "This story's recovery window has closed and it is being permanently deleted.",
      recoverableUntil: dates.recoverableUntil,
    });
    return;
  }

  // Write `state` only. migration 2998's trigger clears `deleted_at` on the way
  // out of 'deleted' — see the docblock. `expires_at` is untouched, so the
  // audience predicates keep withholding it.
  const { data: updated, error: updErr } = await sc
    .from("stories")
    .update({ state: "expired" })
    .eq("id", id)
    .eq("owner_id", user.id)
    .eq("state", "deleted")
    .select("id, state, expires_at, deleted_at, saved_to_highlight_id");

  if (updErr) {
    req.log.error({ err: updErr, storyId: id }, "storyArchive: recover update failed");
    sendError(res, "db_error", updErr.message);
    return;
  }

  // An update matching zero rows errors NOTHING. Without this, a concurrent
  // purge or a second recover would get a cheerful 200 for a Story that was
  // never restored.
  const row = (updated as any[] | null)?.[0];
  if (!row) {
    req.log.error({ storyId: id, ownerId: user.id }, "storyArchive: recover matched zero rows — story NOT recovered");
    sendError(res, "db_error", "The story could not be recovered. Please try again.", { exposeDetail: true });
    return;
  }

  // Report the state that actually exists now, read back from the write, not
  // the state we asked for.
  if (row.deleted_at) {
    req.log.error({ storyId: id }, "storyArchive: recovered story still carries deleted_at — the 2998 trigger is not in place");
    sendError(res, "db_error", "The story could not be recovered. Please try again.", { exposeDetail: true });
    return;
  }

  const restored = retentionDatesFor(row, cfg);
  res.status(200).json({
    id: row.id,
    state: row.state,
    retention: restored,
    // Named in the response rather than left for the client to infer from two
    // dates. Recovery does not restart the archive clock — a Story the owner
    // deleted and undeleted is not a newer Story — so one recovered past its
    // archive deadline is due in the next pass. A caller that says "restored"
    // and nothing else has told the owner something that stops being true
    // within the hour.
    purgeImminent: restored.purgeImminent,
  });
}));

/**
 * POST /stories/:id/repost
 *
 * Publish an archived story again, for a fresh 24 hours.
 *
 * ── WHY THIS EXISTS BESIDE RECOVERY ──────────────────────────────────────────
 * Recovery and repost are different acts and the difference is the whole
 * design. Recovery undoes a deletion and returns the story to the archive,
 * where nobody but the owner can see it. Repost is a new publication the owner
 * asks for by name. Collapsing them would mean an undo button that re-serves a
 * weeks-old story to an audience that moved on.
 *
 * No term argument: a story's window is 24 hours, which is what a story IS.
 * Keeping something longer than that is what Highlights are for.
 *
 * The SAME row is re-activated rather than a copy inserted, so the media,
 * caption, place and view history stay attached to the story they belong to —
 * and so the archive clock, which runs from `expires_at`, restarts from the new
 * publication rather than the old one. That is correct: this is a publication,
 * not a rescue.
 *
 * 'deleted' and 'removed' are terminal here on purpose. Reposting a deleted
 * story would let the owner skip the recovery flow and re-publish in one step;
 * reposting a moderator-removed one would undo a decision that was not theirs.
 * A deleted story is recovered first, to the archive, and reposted after — two
 * deliberate acts, which is what they are.
 */
router.post("/stories/:id/repost", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid story id"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: story, error: readErr } = await sc
    .from("stories")
    .select("id, owner_id, state")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    req.log.error({ err: readErr, storyId: id }, "storyArchive: repost pre-read failed");
    sendError(res, "db_error", readErr.message);
    return;
  }
  if (!story) { sendError(res, "not_found", "Story not found"); return; }
  // Same answer for a story that exists and one that does not, so this cannot
  // be used to probe for other people's archives.
  if ((story as any).owner_id !== user.id) { sendError(res, "not_found", "Story not found"); return; }

  const state = String((story as any).state);
  if (state !== "expired" && state !== "saved") {
    sendError(res, "invalid_payload", `A story in state '${state}' cannot be reposted.`);
    return;
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: updated, error } = await sc
    .from("stories")
    .update({ state: "active", expires_at: expiresAt })
    .eq("id", id)
    .eq("owner_id", user.id)
    .in("state", ["expired", "saved"])
    .select(ARCHIVE_COLS);

  if (error) {
    req.log.error({ err: error, storyId: id }, "storyArchive: repost update failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // An update matching zero rows errors NOTHING. Without this, a story someone
  // deleted between the read and the write would be reported as reposted.
  const row = (updated as any[] | null)?.[0];
  if (!row) {
    req.log.error({ storyId: id, ownerId: user.id }, "storyArchive: repost matched zero rows — story NOT reposted");
    sendError(res, "db_error", "The story could not be reposted. Please try again.", { exposeDetail: true });
    return;
  }

  const cfg = resolveStoryRetentionConfig();
  res.status(200).json({ story: row, expiresAt, retention: retentionDatesFor(row, cfg) });
}));

export default router;
