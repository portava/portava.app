/**
 * memorySharedExperiences — §5 "Shared experiences" (migration 3997, census H53).
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt §5:
 *   "A shared experience is not one globally editable personal Memory. Prefer a
 *    shared-experience anchor plus separate personal Memories. Mutual 'Remember
 *    this together' creates an explicitly shared object only after participant
 *    consent."
 *   §10 "Being tagged or referenced does not make another user a co-owner."
 *   §23 "Participant membership alone does not grant full Memory access."
 *   §25 fixture "Blocked participant after shared experience."
 *
 * THE SHAPE (the SQL is the authority; this module is its only caller):
 *   - The owner of a Memory (the HOST) invites a person who holds an APPROVED
 *     tag on it — the existing evidence that they were there. Nobody else.
 *   - The invitee accepts (optionally linking ONE of their own live Memories) or
 *     declines. The shared experience is created in the transaction of the FIRST
 *     acceptance and never before: until somebody consents there is no shared
 *     object, only a question.
 *   - A participant leaves in one step; when nobody is left the experience is
 *     erased. The host can end it for everyone, which erases every invitation
 *     too. Deleting the host's Memory or account erases it (3997's cascades and
 *     the deleted-Memory trigger).
 *   - No Memory changes owner and none becomes editable by anyone else. The
 *     anchor grants NO read: a member's linked Memory id is shown to a viewer
 *     only when `canReadMemory` already admits that viewer, and a member blocked
 *     in either direction is not shown at all (fail closed: an unreadable block
 *     read hides everyone but the viewer).
 *
 * Every read binds `.error` (supabase-js resolves on a database error), and an
 * unreadable read is a refusal, never "no shared experience" (§28.11).
 */
import { readFlagState } from "../../lib/capability/schemaCapability.js";
import { blockedAmong, canReadMemory, isBlocked } from "./memoryReadPolicy.js"; import { isTableAbsentError } from "../../lib/tableAbsence.js";

export const MEMORY_SHARED_EXPERIENCES_FLAG = "memory_shared_experiences_enabled";
export const SHARED_EXPERIENCES_TABLE = "memory_shared_experiences";
export const SHARED_INVITATIONS_TABLE = "memory_shared_experience_invitations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_READ_COLUMNS = "id, owner_id, title, state, visibility, allowed_user_ids, hidden_user_ids, trip_id";

export type SharedFailure = "disabled" | "unavailable" | "invalid" | "not_found" | "not_invitable" | "conflict";
export type SharedResult<T> = { ok: true; value: T } | { ok: false; reason: SharedFailure; detail: string };

const fail = (reason: SharedFailure, detail: string): { ok: false; reason: SharedFailure; detail: string } => ({ ok: false, reason, detail });

async function gate(sc: any): Promise<SharedResult<true>> {
  const s = await readFlagState(sc, MEMORY_SHARED_EXPERIENCES_FLAG);
  if (s === "on") return { ok: true, value: true };
  if (s === "unreadable") return fail("unavailable", "the shared-experience flag could not be read");
  return fail("disabled", "memory_shared_experiences_enabled is off");
}

async function rpcOutcome(sc: any, fn: string, args: Record<string, unknown>): Promise<SharedResult<Record<string, unknown>>> {
  const { data, error } = await sc.rpc(fn, args);
  if (error) return fail("unavailable", `${fn}: ${error.message ?? "failed"}`);
  if (!data || typeof data !== "object" || typeof (data as any).outcome !== "string") {
    return fail("unavailable", `${fn} returned no outcome`);
  }
  return { ok: true, value: data as Record<string, unknown> };
}

export interface PersonCard { userId: string; name: string | null; handle: string | null; avatarUrl: string | null }

