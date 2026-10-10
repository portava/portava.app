/**
 * Telegraph §30A.12 — group controls, as ONE decision every send door reads.
 *
 * Spec §30A.12: "Large groups may support slow mode, host-only posting,
 * media/link restrictions, member moderation, and bounded acknowledgement
 * semantics." (census-telegraph T417: "None of the five.")
 *
 * ── WHAT IS DECIDED HERE ────────────────────────────────────────────────────
 * `decideGroupSend` is pure. Its facts come from `readGroupSendFacts`, which
 * reads nothing at all while `telegraph_group_controls_enabled` is off, so with
 * the flag off every send is decided exactly as before this file existed.
 *
 *   SAFETY        a safety send (§6.2 SAFETY, NEED_HELP) is NEVER refused by a
 *                 control, and reads nothing — the OD-TRUST-5 posture.
 *   HOST          a host is never refused by their own conversation's controls.
 *   MUTE          a host's mute stops the member's POSTS. A muted member may
 *                 still RESPOND — acknowledge an announcement, vote, react,
 *                 answer an action — because the operational notices a host
 *                 sends are exactly what a muted member must still be able to
 *                 confirm (§30A.5).
 *   HOSTS_ONLY    posting_policy 'hosts_only' refuses a non-host's POST; a
 *                 RESPONSE is still admitted, for the same reason.
 *   MEDIA / LINK  'hosts_only' refuses a non-host send that carries media (an
 *                 upload, a voice note, a media album, a GIF) or a link.
 *   SLOW MODE     a non-host may POST once per `slow_mode_seconds`; responses
 *                 are not counted and not limited.
 *
 * ── WHICH CONVERSATIONS ─────────────────────────────────────────────────────
 * Group-class conversations only: `group` (3660), `trip`, `circle`. A direct or
 * booking conversation is PRIVATE (transportClass.ts) and has no host, so no
 * control applies there and nothing is read. LANE RULING (proposed, T-GRP-1):
 * the controls are available on every group-class conversation, not only above
 * SMALL_GROUP_MAX — a class that a roster drifts in and out of must not switch a
 * host's choice on and off underneath them.
 *
 * ── WHO IS A HOST ───────────────────────────────────────────────────────────
 *   group   an ACTIVE member whose role is 'admin' (the person who formed it).
 *   trip    the trip's owner (`trips.owner_id`).
 *   circle  the circle's owner (`message_threads.circle_owner_id`).
 *
 * ── FAIL DIRECTION ──────────────────────────────────────────────────────────
 * The flag is RESTRICTIVE-WHEN-ON (lib/featureFlags.ts RESTRICTIVE_WHEN_ON_FLAGS)
 * and is read with `readFlagState`: an unreadable flag, or any unreadable fact
 * a decision rests on (the controls row, the mute row, host status, the
 * sender's last post), REFUSES as retryable — never as a pass, and never with a
 * control's own sentence.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { readFlagState } from "../../../lib/featureFlags.js";
import { LARGE_GROUP_SEEN_SAMPLE, transportClassFor } from "./transportClass.js";

export const GROUP_CONTROLS_FLAG = "telegraph_group_controls_enabled";

/** Thread types a host's controls may govern. */
export const GROUP_CONTROLLED_THREAD_TYPES: readonly string[] = ["group", "trip", "circle"];

export const SLOW_MODE_MAX_SECONDS = 3600;
export const AUDIENCE_POLICIES = ["everyone", "hosts_only"] as const;
export type AudiencePolicy = (typeof AUDIENCE_POLICIES)[number];

export interface GroupControls {
  readonly slowModeSeconds: number;
  readonly postingPolicy: AudiencePolicy;
  readonly mediaPolicy: AudiencePolicy;
  readonly linkPolicy: AudiencePolicy;
}

export const NO_CONTROLS: GroupControls = {
  slowModeSeconds: 0,
  postingPolicy: "everyone",
  mediaPolicy: "everyone",
  linkPolicy: "everyone",
};

/** A POST adds content; a RESPONSE answers content already there. */
export type Contribution = "post" | "response";

