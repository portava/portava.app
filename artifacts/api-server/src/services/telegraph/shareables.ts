/**
 * Telegraph §5 — the one share contract, §5.3's revocation, and §606's sixth
 * capability (search behaviour, see `TelegraphShareable` below).
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
import { mayDiscloseGemIdentity } from "../hiddenGems/HiddenGemPrivacyGuard.js";
import {
  type TelegraphAction,
  type TelegraphObjectType,
  isTelegraphObjectType,
} from "./vocabulary.js";
import {
  searchBehaviourFor,
  type TelegraphSearchBehaviour,
} from "../../domain/telegraph/contracts/conversationSearch.js";

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

/**
 * §5.1, verbatim — plus §606's sixth capability.
 *
 * §606: "Every shareable Portava domain registers preview, authorization,
 * current state, actions, SEARCH BEHAVIOR, and revocation through a Telegraph
 * content capability contract." The first five have been here since this file
 * existed. Search behaviour was registered somewhere else entirely — a map in
 * `domain/telegraph/contracts/conversationSearch.ts` keyed by message subtype
 * rather than by object family — so registering a loader here did NOT register
 * a domain's search behaviour, and no check could see the difference.
 * `getSearchBehaviour` closes that: the sixth capability now answers from the
 * same contract as the other five, and returns `null` rather than a guess for a
 * family that registers none. census-discovery A20.
 */
export interface TelegraphShareable {
  getSharePreview(viewerId: string): Promise<TelegraphShareProjection | null>;
  getCurrentState(viewerId: string): Promise<TelegraphObjectState>;
  getAvailableActions(viewerId: string, conversationId: string): Promise<TelegraphAction[]>;
  getDeepLink(): string;
  getSearchBehaviour(): TelegraphSearchBehaviour | null;
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
      return `/(rent-a-buddy)/booking/${objectId}`;
    case "STAMP":
      return `/stamp/${objectId}`;
    case "ROUTE":
      return `/route/${objectId}`;
    case "LAYOVER_PLAN":
      return `/layover/${objectId}`;
    case "MEDIA":
      return `/media-viewer/${objectId}`;
    default:
      return `/`;
  }
}

/**
 * The families whose deep link is the app's ROOT because the client has no
 * screen that takes one — read off `travel-buddy-standalone/app/`, not guessed.
 *
 * This exists so the `default:` arm above is a DECLARED absence instead of a
 * silent one. A family that is shareable and has nowhere to open is a real and
 * acceptable state — the projection, the live state, the actions and the
 * revocation all still work, which is what §5 asks for — but it is not a state
 * anybody should reach by accident. The contract test walks every shareable
 * family and requires that the set of families answering `/` is EXACTLY this
 * one, so adding a loader without a screen fails loudly, and adding the screen
 * without deleting the entry fails too.
 */
