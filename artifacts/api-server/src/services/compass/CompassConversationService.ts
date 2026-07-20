/**
 * CompassConversationService
 *
 * Manages per-user conversation sessions for the Compass AI assistant.
 *
 * Session rules:
 *  - A new conversation is created when: no conversationId is supplied, OR the
 *    found row's last_active_at is older than INACTIVITY_THRESHOLD_MS (6 h).
 *  - History is capped at MAX_HISTORY_MESSAGES (20) and further trimmed to a
 *    TOKEN_BUDGET_CHARS (~6 000 token) ceiling by dropping the oldest messages.
 *
 * The service client bypasses RLS; ownership is enforced by userId WHERE clauses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const INACTIVITY_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_HISTORY_MESSAGES = 20;
const TOKEN_BUDGET_CHARS   = 24_000; // ≈6 000 tokens at 4 chars/token

export interface ConversationMessage {
  role:          "user" | "assistant";
  content:       string;
  payload?:      Record<string, unknown>;
  promptVersion?: string;
  createdAt:     Date;
}

// ── getOrCreateConversation ───────────────────────────────────────────────────

/**
 * Returns the conversation ID to use for this request.
 *
 * - If incomingConvId is supplied and belongs to userId and is not stale → reuse it.
 * - Otherwise create a fresh conversation row and return its ID.
 *
 * Throws if the DB insert fails (caller should handle with an honest error response).
 */
export async function getOrCreateConversation(
  sc: SupabaseClient,
  userId: string,
  incomingConvId?: string,
): Promise<string> {
  if (incomingConvId) {
    const { data } = await sc
      .from("compass_conversations")
      .select("id, last_active_at")
      .eq("id", incomingConvId)
      .eq("user_id", userId)
      .maybeSingle();

    if (data) {
      const lastActive = new Date((data as any).last_active_at as string).getTime();
      const isStale    = Date.now() - lastActive > INACTIVITY_THRESHOLD_MS;
      if (!isStale) return (data as any).id as string;
    }
  }

  const { data: created, error } = await sc
    .from("compass_conversations")
    .insert({ user_id: userId })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`compass_conversations: insert failed — ${error?.message ?? "no data"}`);
  }
  return (created as any).id as string;
}

// ── loadHistory ───────────────────────────────────────────────────────────────

/**
 * Returns the last MAX_HISTORY_MESSAGES messages (chronological order),
 * further trimmed so the total character count stays within TOKEN_BUDGET_CHARS.
 * Oldest messages are dropped first when the budget is exceeded.
 */
export async function loadHistory(
  sc: SupabaseClient,
  conversationId: string,
): Promise<ConversationMessage[]> {
  const { data } = await sc
    .from("compass_conversation_messages")
    .select("role, content, payload, prompt_version, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);

  if (!data || (data as any[]).length === 0) return [];

  // Reverse to chronological (oldest first)
  const rows = [...(data as any[])].reverse();

  // Trim to token budget — drop oldest until under limit
  let totalChars = rows.reduce(
    (sum: number, r: any) => sum + String(r.content ?? "").length,
    0,
  );
  while (totalChars > TOKEN_BUDGET_CHARS && rows.length > 0) {
    const dropped = rows.shift()!;
    totalChars -= String(dropped.content ?? "").length;
  }

  return rows.map((r: any) => ({
    role:          r.role as "user" | "assistant",
    content:       String(r.content ?? ""),
    payload:       r.payload ?? undefined,
    promptVersion: r.prompt_version ?? undefined,
    createdAt:     new Date(r.created_at as string),
  }));
}

// ── appendMessage ─────────────────────────────────────────────────────────────

/**
 * Persists a single message to the conversation.
 * Non-fatal callers should wrap in try/catch.
 */
export async function appendMessage(
  sc:              SupabaseClient,
  conversationId:  string,
  role:            "user" | "assistant",
  content:         string,
  payload?:        Record<string, unknown>,
  promptVersion?:  string,
): Promise<void> {
  await sc.from("compass_conversation_messages").insert({
    conversation_id: conversationId,
    role,
    content,
    payload:         payload ?? null,
    prompt_version:  promptVersion ?? null,
  });
}

// ── touchConversation ─────────────────────────────────────────────────────────

/**
 * Updates last_active_at to now — keeps the session alive.
 */
export async function touchConversation(
  sc:             SupabaseClient,
  conversationId: string,
): Promise<void> {
  await sc
    .from("compass_conversations")
    .update({ last_active_at: new Date().toISOString() })
    .eq("id", conversationId);
}
