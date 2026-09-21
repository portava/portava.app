/**
 * Telegraph §10 — Memory Notes and post-experience content.
 *
 * Spec:
 *   §10.1 `type MemoryNoteShare = { memoryNoteId, authorId, text?,
 *          voiceAssetId?, placeId?, occurredAt?, mediaAssetIds[],
 *          shareProjectionVersion }` and "A Memory Note is shareable,
 *          saveable and actionable WITHOUT exposing the sender's canonical
 *          private Memory graph."
 *   §10.2 "A user may explicitly save a message, voice note, place share or
 *          media item as a private Memory draft. Telegraph NEVER automatically
 *          converts whole conversations into Memories."
 *   §10.3 the end-of-night recap — "derived from confirmed session context and
 *          shared content references. It is an invitation to curate, not
 *          automatic historical truth."
 *
 * ── §10.1's PROHIBITION, MADE UNREPRESENTABLE ───────────────────────────────
 * The note a sender shares must not carry a way into their Memory graph. The
 * contract below has NO field for a memory id, a collection id or a graph
 * edge, and `assertNoMemoryGraphLeak` REFUSES a payload that smuggles one
 * under any of the obvious names. A share that cannot name a memory cannot be
 * followed back to one.
 *
 * ── §10.2's PROHIBITION, MADE UNREACHABLE ───────────────────────────────────
 * "Telegraph never AUTOMATICALLY converts whole conversations into Memories."
 * `memoryDraftRow` below builds ONE row from ONE message id; it has no list
 * form. Its only caller is POST /api/me/memory-drafts, whose body schema takes
 * `messageId` (singular) and refuses `threadId`, `messageIds`, `conversationId`
 * and `all` by name. There is no batch entry point, no thread entry point and
 * no sweep, and that route is the only thing in the Telegraph tree that writes
 * a `memories` row.
 *
 * ── §10.3's PROHIBITION, MADE EXPLICIT ──────────────────────────────────────
 * The recap is a READ. `buildRecap` returns counts and a list of things the
 * user could choose to do; it writes nothing, and its `curateActions` are
 * OFFERS. "Not automatic historical truth" means the recap must never be the
 * thing that created the Memory.
 */
import { z } from "zod";

// ── §10.1 the contract ───────────────────────────────────────────────────────

export const MEMORY_NOTE_SHARE_VERSION = "1" as const;

/** §10.1, field for field. */
export interface MemoryNoteShare {
  memoryNoteId: string;
  authorId: string;
  text?: string | null;
  voiceAssetId?: string | null;
  placeId?: string | null;
  occurredAt?: string | null;
  mediaAssetIds: string[];
  shareProjectionVersion: string;
}

export const MemoryNoteShareSchema = z.object({
  memoryNoteId: z.string().min(1).max(200),
  authorId: z.string().min(1).max(200),
  text: z.string().max(2000).nullish(),
  voiceAssetId: z.string().max(200).nullish(),
  placeId: z.string().max(200).nullish(),
  occurredAt: z.string().max(64).nullish(),
  mediaAssetIds: z.array(z.string().max(200)).max(20).default([]),
  shareProjectionVersion: z.literal(MEMORY_NOTE_SHARE_VERSION).default(MEMORY_NOTE_SHARE_VERSION),
});

/**
 * Every field name that would be a door into the sender's Memory graph.
 *
 * This list is the §10.1 prohibition in executable form. A payload carrying
 * any of these is REFUSED — not stripped, refused, because a caller that sent
 * one was trying to do something the contract does not allow and should be
 * told so rather than quietly half-served.
 */
export const MEMORY_GRAPH_FIELDS = [
  "memoryId",
  "memory_id",
  "memoryIds",
  "memory_ids",
  "memoryGraph",
  "collectionId",
  "collection_id",
  "ownerMemories",
  "memories",
] as const;

export type GraphLeakResult = { ok: true } | { ok: false; field: string };

export function assertNoMemoryGraphLeak(payload: unknown): GraphLeakResult {
  if (!payload || typeof payload !== "object") return { ok: true };
  for (const field of MEMORY_GRAPH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      return { ok: false, field };
    }
  }
  return { ok: true };
}