export interface GroupSendShape {
  readonly contribution?: Contribution;
  readonly media?: boolean;
  /** The text the send carries, scanned for a link. */
  readonly text?: string | null;
  readonly safety?: boolean;
}

export interface GroupSendFacts {
  /** null = no control applies here (flag off, not a group conversation). */
  readonly controls: GroupControls | null;
  readonly isHost: boolean;
  /** ISO instant the mute ends, "indefinite", or null when not muted. */
  readonly mutedUntil: string | "indefinite" | null;
  /** The sender's most recent POST in this conversation, when slow mode needs it. */
  readonly lastPostAt: string | null;
}

export type GroupSendVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly refusal: "muted" | "hosts_only" | "media_restricted" | "links_restricted" | "slow_mode" | "unknown";
      readonly message: string;
      readonly retryAfterMs?: number;
    };

export const GROUP_SEND_MESSAGES = {
  muted: "A host has paused your messages in this conversation. You can still respond to announcements and votes.",
  hosts_only: "Only hosts can post in this conversation right now.",
  media_restricted: "Only hosts can share photos, videos or voice notes in this conversation right now.",
  links_restricted: "Only hosts can share links in this conversation right now.",
  slow_mode: "Slow mode is on in this conversation. Please wait a little before posting again.",
  unknown: "We could not check this conversation's settings right now. Please try again shortly.",
} as const;

