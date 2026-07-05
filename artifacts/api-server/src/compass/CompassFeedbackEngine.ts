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
  // Phase 5 additions — task-specified feedback loop actions
  "not_now",
  "hide_this",
  "wrong_city",
  "already_went",
  "not_safe",
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
  /**
   * UUID of the content author or target user.
   * Required for `report` and `block` actions — the route uses this to trigger
   * an immediate on-demand abuse scan for the targeted user.
   */
  targetUserId?:    string;
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
  const { error } = await db
    .from("compass_user_preferences")
    .upsert(
      { user_id: userId, ...update, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(`compass_user_preferences upsert failed: ${error.message}`);
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
 * Returns { updated: true } when the preference write succeeded.
 * Returns { updated: false } when the DB is unavailable or the write fails.
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
    // ── show_more — explicit positive ranking signal for this type/category ───
    case "show_more": {
      const existing: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      const key = req.category ?? req.itemType;
      existing[key] = Math.min(10, (existing[key] ?? 0) + 2);
      update.category_weights = existing;
      break;
    }

    // ── show_less / not_my_vibe / report / block / hide_user ─────────────────
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

    // ── not_interested — item suppression + type/category penalty ────────────
    case "not_interested": {
      const itemId = (() => {
        try {
          const d = JSON.parse(Buffer.from(req.recommendationId, "base64url").toString("utf8"));
          return (d.itemId as string) ?? req.recommendationId;
        } catch {
          return req.recommendationId;
        }
      })();
      // Suppress this specific item permanently
      const ignored: string[] = (currentPrefs.ignored_item_ids as string[]) ?? [];
      if (!ignored.includes(itemId)) ignored.push(itemId);
      update.ignored_item_ids = ignored.slice(-500);
      // Apply a mild type/category penalty so fewer similar items surface
      const weights: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      const penaltyKey = req.category ?? req.itemType;
      weights[penaltyKey] = Math.max(-10, (weights[penaltyKey] ?? 0) - 1);
      update.category_weights = weights;
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

    // ── not_now — session-scoped suppression written to compass_recent_context ─
    // The item is appended to signals.session_suppressed_ids so the feed
    // builder can filter it out during the current session without permanently
    // affecting the user's long-term preferences.
    case "not_now": {
      try {
        // Decode the recommendation token to get the raw item ID — the feed
        // route filters session_suppressed_ids against item.id, so we must
        // store the entity ID (not the signed token) for the check to match.
        const notNowItemId = (() => {
          try {
            const d = JSON.parse(Buffer.from(req.recommendationId, "base64url").toString("utf8"));
            return (d.itemId as string) ?? req.recommendationId;
          } catch {
            return req.recommendationId;
          }
        })();
        const { data: ctxRow } = await db
          .from("compass_recent_context")
          .select("signals")
          .eq("user_id", userId)
          .maybeSingle();
        const sigs = ((ctxRow?.signals ?? {}) as Record<string, unknown>);
        const suppressed: string[] = (sigs.session_suppressed_ids as string[]) ?? [];
        if (!suppressed.includes(notNowItemId)) suppressed.push(notNowItemId);
        sigs.session_suppressed_ids = suppressed.slice(-100);
        await db
          .from("compass_recent_context")
          .upsert(
            {
              user_id:    userId,
              signals:    sigs,
              expires_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
            },
            { onConflict: "user_id" },
          );
      } catch { /* best-effort — non-blocking */ }
      break;
    }

    // ── hide_this — permanently suppress this specific item ───────────────────
    case "hide_this": {
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
      update.ignored_item_ids = ignored.slice(-500);
      break;
    }

    // ── wrong_city — reduce weight for the item's city ────────────────────────
    case "wrong_city": {
      const existing: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      const cityKey = `city:${req.category ?? "unknown"}`;
      existing[cityKey] = Math.max(-10, (existing[cityKey] ?? 0) - 3);
      update.category_weights = existing;
      break;
    }

    // ── already_went — treat as stronger not_interested for this item ─────────
    case "already_went": {
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
      update.ignored_item_ids = ignored.slice(-500);
      break;
    }

    // ── not_safe — increase safety preference signal ──────────────────────────
    case "not_safe": {
      const existing: Record<string, number> =
        (currentPrefs.category_weights as Record<string, number>) ?? {};
      existing["unsafe"] = Math.max(-10, (existing["unsafe"] ?? 0) - 4);
      update.category_weights = existing;
      break;
    }
  }

  // Ordered per spec: event write → prefs update → cache invalidation.
  // compass_feedback_events is the authoritative append-only audit log; it is
  // written first so the record exists even if the subsequent prefs update fails.
  await logFeedbackEvent(db, userId, req, update);

  try {
    // applyPrefsUpdate throws on DB error — we must treat this as a hard failure.
    // Feedback returning { updated: true } when the write silently failed would
    // mislead clients into thinking preferences changed when they didn't.
    await applyPrefsUpdate(db, userId, update);
  } catch {
    return { updated: false };
  }

  // Cache invalidation — await so the stale feed is purged before we return.
  // Non-fatal: allSettled so a cache-layer error doesn't fail the feedback response.
  await Promise.allSettled([invalidate(db, userId, `feedback:${req.action}`)]);

  return { updated: true, prefsChanged: update };
}
