/**
 * memorySharedAnchors — §5 "Remember this together": a shared-experience anchor
 * plus separate personal Memories, created only after participant consent.
 * Census-highlights-memories H53 (B58 cluster MEM-ANCHOR-1, the SERVER half;
 * migration 3805, unapplied; flag `memory_shared_anchors_enabled`, seeded FALSE).
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       :225-226 "A shared experience is not one globally editable personal
 *       Memory. Prefer a shared-experience anchor plus separate personal
 *       Memories. Mutual 'Remember this together' creates an explicitly shared
 *       object only after participant consent."
 *
 * ── WHAT AN ANCHOR IS, AND IS NOT ───────────────────────────────────────────
 * A link between separate personal Memories, each its owner's alone. The host
 * (the owner of the Memory it was started from) is accepted from the start —
 * inviting is the host's consent. An invitee accepts (optionally linking their
 * OWN Memory), declines, or later leaves. The anchor is SHARED only while two
 * or more people have accepted.
 *
 * IT ADDS NO READ GRANT. A member's linked Memory reaches a viewer as an id
 * ONLY when `canReadMemory(viewer, thatMemory, "single")` — the existing §23
 * ladder — already admits the viewer; otherwise the member is listed with
 * `memoryId: null`. Being in an anchor with someone does not let you read their
 * `only_me` Memory, exactly as being tagged does not (§10). Open owner question
 * Q-H53-3 (what acceptance shows): this is its fail-closed default — nothing
 * beyond the ladder.
 *
 * WHO SEES WHOM. An accepted member sees the ACCEPTED members only — never who
 * was invited, who declined or who left — minus everyone blocked in either
 * direction. An invitee sees only the host who invited them (and the host's
 * Memory, through the same ladder). A block hides the two people from each
 * other; it does not remove anyone from the anchor.
 *
 * WHO MAY BE INVITED (Q-H53-1, fail-closed default): only by the host, from the
 * host's own live Memory, and only a person holding an APPROVED tag on it — not
 * a pending or removed tag, not trip crew, not anyone else — and never anyone
 * blocked either way. Every refusal is the same 403, so a refusal adds nothing
 * to what the host's own tag list already shows: the §10 ladder hides a
 * blocked participant from the owner too (memoryParticipantVisibility.ts,
 * branch 1).
 *
 * BLOCKS ARE READ WITH THE SHARED READER (lib/exclusionSet.ts
 * `readBlockExclusions`, scoped `among` the people concerned). PR #729 hardens
 * that reader so a thrown or malformed read answers "unreadable"; until it
 * merges, `blocksAmong` below treats a thrown read and anything but `ok: true`
 * as BLOCKED. What it cannot see on main: a `blocks` read that resolves with a
 * non-list `data` and no error is folded into "nobody" INSIDE the shared reader
 * (exclusionSet.ts `?? []`) — that is #729's fix and this module's stated
 * hazard.
 *
 * NOTIFICATION (Q-H53-2, fail-closed default): IN-APP ONLY. One row through the
 * existing NotificationService.create (persist only: privacy guard, dedup,
 * insert). NotificationRouter — the only path that pushes — is never called, and
 * the row's category is `trips`, whose daily digest is itself in-app only
 * (NotificationTemplateService `digest.trips`). No push.
 *
 * DISSOLUTION (Q-H53-4, fail-closed default) is the database's job (3805's
 * `memory_shared_anchor_dissolve`): when the host is no longer accepted, or
 * fewer than two people remain invited or accepted, the anchor and EVERY
 * member row are erased.
 *
 * ── THE FLAG ────────────────────────────────────────────────────────────────
 * `memory_shared_anchors_enabled` OFF or absent ⇒ the routes are not there
 * (routes/memorySharedAnchors.ts falls through to the API's own "no such
 * route") and this module is never reached. Unreadable ⇒ 503.
 */
import { logger } from "../../lib/logger.js";
import { readFlagState } from "../../lib/featureFlags.js";
import { readBlockExclusions, type ExclusionSet } from "../../lib/exclusionSet.js";
import { actorHandleFrom, resolveHandle } from "../../lib/publicIdentity.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { canReadMemory } from "./memoryReadPolicy.js";