/** http(s) URLs and bare `www.` hosts. Not every dotted word — that would refuse "e.g." and "3.5". */
const LINK_RE = /(https?:\/\/[^\s<>"']+)|(\bwww\.[a-z0-9-]+\.[a-z]{2,})/i;

export function carriesLink(text: string | null | undefined): boolean {
  return typeof text === "string" && LINK_RE.test(text);
}

function muteInForce(mutedUntil: string | "indefinite" | null, nowMs: number): boolean {
  if (mutedUntil === null) return false;
  if (mutedUntil === "indefinite") return true;
  const t = Date.parse(mutedUntil);
  // An unparseable end is a mute we cannot bound: in force, not lifted.
  return Number.isNaN(t) ? true : t > nowMs;
}

/** The ONE decision. Pure. */
export function decideGroupSend(facts: GroupSendFacts, shape: GroupSendShape, nowMs: number = Date.now()): GroupSendVerdict {
  if (shape.safety) return { allowed: true };
  if (facts.isHost) return { allowed: true };
  const contribution: Contribution = shape.contribution ?? "post";

  if (contribution === "post" && muteInForce(facts.mutedUntil, nowMs)) {
    return { allowed: false, refusal: "muted", message: GROUP_SEND_MESSAGES.muted };
  }
  const c = facts.controls;
  if (!c) return { allowed: true };
  if (contribution === "post" && c.postingPolicy === "hosts_only") {
    return { allowed: false, refusal: "hosts_only", message: GROUP_SEND_MESSAGES.hosts_only };
  }
  if (shape.media && c.mediaPolicy === "hosts_only") {
    return { allowed: false, refusal: "media_restricted", message: GROUP_SEND_MESSAGES.media_restricted };
  }
  if (c.linkPolicy === "hosts_only" && carriesLink(shape.text)) {
    return { allowed: false, refusal: "links_restricted", message: GROUP_SEND_MESSAGES.links_restricted };
  }
  if (contribution === "post" && c.slowModeSeconds > 0 && facts.lastPostAt) {
    const last = Date.parse(facts.lastPostAt);
    const windowMs = c.slowModeSeconds * 1000;
    if (!Number.isNaN(last) && nowMs - last < windowMs) {
      return {
        allowed: false,
        refusal: "slow_mode",
        message: GROUP_SEND_MESSAGES.slow_mode,
        retryAfterMs: windowMs - (nowMs - last),
      };
    }
  }
  return { allowed: true };
}

const UNKNOWN: GroupSendVerdict = { allowed: false, refusal: "unknown", message: GROUP_SEND_MESSAGES.unknown };

function asPolicy(v: unknown): AudiencePolicy {
  // An unrecognised stored value is read as the RESTRICTIVE one: a corrupt row
  // must not open a conversation its host closed.
  return v === "everyone" ? "everyone" : "hosts_only";
}

export function controlsFromRow(row: Record<string, unknown> | null | undefined): GroupControls | null {
  if (!row) return null;
  const s = Number(row.slow_mode_seconds);
  return {
    slowModeSeconds: Number.isFinite(s) && s > 0 ? Math.min(Math.floor(s), SLOW_MODE_MAX_SECONDS) : 0,
    postingPolicy: asPolicy(row.posting_policy),
    mediaPolicy: asPolicy(row.media_policy),
    linkPolicy: asPolicy(row.link_policy),
  };
}

export interface GroupThreadRef {
  readonly id: string;
  readonly thread_type?: string | null;
  readonly trip_id?: string | null;
  readonly circle_owner_id?: string | null;
}

/** Is `userId` a host of this conversation? null = could not be established. */
export async function isConversationHost(sc: SupabaseClient, thread: GroupThreadRef, userId: string): Promise<boolean | null> {
  const type = thread.thread_type ?? "direct";
  if (type === "circle") return typeof thread.circle_owner_id === "string" && thread.circle_owner_id === userId;
  if (type === "trip") {
    if (!thread.trip_id) return false;
    const { data, error } = await sc.from("trips").select("owner_id").eq("id", thread.trip_id).maybeSingle();
    if (error) return null;
    return (data as { owner_id?: string } | null)?.owner_id === userId;
  }
  if (type === "group") {
    const { data, error } = await sc
      .from("message_thread_members")
      .select("role, left_at")
      .eq("thread_id", thread.id)
      .eq("user_id", userId)
      .is("left_at", null)
      .maybeSingle();
    if (error) return null;
    return (data as { role?: string } | null)?.role === "admin";
  }
  return false;
}

/** Is the controls capability on? "unknown" when the flag could not be read. */
export async function groupControlsState(flagSc: SupabaseClient): Promise<"on" | "off" | "unknown"> {
  // The literal, not the constant: the RESTRICTIVE_WHEN_ON_FLAGS ratchet looks for a three-valued read of this name.
  return readFlagState(flagSc, "telegraph_group_controls_enabled");
}

/**
 * Read what `decideGroupSend` needs, and decide. Reads NOTHING with the flag
 * off, for a safety send, or outside a group-class conversation.
 *
 * `thread` is the row the caller already read (its type is needed anyway); a
 * caller that did not read it passes null and this reads it.
 */
export async function decideGroupSendInThread(
  sc: SupabaseClient,
  flagSc: SupabaseClient,
  input: { threadId: string; senderId: string; thread: GroupThreadRef | null; shape: GroupSendShape; nowMs?: number },
): Promise<GroupSendVerdict> {
  if (input.shape.safety) return { allowed: true };
  const state = await groupControlsState(flagSc);
  if (state === "off") return { allowed: true };
  if (state === "unknown") return UNKNOWN;

  let thread = input.thread;
  if (!thread || thread.thread_type === undefined) {
    const { data, error } = await sc
      .from("message_threads")
      .select("id, thread_type, trip_id, circle_owner_id")
      .eq("id", input.threadId)
      .maybeSingle();
    if (error) return UNKNOWN;
    thread = (data as GroupThreadRef | null) ?? null;
  }
  if (!thread || !GROUP_CONTROLLED_THREAD_TYPES.includes(thread.thread_type ?? "direct")) return { allowed: true };

  const [{ data: ctl, error: ctlErr }, { data: mute, error: muteErr }] = await Promise.all([
    sc.from("telegraph_thread_controls")
      .select("slow_mode_seconds, posting_policy, media_policy, link_policy")
      .eq("thread_id", input.threadId)
      .maybeSingle(),
    sc.from("telegraph_thread_member_mutes")
      .select("muted_until")
      .eq("thread_id", input.threadId)
      .eq("user_id", input.senderId)
      .maybeSingle(),
  ]);
  if (ctlErr || muteErr) return UNKNOWN;
  const controls = controlsFromRow(ctl as Record<string, unknown> | null);
  const mutedUntil: string | "indefinite" | null = mute
    ? ((mute as { muted_until?: string | null }).muted_until ?? "indefinite")
    : null;
  if (!controls && mutedUntil === null) return { allowed: true };

  const host = await isConversationHost(sc, thread, input.senderId);
  if (host === null) return UNKNOWN;

  let lastPostAt: string | null = null;
  if (!host && controls && controls.slowModeSeconds > 0 && (input.shape.contribution ?? "post") === "post") {
    const { data: last, error: lastErr } = await sc
      .from("messages")
      .select("created_at")
      .eq("thread_id", input.threadId)
      .eq("sender_id", input.senderId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (lastErr) return UNKNOWN;
    lastPostAt = ((last as Array<{ created_at?: string }> | null) ?? [])[0]?.created_at ?? null;
  }

  return decideGroupSend({ controls, isHost: host, mutedUntil, lastPostAt }, input.shape, input.nowMs ?? Date.now());
}

// ── Bounded acknowledgement (§30A.12's fifth item) ───────────────────────────

/**
 * In a LARGE_GROUP, an announcement's acknowledgement roster is BOUNDED:
 *   - `acknowledgedBy` names at most LARGE_GROUP_SEEN_SAMPLE people; the exact
 *     count travels as `acknowledgedCount` (the count is never sampled);
 *   - `outstanding` — the list of who has NOT confirmed — is a HOST's view: a
 *     host gets a bounded sample and the exact count, every other member gets
 *     the count only. In a nine-hundred-person event conversation, handing
 *     every member the names of everyone who has not pressed a button is a
 *     per-recipient Seen list by another name, which §30A.12 forbids "without
 *     bounded strategies".
 * Outside a LARGE_GROUP, or with the flag off, the projection is returned
 * UNCHANGED (the caller does not call this).
 */
export interface AcknowledgementRosterLike {
  acknowledgedBy: Array<{ userId: string; at: string; note: string | null }>;
  outstanding: string[] | null;
  complete: boolean | null;
}

export function boundAcknowledgementRoster<T extends AcknowledgementRosterLike>(
  projected: T,
  opts: { viewerIsHost: boolean; sample: number },
): T & { acknowledgedCount: number; outstandingCount: number | null; rosterBounded: true } {
  const outstandingCount = projected.outstanding === null ? null : projected.outstanding.length;
  return {
    ...projected,
    acknowledgedBy: projected.acknowledgedBy.slice(0, opts.sample),
    acknowledgedCount: projected.acknowledgedBy.length,
    outstanding: projected.outstanding === null ? null : opts.viewerIsHost ? projected.outstanding.slice(0, opts.sample) : null,
    outstandingCount,
    // `complete` is a count fact and stays exact for everyone.
    complete: projected.complete,
    rosterBounded: true,
  };
}

/**
 * Apply `boundAcknowledgementRoster` to every announcement when, and only when,
 * the conversation is a LARGE_GROUP and the controls flag is not OFF.
 *
 * Fail direction on a READ surface is the SMALLER disclosure: an unreadable
 * flag, thread row or host status bounds the roster as for a non-host rather
 * than serving every name.
 */
export async function boundAnnouncementsForViewer<T extends AcknowledgementRosterLike>(
  sc: SupabaseClient,
  flagSc: SupabaseClient,
  threadId: string,
  viewerId: string,
  memberIds: readonly string[] | undefined,
  announcements: T[],
): Promise<Array<T | (T & { acknowledgedCount: number; outstandingCount: number | null; rosterBounded: true })>> {
  if (memberIds === undefined || announcements.length === 0) return announcements;
  const state = await groupControlsState(flagSc);
  if (state === "off") return announcements;
  const { data: thread, error } = await sc
    .from("message_threads")
    .select("id, thread_type, trip_id, circle_owner_id")
    .eq("id", threadId)
    .maybeSingle();
  const ref = (thread as GroupThreadRef | null) ?? null;
  if (!error && ref && transportClassFor({ threadType: ref.thread_type ?? "direct", activeMembers: memberIds.length }) !== "LARGE_GROUP") {
    return announcements;
  }
  if (!error && !ref) return announcements;
  const host = state === "on" && !error && ref ? (await isConversationHost(sc, ref, viewerId)) === true : false;
  return announcements.map((a) => boundAcknowledgementRoster(a, { viewerIsHost: host, sample: LARGE_GROUP_SEEN_SAMPLE }));
}
