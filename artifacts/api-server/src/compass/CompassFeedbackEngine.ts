/**
 * CompassFeedbackEngine — Phase 5 user feedback processing.
 *
 * Accepted feedback actions:
 *   show_more           — increase weight for this item type / category
 *   show_less           — decrease weight for this item type / category
 *   not_interested      — add item to ignored list (one-off)
 *   hide_category       — decrease category weight in compass_user_preferences
 *   save                — mark item as saved (no weight change)
 *   report              — record report signal (handled externally; weight −2)
 *   block               — hard block (handled externally; weight −5)
 *   too_expensive       — decrease luxury / paid category weight
 *   too_far             — decrease distance tolerance signal
 *   not_my_vibe         — decrease match score for this item type
 *   verified_users_only — increase min_trust_level preference
 *   public_meetups_only — increase preference for public events
 *   no_alcohol          — add "no_alcohol" to exclude_budget_styles
 *   no_clubs            — add "no_clubs" to exclude_budget_styles
 *   hide_user           — similar to block; removes user from feed
 *   mute_topic          — decrease weight for a topic tag
 *   mute_hashtag        — suppress a specific hashtag from feed results
 *
 * Each action:
 *   1.  Writes a raw event row to compass_feedback_events
 *   2.  Updates compass_user_preferences via upsert
 *   3.  Calls CompassCacheEngine.invalidate() to bust the caller's feed cache
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { invalidate } from "./CompassCacheEngine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export const FEEDBACK_ACTIONS = [
  "show_more",
  "show_less",
  "not_interested",
  "hide_category",
  "save",
  "report",
  "block",
  "too_expensive",
  "too_far",
  "not_my_vibe",
  "verified_users_only",
  "public_meetups_only",
  "no_alcohol",
  "no_clubs",
  "hide_user",
  "mute_topic",
  "mute_hashtag",
] as const;

export type FeedbackAction = typeof FEEDBACK_ACTIONS[number];

export interface FeedbackRequest {
  recommendationId: string;
  action:           FeedbackAction;
  itemType:         string;
  /** Category tag (e.g. "nightlife", "food") — required for hide_category */
  category?:        string;
  /** Hashtag slug — required for mute_hashtag */
  hashtag?:         string;
  /** Topic slug — required for mute_topic */
  topic?:           string;
}

export interface FeedbackResult {
  updated:       boolean;
  prefsChanged?: Partial<PrefsUpdate>;
}

// ── Preference weight deltas ──────────────────────────────────────────────────

interface PrefsUpdate {
  category_weights?:       Record<string, number>;
  min_trust_level?:        string;
  public_meetups_only?:    boolean;
  exclude_budget_styles?:  string[];
  muted_hashtags?:         string[];
  muted_topics?:           string[];
  ignored_item_ids?:       string[];
}

const ACTION_WEIGHT_DELTA: Partial<Record<FeedbackAction, number>> = {
  show_more:    +2,
  show_less:    -2,
  hide_category: -4,
  not_my_vibe:  -3,
  report:       -6,
  block:        -8,
  hide_user:    -5,
};

// ── Preference loader ─────────────────────────────────────────────────────────

