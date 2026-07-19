/**
 * calls/callStoreAdapter — CallStore port over the call tables.
 *
 * - Status transitions are compare-and-set (`UPDATE … WHERE status = from`)
 *   so concurrent reconciliation cannot double-apply.
 * - Terminal outcomes write the contextual call-history system message into
 *   the associated Telegraph conversation using the foundation's
 *   callHistoryLine() formatter (mirrors emitBookingMilestone).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallStore } from "./callReconciler";
import { callHistoryLine } from "./callStateMachine";
import type { CallParticipant, CallSession, CallStatus } from "./callTypes";

export type StoredCallSession = CallSession & { roomName: string };

export function mapSessionRow(r: any): StoredCallSession {
  return {
    id: r.id,
    callType: r.call_type,
    contextType: r.context_type,
    contextId: r.context_id,
    threadId: r.thread_id ?? null,
    startedBy: r.started_by,
    status: r.status,
    startedAt: r.started_at,
    connectedAt: r.connected_at ?? null,
    endedAt: r.ended_at ?? null,
    roomName: r.room_name,
  };
}

export function mapParticipantRow(r: any): CallParticipant {
  return {
    callId: r.call_id,
    userId: r.user_id,
    role: r.role,
    status: r.status,
    invitedAt: r.invited_at ?? null,
    joinedAt: r.joined_at ?? null,
    leftAt: r.left_at ?? null,
  };
}

const SESSION_COLS =
  "id, call_type, context_type, context_id, thread_id, room_name, started_by, status, started_at, connected_at, ended_at";

export interface CallStoreEx extends CallStore {
  createSession(input: {
    callType: CallSession["callType"];
    contextType: CallSession["contextType"];
    contextId: string;
    threadId: string | null;
    roomName: string;
    startedBy: string;
    participants: Array<{ userId: string; role: CallParticipant["role"]; status: CallParticipant["status"] }>;
  }): Promise<StoredCallSession>;
  getParticipants(callId: string): Promise<CallParticipant[]>;
  upsertParticipant(
    callId: string,
    userId: string,
    role: CallParticipant["role"],
    status: CallParticipant["status"],
  ): Promise<void>;
  setParticipantStatus(callId: string, userId: string, status: CallParticipant["status"]): Promise<void>;
  /** Most recent open (ringing|active) session the user participates in. */
  findActiveSessionForUser(userId: string): Promise<StoredCallSession | null>;
  /** Open DIRECT sessions where both users are participants (block force-end). */
  findOpenDirectSessionsBetween(userA: string, userB: string): Promise<StoredCallSession[]>;
}

