/**
 * postHide — the ONE writer of `post_hides`.
 *
 * WHY THIS EXISTS, AND THE MISTAKE THAT PRODUCED IT
 * =================================================
 * `post_hides` (migration 0116, `UNIQUE (user_id, post_id)`) is the per-viewer
 * hide list. It was already a complete, reachable feature before Media touched
 * it: `POST /api/posts/:postId/hide` writes it, and THREE readers honour it —
 * the following feed (`routes/posts.ts`), the global feed (`routes/posts.ts`)
 * and Pulse (`routes/pulse.ts`) — with a client service (`services/posts.ts`
 * `hidePost`) and a UI entry point on the Pulse feed card.
 *
 * What Media did was not build the missing half. It BYPASSED the working one:
 * the Media options sheet's "Not interested" and "Hide" POSTed to
 * `/api/media/:id/report`, so on Watch and Gems the gesture filed a moderation
 * report and hid nothing, while the same gesture on a Pulse card worked. A
 * divergent duplicate of a working feature, pointed at the moderation queue.
 *
 * census-media.md §9.1 first recorded this as "`post_hides` was written by
 * nothing anywhere in the tree". That was FALSE, and it was false for a stupid
 * reason worth writing down: the grep that established it ended in `head -20`
 * and the writer sorted past the cut. An absence asserted from a truncated list
 * is not a measurement. §10 of that census carries the correction.
 *
 * SO WHY A HELPER RATHER THAN A SECOND UPSERT
 * ===========================================
 * Once the media path had to write this table too, the choice was two
 * three-line upserts or one function. Two would have been defensible — same
 * table, same conflict target, same semantics — right up until one of them
 * changed. The conflict target IS the idempotency contract: get
 * `onConflict`/`ignoreDuplicates` wrong on one caller and a second tap raises a
 * unique-violation that the route turns into a 500 on a gesture whose whole
 * point is that repeating it is harmless. That is exactly the shape of drift
 * that put two different moderation deny-lists in two files (see
 * lib/mediaEligibility NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES).
 *
 * So: two ROUTES reach the hide, by choice; one WRITER, in this file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Add a post to a viewer's hide list. Idempotent: hiding the same post twice is
 * a no-op, not an error.
 *
 * Returns the PostgREST error message on failure and `null` on success, so the
 * caller decides whether a failed hide is fatal (the dedicated hide endpoint
 * says yes) or not. It never throws.
 */
export async function hidePostForViewer(
  sc: SupabaseClient,
  viewerUserId: string,
  postId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await sc
    .from("post_hides")
    .upsert(
      { user_id: viewerUserId, post_id: postId },
      { onConflict: "user_id,post_id", ignoreDuplicates: true },
    );
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
