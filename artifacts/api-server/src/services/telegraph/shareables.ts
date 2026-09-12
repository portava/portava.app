/**
 * Telegraph §5 — the one share contract, and §5.3's revocation.
 *
 * Spec:
 *   §5    "All eligible Portava content should be shareable into Telegraph
 *          through one consistent share contract", over five object families
 *          (Social / Travel / Places / Services / Media).
 *   §5.1  interface TelegraphShareable {
 *            getSharePreview(viewerId): Promise<TelegraphShareProjection>
 *            getCurrentState(viewerId): Promise<TelegraphObjectState>
 *            getAvailableActions(viewerId, conversationId): Promise<TelegraphAction[]>
 *            getDeepLink(): string
 *          }
 *   §5.2  the four-layer model: message content / source object / SHARE
 *          PROJECTION (what the recipient is CURRENTLY authorized to see) /
 *          derived enrichment.
 *   §5.3  "If the source becomes deleted, private or unauthorized, the
 *          Telegraph reference must degrade to an unavailable state. Telegraph
 *          is never a backdoor into revoked source content."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * Shared cards were FROZEN SNAPSHOTS. `components/DiscoveryCardMessage.tsx`
 * parses the JSON the sender serialised at send time and renders it, with no
 * refetch and no authorization call; `components/PostCardMessage.tsx` has no
 * fetch at all. A place made private, or a post deleted, after sharing still
 * rendered in full inside the thread forever — §5.3 violated, not merely
 * absent (census T46 / T359).
 *
 * The layer that was missing is §5.2's THIRD one. A share projection is not
 * what the sender saw; it is what THIS viewer is authorized to see, NOW. So it
 * is computed per (viewer, object) on every read, and the answer is allowed to
 * be "unavailable".
 *
 * ── FAIL CLOSED, ALWAYS ─────────────────────────────────────────────────────
 * supabase-js resolves on a database error rather than throwing, so an
 * unchecked read turns "we could not tell" into "no such row" — and on this
 * path the permissive reading is the dangerous one. Every read below binds and
 * reads `error`, and an unreadable source resolves to `unavailable` with
 * reason `unknown`. A viewer seeing "unavailable" for a moment is a worse UI
 * and a correct one; the alternative is a backdoor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type TelegraphAction,
  type TelegraphObjectType,
  isTelegraphObjectType,
} from "./vocabulary.js";

// ── §5.1 contract ────────────────────────────────────────────────────────────

/** What the recipient is currently allowed to SEE. Never the raw source row. */
export interface TelegraphShareProjection {
  objectType: TelegraphObjectType;
  objectId: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  /**
   * §5.2 — the projection is versioned, so a client can tell a re-resolution
   * apart from the snapshot it replaced. It is the source's own updated_at
   * where the source has one.
   */
  projectionVersion: string | null;
  deepLink: string;
}

export type UnavailableReason = "deleted" | "private" | "unauthorized" | "not_found" | "unknown";

/** §5.1 `getCurrentState` — the live state of the SOURCE, for this viewer. */
export interface TelegraphObjectState {
  available: boolean;
  /** The source's own status word when available ("active", "published", …). */
  status: string;
  /** Why not, when not. Never null while `available` is false. */
  reason: UnavailableReason | null;
}

/** §5.1, verbatim. Implemented once per object family by `shareableFor`. */
export interface TelegraphShareable {
  getSharePreview(viewerId: string): Promise<TelegraphShareProjection | null>;
  getCurrentState(viewerId: string): Promise<TelegraphObjectState>;
  getAvailableActions(viewerId: string, conversationId: string): Promise<TelegraphAction[]>;
  getDeepLink(): string;
}

const UNAVAILABLE = (reason: UnavailableReason): TelegraphObjectState => ({
  available: false,
  status: reason,
  reason,
});

const AVAILABLE = (status: string): TelegraphObjectState => ({
  available: true,
  status,
  reason: null,
});

// ── deep links ───────────────────────────────────────────────────────────────

/**
 * §5.1 `getDeepLink`. These are the client's real Expo Router paths —
 * `travel-buddy-standalone/app/post/[id].tsx`, `app/trip/[id].tsx`,
 * `app/event/[id].tsx`, `app/place/[id].tsx`, `app/gems/[id].tsx`,
 * `app/memory/[id].tsx`, `app/meetup/[id].tsx`, `app/u/[username].tsx` — so a
 * link that resolves here resolves in the app.
 */