export type MemoryNoteParse =
  | { ok: true; note: MemoryNoteShare }
  | { ok: false; error: string };

/** Validate a Memory Note share, refusing any graph leak first. */
export function parseMemoryNoteShare(payload: unknown): MemoryNoteParse {
  const leak = assertNoMemoryGraphLeak(payload);
  if (!leak.ok) {
    return {
      ok: false,
      error:
        `A Memory Note may not carry "${leak.field}". §10.1: a note is shareable ` +
        "without exposing the sender's canonical private Memory graph.",
    };
  }
  const parsed = MemoryNoteShareSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid Memory Note" };
  }
  return { ok: true, note: { ...parsed.data, mediaAssetIds: parsed.data.mediaAssetIds ?? [] } };
}

// ── §10.2 the draft promotion ────────────────────────────────────────────────

export type DraftSource = "message" | "media" | "place_share" | "voice_note";

export interface MemoryDraftInput {
  /** EXACTLY ONE message. There is no plural form of this field, on purpose. */
  messageId: string;
  ownerId: string;
  title: string | null;
  caption: string | null;
  occurredAt: string | null;
  source: DraftSource;
}

/**
 * The row a §10.2 promotion writes.
 *
 * `state: "draft"` and `visibility: "only_me"` are both literal here rather
 * than parameters: "a PRIVATE Memory draft" is the whole of what §10.2
 * authorises, and a caller must not be able to ask for a published, visible
 * Memory as a side effect of saving a message.
 */
export function memoryDraftRow(input: MemoryDraftInput): Record<string, unknown> {
  return {
    owner_id: input.ownerId,
    title: input.title,
    caption: input.caption,
    visibility: "only_me",
    state: "draft",
    starts_at: input.occurredAt,
    allowed_user_ids: [],
    hidden_user_ids: [],
  };
}

/** A short, honest title for a draft made from a message. */
export function draftTitleFor(source: DraftSource, body: string | null): string {
  const trimmed = (body ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) return trimmed.slice(0, 60);
  switch (source) {
    case "media":
      return "Saved photo";
    case "place_share":
      return "Saved place";
    case "voice_note":
      return "Saved voice note";
    default:
      return "Saved from a conversation";
  }
}

// ── §10.3 the recap ──────────────────────────────────────────────────────────

/** §10.3's four offers, verbatim and in the mockup's order. */
export const RECAP_CURATE_ACTIONS = [
  "CREATE_MEMORY",
  "SHARE_PHOTOS",
  "FOLLOW_PEOPLE_YOU_MET",
  "DONE",
] as const;

export type RecapCurateAction = (typeof RECAP_CURATE_ACTIONS)[number];

export interface RecapCounts {
  places: number;
  people: number;
  photos: number;
  videos: number;
}

export interface SessionRecap {
  threadId: string;
  /** The plan the recap is about; null when the session is the thread's own window. */
  planId: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  counts: RecapCounts;
  /** The message ids the counts came from — a recap cites, it does not assert. */
  sourceMessageIds: string[];
  curateActions: readonly RecapCurateAction[];
  /**
   * §10.3: "an invitation to curate, not automatic historical truth". Stated in
   * the payload so a reader of the API sees it, not only a reader of this file.
   */
  invitation: true;
  /** True when the window produced nothing; the surface should not appear. */
  empty: boolean;
}

export interface RecapRow {
  id: string;
  sender_id: string;
  created_at: string;
  msg_type?: string | null;
  subtype?: string | null;
  media_type?: string | null;
  media_url?: string | null;
  body?: string | null;
  deleted_at?: string | null;
}

function within(at: string, from: string | null, to: string | null): boolean {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  if (from !== null && t < Date.parse(from)) return false;
  if (to !== null && t > Date.parse(to)) return false;
  return true;
}