export const MEMORY_SHARED_ANCHORS_FLAG = "memory_shared_anchors_enabled";

/** A Memory that may start or join an anchor: not deleted, not removed by a moderator (3805's guard says the same). */
const NOT_LIVE_STATES: ReadonlySet<string> = new Set(["deleted", "removed"]);

/** The columns `canReadMemory` reads. */
const MEMORY_GATE_COLUMNS = "id, owner_id, state, visibility, allowed_user_ids, hidden_user_ids, trip_id";

/** The most anchors one person's list returns. */
export const SHARED_ANCHOR_LIST_LIMIT = 50;

// ── The flag ─────────────────────────────────────────────────────────────────

export type SharedAnchorsFlag = "on" | "off" | "unreadable";

/**
 * Through the shared three-state reader (lib/featureFlags.ts `readFlagState`).
 * Absent row = off (3805 not applied: production today). An error is NOT off —
 * the caller answers 503 rather than "this does not exist".
 */
export async function readSharedAnchorsFlag(sc: any): Promise<SharedAnchorsFlag> {
  const state = await readFlagState(sc, "memory_shared_anchors_enabled");
  if (state === "on") return "on";
  if (state === "off") return "off";
  return "unreadable";
}

// ── Blocks ───────────────────────────────────────────────────────────────────

export type BlockRead =
  | { readonly ok: true; readonly blocked: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: string };

/**
 * Who among `others` is blocked with `viewerId`, in either direction, through
 * the shared reader. NEVER answers "nobody" for a read it could not complete: a
 * thrown read (main's reader lets a throw out; PR #729 catches it inside) and
 * anything but `ok: true` are `ok: false`, which every caller here treats as
 * BLOCKED (a gate denies, a view refuses).
 */
export async function blocksAmong(sc: any, viewerId: string, others: readonly string[]): Promise<BlockRead> {
  const among = [...new Set(others.filter((o) => typeof o === "string" && o.length > 0 && o !== viewerId))];
  if (among.length === 0) return { ok: true, blocked: new Set() };
  let set: ExclusionSet;
  try {
    set = await readBlockExclusions(sc, viewerId, { among });
  } catch (err) {
    return { ok: false, reason: `block read threw: ${String((err as any)?.message ?? err)}` };
  }
  if (set?.ok !== true) return { ok: false, reason: (set as any)?.reason ?? "block read answered no exclusion set" };
  return { ok: true, blocked: new Set([...set.ids].filter((id) => among.includes(id))) };
}

// ── Invite ───────────────────────────────────────────────────────────────────

export type InviteOutcome =
  | { readonly kind: "invited"; readonly anchorId: string; readonly created: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_invitable" }
  | { readonly kind: "already_invited" }
  | { readonly kind: "not_host" }
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "write_failed"; readonly detail: string };

/**
 * The host of Memory `memoryId` invites `inviteeId`.
 *
 * The API checks, in this order: the Memory is the inviter's own and live
 * (else the same 404 as a missing one); the invitee holds an APPROVED tag on it
 * and is not the inviter; no block either way (an unreadable block read is a
 * block). Then 3805's `memory_shared_anchor_invite` — the one writer of new rows —
 * re-checks the Memory and the tag in the transaction that writes, finds or
 * creates the anchor under a per-Memory lock, and refuses a Memory linked to an
 * anchor someone else hosts.
 */