async function loadPrefs(db: SupabaseClient, userId: string): Promise<any> {
  try {
    const { data } = await db
      .from("compass_user_preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    return (data as any) ?? {};
  } catch {
    return {};
  }
}

// ── Core preference updater ───────────────────────────────────────────────────

async function applyPrefsUpdate(
  db:      SupabaseClient,
  userId:  string,
  update:  PrefsUpdate,
): Promise<void> {
  if (Object.keys(update).length === 0) return;
  try {
    await db
      .from("compass_user_preferences")
      .upsert(
        { user_id: userId, ...update, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
  } catch { /* non-fatal */ }
}

// ── Event logger ──────────────────────────────────────────────────────────────

async function logFeedbackEvent(
  db:               SupabaseClient,
  userId:           string,
  req:              FeedbackRequest,
  prefsChanged:     Partial<PrefsUpdate>,
): Promise<void> {
  try {
    const itemId = (() => {
      try {
        const decoded = JSON.parse(
          Buffer.from(req.recommendationId, "base64url").toString("utf8"),
        );
        return (decoded.itemId as string) ?? req.recommendationId;
      } catch {
        return req.recommendationId;
      }
    })();

    await db.from("compass_feedback_events").insert({
      user_id:           userId,
      recommendation_id: req.recommendationId,
      item_id:           itemId,
      item_type:         req.itemType,
      action:            req.action,
      metadata:          { ...prefsChanged, category: req.category ?? null },
    });
  } catch { /* non-fatal */ }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Process a user feedback action on a Compass recommendation.
 *
 * Always returns { updated: true } unless the DB is unavailable.
 */
export async function processFeedback(
  db:     SupabaseClient | null,
  userId: string,
  req:    FeedbackRequest,
): Promise<FeedbackResult> {
  if (!db) return { updated: false };

  const currentPrefs = await loadPrefs(db, userId);
  const update: PrefsUpdate = {};

  switch (req.action) {
    // ── show_more / show_less / not_my_vibe / report / block / hide_user ──────
    case "show_more":
    case "show_less":
    case "not_my_vibe":
    case "report":
    case "block":
    case "hide_user": {
      const delta = ACTION_WEIGHT_DELTA[req.action] ?? 0;
      if (delta !== 0) {
        const existing: Record<string, number> =
          (currentPrefs.category_weights as Record<string, number>) ?? {};
        const key = req.category ?? req.itemType;
        existing[key] = Math.max(-10, Math.min(10, (existing[key] ?? 0) + delta));
        update.category_weights = existing;
      }
      break;
    }

    // ── hide_category ─────────────────────────────────────────────────────────
    case "hide_category": {
      const cat = req.category ?? req.itemType;
      const existing: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      existing[cat] = Math.max(-10, (existing[cat] ?? 0) - 4);
      update.category_weights = existing;
      break;
    }

    // ── not_interested — add to ignored list ──────────────────────────────────
    case "not_interested": {
      const itemId = (() => {
        try {
          const d = JSON.parse(Buffer.from(req.recommendationId, "base64url").toString("utf8"));
          return (d.itemId as string) ?? req.recommendationId;
        } catch {
          return req.recommendationId;
        }
      })();
      const ignored: string[] = (currentPrefs.ignored_item_ids as string[]) ?? [];
      if (!ignored.includes(itemId)) ignored.push(itemId);
      update.ignored_item_ids = ignored.slice(-500); // cap at 500
      break;
    }

    // ── save — no preference change, just log the event ───────────────────────
    case "save":
      break;

    // ── too_expensive — reduce luxury/paid weight ─────────────────────────────
    case "too_expensive": {
      const existing: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      existing["luxury"]   = Math.max(-10, (existing["luxury"]   ?? 0) - 2);
      existing["paid"]     = Math.max(-10, (existing["paid"]     ?? 0) - 2);
      update.category_weights = existing;
      break;
    }

    // ── too_far — reduce distance-heavy categories ────────────────────────────
    case "too_far": {
      const existing: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      existing["far_away"] = Math.max(-10, (existing["far_away"] ?? 0) - 3);
      update.category_weights = existing;
      break;
    }

    // ── verified_users_only ───────────────────────────────────────────────────
    case "verified_users_only":
      update.min_trust_level = "building_trust";
      break;

    // ── public_meetups_only ───────────────────────────────────────────────────
    case "public_meetups_only":
      update.public_meetups_only = true;
      break;

    // ── no_alcohol / no_clubs ─────────────────────────────────────────────────
    case "no_alcohol":
    case "no_clubs": {
      const tag = req.action === "no_alcohol" ? "alcohol" : "clubs";
      const existing: string[] = (currentPrefs.exclude_budget_styles as string[]) ?? [];
      if (!existing.includes(tag)) existing.push(tag);
      update.exclude_budget_styles = existing;
      break;
    }

    // ── mute_hashtag ──────────────────────────────────────────────────────────
    case "mute_hashtag": {
      const slug = req.hashtag ?? "";
      if (slug) {
        const existing: string[] = (currentPrefs.muted_hashtags as string[]) ?? [];
        if (!existing.includes(slug)) existing.push(slug);
        update.muted_hashtags = existing.slice(-200);
      }
      break;
    }

    // ── mute_topic ────────────────────────────────────────────────────────────
    case "mute_topic": {
      const slug = req.topic ?? "";
      if (slug) {
        const existing: string[] = (currentPrefs.muted_topics as string[]) ?? [];
        if (!existing.includes(slug)) existing.push(slug);
        update.muted_topics = existing.slice(-200);
      }
      break;
    }
  }

  await Promise.allSettled([
    applyPrefsUpdate(db, userId, update),
    logFeedbackEvent(db, userId, req, update),
  ]);

  // Invalidate cache so the next feed build reflects the new preferences
  await invalidate(db, userId, `feedback:${req.action}`);

  return { updated: true, prefsChanged: update };
}