/**
 * §10.3's recap, derived from CONFIRMED session context.
 *
 * "Confirmed" is doing work: the window is the plan's own start/end, not "the
 * last few hours of chat". A recap built from a sliding window would assert a
 * session that nobody agreed happened, which is exactly the "automatic
 * historical truth" §10.3 refuses.
 *
 * Deleted rows are excluded, which is §7.4 again: a photo the sender removed
 * is not part of the night.
 */
export function buildRecap(input: {
  threadId: string;
  planId: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  rows: RecapRow[];
  /** Confirmed participants of the plan — people, not senders. */
  participantIds: string[];
}): SessionRecap {
  const inWindow = input.rows.filter(
    (r) => !r.deleted_at && within(r.created_at, input.windowStartsAt, input.windowEndsAt),
  );

  let photos = 0;
  let videos = 0;
  const placeIds = new Set<string>();
  const sourceMessageIds: string[] = [];

  for (const r of inWindow) {
    let counted = false;
    if (r.media_url && r.media_type === "image") {
      photos += 1;
      counted = true;
    } else if (r.media_url && r.media_type === "video") {
      videos += 1;
      counted = true;
    }
    const kind = (r.msg_type ?? "").toLowerCase();
    if (kind === "media_album") {
      const assets = albumAssets(r.body);
      photos += assets.images;
      videos += assets.videos;
      counted = counted || assets.images + assets.videos > 0;
    }
    if (kind === "location") {
      const label = envelopeField(r.body, "label");
      if (label) {
        placeIds.add(`location:${label}`);
        counted = true;
      }
    }
    if (kind === "portava_object") {
      const sub = (r.subtype ?? "").toLowerCase();
      if (sub === "place" || sub === "hidden_gem" || sub === "map_pin" || sub === "meetup_point") {
        const id = jsonField(r.body, "objectId");
        if (id) {
          placeIds.add(`${sub}:${id}`);
          counted = true;
        }
      }
    }
    if (r.subtype === "discovery_card") {
      const id = jsonField(r.body, "sourceId");
      if (id) {
        placeIds.add(`discovery:${id}`);
        counted = true;
      }
    }
    if (counted) sourceMessageIds.push(r.id);
  }

  const counts: RecapCounts = {
    places: placeIds.size,
    // People are the plan's CONFIRMED participants, not everyone who typed.
    people: new Set(input.participantIds).size,
    photos,
    videos,
  };

  const empty = counts.places === 0 && counts.photos === 0 && counts.videos === 0;

  return {
    threadId: input.threadId,
    planId: input.planId,
    windowStartsAt: input.windowStartsAt,
    windowEndsAt: input.windowEndsAt,
    counts,
    sourceMessageIds,
    curateActions: RECAP_CURATE_ACTIONS,
    invitation: true,
    empty,
  };
}

function albumAssets(body: string | null | undefined): { images: number; videos: number } {
  try {
    const parsed = JSON.parse(String(body ?? ""));
    const assets = parsed?.payload?.assets;
    if (!Array.isArray(assets)) return { images: 0, videos: 0 };
    let images = 0;
    let videos = 0;
    for (const a of assets) {
      if (a?.mediaType === "video") videos += 1;
      else images += 1;
    }
    return { images, videos };
  } catch {
    return { images: 0, videos: 0 };
  }
}

function envelopeField(body: string | null | undefined, field: string): string | null {
  try {
    const parsed = JSON.parse(String(body ?? ""));
    const v = parsed?.payload?.[field];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function jsonField(body: string | null | undefined, field: string): string | null {
  try {
    const parsed = JSON.parse(String(body ?? ""));
    const v = parsed?.[field];
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** §10.3's headline line, e.g. "4 places · 6 people · 18 photos · 2 videos". */
export function recapHeadline(counts: RecapCounts): string {
  const parts: string[] = [];
  if (counts.places > 0) parts.push(`${counts.places} place${counts.places === 1 ? "" : "s"}`);
  if (counts.people > 0) parts.push(`${counts.people} ${counts.people === 1 ? "person" : "people"}`);
  if (counts.photos > 0) parts.push(`${counts.photos} photo${counts.photos === 1 ? "" : "s"}`);
  if (counts.videos > 0) parts.push(`${counts.videos} video${counts.videos === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