export function deepLinkFor(objectType: TelegraphObjectType, objectId: string): string {
  switch (objectType) {
    case "POST":
      return `/post/${objectId}`;
    case "TRIP":
    case "TRIP_STAGE":
      return `/trip/${objectId}`;
    case "EVENT":
      return `/event/${objectId}`;
    case "MEETUP":
    case "PLAN":
      return `/meetup/${objectId}`;
    case "PLACE":
    case "MAP_PIN":
    case "MEETUP_POINT":
      return `/place/${objectId}`;
    case "HIDDEN_GEM":
      return `/gems/${objectId}`;
    case "MEMORY":
    case "MEMORY_NOTE":
      return `/memory/${objectId}`;
    case "PROFILE":
      return `/u/${objectId}`;
    case "BOOKING":
    case "BUDDY_SERVICE":
      return `/(rent-a-buddy)/booking/${objectId}`;
    case "STAMP":
      return `/stamp/${objectId}`;
    default:
      return `/`;
  }
}

/** §5.1 `getAvailableActions`, drawn from §8.1's fourteen. */
export function shareActionsFor(objectType: TelegraphObjectType): TelegraphAction[] {
  switch (objectType) {
    case "PLACE":
    case "HIDDEN_GEM":
    case "MAP_PIN":
    case "NEIGHBORHOOD":
    case "MEETUP_POINT":
      return ["ADD_TO_TRIP", "CREATE_PLAN", "MEET_HERE", "SHARE_PLACE", "DO_THIS_NOW"];
    case "TRIP":
    case "TRIP_STAGE":
      return ["ADD_TO_TRIP", "CREATE_PLAN"];
    case "EVENT":
      return ["JOIN_PLAN", "LEAVE_PLAN", "MEET_HERE"];
    case "MEETUP":
    case "PLAN":
      return ["JOIN_PLAN", "LEAVE_PLAN", "VOTE", "MEET_HERE"];
    case "ROUTE":
      return ["SHARE_ROUTE", "ADD_TO_TRIP"];
    case "BOOKING":
    case "BUDDY_SERVICE":
      return ["MEET_HERE", "SHARE_LOCATION", "CHECK_IN_SAFE"];
    default:
      return [];
  }
}

// ── the registry ─────────────────────────────────────────────────────────────

type Row = Record<string, any>;

interface Loaded {
  state: TelegraphObjectState;
  projection: TelegraphShareProjection | null;
}

type Loader = (
  client: SupabaseClient,
  objectId: string,
  viewerId: string,
) => Promise<Loaded>;

function proj(
  objectType: TelegraphObjectType,
  objectId: string,
  title: string,
  subtitle: string | null,
  imageUrl: string | null,
  version: string | null,
): TelegraphShareProjection {
  return {
    objectType,
    objectId,
    title,
    subtitle,
    imageUrl,
    projectionVersion: version,
    deepLink: deepLinkFor(objectType, objectId),
  };
}

