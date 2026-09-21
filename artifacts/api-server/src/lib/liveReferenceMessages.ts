/**
 * liveReferenceMessages — the reads and the one write behind Telegraph's live
 * references (lib/liveReference): thread membership, the newest version ids
 * a reference pins to, the messages row a reference rides in, and reading it
 * back. Every failure is a REFUSAL with a name; none of these reads as empty.
 *
 * ── WHY THE WRITE IS THE SERVICE ROLE'S ──────────────────────────────────────
 * public.messages carries `msg_insert ... WITH CHECK (false)` (baseline; read
 * on the lane's replica of the 2026-09-08 production snapshot, and pinned in
 * src/test/db/telegraphLiveReferences.db.test.ts): an authenticated member
 * cannot INSERT a message through PostgREST at all. So the row is written
 * with the service client AFTER membership is established here, by the same
 * predicate `authz.is_active_thread_member` uses — a present member row with
 * `left_at IS NULL`. `msg_select` then serves it to active members and to
 * nobody else; that is the database's rule, and this module does not weaken it.
 *
 * The client is injected; this module names no credential.
 */
import {
  LIVE_REFERENCE_MSG_SUBTYPE,
  LIVE_REFERENCE_MSG_TYPE,
  liveReferenceBody,
  type LiveReference,
} from "./liveReference.js";

export const MESSAGES_TABLE = "messages";
export const THREAD_MEMBERS_TABLE = "message_thread_members";
export const SNAPSHOT_VERSIONS_TABLE = "intel_state_snapshot_versions";
/** Versions read per claim type — the newest is the one that can pin. */
export const VERSIONS_PER_TYPE = 5;

export type MembershipResult = { ok: true; member: boolean } | { ok: false; reason: "no_client" | "error" };

/** Is `userId` an ACTIVE member of `threadId` — present and not left. Mirrors authz.is_active_thread_member. */
export async function isActiveThreadMember(sc: any, threadId: string, userId: string): Promise<MembershipResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc
      .from(THREAD_MEMBERS_TABLE)
      .select("user_id, left_at")
      .eq("thread_id", threadId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { ok: false, reason: "error" };
    if (!data) return { ok: true, member: false };
    return { ok: true, member: (data as { left_at?: unknown }).left_at == null };
  } catch {
    return { ok: false, reason: "error" };
  }
}

function isMissingRelation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "42P01" || code === "PGRST205") return true;
  const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return msg.includes("does not exist") || msg.includes("could not find the table");
}

export type LatestVersionsResult =
  | { ok: true; versions: Map<string, { id: string; value: unknown }> }
  | { ok: false; reason: "no_client" | "versions_unavailable" | "error" };

/** The newest privacy-eligible version per claim type, from the projection's own record (2273). */
export async function readLatestVersions(sc: any, subjectId: string, claimTypes: readonly string[]): Promise<LatestVersionsResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  if (!subjectId || claimTypes.length === 0) return { ok: true, versions: new Map() };
  try {
    const { data, error } = await sc
      .from(SNAPSHOT_VERSIONS_TABLE)
      .select("id, claim_type, value, generated_at")
      .eq("subject_id", subjectId)
      .eq("privacy_eligible", true)
      .in("claim_type", claimTypes)
      .order("generated_at", { ascending: false })
      .limit(VERSIONS_PER_TYPE * claimTypes.length);
    if (error) return { ok: false, reason: isMissingRelation(error) ? "versions_unavailable" : "error" };
    // Newest first is asserted here as well as asked of the query: the pin
    // must be the LATEST version of a type, whatever order the rows arrived in.
    const rows = (((data as any[]) ?? []) as Array<{ id?: unknown; claim_type?: unknown; value?: unknown; generated_at?: unknown }>)
      .filter((r) => r && typeof r.claim_type === "string" && typeof r.id === "string")
      .sort((a, b) => (Date.parse(String(b.generated_at ?? "")) || 0) - (Date.parse(String(a.generated_at ?? "")) || 0));
    const versions = new Map<string, { id: string; value: unknown }>();
    for (const row of rows) {
      const claimType = row.claim_type as string;
      if (!versions.has(claimType)) versions.set(claimType, { id: row.id as string, value: row.value });
    }
    return { ok: true, versions };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type InsertReferenceResult = { ok: true; messageId: string; createdAt: string | null } | { ok: false; reason: "no_client" | "error" };

/** Write the card. Service client — see the header — after the caller established membership. */
export async function insertLiveReferenceMessage(
  sc: any,
  input: { threadId: string; senderId: string; reference: LiveReference },
): Promise<InsertReferenceResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc
      .from(MESSAGES_TABLE)
      .insert({
        thread_id: input.threadId,
        sender_id: input.senderId,
        body: liveReferenceBody(input.reference),
        msg_type: LIVE_REFERENCE_MSG_TYPE,
        subtype: LIVE_REFERENCE_MSG_SUBTYPE,
      })
      .select("id, created_at")
      .single();
    if (error || !data || typeof (data as any).id !== "string") return { ok: false, reason: "error" };
    const createdAt = (data as any).created_at;
    return { ok: true, messageId: (data as any).id, createdAt: typeof createdAt === "string" ? createdAt : null };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export interface LiveReferenceMessageRow {
  id: string;
  threadId: string;
  senderId: string | null;
  createdAt: string | null;
  /** The stored body, unparsed — lib/liveReference.parseLiveReference decides what it is. */
  body: string;
}

export type ReadReferenceResult =
  | { ok: true; message: LiveReferenceMessageRow }
  | { ok: false; reason: "no_client" | "not_found" | "error" };

/** The card by id. Not found when absent, deleted, or not a live-reference card. Membership is the caller's check. */
export async function readLiveReferenceMessage(sc: any, messageId: string): Promise<ReadReferenceResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc
      .from(MESSAGES_TABLE)
      .select("id, thread_id, sender_id, body, msg_type, subtype, created_at, deleted_at")
      .eq("id", messageId)
      .maybeSingle();
    if (error) return { ok: false, reason: "error" };
    if (!data) return { ok: false, reason: "not_found" };
    const row = data as Record<string, unknown>;
    if (row.subtype !== LIVE_REFERENCE_MSG_SUBTYPE || row.deleted_at != null) return { ok: false, reason: "not_found" };
    if (typeof row.body !== "string" || typeof row.thread_id !== "string") return { ok: false, reason: "not_found" };
    return {
      ok: true,
      message: {
        id: String(row.id),
        threadId: row.thread_id,
        senderId: typeof row.sender_id === "string" ? row.sender_id : null,
        createdAt: typeof row.created_at === "string" ? row.created_at : null,
        body: row.body,
      },
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}