export async function inviteToSharedAnchor(
  sc: any,
  memoryId: string,
  inviterId: string,
  inviteeId: string,
): Promise<InviteOutcome> {
  const { data: memory, error: memoryErr } = await sc
    .from("memories")
    .select("id, owner_id, state")
    .eq("id", memoryId)
    .maybeSingle();
  if (memoryErr) return { kind: "unreadable", detail: `memories: ${memoryErr.message ?? memoryErr.code ?? "error"}` };
  if (!memory || (memory as any).owner_id !== inviterId || NOT_LIVE_STATES.has(String((memory as any).state))) {
    return { kind: "not_found" };
  }
  if (inviteeId === inviterId) return { kind: "not_invitable" };

  const { data: tag, error: tagErr } = await sc
    .from("memory_tags")
    .select("status")
    .eq("memory_id", memoryId)
    .eq("tagged_user_id", inviteeId)
    .maybeSingle();
  if (tagErr) return { kind: "unreadable", detail: `memory_tags: ${tagErr.message ?? tagErr.code ?? "error"}` };
  if ((tag as any)?.status !== "approved") return { kind: "not_invitable" };

  const blocks = await blocksAmong(sc, inviterId, [inviteeId]);
  if (!blocks.ok) {
    logger.warn({ memoryId, reason: blocks.reason }, "memory shared anchor: block state unreadable — refusing the invitation as if blocked");
    return { kind: "not_invitable" };
  }
  if (blocks.blocked.has(inviteeId)) return { kind: "not_invitable" };

  const { data, error } = await sc.rpc("memory_shared_anchor_invite", {
    p_memory_id: memoryId,
    p_inviter_id: inviterId,
    p_invitee_id: inviteeId,
  });
  if (error) return { kind: "write_failed", detail: `memory_shared_anchor_invite: ${error.message ?? error.code ?? "error"}` };
  const outcome = (data as any)?.outcome;
  const anchorId = (data as any)?.anchor_id;
  switch (outcome) {
    case "invited":
      if (typeof anchorId !== "string") return { kind: "write_failed", detail: "invite answered without an anchor id" };
      return { kind: "invited", anchorId, created: (data as any)?.created === true };
    case "already_invited": return { kind: "already_invited" };
    case "not_found": return { kind: "not_found" };
    case "not_invitable": return { kind: "not_invitable" };
    case "not_host": return { kind: "not_host" };
    default: return { kind: "write_failed", detail: `invite answered an unknown outcome: ${String(outcome)}` };
  }
}

/**
 * Q-H53-2: the invitee learns of the invitation IN-APP ONLY. Non-fatal: the
 * invitation stands whether or not the row is written, and a failure is logged.
 * Names the host by @handle only (lib/publicIdentity.ts); an unreadable profile
 * names nobody rather than "someone".
 */
export async function notifyInvitedInApp(
  sc: any,
  anchorId: string,
  inviterId: string,
  inviteeId: string,
): Promise<boolean> {
  try {
    const { data: profile, error } = await sc
      .from("profiles")
      .select("handle, username")
      .eq("id", inviterId)
      .maybeSingle();
    const claim = actorHandleFrom(profile as any, error);
    const who = claim.handle ? `@${claim.handle}` : null;
    const result = await new NotificationService(sc).createDetailed({
      userId: inviteeId,
      eventType: "memory.shared_anchor_invited",
      category: "trips",
      priority: "normal",
      channels: ["in_app"],
      title: "Remember this together?",
      body: who
        ? `${who} invited you to link your Memory of a moment you shared. Nothing is shared unless you accept.`
        : "You were invited to link your Memory of a moment you shared. Nothing is shared unless you accept.",
      sourceType: "memory_shared_anchor",
      sourceId: anchorId,
      actorId: inviterId,
      metadata: { anchorId },
    });
    if (result.refusal) {
      logger.warn({ anchorId, refusal: result.refusal }, "memory shared anchor: in-app invitation notice not written");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, anchorId }, "memory shared anchor: in-app invitation notice threw");
    return false;
  }
}

// ── Accept / decline / leave ─────────────────────────────────────────────────

export type RespondOutcome =
  | { readonly kind: "ok"; readonly memoryId: string | null }
  | { readonly kind: "not_found" }
  | { readonly kind: "memory_not_found" }
  | { readonly kind: "memory_already_linked" }
  | { readonly kind: "unreadable"; readonly detail: string }
  | { readonly kind: "write_failed"; readonly detail: string };

interface OwnRow { status: string; hostId: string }