export function makeCallStore(sc: SupabaseClient): CallStoreEx {
  return {
    async createSession(input) {
      const { data, error } = await sc
        .from("call_sessions")
        .insert({
          call_type: input.callType,
          context_type: input.contextType,
          context_id: input.contextId,
          thread_id: input.threadId,
          room_name: input.roomName,
          started_by: input.startedBy,
          status: "ringing",
        })
        .select(SESSION_COLS)
        .single();
      if (error || !data) throw new Error(`createSession failed: ${error?.message ?? "no row"}`);
      const session = mapSessionRow(data);
      if (input.participants.length > 0) {
        const { error: pErr } = await sc.from("call_participants").insert(
          input.participants.map((p) => ({
            call_id: session.id,
            user_id: p.userId,
            role: p.role,
            status: p.status,
          })),
        );
        if (pErr) {
          // A session without its participants is unusable — surface loudly.
          await sc.from("call_sessions").delete().eq("id", session.id);
          throw new Error(`createSession participants failed: ${pErr.message}`);
        }
      }
      return session;
    },

    async getSession(callId) {
      const { data } = await sc.from("call_sessions").select(SESSION_COLS).eq("id", callId).maybeSingle();
      return data ? mapSessionRow(data) : null;
    },

    async getSessionByRoom(roomName) {
      const { data } = await sc
        .from("call_sessions")
        .select(SESSION_COLS)
        .eq("room_name", roomName)
        .maybeSingle();
      return data ? mapSessionRow(data) : null;
    },

    async applyTransition(callId, fromStatus, toStatus, patch) {
      const update: Record<string, unknown> = {
        status: toStatus,
        updated_at: new Date().toISOString(),
      };
      if (patch.connectedAt) update.connected_at = patch.connectedAt;
      if (patch.endedAt) update.ended_at = patch.endedAt;
      const { data, error } = await sc
        .from("call_sessions")
        .update(update)
        .eq("id", callId)
        .eq("status", fromStatus) // compare-and-set
        .select("id");
      if (error) throw new Error(`applyTransition failed: ${error.message}`);
      return ((data as any[]) ?? []).length > 0;
    },

    async markParticipantJoined(callId, userId, atIso) {
      await sc
        .from("call_participants")
        .update({ status: "joined", joined_at: atIso })
        .eq("call_id", callId)
        .eq("user_id", userId)
        .in("status", ["invited", "ringing", "joined"]);
    },

    async markParticipantLeft(callId, userId, atIso) {
      await sc
        .from("call_participants")
        .update({ status: "left", left_at: atIso })
        .eq("call_id", callId)
        .eq("user_id", userId)
        .eq("status", "joined");
    },

    async listOpenSessions() {
      const { data } = await sc
        .from("call_sessions")
        .select(SESSION_COLS)
        .in("status", ["ringing", "active"]);
      return (((data as any[]) ?? [])).map(mapSessionRow);
    },

    async writeCallHistoryMessage(session) {
      // Contextual history lives in the Telegraph conversation; sessions
      // without a thread (e.g. event rooms) simply have no history line.
      if (!session.threadId) return;
      try {
        await sc.from("messages").insert({
          thread_id: session.threadId,
          sender_id: session.startedBy,
          body: callHistoryLine(session),
          msg_type: "system",
          subtype: `call_${session.status}`,
        });
      } catch {
        /* non-critical — never fail call teardown on a history write */
      }
    },

    async getParticipants(callId) {
      const { data } = await sc
        .from("call_participants")
        .select("call_id, user_id, role, status, invited_at, joined_at, left_at")
        .eq("call_id", callId);
      return (((data as any[]) ?? [])).map(mapParticipantRow);
    },

    async upsertParticipant(callId, userId, role, status) {
      await sc
        .from("call_participants")
        .upsert(
          { call_id: callId, user_id: userId, role, status },
          { onConflict: "call_id,user_id" },
        );
    },

    async setParticipantStatus(callId, userId, status) {
      await sc
        .from("call_participants")
        .update({ status })
        .eq("call_id", callId)
        .eq("user_id", userId);
    },

    async findActiveSessionForUser(userId) {
      const { data: parts } = await sc
        .from("call_participants")
        .select("call_id")
        .eq("user_id", userId)
        .not("status", "in", "(declined,removed)");
      const callIds = [...new Set((((parts as any[]) ?? [])).map((p) => p.call_id))];
      if (callIds.length === 0) return null;
      const { data } = await sc
        .from("call_sessions")
        .select(SESSION_COLS)
        .in("id", callIds)
        .in("status", ["ringing", "active"])
        .order("started_at", { ascending: false })
        .limit(1);
      const row = ((data as any[]) ?? [])[0];
      return row ? mapSessionRow(row) : null;
    },

    async findOpenDirectSessionsBetween(userA, userB) {
      const { data: sessions } = await sc
        .from("call_sessions")
        .select(SESSION_COLS)
        .in("status", ["ringing", "active"])
        .in("context_type", ["telegraph_dm", "rent_a_buddy"]);
      const open = (((sessions as any[]) ?? [])).map(mapSessionRow);
      if (open.length === 0) return [];
      const { data: parts } = await sc
        .from("call_participants")
        .select("call_id, user_id")
        .in("call_id", open.map((s) => s.id))
        .in("user_id", [userA, userB]);
      const byCall = new Map<string, Set<string>>();
      for (const p of (parts as any[]) ?? []) {
        if (!byCall.has(p.call_id)) byCall.set(p.call_id, new Set());
        byCall.get(p.call_id)!.add(p.user_id);
      }
      return open.filter((s) => (byCall.get(s.id)?.size ?? 0) === 2);
    },
  };
}

export type { CallStatus };