/** Social — a post. Deleted or non-public degrades unless the viewer authored it. */
const loadPost: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("posts")
    .select("id, author_id, content, visibility, status, deleted_at, media_urls, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.deleted_at || r.status !== "active") return { state: UNAVAILABLE("deleted"), projection: null };
  const mine = r.author_id === viewerId;
  if (!mine && r.visibility !== "public") return { state: UNAVAILABLE("private"), projection: null };
  const body = typeof r.content === "string" ? r.content : "";
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "POST",
      id,
      body.slice(0, 80) || "Post",
      null,
      Array.isArray(r.media_urls) && r.media_urls.length > 0 ? String(r.media_urls[0]) : null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Travel — a Trip. Private trips degrade for anyone who is not a member. */
const loadTrip: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("trips")
    .select("id, owner_id, title, destination_city, start_date, end_date, status, visibility, cover_url, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  let allowed = r.owner_id === viewerId || r.visibility === "public";
  if (!allowed) {
    const { data: member, error: mErr } = await client
      .from("trip_members")
      .select("user_id, status")
      .eq("trip_id", id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (mErr) return { state: UNAVAILABLE("unknown"), projection: null };
    allowed = Boolean(member) && (member as Row).status === "accepted";
  }
  if (!allowed) return { state: UNAVAILABLE("unauthorized"), projection: null };
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "TRIP",
      id,
      (r.title as string) ?? "Trip",
      [r.destination_city, r.start_date].filter(Boolean).join(" · ") || null,
      (r.cover_url as string) ?? null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Travel — an Event. A draft or cancelled event degrades. */
const loadEvent: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("events")
    .select("id, host_id, title, city, starts_at, state, visibility, cover_url, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  const mine = r.host_id === viewerId;
  // `event_state` is draft|open|full|waitlist|started|completed|cancelled|archived
  // (baseline/20260819_baseline_structure.sql:173). Three of those are not a
  // live event for anyone but the host.
  if (!mine && (r.state === "draft" || r.state === "cancelled" || r.state === "archived")) {
    return { state: UNAVAILABLE("deleted"), projection: null };
  }
  if (!mine && r.visibility !== "public") {
    const { data: att, error: aErr } = await client
      .from("event_attendees")
      .select("user_id")
      .eq("event_id", id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (aErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if (!att) return { state: UNAVAILABLE("private"), projection: null };
  }
  return {
    state: AVAILABLE(String(r.state)),
    projection: proj(
      "EVENT",
      id,
      (r.title as string) ?? "Event",
      [r.city, r.starts_at].filter(Boolean).join(" · ") || null,
      (r.cover_url as string) ?? null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Travel — a meetup. Only invitees and the creator may see one. */
const loadMeetup: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("meetups")
    .select("id, creator_id, title, location_name, starts_at, status, visibility, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.status === "cancelled") return { state: UNAVAILABLE("deleted"), projection: null };
  if (r.creator_id !== viewerId) {
    const { data: inv, error: iErr } = await client
      .from("meetup_invites")
      .select("user_id, status")
      .eq("meetup_id", id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (iErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if (!inv || (inv as Row).status === "cancelled") {
      return { state: UNAVAILABLE("unauthorized"), projection: null };
    }
  }
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "MEETUP",
      id,
      (r.title as string) ?? "Meetup",
      [r.location_name, r.starts_at].filter(Boolean).join(" · ") || null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Places — a canonical place. Public by nature; a merged/duplicate row degrades. */
const loadPlace: Loader = async (client, id) => {
  const { data, error } = await client
    .from("places")
    .select("id, name, city, neighborhood, primary_category, status, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.status === "duplicate" || r.status === "moved") {
    return { state: UNAVAILABLE("deleted"), projection: null };
  }
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "PLACE",
      id,
      (r.name as string) ?? "Place",
      [r.neighborhood, r.city].filter(Boolean).join(", ") || null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Places — a Hidden Gem. Only an APPROVED, unmerged gem is shareable. */
const loadHiddenGem: Loader = async (client, id) => {
  const { data, error } = await client
    .from("hidden_gems")
    .select("id, name, city, neighborhood, category, status, sensitivity_level, merged_into, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.merged_into) return { state: UNAVAILABLE("deleted"), projection: null };
  // `hidden_gem_status` is pending|active|hidden|merged
  // (baseline/20260819_baseline_structure.sql:237). Only `active` is a gem
  // anyone may be handed; `hidden` is a moderation state and `pending` is not
  // yet a gem at all.
  if (r.status !== "active") {
    return { state: UNAVAILABLE("unauthorized"), projection: null };
  }
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "HIDDEN_GEM",
      id,
      (r.name as string) ?? "Hidden gem",
      [r.neighborhood, r.city].filter(Boolean).join(", ") || null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * Social — a Memory. The visibility ladder is `memories.visibility` plus the
 * explicit allow/deny arrays, and this loader is deliberately CONSERVATIVE: it
 * grants only `public`, an explicit `allowed_user_ids` entry, or ownership.
 * `friends_only` / `trip_crew` / `circle_only` need a relationship read owned
 * by the Memories surface, and guessing at it here is exactly the backdoor
 * §5.3 forbids — so they degrade to `private` rather than being approximated.
 */
const loadMemory: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("memories")
    .select("id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, state, location_city, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.state !== "published") return { state: UNAVAILABLE("deleted"), projection: null };
  const hidden = Array.isArray(r.hidden_user_ids) ? (r.hidden_user_ids as string[]) : [];
  if (hidden.includes(viewerId)) return { state: UNAVAILABLE("unauthorized"), projection: null };
  const allowed = Array.isArray(r.allowed_user_ids) ? (r.allowed_user_ids as string[]) : [];
  const mine = r.owner_id === viewerId;
  const visible = mine || r.visibility === "public" || allowed.includes(viewerId);
  if (!visible) return { state: UNAVAILABLE("private"), projection: null };
  return {
    state: AVAILABLE(String(r.state)),
    projection: proj(
      "MEMORY",
      id,
      (r.title as string) ?? (r.caption as string) ?? "Memory",
      (r.location_city as string) ?? null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Social — a profile. A banned, suspended or deleted account degrades. */
const loadProfile: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("profiles")
    .select("id, handle, name, avatar_url, account_status, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  const status = (r.account_status as string) ?? "active";
  if (status !== "active") return { state: UNAVAILABLE("deleted"), projection: null };
  if (r.id !== viewerId) {
    const { data: blocks, error: bErr } = await client
      .from("blocks")
      .select("blocker_id, blocked_id")
      .eq("blocker_id", r.id)
      .eq("blocked_id", viewerId);
    if (bErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if ((blocks ?? []).length > 0) return { state: UNAVAILABLE("unauthorized"), projection: null };
  }
  return {
    state: AVAILABLE(status),
    projection: proj(
      "PROFILE",
      id,
      (r.name as string) ?? (r.handle as string) ?? "Traveler",
      r.handle ? `@${r.handle}` : null,
      (r.avatar_url as string) ?? null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/** Services — a Rent-a-Buddy booking; only its two parties may see it. */
const loadBooking: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("rent_buddy_bookings")
    .select("id, buddy_id, traveler_id, city, category, booking_date, status, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.buddy_id !== viewerId && r.traveler_id !== viewerId) {
    return { state: UNAVAILABLE("unauthorized"), projection: null };
  }
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "BOOKING",
      id,
      `${r.category ?? "Buddy"} in ${r.city ?? "town"}`,
      (r.booking_date as string) ?? null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * The registry. A type absent from here is NOT shareable, and
 * `resolveShareProjection` says so with `not_found` rather than inventing a
 * card — an unknown family must not silently become a live reference.
 */
const LOADERS: Partial<Record<TelegraphObjectType, Loader>> = {
  POST: loadPost,
  TRIP: loadTrip,
  TRIP_STAGE: loadTrip,
  EVENT: loadEvent,
  MEETUP: loadMeetup,
  PLAN: loadMeetup,
  PLACE: loadPlace,
  MAP_PIN: loadPlace,
  MEETUP_POINT: loadPlace,
  HIDDEN_GEM: loadHiddenGem,
  MEMORY: loadMemory,
  MEMORY_NOTE: loadMemory,
  PROFILE: loadProfile,
  BOOKING: loadBooking,
  BUDDY_SERVICE: loadBooking,
};

/** Which object families §5 can carry today. Read by the route and by tests. */
export const SHAREABLE_OBJECT_TYPES = Object.keys(LOADERS) as TelegraphObjectType[];

export function isShareable(objectType: unknown): objectType is TelegraphObjectType {
  return isTelegraphObjectType(objectType) && objectType in LOADERS;
}

/**
 * §5.1's interface, instantiated for one (type, id). Returns null for a family
 * with no loader — the caller must not pretend the object exists.
 */
export function shareableFor(
  client: SupabaseClient,
  objectType: TelegraphObjectType,
  objectId: string,
  conversationActions: TelegraphAction[] = shareActionsFor(objectType),
): TelegraphShareable | null {
  const loader = LOADERS[objectType];
  if (!loader) return null;
  let cache: Promise<Loaded> | null = null;
  const load = (viewerId: string) => {
    if (!cache) cache = loader(client, objectId, viewerId);
    return cache;
  };
  return {
    async getSharePreview(viewerId) {
      const r = await load(viewerId);
      return r.state.available ? r.projection : null;
    },
    async getCurrentState(viewerId) {
      const r = await load(viewerId);
      return r.state;
    },
    async getAvailableActions(viewerId, _conversationId) {
      const r = await load(viewerId);
      return r.state.available ? conversationActions : [];
    },
    getDeepLink() {
      return deepLinkFor(objectType, objectId);
    },
  };
}

// ── §5.2 layer three: the resolved reference ─────────────────────────────────

export interface ShareRef {
  objectType: TelegraphObjectType;
  objectId: string;
  /** The message this reference was carried by, when there is one. */
  messageId?: string;
}

export type ResolvedShare =
  | {
      objectType: TelegraphObjectType;
      objectId: string;
      messageId: string | null;
      available: true;
      status: string;
      projection: TelegraphShareProjection;
      actions: TelegraphAction[];
      deepLink: string;
    }
  | {
      objectType: TelegraphObjectType;
      objectId: string;
      messageId: string | null;
      available: false;
      status: string;
      reason: UnavailableReason;
      /** NOTHING from the source is carried on an unavailable reference. */
      projection: null;
      actions: [];
      deepLink: string;
    };

/**
 * §5.3, in one function. Resolve a batch of references FOR THIS VIEWER, right
 * now. An unavailable reference carries no title, no image and no actions —
 * degrading to "unavailable" while still shipping the sender's cached title
 * would be the backdoor with extra steps.
 */
export async function resolveShareProjections(
  client: SupabaseClient,
  viewerId: string,
  conversationId: string,
  refs: ShareRef[],
): Promise<ResolvedShare[]> {
  const out: ResolvedShare[] = [];
  for (const ref of refs) {
    const deepLink = deepLinkFor(ref.objectType, ref.objectId);
    const shareable = shareableFor(client, ref.objectType, ref.objectId);
    if (!shareable) {
      out.push({
        objectType: ref.objectType,
        objectId: ref.objectId,
        messageId: ref.messageId ?? null,
        available: false,
        status: "not_found",
        reason: "not_found",
        projection: null,
        actions: [],
        deepLink,
      });
      continue;
    }
    const state = await shareable.getCurrentState(viewerId);
    if (!state.available) {
      out.push({
        objectType: ref.objectType,
        objectId: ref.objectId,
        messageId: ref.messageId ?? null,
        available: false,
        status: state.status,
        reason: state.reason ?? "unknown",
        projection: null,
        actions: [],
        deepLink,
      });
      continue;
    }
    const projection = await shareable.getSharePreview(viewerId);
    const actions = await shareable.getAvailableActions(viewerId, conversationId);
    if (!projection) {
      out.push({
        objectType: ref.objectType,
        objectId: ref.objectId,
        messageId: ref.messageId ?? null,
        available: false,
        status: state.status,
        reason: "unknown",
        projection: null,
        actions: [],
        deepLink,
      });
      continue;
    }
    out.push({
      objectType: ref.objectType,
      objectId: ref.objectId,
      messageId: ref.messageId ?? null,
      available: true,
      status: state.status,
      projection,
      actions,
      deepLink,
    });
  }
  return out;
}

// ── the message envelope §6.2 calls PORTAVA_OBJECT ───────────────────────────

/**
 * The body a PORTAVA_OBJECT message carries. It is a REFERENCE plus a
 * send-time caption — deliberately NOT a copy of the object, because a copy is
 * what made the old cards un-revocable. The renderer resolves the reference;
 * the only thing it may render without resolving is `caption`, which the
 * sender wrote.
 */
export interface PortavaObjectBody {
  kind: "PORTAVA_OBJECT";
  objectType: TelegraphObjectType;
  objectId: string;
  caption: string | null;
  /** The contract version of this envelope, so a reader can refuse a future one. */
  shareProjectionVersion: "1";
}

export const SHARE_PROJECTION_VERSION = "1" as const;

export function buildPortavaObjectBody(
  objectType: TelegraphObjectType,
  objectId: string,
  caption?: string | null,
): PortavaObjectBody {
  return {
    kind: "PORTAVA_OBJECT",
    objectType,
    objectId,
    caption: caption && caption.trim().length > 0 ? caption.trim().slice(0, 500) : null,
    shareProjectionVersion: SHARE_PROJECTION_VERSION,
  };
}

/** Parse a stored body back into a reference. Anything malformed is null. */
export function parsePortavaObjectBody(body: unknown): PortavaObjectBody | null {
  let parsed: any = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.kind !== "PORTAVA_OBJECT") return null;
  if (parsed.shareProjectionVersion !== SHARE_PROJECTION_VERSION) return null;
  if (!isShareable(parsed.objectType)) return null;
  if (typeof parsed.objectId !== "string" || parsed.objectId.length === 0) return null;
  return {
    kind: "PORTAVA_OBJECT",
    objectType: parsed.objectType,
    objectId: parsed.objectId,
    caption: typeof parsed.caption === "string" ? parsed.caption : null,
    shareProjectionVersion: SHARE_PROJECTION_VERSION,
  };
}