/** The caller's own row and the anchor's host, or null when either is absent. */
async function readOwnRow(sc: any, anchorId: string, userId: string): Promise<{ ok: true; row: OwnRow | null } | { ok: false; detail: string }> {
  const { data: member, error: memberErr } = await sc
    .from("memory_shared_anchor_members")
    .select("status")
    .eq("anchor_id", anchorId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberErr) return { ok: false, detail: `memory_shared_anchor_members: ${memberErr.message ?? memberErr.code ?? "error"}` };
  if (!member) return { ok: true, row: null };
  const { data: anchor, error: anchorErr } = await sc
    .from("memory_shared_anchors")
    .select("created_by")
    .eq("id", anchorId)
    .maybeSingle();
  if (anchorErr) return { ok: false, detail: `memory_shared_anchors: ${anchorErr.message ?? anchorErr.code ?? "error"}` };
  if (!anchor) return { ok: true, row: null };
  return { ok: true, row: { status: String((member as any).status), hostId: String((anchor as any).created_by) } };
}

/**
 * Accept an OPEN invitation, optionally linking the caller's OWN live Memory.
 * An invitation from a host the caller is blocked with (either way, or
 * unreadable) is hidden, so it cannot be accepted: the same 404 as none.
 */
export async function acceptInvitation(
  sc: any,
  anchorId: string,
  userId: string,
  memoryId: string | null,
): Promise<RespondOutcome> {
  const own = await readOwnRow(sc, anchorId, userId);
  if (!own.ok) return { kind: "unreadable", detail: own.detail };
  if (!own.row || own.row.status !== "invited") return { kind: "not_found" };

  const blocks = await blocksAmong(sc, userId, [own.row.hostId]);
  if (!blocks.ok) {
    logger.warn({ anchorId, reason: blocks.reason }, "memory shared anchor: block state unreadable — the invitation stays hidden");
    return { kind: "not_found" };
  }
  if (blocks.blocked.has(own.row.hostId)) return { kind: "not_found" };

  if (memoryId !== null) {
    const { data: mine, error: mineErr } = await sc
      .from("memories")
      .select("id, owner_id, state")
      .eq("id", memoryId)
      .maybeSingle();
    if (mineErr) return { kind: "unreadable", detail: `memories: ${mineErr.message ?? mineErr.code ?? "error"}` };
    if (!mine || (mine as any).owner_id !== userId || NOT_LIVE_STATES.has(String((mine as any).state))) {
      return { kind: "memory_not_found" };
    }
  }

  const { data, error } = await sc
    .from("memory_shared_anchor_members")
    .update({ status: "accepted", consented_at: new Date().toISOString(), memory_id: memoryId })
    .eq("anchor_id", anchorId)
    .eq("user_id", userId)
    .eq("status", "invited")
    .select("anchor_id");
  if (error) {
    if ((error as any).code === "23505") return { kind: "memory_already_linked" };
    if ((error as any).code === "23514") return { kind: "memory_not_found" };
    return { kind: "write_failed", detail: `accept: ${error.message ?? error.code ?? "error"}` };
  }
  if (!Array.isArray(data) || data.length === 0) return { kind: "not_found" };
  return { kind: "ok", memoryId };
}

/** Decline an OPEN invitation. Always allowed — declining is an exit, and needs no block read. */
export async function declineInvitation(sc: any, anchorId: string, userId: string): Promise<RespondOutcome> {
  const { data, error } = await sc
    .from("memory_shared_anchor_members")
    .update({ status: "declined" })
    .eq("anchor_id", anchorId)
    .eq("user_id", userId)
    .eq("status", "invited")
    .select("anchor_id");
  if (error) return { kind: "write_failed", detail: `decline: ${error.message ?? error.code ?? "error"}` };
  if (!Array.isArray(data) || data.length === 0) return { kind: "not_found" };
  return { kind: "ok", memoryId: null };
}

/**
 * Leave, at any time. The link to the caller's Memory is cut in the same write.
 * Always allowed — leaving is an exit, and needs no block read. When the host
 * leaves, or one person would be left, 3805 dissolves and erases the anchor.
 */
