/**
 * storyHighlightVisibility — the ONLY place a Story's audience is translated
 * into a Highlight's audience, for POST /stories/:id/save-to-highlight.
 *
 * THE DEFECT THIS CLOSES
 * ======================
 * routes/stories.ts hard-coded `visibility: "public"` on the Highlight it
 * created from a Story, whatever the Story's own visibility was. A
 * close-friends Story became a PUBLIC Highlight. The two vocabularies do not
 * line up:
 *
 *   story_visibility   public | friends_only | close_friends | trip_crew | circle_only | custom
 *   highlights         public | travelers_nearby | circle_only | trip_only | private
 *
 * FAITHFUL means: every viewer the Highlight admits is a viewer the Story
 * admitted, judged by the code that actually enforces each side today —
 * `checkStoryAccess` / the story feed filter in routes/stories.ts, and
 * `resolveViewAccess` / the profile and feed filters in routes/highlights.ts.
 * Measured against those, only TWO rungs translate without widening:
 *
 *   public      → public       identical: any authenticated, unblocked user.
 *   circle_only → circle_only  identical predicate on both sides:
 *                              circle_memberships(user_id = owner, other_id = viewer).
 *
 * The rest have NO faithful target and are REFUSED — the Story is left exactly
 * as it was and the caller gets a reason it can render:
 *
 *   close_friends   Highlights have no close-friends audience.
 *   friends_only    (mutual follow) — no Highlight equivalent.
 *   custom          (allow/hide lists) — Highlights carry no ACL columns.
 *   trip_crew       LOOKS mappable to `trip_only` and is NOT. A trip_crew Story
 *                   admits the accepted members of THAT ONE trip
 *                   (`stories.trip_id`). A trip_only Highlight admits anyone
 *                   who shares ANY trip with the owner — `highlights` has no
 *                   trip_id column, and every highlight read path resolves
 *                   `sharesTrip` across all of the viewer's trips. Promoting
 *                   would widen the audience from one crew to every crew the
 *                   owner has ever had.
 *
 * Two row-level conditions refuse independently of the visibility string:
 *
 *   close_friends_only = true   The legacy boolean. checkStoryAccess treats it
 *                               as close_friends whatever `visibility` says, so
 *                               the promotion must too.
 *   hidden_user_ids non-empty   The owner named people this Story must not
 *                               reach. A Highlight cannot honour a hide list.
 *                               This is deliberately STRICTER than the Story's
 *                               own enforcement (which consults the list only
 *                               under `custom`): the owner's stated intent is
 *                               on the row, and a promotion that discards it
 *                               is not faithful. The owner may relax this.
 *
 * FAIL CLOSED. An unrecognised or null visibility is refused, never defaulted
 * to public. PURE: no DB access, decidable from the row.
 *
 * This module does not decide what SHOULD happen to the refused rungs — that
 * is the owner's call (add matching Highlight audiences, restrict promotion to
 * the faithful rungs, or snapshot an explicit viewer ACL onto the Highlight).
 * It makes sure the wrong thing cannot happen while that is decided.
 */
import type { HighlightVisibility } from "./highlightPermissions.js";

export const STORY_VISIBILITIES = [
  "public",
  "friends_only",
  "close_friends",
  "trip_crew",
  "circle_only",
  "custom",
] as const;
export type StoryVisibility = (typeof STORY_VISIBILITIES)[number];

/**
 * The faithful translations, and nothing else. A `null` here is a documented
 * "no equivalent", so a reader can see every rung was considered.
 */
export const STORY_TO_HIGHLIGHT_VISIBILITY: Readonly<Record<StoryVisibility, HighlightVisibility | null>> = {
  public: "public",
  circle_only: "circle_only",
  friends_only: null,
  close_friends: null,
  trip_crew: null,
  custom: null,
};

/** Story visibilities a Highlight can faithfully represent today. */
export const PROMOTABLE_STORY_VISIBILITIES: readonly StoryVisibility[] = (
  Object.keys(STORY_TO_HIGHLIGHT_VISIBILITY) as StoryVisibility[]
).filter((v) => STORY_TO_HIGHLIGHT_VISIBILITY[v] != null);

export type PromotionRefusalReason =
  | "close_friends_audience"
  | "mutual_follow_audience"
  | "trip_crew_audience"
  | "custom_audience"
  | "hidden_list_unsupported"
  | "unknown_visibility";

export interface StoryAudienceRow {
  visibility?: unknown;
  close_friends_only?: unknown;
  hidden_user_ids?: unknown;
  allowed_user_ids?: unknown;
  trip_id?: unknown;
}

export type HighlightPromotionDecision =
  | { ok: true; visibility: HighlightVisibility; storyVisibility: StoryVisibility }
  | {
      ok: false;
      state: "not_promotable";
      reason: PromotionRefusalReason;
      storyVisibility: string | null;
      /** A sentence the UI may show verbatim. Names no other user. */
      message: string;
    };

const REFUSAL_MESSAGE: Record<PromotionRefusalReason, string> = {
  close_friends_audience:
    "This story is for close friends only. Highlights can't be limited to close friends yet, so it can't be saved as a highlight.",
  mutual_follow_audience:
    "This story is for friends only. Highlights can't be limited to friends yet, so it can't be saved as a highlight.",
  trip_crew_audience:
    "This story is for one trip's crew. Highlights can't be limited to a single trip yet, so it can't be saved as a highlight.",
  custom_audience:
    "This story has a custom audience. Highlights can't carry a custom audience yet, so it can't be saved as a highlight.",
  hidden_list_unsupported:
    "This story is hidden from some people. Highlights can't hide from specific people yet, so it can't be saved as a highlight.",
  unknown_visibility:
    "This story's audience couldn't be determined, so it can't be saved as a highlight.",
};

function nonEmptyList(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

/**
 * Decide the Highlight visibility for a Story, or refuse.
 *
 * Order of checks matters and is deliberate: the legacy boolean is checked
 * before the string because that is the order `checkStoryAccess` gives them
 * (a `public` row with close_friends_only=true is served to close friends
 * only); the hide list is checked last so the reason names the most specific
 * obstacle first.
 */
export function resolveHighlightVisibilityForStory(story: StoryAudienceRow | null | undefined): HighlightPromotionDecision {
  const rawVis = story?.visibility;
  const storyVisibility: string | null = typeof rawVis === "string" ? rawVis : null;

  const refuse = (reason: PromotionRefusalReason): HighlightPromotionDecision => ({
    ok: false,
    state: "not_promotable",
    reason,
    storyVisibility,
    message: REFUSAL_MESSAGE[reason],
  });

  if (!story) return refuse("unknown_visibility");
  if (story.close_friends_only === true) return refuse("close_friends_audience");

  if (storyVisibility == null || !(STORY_VISIBILITIES as readonly string[]).includes(storyVisibility)) {
    return refuse("unknown_visibility");
  }
  const vis = storyVisibility as StoryVisibility;

  switch (vis) {
    case "close_friends": return refuse("close_friends_audience");
    case "friends_only":  return refuse("mutual_follow_audience");
    case "trip_crew":     return refuse("trip_crew_audience");
    case "custom":        return refuse("custom_audience");
    case "public":
    case "circle_only":
      break;
  }

  if (nonEmptyList(story.hidden_user_ids)) return refuse("hidden_list_unsupported");

  const target = STORY_TO_HIGHLIGHT_VISIBILITY[vis];
  // Unreachable by construction (both remaining rungs map), kept so a future
  // edit to the table cannot fall through to a fabricated value.
  if (target == null) return refuse("unknown_visibility");
  return { ok: true, visibility: target, storyVisibility: vis };
}
