/**
 * mediaEventLinks — the writer for `post_event_links` (census-media §21, MD103).
 *
 * `post_event_links` is the canonical Media → Event link (migration
 * 20260731_post_event_links: `posts.event_id` was removed and this join table
 * replaced it). It had four readers — the §15 View Event action, the §24
 * availability term, the event experience's hero media, Discovery's "Live from
 * events" — and NO writer anywhere, so every one of them returned nothing,
 * forever (`check:writerless-reads` carried it as a dead lane).
 *
 * The writer is the AUTHOR, deliberately and explicitly (the migration's own
 * word: "explicit post-to-Portava-Event linking"). Nothing is inferred: a post
 * taken near an event is not thereby "from" it.
 *
 * WHICH EVENTS A POST MAY BE LINKED TO — one predicate, `listLinkableEvents`,
 * used both to OFFER the action and to ACCEPT the write (§47: an action is
 * offered only when the target endpoint would accept it):
 *   - the post is the caller's own, and active;
 *   - the event is PUBLIC and not cancelled / archived — a link is shown to
 *     other viewers, and a private event's existence is not the author's to
 *     disclose through their post;
 *   - the caller hosts it, co-hosts it, or RSVP'd going — a participant, not a
 *     bystander attaching their post to someone else's event;
 *   - the post was made during the event or near it (LINK_WINDOW_*), so a link
 *     describes the post rather than advertising an unrelated event.
 *
 * Every read resolves `null` on error ("could not decide"), never `[]`
 * ("nothing is linkable") — the write refuses on `null` rather than guessing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

const HOUR_MS = 3_600_000;
/** A post may be linked to an event that started up to this long before it was posted … */
export const LINK_WINDOW_AFTER_END_MS = 48 * HOUR_MS;
/** … or that starts up to this long after (posted on the way there). */
export const LINK_WINDOW_BEFORE_START_MS = 24 * HOUR_MS;
/** An event with no end time is treated as lasting this long. */
export const DEFAULT_EVENT_SPAN_MS = 12 * HOUR_MS;
export const MAX_LINKABLE_EVENTS = 5;
const CLOSED_STATES = new Set(["cancelled", "archived"]);

export interface LinkableEvent {
  eventId: string;
  title: string | null;
  startsAt: string | null;
}

export interface LinkablePost {
  id: string;
  author_id: string;
  status: string | null;
  created_at: string;
}

function ms(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Pure: is the post's time inside the event's link window? */
export function withinLinkWindow(postMs: number, startMs: number | null, endMs: number | null): boolean {
  if (startMs === null) return false;
  const end = endMs ?? startMs + DEFAULT_EVENT_SPAN_MS;
  return postMs >= startMs - LINK_WINDOW_BEFORE_START_MS && postMs <= end + LINK_WINDOW_AFTER_END_MS;
}

/**
 * The events `userId` may link a post created at `postCreatedAt` to. `null`
 * when any read failed. Most recent first, capped.
 */
export async function listLinkableEvents(
  sc: SupabaseClient,
  userId: string,
  postCreatedAt: string,
): Promise<LinkableEvent[] | null> {
  const postMs = ms(postCreatedAt);
  if (postMs === null) return [];
  const db = sc as any;
  try {
    const [roles, rsvps, hosted] = await Promise.all([
      db.from("event_roles").select("event_id").eq("user_id", userId).in("role", ["host", "co_host"]).limit(200),
      db.from("event_rsvps").select("event_id").eq("user_id", userId).eq("status", "going").limit(200),
      db.from("events").select("id").eq("host_id", userId).limit(200),
    ]);
    if (roles.error || rsvps.error || hosted.error) return null;
    const ids = new Set<string>();
    for (const r of [...(roles.data ?? []), ...(rsvps.data ?? [])] as any[]) if (r?.event_id) ids.add(String(r.event_id));
    for (const r of (hosted.data ?? []) as any[]) if (r?.id) ids.add(String(r.id));
    if (ids.size === 0) return [];
    const { data: evs, error } = await db
      .from("events")
      .select("id, title, starts_at, ends_at, visibility, state")
      .in("id", [...ids])
      .eq("visibility", "public");
    if (error) return null;
    return ((evs ?? []) as any[])
      .filter((e) => e.visibility === "public" && !CLOSED_STATES.has(String(e.state ?? "")))
      .filter((e) => withinLinkWindow(postMs, ms(e.starts_at), ms(e.ends_at)))
      .sort((a, b) => (ms(b.starts_at) ?? 0) - (ms(a.starts_at) ?? 0))
      .slice(0, MAX_LINKABLE_EVENTS)
      .map((e) => ({ eventId: String(e.id), title: typeof e.title === "string" ? e.title : null, startsAt: typeof e.starts_at === "string" ? e.starts_at : null }));
  } catch {
    return null;
  }
}

export type EventLinkResult =
  | { ok: true; eventId: string }
  | { ok: false; error: "not_found" | "not_linkable" | "db_error" };

async function loadOwnActivePost(sc: SupabaseClient, userId: string, postId: string, requireActive = true): Promise<LinkablePost | null | "error"> {
  const { data, error } = await (sc as any)
    .from("posts")
    .select("id, author_id, status, created_at")
    .eq("id", postId)
    .maybeSingle();
  if (error) return "error";
  if (!data || (data as any).author_id !== userId) return null;
  if (requireActive && (data as any).status !== "active") return null;
  return data as LinkablePost;
}

/** Link the caller's own post to an event they may link it to. */
export async function linkPostToEvent(
  sc: SupabaseClient,
  userId: string,
  postId: string,
  eventId: string,
): Promise<EventLinkResult> {
  const post = await loadOwnActivePost(sc, userId, postId).catch(() => "error" as const);
  if (post === "error") return { ok: false, error: "db_error" };
  // Someone else's post and a missing post answer the same: probe-safe.
  if (!post) return { ok: false, error: "not_found" };
  const linkable = await listLinkableEvents(sc, userId, post.created_at);
  if (linkable === null) return { ok: false, error: "db_error" };
  if (!linkable.some((e) => e.eventId === eventId)) return { ok: false, error: "not_linkable" };
  const { error } = await (sc as any)
    .from("post_event_links")
    .upsert({ post_id: postId, event_id: eventId }, { onConflict: "post_id,event_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: "db_error" };
  return { ok: true, eventId };
}

/** Remove a link from the caller's own post. Idempotent. */
export async function unlinkPostFromEvent(
  sc: SupabaseClient,
  userId: string,
  postId: string,
  eventId: string,
): Promise<EventLinkResult> {
  // Unlinking is allowed on the author's own post whatever its status.
  const post = await loadOwnActivePost(sc, userId, postId, false).catch(() => "error" as const);
  if (post === "error") return { ok: false, error: "db_error" };
  if (!post) return { ok: false, error: "not_found" };
  const { error } = await (sc as any).from("post_event_links").delete().eq("post_id", postId).eq("event_id", eventId);
  if (error) return { ok: false, error: "db_error" };
  return { ok: true, eventId };
}
