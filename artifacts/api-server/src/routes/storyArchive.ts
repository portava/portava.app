/**
 * Story archive — recovery, and the dates the archive has to show.
 *
 *   GET  /stories/retention-policy  — the windows this deployment enforces
 *   POST /stories/:id/recover       — owner-only; undo a deletion inside its window
 *
 * ── WHY A SEPARATE FILE ──────────────────────────────────────────────────────
 * The archive's *viewing* half — `GET /stories/archive` and
 * `POST /stories/:id/repost` — is being added on the #461 branch, and
 * routes/stories.ts is under active edit on two other branches at once. These
 * two endpoints are genuinely new behaviour that exists nowhere else, so they
 * live where they cannot collide with either. `retentionDatesFor` below is
 * exported for the archive listing to call once the branches meet; it is the
 * one place the dates are computed, so the listing and this route cannot drift.
 *
 * This is not a second archive. There is no listing here.
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
  const recoverableUntil = Number.isFinite(deletedMs)
    ? new Date(deletedMs + cfg.deletedRecoveryDays * DAY_MS).toISOString()
    : null;

  let purgeAt: string | null = null;
  if (story.saved_to_highlight_id || story.state === "saved" || story.state === "removed") {
    purgeAt = null; // not this job's to purge — see the docblock
  } else if (isDeleted) {
    purgeAt = recoverableUntil;
  } else if (hasExpiry) {
    purgeAt = new Date(expiresMs + cfg.archiveRetentionDays * DAY_MS).toISOString();
  }

  return {
    audienceEndedAt,
    engagementPurgeAt,
    purgeAt,
    recoverableUntil: isDeleted ? recoverableUntil : null,
    recoverable: isDeleted && recoverableUntil !== null && Date.parse(recoverableUntil) > nowMs,
  };
}

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

  res.status(200).json({
    id: row.id,
    state: row.state,
    retention: retentionDatesFor(row, cfg),
  });
}));

export default router;