export async function leaveSharedAnchor(sc: any, anchorId: string, userId: string): Promise<RespondOutcome> {
  const { data, error } = await sc
    .from("memory_shared_anchor_members")
    .update({ status: "left", left_at: new Date().toISOString(), memory_id: null })
    .eq("anchor_id", anchorId)
    .eq("user_id", userId)
    .eq("status", "accepted")
    .select("anchor_id");
  if (error) return { kind: "write_failed", detail: `leave: ${error.message ?? error.code ?? "error"}` };
  if (!Array.isArray(data) || data.length === 0) return { kind: "not_found" };
  return { kind: "ok", memoryId: null };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface AnchorPerson {
  readonly userId: string;
  readonly handle: string | null;
}

export interface AnchorMemberView extends AnchorPerson {
  readonly isYou: boolean;
  /** The member's own linked Memory, ONLY when canReadMemory admits the viewer; else null. */
  readonly memoryId: string | null;
}

export type AnchorView =
  | {
      readonly id: string;
      readonly yourStatus: "accepted";
      /** Two or more accepted members THIS viewer can see. */
      readonly shared: boolean;
      readonly members: readonly AnchorMemberView[];
    }
  | {
      readonly id: string;
      readonly yourStatus: "invited";
      readonly invitedBy: AnchorPerson;
      /** The host's Memory, ONLY when canReadMemory admits the viewer; else null. */
      readonly memoryId: string | null;
    };

export type AnchorViewResult =
  | { readonly kind: "ok"; readonly view: AnchorView }
  | { readonly kind: "not_found" }
  | { readonly kind: "unreadable"; readonly detail: string };

async function handlesOf(sc: any, ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  const { data, error } = await sc
    .from("profiles")
    .select("id, handle, username")
    .in("id", ids as string[]);
  // A handle is a label, not a permission: an unreadable profiles table costs
  // the handle (null), never the membership the ladder already decided.
  if (error) {
    logger.error({ err: error }, "memory shared anchor: member profile read failed — serving members without handles");
    return out;
  }
  for (const p of (data ?? []) as any[]) out.set(String(p.id), resolveHandle(p));
  return out;
}

/**
 * Each linked Memory id the viewer may see: only a live row the member owns, and
 * only through `canReadMemory(viewer, row, "single")`. An unreadable read
 * withholds every id (the members are still shown, unlinked).
 */
async function readableMemoryIds(
  sc: any,
  viewerId: string,
  links: ReadonlyArray<{ userId: string; memoryId: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (links.length === 0) return out;
  const { data, error } = await sc
    .from("memories")
    .select(MEMORY_GATE_COLUMNS)
    .in("id", links.map((l) => l.memoryId))
    .neq("state", "deleted");
  if (error) {
    logger.error({ err: error }, "memory shared anchor: linked Memory read failed — withholding every link");
    return out;
  }
  const byId = new Map<string, any>(((data ?? []) as any[]).map((m) => [String(m.id), m]));
  for (const l of links) {
    const row = byId.get(l.memoryId);
    if (!row || row.owner_id !== l.userId) continue;
    if (await canReadMemory(sc, row, viewerId, "single")) out.set(l.userId, l.memoryId);
  }
  return out;
}

/**
 * One anchor as `viewerId` may see it. Not a member, declined, left, or an
 * invitation from a host the viewer is blocked with: `not_found`, the same as an
 * anchor that does not exist. When block state cannot be read the answer is
 * `unreadable` (the route's 503) — nothing about anyone is served, and nothing
 * is claimed: not "nobody else is here", not "you have no invitation".
 */
export async function anchorViewFor(sc: any, anchorId: string, viewerId: string): Promise<AnchorViewResult> {
  const own = await readOwnRow(sc, anchorId, viewerId);
  if (!own.ok) return { kind: "unreadable", detail: own.detail };
  if (!own.row) return { kind: "not_found" };

  if (own.row.status === "invited") {
    const hostId = own.row.hostId;
    const blocks = await blocksAmong(sc, viewerId, [hostId]);
    if (!blocks.ok) return { kind: "unreadable", detail: blocks.reason };
    if (blocks.blocked.has(hostId)) return { kind: "not_found" };
    const { data: hostRow, error: hostErr } = await sc
      .from("memory_shared_anchor_members")
      .select("memory_id")
      .eq("anchor_id", anchorId)
      .eq("user_id", hostId)
      .eq("status", "accepted")
      .maybeSingle();
    if (hostErr) return { kind: "unreadable", detail: `memory_shared_anchor_members: ${hostErr.message ?? hostErr.code ?? "error"}` };
    const hostMemory = typeof (hostRow as any)?.memory_id === "string" ? String((hostRow as any).memory_id) : null;
    const readable = hostMemory ? await readableMemoryIds(sc, viewerId, [{ userId: hostId, memoryId: hostMemory }]) : new Map();
    const handles = await handlesOf(sc, [hostId]);
    return {
      kind: "ok",
      view: {
        id: anchorId,
        yourStatus: "invited",
        invitedBy: { userId: hostId, handle: handles.get(hostId) ?? null },
        memoryId: readable.get(hostId) ?? null,
      },
    };
  }

  if (own.row.status !== "accepted") return { kind: "not_found" };

  const { data: accepted, error: acceptedErr } = await sc
    .from("memory_shared_anchor_members")
    .select("user_id, memory_id")
    .eq("anchor_id", anchorId)
    .eq("status", "accepted");
  if (acceptedErr) return { kind: "unreadable", detail: `memory_shared_anchor_members: ${acceptedErr.message ?? acceptedErr.code ?? "error"}` };
  const rows = ((accepted ?? []) as any[]).map((r) => ({
    userId: String(r.user_id),
    memoryId: typeof r.memory_id === "string" ? String(r.memory_id) : null,
  }));
  const blocks = await blocksAmong(sc, viewerId, rows.map((r) => r.userId));
  if (!blocks.ok) return { kind: "unreadable", detail: blocks.reason };
  const visible = rows.filter((r) => r.userId === viewerId || !blocks.blocked.has(r.userId));
  const readable = await readableMemoryIds(
    sc,
    viewerId,
    visible.filter((r): r is { userId: string; memoryId: string } => r.memoryId !== null),
  );
  const handles = await handlesOf(sc, visible.map((r) => r.userId));
  const members: AnchorMemberView[] = visible
    .map((r) => ({
      userId: r.userId,
      handle: handles.get(r.userId) ?? null,
      isYou: r.userId === viewerId,
      memoryId: readable.get(r.userId) ?? null,
    }))
    .sort((a, b) => (a.isYou === b.isYou ? a.userId.localeCompare(b.userId) : a.isYou ? -1 : 1));
  return { kind: "ok", view: { id: anchorId, yourStatus: "accepted", shared: members.length >= 2, members } };
}

export type AnchorListResult =
  | { readonly kind: "ok"; readonly anchors: readonly AnchorView[] }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * Every anchor the viewer is invited to or has accepted, each as `anchorViewFor`
 * renders it. A hidden invitation is left out; any unreadable read refuses the
 * whole list (a list that silently dropped an anchor would be a false statement).
 */
export async function listAnchorsFor(sc: any, viewerId: string): Promise<AnchorListResult> {
  const { data, error } = await sc
    .from("memory_shared_anchor_members")
    .select("anchor_id, status")
    .eq("user_id", viewerId)
    .in("status", ["invited", "accepted"])
    .order("invited_at", { ascending: false })
    .limit(SHARED_ANCHOR_LIST_LIMIT);
  if (error) return { kind: "unreadable", detail: `memory_shared_anchor_members: ${error.message ?? error.code ?? "error"}` };
  const anchors: AnchorView[] = [];
  for (const r of (data ?? []) as any[]) {
    const one = await anchorViewFor(sc, String(r.anchor_id), viewerId);
    if (one.kind === "unreadable") return one;
    if (one.kind === "ok") anchors.push(one.view);
  }
  return { kind: "ok", anchors };
}
