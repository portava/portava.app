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
import { probeSchemaReadiness } from "../../lib/capability/schemaCapability.js";
import type { CapabilityDefinition } from "../../lib/capability/schemaRequirement.js";

export const INACTIVITY_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_HISTORY_MESSAGES = 20;
const TOKEN_BUDGET_CHARS   = 24_000; // ≈6 000 tokens at 4 chars/token

/**
 * compass-phase1-spec §1: `role user|assistant|system-event`. A system-event is
 * something that HAPPENED in the conversation (the assistant was unavailable,
 * a proposal resolved) rather than a turn either party wrote, and it is never
 * handed to the model as one — see `modelTurns`.
 */
export type ConversationRole = "user" | "assistant" | "system-event";

export type ConversationSchema = "ready" | "absent" | "unreadable";

/**
 * The capability this service guards: migration 2996's two columns, under the
 * flag that turns Compass on. Registered in lib/capability/registry.ts so that
 * checkFlagSchemaPrerequisites classifies the pair GUARDED — `COMPASS_ENABLED`
 * is ON in production and production lacks both columns, which is exactly the
 * state the ratchet exists to refuse unless a probe sits before every use.
 */
export const COMPASS_CONVERSATION_PHASE1: CapabilityDefinition = {
  flag: "COMPASS_ENABLED",
  providedBy: ["2996_compass_conversations_phase1_schema.sql"],
  requires: {
    tables: {
      compass_conversations: { columns: ["trip_id", "status"] },
    },
  },
  consumers: ["services/compass/CompassConversationService.ts"],
  note:
    "Naming trip_id/status on a database without 2996 fails the conversation INSERT and drops the " +
    "person into the honest fallback for every turn; probing first keeps the legacy shape working until the " +
    "migration is applied, and refuses to write a system-event row the old CHECK would reject.",
};

/**
 * Does this database carry migration 2996's columns (`trip_id`, `status`) and,
 * with them, the widened `role` CHECK? Probed through lib/capability's
 * schema-readiness contract (memoised per client there), so a build carrying
 * 2996 runs unchanged against a database that has not applied it — the
 * columns are named only when this answers `ready`.
 *
 * THREE outcomes, not two. `absent` is the contract's `missing` (42703 /
 * PGRST204 on the probe): the migration is not applied and the legacy shape is
 * used. `unreadable` is its `unknown`: an outage, which the caller turns into
 * its honest fallback rather than into "no such column".
 */
export async function conversationSchemaReady(sc: SupabaseClient | any): Promise<ConversationSchema> {
  const r = await probeSchemaReadiness(sc, COMPASS_CONVERSATION_PHASE1);
  if (r.state === "ready") return "ready";
  if (r.state === "missing") return "absent";
  return "unreadable";
}

export interface ConversationMessage {
  role:          ConversationRole;
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
  opts: { tripId?: string | null } = {},
): Promise<string> {
  const schema = await conversationSchemaReady(sc);
  if (schema === "unreadable") {
    throw new Error("compass_conversations: schema probe failed — cannot tell a live conversation from an outage");
  }
  const phase1 = schema === "ready";
  if (incomingConvId) {
    // A failed read resolves as `{ data: null }`, which the branch below cannot
    // tell from "that conversation is not yours / does not exist" — and the
    // answer decides whether we INSERT. Reading an outage as "no such
    // conversation" abandons a live session mid-thread: a fresh row is created,
    // the client is handed a new id, and every prior turn drops out of the
    // model's context while the user is still typing into what they think is
    // the same chat. Throw instead; this function already documents that the
    // caller turns a throw into an honest error response, and a retry against a
    // healthy database reuses the conversation.
    // Two complete literal chains rather than one with a computed column
    // list: the flag-schema ratchet (scripts/checkFlagSchemaPrerequisites.ts)
    // reads `.from("table").select("cols")` STATICALLY, and `status` has to be
    // visible to it so the COMPASS_ENABLED closure is classified GUARDED —
    // registered and probed — rather than vanishing from its view behind a
    // ternary or a query variable.
    const { data, error: lookupErr } = phase1
      ? await sc.from("compass_conversations").select("id, last_active_at, status")
          .eq("id", incomingConvId).eq("user_id", userId).maybeSingle()
      : await sc.from("compass_conversations").select("id, last_active_at")
          .eq("id", incomingConvId).eq("user_id", userId).maybeSingle();

    if (lookupErr) {
      throw new Error(`compass_conversations: lookup failed — ${lookupErr.message}`);
    }

    if (data) {
      const lastActive = new Date((data as any).last_active_at as string).getTime();
      const isStale    = Date.now() - lastActive > INACTIVITY_THRESHOLD_MS;
      // spec §1 `status`: only an ACTIVE conversation is resumed. A row from
      // before 2996 carries no status and reads as active, which is what the
      // column's default makes it the moment the migration runs.
      const status = (data as any).status;
      const isArchived = phase1 && status != null && status !== "active";
      if (!isStale && !isArchived) return (data as any).id as string;
    }
  }

  // Same reason as the lookup above: the INSERT names trip_id/status only
  // when the probe said `ready`, and it names them as LITERAL keys on a
  // literal chain so the ratchet can see that this closure reaches them.
  const { data: created, error } = phase1
    ? await sc.from("compass_conversations")
        .insert({ user_id: userId, status: "active", trip_id: opts.tripId ?? null })
        .select("id").single()
    : await sc.from("compass_conversations").insert({ user_id: userId }).select("id").single();

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
    role:          r.role as ConversationRole,
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
  role:            ConversationRole,
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

// ── system events (spec §1 role `system-event`) ──────────────────────────────

/**
 * Record something that HAPPENED in the conversation. Refused — `false`, no
 * insert attempted — where 2996 is not applied, because the shipped CHECK
 * would reject the row and a rejected insert is not a recorded event.
 */
export async function appendSystemEvent(
  sc:             SupabaseClient,
  conversationId: string,
  content:        string,
  payload:        Record<string, unknown> = {},
): Promise<boolean> {
  if ((await conversationSchemaReady(sc)) !== "ready") return false;
  const { error } = await sc.from("compass_conversation_messages").insert({
    conversation_id: conversationId,
    role:            "system-event",
    content,
    payload,
    prompt_version:  null,
  });
  return !error;
}

/** spec §1 `status`: archive the owner's conversation. False when not theirs or not applied. */
export async function archiveConversation(sc: SupabaseClient, conversationId: string, userId: string): Promise<boolean> {
  if ((await conversationSchemaReady(sc)) !== "ready") return false;
  const { data, error } = await sc
    .from("compass_conversations")
    .update({ status: "archived" })
    .eq("id", conversationId)
    .eq("user_id", userId)
    .select("id");
  return !error && Array.isArray(data) && data.length > 0;
}

/**
 * The turns the MODEL is given: user and assistant only. A system-event is a
 * fact about the conversation, not something either party said, and handing it
 * to the model as a turn would put words in nobody's mouth.
 */
export function modelTurns(history: readonly ConversationMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const h of history) {
    if (h.role === "user" || h.role === "assistant") out.push({ role: h.role, content: h.content });
  }
  return out;
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