async function readPeople(sc: any, ids: readonly string[]): Promise<SharedResult<Map<string, PersonCard>>> {
  const out = new Map<string, PersonCard>();
  if (ids.length === 0) return { ok: true, value: out };
  const { data, error } = await sc.from("profiles").select("id, name, handle, avatar_url").in("id", [...ids]);
  if (error || !Array.isArray(data)) return fail("unavailable", `profiles: ${error?.message ?? "no row array"}`);
  for (const p of data as any[]) {
    if (typeof p?.id === "string") out.set(p.id, { userId: p.id, name: p.name ?? null, handle: p.handle ?? null, avatarUrl: p.avatar_url ?? null });
  }
  return { ok: true, value: out };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** The host invites one person who holds an approved tag on the host's Memory. */
export async function inviteToSharedExperience(
  sc: any,
  input: { hostId: string; memoryId: string; inviteeId: string },
): Promise<SharedResult<{ outcome: "invited" | "already_invited" | "already_member"; invitationId: string | null }>> {
  if (!UUID_RE.test(input.memoryId) || !UUID_RE.test(input.inviteeId)) return fail("invalid", "ids must be UUIDs");
  const g = await gate(sc);
  if (!g.ok) return g;
  // A block in either direction makes the person not invitable, and is not
  // named as the reason (an invitation must not become a block oracle).
  if (await isBlocked(sc, input.hostId, input.inviteeId)) return fail("not_invitable", "this person cannot be invited");
  const r = await rpcOutcome(sc, "memory_shared_experience_invite", {
    p_host_id: input.hostId, p_memory_id: input.memoryId, p_invitee_id: input.inviteeId,
  });
  if (!r.ok) return r;
  const outcome = String(r.value.outcome);
  const invitationId = typeof r.value.invitation_id === "string" ? r.value.invitation_id : null;
  if (outcome === "invited" || outcome === "already_invited" || outcome === "already_member") {
    return { ok: true, value: { outcome, invitationId } };
  }
  if (outcome === "disabled") return fail("disabled", "the database refused: flag off");
  if (outcome === "not_found") return fail("not_found", "no live Memory of yours with that id");
  // not_invitable, answered (declined or left: final for this Memory)
  return fail("not_invitable", outcome === "answered" ? "this person already answered" : "this person cannot be invited");
}

/** The host withdraws a PENDING invitation. An answered one is not theirs to erase. */
export async function withdrawInvitation(
  sc: any,
  input: { hostId: string; memoryId: string; inviteeId: string },
): Promise<SharedResult<{ withdrawn: boolean }>> {
  if (!UUID_RE.test(input.memoryId) || !UUID_RE.test(input.inviteeId)) return fail("invalid", "ids must be UUIDs");
  // NO flag gate, on purpose (H53): taking back a question is a way OUT, and no
  // switch may strand it. Only the host's own pending row matches the filter.
  const { data, error } = await sc.from(SHARED_INVITATIONS_TABLE).delete()
    .eq("host_memory_id", input.memoryId).eq("host_id", input.hostId)
    .eq("invitee_id", input.inviteeId).eq("status", "pending")
    .select("id");
  if (error) return fail("unavailable", `withdraw: ${error.message ?? "failed"}`);
  return { ok: true, value: { withdrawn: Array.isArray(data) && data.length > 0 } };
}

/** The invitee's answer. Accepting the first time creates the shared experience. */
export async function respondToInvitation(
  sc: any,
  input: { invitationId: string; inviteeId: string; accept: boolean; participantMemoryId: string | null },
): Promise<SharedResult<{ outcome: "accepted" | "declined"; experienceId: string | null }>> {
  if (!UUID_RE.test(input.invitationId) || (input.participantMemoryId !== null && !UUID_RE.test(input.participantMemoryId))) {
    return fail("invalid", "ids must be UUIDs");
  }
  // Only ACCEPTING is gated: it creates sharing. A decline is a way OUT (H53).
  if (input.accept) {
    const g = await gate(sc); if (!g.ok) return g;
    // A block that arrived after the invitation stops the acceptance: the
    // host's invitation is not a way past it, in either direction.
    const inv = await sc.from(SHARED_INVITATIONS_TABLE).select("host_id")
      .eq("id", input.invitationId).eq("invitee_id", input.inviteeId).maybeSingle();
    if (inv.error) return fail("unavailable", `invitation: ${inv.error.message ?? "failed"}`);
    if (!inv.data) return fail("not_found", "no pending invitation of yours with that id");
    if (await isBlocked(sc, input.inviteeId, String(inv.data.host_id))) return fail("not_found", "no pending invitation of yours with that id");
  }
  const r = await rpcOutcome(sc, "memory_shared_experience_respond", {
    p_invitation_id: input.invitationId, p_invitee_id: input.inviteeId,
    p_accept: input.accept, p_participant_memory_id: input.participantMemoryId,
  });
  if (!r.ok) return r;
  const outcome = String(r.value.outcome);
  if (outcome === "accepted" || outcome === "declined") {
    return { ok: true, value: { outcome, experienceId: typeof r.value.experience_id === "string" ? r.value.experience_id : null } };
  }
  if (outcome === "disabled") return fail("disabled", "the database refused: flag off");
  if (outcome === "memory_not_linkable") return fail("conflict", "that Memory cannot be linked: it is not yours, not live, or already linked");
  if (outcome === "not_invitable") return fail("not_found", "the invitation no longer stands");
  if (outcome === "host_memory_gone") return fail("not_found", "the Memory you were invited to is gone");
  return fail("not_found", "no pending invitation of yours with that id");
}

/** A participant leaves. The experience dissolves when nobody is left. */
export async function leaveSharedExperience(
  sc: any,
  input: { experienceId: string; userId: string },
): Promise<SharedResult<{ left: true }>> {
  if (!UUID_RE.test(input.experienceId)) return fail("invalid", "ids must be UUIDs");
  // NO flag gate, on purpose (H53, as 3997's SQL says): turning the feature off
  // must never trap a person in it. The SQL admits only this user's accepted row.
  const r = await rpcOutcome(sc, "memory_shared_experience_leave", { p_experience_id: input.experienceId, p_user_id: input.userId });
  if (!r.ok) return r;
  if (r.value.outcome === "left") return { ok: true, value: { left: true } };
  return fail("not_found", "you are not a participant of that shared experience");
}

/** The host ends it for everyone: the experience and every invitation are erased. */
export async function endSharedExperience(
  sc: any,
  input: { hostId: string; memoryId: string },
): Promise<SharedResult<{ ended: true }>> {
  if (!UUID_RE.test(input.memoryId)) return fail("invalid", "ids must be UUIDs");
  // NO flag gate, on purpose (H53): ending is the host's way OUT; the SQL erases
  // only what is on a Memory this host owns.
  const r = await rpcOutcome(sc, "memory_shared_experience_end", { p_host_id: input.hostId, p_memory_id: input.memoryId });
  if (!r.ok) return r;
  if (r.value.outcome === "ended") return { ok: true, value: { ended: true } };
  return fail("not_found", "no shared experience or invitation on a Memory of yours");
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface SharedMember extends PersonCard {
  role: "host" | "participant";
  /** This member's own Memory in the experience — only when the VIEWER may already read it. */
  memoryId: string | null;
}

export interface SharedExperienceView {
  experienceId: string | null;
  viewerRole: "host" | "participant";
  hostMemoryId: string;
  members: SharedMember[];
  /** Host only: who has been asked and has not answered. */
  pending: PersonCard[];
  /** Host only: people with an approved tag on this Memory who could be asked. */
  invitable: PersonCard[];
}

/**
 * The shared experience a Memory belongs to, as `viewerId` may see it. The
 * Memory may be the host's (the anchor's own) or a participant's linked one.
 * Null when there is none the viewer is part of — a stranger learns nothing.
 */
export async function readSharedExperienceForMemory(
  sc: any,
  input: { viewerId: string; memoryId: string },
): Promise<SharedResult<SharedExperienceView | null>> {
  if (!UUID_RE.test(input.memoryId)) return fail("invalid", "ids must be UUIDs");
  const g = await gate(sc);
  if (!g.ok) return g;

  // Which host Memory is this about?
  let hostMemoryId = input.memoryId;
  const linked = await sc.from(SHARED_INVITATIONS_TABLE).select("host_memory_id")
    .eq("participant_memory_id", input.memoryId).eq("status", "accepted").maybeSingle();
  if (linked.error) return fail("unavailable", `invitations: ${linked.error.message ?? "failed"}`);
  if (linked.data?.host_memory_id) hostMemoryId = String(linked.data.host_memory_id);

  const host = await sc.from("memories").select(MEMORY_READ_COLUMNS).eq("id", hostMemoryId).maybeSingle();
  if (host.error) return fail("unavailable", `memories: ${host.error.message ?? "failed"}`);
  if (!host.data || host.data.state === "deleted" || host.data.state === "removed") return { ok: true, value: null };
  const hostId = String(host.data.owner_id);

  const exp = await sc.from(SHARED_EXPERIENCES_TABLE).select("id, host_id, host_memory_id")
    .eq("host_memory_id", hostMemoryId).maybeSingle();
  if (exp.error) return fail("unavailable", `experiences: ${exp.error.message ?? "failed"}`);
  const experienceId: string | null = exp.data?.id ? String(exp.data.id) : null;

  const invs = await sc.from(SHARED_INVITATIONS_TABLE)
    .select("id, invitee_id, status, participant_memory_id, experience_id")
    .eq("host_memory_id", hostMemoryId);
  if (invs.error || !Array.isArray(invs.data)) return fail("unavailable", `invitations: ${invs.error?.message ?? "no row array"}`);
  const accepted = (invs.data as any[]).filter((i) => i.status === "accepted" && experienceId !== null && i.experience_id === experienceId);

  const viewerIsHost = input.viewerId === hostId;
  const viewerIsParticipant = accepted.some((i) => i.invitee_id === input.viewerId);
  if (!viewerIsHost && !viewerIsParticipant) return { ok: true, value: null };
  if (!viewerIsHost && experienceId === null) return { ok: true, value: null };

  const everyone = [hostId, ...accepted.map((i) => String(i.invitee_id))];
  const blocks = await blockedAmong(sc, input.viewerId, everyone);
  // Fail closed: if blocks cannot be read, show nobody but the viewer.
  const hidden = (id: string) => id !== input.viewerId && (blocks.ok ? blocks.blocked.has(id) : true);
  const visibleIds = everyone.filter((id) => !hidden(id));

  // Linked Memories: shown only when the viewer may already read them.
  const linkedIds = accepted.map((i) => i.participant_memory_id).filter((m): m is string => typeof m === "string");
  const linkedRows = new Map<string, any>();
  if (linkedIds.length > 0) {
    const lm = await sc.from("memories").select(MEMORY_READ_COLUMNS).in("id", linkedIds);
    if (lm.error || !Array.isArray(lm.data)) return fail("unavailable", `memories: ${lm.error?.message ?? "no row array"}`);
    for (const m of lm.data as any[]) linkedRows.set(String(m.id), m);
  }
  const readable = async (row: any): Promise<boolean> => (row ? canReadMemory(sc, row, input.viewerId, "single") : false);

  const pendingIds = viewerIsHost ? (invs.data as any[]).filter((i) => i.status === "pending").map((i) => String(i.invitee_id)) : [];
  let invitableIds: string[] = [];
  if (viewerIsHost) {
    const tags = await sc.from("memory_tags").select("tagged_user_id, status").eq("memory_id", hostMemoryId).eq("status", "approved");
    if (tags.error || !Array.isArray(tags.data)) return fail("unavailable", `memory_tags: ${tags.error?.message ?? "no row array"}`);
    const asked = new Set((invs.data as any[]).map((i) => String(i.invitee_id)));
    invitableIds = (tags.data as any[]).map((t) => String(t.tagged_user_id)).filter((id) => id !== hostId && !asked.has(id));
  }
  const extraBlocks = viewerIsHost ? await blockedAmong(sc, input.viewerId, [...pendingIds, ...invitableIds]) : { ok: true as const, blocked: new Set<string>() };
  const notBlocked = (id: string) => extraBlocks.ok && !extraBlocks.blocked.has(id);

  const people = await readPeople(sc, [...new Set([...visibleIds, ...pendingIds.filter(notBlocked), ...invitableIds.filter(notBlocked)])]);
  if (!people.ok) return people;
  const card = (id: string): PersonCard => people.value.get(id) ?? { userId: id, name: null, handle: null, avatarUrl: null };

  const members: SharedMember[] = [];
  if (visibleIds.includes(hostId)) {
    members.push({ ...card(hostId), role: "host", memoryId: (await readable(host.data)) ? hostMemoryId : null });
  }
  for (const i of accepted) {
    const id = String(i.invitee_id);
    if (!visibleIds.includes(id)) continue;
    const mine = typeof i.participant_memory_id === "string" ? i.participant_memory_id : null;
    members.push({ ...card(id), role: "participant", memoryId: mine && (await readable(linkedRows.get(mine))) ? mine : null });
  }

  return {
    ok: true,
    value: {
      experienceId,
      viewerRole: viewerIsHost ? "host" : "participant",
      hostMemoryId,
      members,
      pending: pendingIds.filter(notBlocked).map(card),
      invitable: invitableIds.filter(notBlocked).map(card),
    },
  };
}

export interface InvitationView {
  invitationId: string;
  host: PersonCard;
  /** The host's Memory title, only when the invitee may already read that Memory. */
  memoryTitle: string | null;
  memoryId: string | null;
  invitedAt: string | null;
}

/** My pending invitations, minus any whose host is blocked in either direction. */
export async function listMyInvitations(sc: any, viewerId: string): Promise<SharedResult<InvitationView[]>> {
  const g = await gate(sc);
  if (!g.ok) return g;
  const invs = await sc.from(SHARED_INVITATIONS_TABLE).select("id, host_id, host_memory_id, created_at")
    .eq("invitee_id", viewerId).eq("status", "pending");
  if (invs.error || !Array.isArray(invs.data)) return fail("unavailable", `invitations: ${invs.error?.message ?? "no row array"}`);
  const rows = invs.data as any[];
  if (rows.length === 0) return { ok: true, value: [] };
  const blocks = await blockedAmong(sc, viewerId, rows.map((r) => String(r.host_id)));
  if (!blocks.ok) return fail("unavailable", "blocks could not be read");
  const kept = rows.filter((r) => !blocks.blocked.has(String(r.host_id)));
  const mems = await sc.from("memories").select(MEMORY_READ_COLUMNS).in("id", kept.map((r) => String(r.host_memory_id)));
  if (mems.error || !Array.isArray(mems.data)) return fail("unavailable", `memories: ${mems.error?.message ?? "no row array"}`);
  const byId = new Map((mems.data as any[]).map((m) => [String(m.id), m]));
  const people = await readPeople(sc, [...new Set(kept.map((r) => String(r.host_id)))]);
  if (!people.ok) return people;
  const out: InvitationView[] = [];
  for (const r of kept) {
    const m = byId.get(String(r.host_memory_id));
    if (!m || m.state === "deleted" || m.state === "removed") continue;
    const canSee = await canReadMemory(sc, m, viewerId, "single");
    out.push({
      invitationId: String(r.id),
      host: people.value.get(String(r.host_id)) ?? { userId: String(r.host_id), name: null, handle: null, avatarUrl: null },
      memoryTitle: canSee ? (m.title ?? null) : null,
      memoryId: canSee ? String(m.id) : null,
      invitedAt: r.created_at ?? null,
    });
  }
  return { ok: true, value: out };
}

// ── The ways out, with the flag OFF ──────────────────────────────────────────

export interface SharedExits {
  /** Shared experiences I joined (accepted), each leavable by its id. */
  memberships: Array<{ experienceId: string; myMemoryId: string | null }>;
  /** Invitations I have not answered, each declinable by its id. */
  invitations: Array<{ invitationId: string }>;
  /** My own Memories that host an experience or an unanswered invitation, each endable. */
  hosting: Array<{ hostMemoryId: string }>;
}

/**
 * Everything the caller can step OUT of, and nothing else — readable whatever
 * memory_shared_experiences_enabled says.
 *
 * "Never trap a person" (H53; 3997's FLAGS paragraph): with the flag off,
 * decline, withdraw, leave and end all run, but every read that would reveal
 * the ids they take is gated, so a person who joined while it was on had no way
 * to find the experience id to leave by. This read returns only the caller's
 * OWN rows, as ids: their accepted memberships (with their own linked Memory
 * id, which is theirs), their pending invitations, and their own Memories that
 * host something. No other member, no host, no title, no count of anyone else —
 * the minimum an exit control needs. Blocks are deliberately NOT applied: a
 * block must never be the thing that keeps someone in.
 *
 * Tables absent (3997 not applied) is the truth "there is nothing to leave",
 * answered as empty lists. Any other failed read is `unavailable`, never empty.
 */
export async function listMyExits(sc: any, viewerId: string): Promise<SharedResult<SharedExits>> {
  const out: SharedExits = { memberships: [], invitations: [], hosting: [] };
  if (!UUID_RE.test(viewerId)) return fail("invalid", "viewer id must be a UUID");
  const mine = await sc.from(SHARED_INVITATIONS_TABLE).select("id, status, experience_id, participant_memory_id")
    .eq("invitee_id", viewerId).in("status", ["pending", "accepted"]);
  if (mine.error) {
    if (isTableAbsentError(mine.error)) return { ok: true, value: out };
    return fail("unavailable", `invitations: ${mine.error.message ?? "failed"}`);
  }
  if (!Array.isArray(mine.data)) return fail("unavailable", "invitations: no row array");
  for (const r of mine.data as any[]) {
    if (r.status === "pending" && typeof r.id === "string") out.invitations.push({ invitationId: r.id });
    if (r.status === "accepted" && typeof r.experience_id === "string") {
      out.memberships.push({ experienceId: r.experience_id, myMemoryId: typeof r.participant_memory_id === "string" ? r.participant_memory_id : null });
    }
  }
  const [hostedExp, hostedInv] = await Promise.all([
    sc.from(SHARED_EXPERIENCES_TABLE).select("host_memory_id").eq("host_id", viewerId),
    sc.from(SHARED_INVITATIONS_TABLE).select("host_memory_id").eq("host_id", viewerId).eq("status", "pending"),
  ]);
  for (const [name, r] of [[SHARED_EXPERIENCES_TABLE, hostedExp], [SHARED_INVITATIONS_TABLE, hostedInv]] as const) {
    if (r.error || !Array.isArray(r.data)) return fail("unavailable", `${name}: ${r.error?.message ?? "no row array"}`);
  }
  const hosted = new Set<string>();
  for (const r of [...(hostedExp.data as any[]), ...(hostedInv.data as any[])]) if (typeof r.host_memory_id === "string") hosted.add(r.host_memory_id);
  out.hosting = [...hosted].map((hostMemoryId) => ({ hostMemoryId }));
  return { ok: true, value: out };
}