export const FAMILIES_WITH_NO_CLIENT_SCREEN: readonly TelegraphObjectType[] = [
  "HIGHLIGHT",
  "NEIGHBORHOOD",
  "RESERVATION",
  // BUDDY_SERVICE used to answer `/(rent-a-buddy)/booking/${id}`, which was a
  // real screen for the wrong object: that route takes a BOOKING id and
  // `app/(rent-a-buddy)/buddy/[id].tsx` takes a BUDDY id. A `buddy_services.id`
  // opens neither. The honest answer is the root and a declared absence.
  "BUDDY_SERVICE",
];

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
  //
  // STATUS IS HALF THE POLICY, AND THIS USED TO BE THE ONLY HALF CHECKED.
  // `sensitivity_level` was already SELECTed above and then never read, so a
  // `protected` / `reveal_after_save` / `reveal_after_acceptance` gem — whose
  // whole point is that its existence and place are earned, or never given —
  // was shareable into a thread by name, neighbourhood and city, with a
  // /gems/:id deep link. RLS does not cover this: the route reads
  // `const { client } = await requireUser(...)`, which looks user-scoped and is
  // not — lib/http.ts's requireUser verifies the bearer token and returns
  // getServiceClient(), so the identity is the caller's and the privileges are
  // the service role's. mayDiscloseGemIdentity IS migration 0043's
  // `hidden_gems_public_read` written as a predicate, for exactly this case.
  //
  // The viewer passed is `null`, NOT viewerId, and that is deliberate. The
  // predicate's owner bypass answers "may THIS VIEWER be told the gem exists",
  // and for the submitter that is yes. But a share does not disclose to the
  // sharer — it discloses to everyone else in the thread, none of whom has
  // earned a reveal_after_save gem or may ever see a protected one. So the
  // bypass is kept out of this surface on purpose.
  if (!mayDiscloseGemIdentity(
        { status: r.status as string, sensitivity_level: r.sensitivity_level as any, submitted_by: null },
        null)) {
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
  // A BLOCK OUTRANKS "public", and this loader used to be the one place on the
  // Memory surface where it did not. §23's predicate
  // (`services/memory/memoryReadPolicy.ts`) checks blocks in both directions,
  // and `loadProfile` below has checked them since it was written — so a
  // traveller who blocked somebody had that person refused their PROFILE card
  // and served the title and city of their public MEMORY in the same chat.
  // Highlights/Memories §10: blocking "unlinks profile identity"; §5.3's word
  // for the outcome is `unauthorized`, the same one `loadProfile` uses.
  //
  // One direction only, deliberately, and it is the same direction
  // `loadProfile` takes: the OWNER blocking the VIEWER. Adding the reverse arm
  // would be a wider rule than this file's neighbour applies, and widening a
  // share rule is a product decision rather than a repair of a divergence.
  // Fail-closed: an unreadable `blocks` degrades to "unknown" rather than to
  // "not blocked", which is what every other read in this file already does.
  if (!mine) {
    const { data: blocks, error: bErr } = await client
      .from("blocks")
      .select("blocker_id, blocked_id")
      .eq("blocker_id", r.owner_id as string)
      .eq("blocked_id", viewerId);
    if (bErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if ((blocks ?? []).length > 0) return { state: UNAVAILABLE("unauthorized"), projection: null };
  }
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
 * Social — a Highlight.
 *
 * A Highlight is the one shareable family with a BUILT-IN end: `expires_at` is
 * NOT NULL on the table. So §5.3's "deleted, private or unauthorized" has a
 * fourth road here — an object that becomes unavailable because time passed,
 * with nothing written and nobody acting. A card that kept rendering it would
 * be a backdoor into content the author chose to make temporary, which is the
 * same defect as the frozen card and arrives on its own.
 *
 * An unparseable `expires_at` is UNKNOWN, not "not expired": "we cannot tell
 * when this ends" must not resolve to "it never does".
 *
 * `highlights.visibility` is public | travelers_nearby | circle_only |
 * trip_only | private. Only `public` and ownership are granted here, for the
 * reason `loadMemory` states: the other three need a relationship read owned by
 * another surface, and approximating it here is the backdoor §5.3 forbids.
 */
const loadHighlight: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("highlights")
    .select(
      "id, owner_id, caption, location_name, location_city, visibility, expires_at, deleted_at, archived_at, media_url, media_type, updated_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.deleted_at || r.archived_at) return { state: UNAVAILABLE("deleted"), projection: null };
  const expiresAt = Date.parse(String(r.expires_at ?? ""));
  if (!Number.isFinite(expiresAt)) return { state: UNAVAILABLE("unknown"), projection: null };
  if (expiresAt <= Date.now()) return { state: UNAVAILABLE("deleted"), projection: null };
  const mine = r.owner_id === viewerId;
  if (!mine && r.visibility !== "public") return { state: UNAVAILABLE("private"), projection: null };
  return {
    state: AVAILABLE("live"),
    projection: proj(
      "HIGHLIGHT",
      id,
      (r.caption as string) || "Highlight",
      [r.location_name, r.location_city].filter(Boolean).join(", ") || null,
      (r.media_url as string) ?? null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * Social — a Stamp.
 *
 * Two reads, because the earned row and the thing it was earned for are two
 * tables: `user_stamps` is the award, `stamp_definitions` is the name and the
 * artwork. The second read is bound and checked like the first — an unreadable
 * definition is `unknown`, not an untitled stamp.
 *
 * A stamp can be REVOKED (`is_revoked`), which is §5.3's case exactly: the
 * award was taken back and the card must stop rendering it. `display_on_passport
 * = false` is the owner having hidden it from their own passport, so it is not
 * something a third party may be handed either.
 */
const loadStamp: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("user_stamps")
    .select(
      "id, user_id, stamp_definition_id, title_override, city, country, visibility, display_on_passport, is_revoked, earned_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.is_revoked === true) return { state: UNAVAILABLE("deleted"), projection: null };
  const mine = r.user_id === viewerId;
  if (!mine && (r.visibility !== "public" || r.display_on_passport === false)) {
    return { state: UNAVAILABLE("private"), projection: null };
  }
  let title = (r.title_override as string) ?? null;
  let icon: string | null = null;
  if (r.stamp_definition_id) {
    const { data: def, error: dErr } = await client
      .from("stamp_definitions")
      .select("id, name, icon_url, universal_artwork_url")
      .eq("id", r.stamp_definition_id)
      .maybeSingle();
    if (dErr) return { state: UNAVAILABLE("unknown"), projection: null };
    const d = (def ?? null) as Row | null;
    if (d) {
      title = title ?? ((d.name as string) ?? null);
      icon = ((d.icon_url as string) ?? (d.universal_artwork_url as string)) ?? null;
    }
  }
  return {
    state: AVAILABLE("earned"),
    projection: proj(
      "STAMP",
      id,
      title ?? "Stamp",
      [r.city, r.country].filter(Boolean).join(", ") || null,
      icon,
      (r.earned_at as string) ?? null,
    ),
  };
};

/**
 * Places — a neighborhood.
 *
 * `neighborhood_areas` is DERIVED public reference data: a name, a city, a
 * centre and confidence scores computed from OSM or a grid. It has no owner, no
 * visibility column and nothing private in it, so there is no authorization
 * read to do and none is invented. §11's census said NEIGHBORHOOD "deliberately
 * has no loader ... rather than pretending"; the thing it refused to pretend
 * about was an authorization model, and this family genuinely has none to get
 * wrong.
 *
 * What it CAN be wrong about is precision, so `confidence` travels in the
 * subtitle rather than being dropped: a `low`-confidence grid cell and a `high`
 * confidence OSM polygon are different claims about the same shape.
 */
const loadNeighborhood: Loader = async (client, id) => {
  const { data, error } = await client
    .from("neighborhood_areas")
    .select("id, name, city_name, country, confidence, source, computed_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  return {
    state: AVAILABLE(String(r.confidence ?? "low")),
    projection: proj(
      "NEIGHBORHOOD",
      id,
      (r.name as string) ?? "Neighborhood",
      [r.city_name, r.country].filter(Boolean).join(", ") || null,
      null,
      (r.computed_at as string) ?? null,
    ),
  };
};

/**
 * Travel — a route plan.
 *
 * A DRAFT route is not a route anyone else has been shown, so it degrades for
 * everybody but its owner; a cancelled one degrades for everybody. Membership
 * is `route_plan_members`, which is the table the route surface itself uses —
 * a trip or circle id on the row is NOT taken as membership, because being on
 * the trip a route was planned for is not the same as having been added to the
 * route.
 */
const loadRoute: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("route_plans")
    .select("id, owner_user_id, title, route_style, status, is_approximated, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.status === "cancelled") return { state: UNAVAILABLE("deleted"), projection: null };
  const mine = r.owner_user_id === viewerId;
  if (!mine) {
    if (r.status === "draft") return { state: UNAVAILABLE("private"), projection: null };
    const { data: member, error: mErr } = await client
      .from("route_plan_members")
      .select("user_id")
      .eq("route_plan_id", id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (mErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if (!member) return { state: UNAVAILABLE("unauthorized"), projection: null };
  }
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "ROUTE",
      id,
      (r.title as string) ?? "Route",
      [r.route_style, r.is_approximated === true ? "approximate" : null].filter(Boolean).join(" · ") || null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * Travel — §5's "reservation-safe derivative", and the SAFE is the whole point.
 *
 * `trip_reservations` holds three things that must never leave the person who
 * pasted them: `confirmation_ref` (a booking reference is a credential — it is
 * what an airline's "manage my booking" page authenticates on), `raw_text` (the
 * pasted confirmation email, entire) and `extraction` (the model's read of it,
 * which contains whatever the email did). A DERIVATIVE is what is left when
 * those are gone: what kind of thing it is, what it is called, when, and where.
 *
 * Those three columns are not in the `select` and are not in the projection,
 * and the test asserts the absence against a fixture row that HAS them — so a
 * later "just add the ref, it's useful" edit fails rather than shipping.
 */
const loadReservation: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("trip_reservations")
    .select("id, trip_id, user_id, type, title, starts_at, ends_at, location_name, status, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.status === "dismissed") return { state: UNAVAILABLE("deleted"), projection: null };
  if (r.user_id !== viewerId) {
    const { data: member, error: mErr } = await client
      .from("trip_members")
      .select("user_id, status")
      .eq("trip_id", r.trip_id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (mErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if (!member || (member as Row).status !== "accepted") {
      return { state: UNAVAILABLE("unauthorized"), projection: null };
    }
  }
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "RESERVATION",
      id,
      (r.title as string) ?? "Reservation",
      [r.type, r.location_name, r.starts_at].filter(Boolean).join(" · ") || null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * Travel — a layover plan.
 *
 * `layover_sessions` is the plan and `layover_plan_stops` hangs off it. A
 * layover is over when it is over: `expired` and `completed` are not states a
 * card should keep offering, and `cancelled` is a deletion. Only the traveller
 * and the accepted members of the trip the layover belongs to may see one; a
 * session with no `trip_id` is private to its owner, full stop.
 */
const loadLayoverPlan: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("layover_sessions")
    .select(
      "id, user_id, trip_id, manual_airport_name, manual_city, manual_iata, arrival_time, departure_time, status, updated_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.status === "cancelled" || r.status === "expired") {
    return { state: UNAVAILABLE("deleted"), projection: null };
  }
  if (r.user_id !== viewerId) {
    if (!r.trip_id) return { state: UNAVAILABLE("private"), projection: null };
    const { data: member, error: mErr } = await client
      .from("trip_members")
      .select("user_id, status")
      .eq("trip_id", r.trip_id)
      .eq("user_id", viewerId)
      .maybeSingle();
    if (mErr) return { state: UNAVAILABLE("unknown"), projection: null };
    if (!member || (member as Row).status !== "accepted") {
      return { state: UNAVAILABLE("unauthorized"), projection: null };
    }
  }
  const where = (r.manual_city as string) ?? (r.manual_airport_name as string) ?? (r.manual_iata as string) ?? null;
  return {
    state: AVAILABLE(String(r.status)),
    projection: proj(
      "LAYOVER_PLAN",
      id,
      where ? `Layover in ${where}` : "Layover",
      [r.arrival_time, r.departure_time].filter(Boolean).join(" → ") || null,
      null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * Media — §5's fifth family, and the one that had no loader at all.
 *
 * `media_assets.visibility` defaults to `inherit`, which means "whatever the
 * object this asset hangs off says". This loader cannot resolve that — the
 * parent could be a post, a memory, a highlight or a message, each with its own
 * ladder — so `inherit` degrades to `private` for anybody but the owner. That
 * is the conservative direction and it is deliberate: the permissive reading of
 * "inherit" is a backdoor into whatever the parent was hiding.
 *
 * Moderation is a second gate. A `rejected` asset is gone; a `flagged` or
 * `pending` one is under review and is not something a third party may be
 * handed while that is true, even if it is public.
 */
const loadMedia: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("media_assets")
    .select(
      "id, owner_user_id, caption, alt_text, media_type, thumbnail_url, public_url, visibility, moderation_status, processing_status, updated_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  if (r.moderation_status === "rejected") return { state: UNAVAILABLE("deleted"), projection: null };
  const processing = String(r.processing_status ?? "");
  if (processing === "removed" || processing === "expired" || processing === "rejected" || processing === "failed") {
    return { state: UNAVAILABLE("deleted"), projection: null };
  }
  const mine = r.owner_user_id === viewerId;
  if (!mine) {
    if (r.visibility !== "public") return { state: UNAVAILABLE("private"), projection: null };
    if (r.moderation_status !== "approved") return { state: UNAVAILABLE("unauthorized"), projection: null };
  }
  if (processing !== "ready") return { state: UNAVAILABLE("unknown"), projection: null };
  return {
    state: AVAILABLE(String(r.media_type ?? "image")),
    projection: proj(
      "MEDIA",
      id,
      (r.caption as string) || (r.alt_text as string) || (r.media_type === "video" ? "Video" : "Photo"),
      (r.media_type as string) ?? null,
      ((r.thumbnail_url as string) ?? (r.public_url as string)) ?? null,
      (r.updated_at as string) ?? null,
    ),
  };
};

/**
 * Services — a Buddy's advertised service.
 *
 * BUDDY_SERVICE was in the registry pointing at `loadBooking`, which reads
 * `rent_buddy_bookings`. A service id is not a booking id, so `isShareable`
 * answered true and every actual BUDDY_SERVICE reference then resolved
 * `not_found` — a family that looked registered and could not be shared. The
 * two are genuinely different objects: a booking is an agreement between two
 * named people, a service is a marketplace LISTING anyone may be shown.
 *
 * Which is why the authorization is different too. A listing is public once it
 * is both `approved` (an admin act) and `is_active` (the buddy's own switch) —
 * and a listing that has lost either is exactly §5.3's case: the card in the
 * thread must stop offering it.
 */
const loadBuddyService: Loader = async (client, id, viewerId) => {
  const { data, error } = await client
    .from("buddy_services")
    .select("id, buddy_id, category, title, description, hourly_rate_usd, is_active, approved, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return { state: UNAVAILABLE("unknown"), projection: null };
  if (!data) return { state: UNAVAILABLE("not_found"), projection: null };
  const r = data as Row;
  const mine = r.buddy_id === viewerId;
  if (!mine) {
    if (r.approved !== true) return { state: UNAVAILABLE("unauthorized"), projection: null };
    if (r.is_active !== true) return { state: UNAVAILABLE("deleted"), projection: null };
  }
  const rate = r.hourly_rate_usd == null ? null : `$${r.hourly_rate_usd}/hr`;
  return {
    state: AVAILABLE(r.is_active === true ? "active" : "paused"),
    projection: proj(
      "BUDDY_SERVICE",
      id,
      (r.title as string) ?? "Buddy service",
      [r.category, rate].filter(Boolean).join(" · ") || null,
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
  HIGHLIGHT: loadHighlight,
  STAMP: loadStamp,
  NEIGHBORHOOD: loadNeighborhood,
  ROUTE: loadRoute,
  RESERVATION: loadReservation,
  LAYOVER_PLAN: loadLayoverPlan,
  MEDIA: loadMedia,
  BOOKING: loadBooking,
  BUDDY_SERVICE: loadBuddyService,
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
    getSearchBehaviour() {
      return searchBehaviourFor(objectType);
    },
  };
}

/**
 * §606's sixth capability for a family, without instantiating a shareable.
 * `resolveShareProjections` and the search path both need it per FAMILY, not
 * per object, and building a loader closure to ask a static question would
 * invite someone to cache the answer on the object.
 */
export function searchBehaviourForObjectType(objectType: TelegraphObjectType): TelegraphSearchBehaviour | null {
  return searchBehaviourFor(objectType);
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
