import type { SupabaseClient } from "@supabase/supabase-js";

export type EventViewAccess = "allowed" | "denied" | "unavailable";

interface EventAccessSubject {
  id: string;
  host_id: string;
  state?: string | null;
  visibility?: string | null;
  circle_id?: string | null;
  trip_id?: string | null;
}

async function readAccessRow(query: PromiseLike<unknown>, field: string): Promise<Record<string, unknown> | null> {
  const result = await query;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Event access read unavailable");
  const { data, error } = result as { data?: unknown; error?: unknown };
  if (error || data === undefined) throw new Error("Event access read unavailable");
  if (data === null) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("Event access row unavailable");
  const row = data as Record<string, unknown>;
  if (typeof row[field] !== "string" || row[field] === "") throw new Error("Event access row unavailable");
  return row;
}

export async function readEventViewAccess(client: SupabaseClient, event: EventAccessSubject, viewerId: string): Promise<EventViewAccess> {
  if (!event || typeof event.id !== "string" || !event.id || typeof event.host_id !== "string" || !event.host_id || !viewerId) return "unavailable";
  if (event.host_id === viewerId) return "allowed";
  try {
    const role = await readAccessRow(client.from("event_roles").select("role")
      .eq("event_id", event.id).eq("user_id", viewerId).maybeSingle(), "role");
    if (role && ["co_host", "moderator"].includes(String(role.role))) return "allowed";
    if (["draft", "cancelled", "archived"].includes(event.state ?? "")) return "denied";
    if (event.visibility === "public") return "allowed";
    if (event.visibility === "circle") {
      if (!event.circle_id) return "denied";
      if (event.circle_id === viewerId) return "allowed";
      const member = await readAccessRow(client.from("circle_memberships").select("other_id")
        .eq("user_id", event.circle_id).eq("other_id", viewerId).maybeSingle(), "other_id");
      return member?.other_id === viewerId ? "allowed" : "denied";
    }
    if (event.visibility === "trip") {
      if (!event.trip_id) return "denied";
      const member = await readAccessRow(client.from("trip_members").select("role, status")
        .eq("trip_id", event.trip_id).eq("user_id", viewerId).maybeSingle(), "role");
      if (member && (typeof member.status !== "string" || member.status === "")) return "unavailable";
      return member?.status === "accepted" && ["owner", "co_host", "member", "viewer"].includes(String(member.role)) ? "allowed" : "denied";
    }
    if (event.visibility === "friends_only") {
      const friendship = await readAccessRow(client.from("user_friendships").select("user_a")
        .or(`and(user_a.eq.${viewerId},user_b.eq.${event.host_id}),and(user_b.eq.${viewerId},user_a.eq.${event.host_id})`)
        .maybeSingle(), "user_a");
      if (friendship) return "allowed";
    }
    const rsvp = await readAccessRow(client.from("event_rsvps").select("status")
      .eq("event_id", event.id).eq("user_id", viewerId).maybeSingle(), "status");
    return rsvp || role ? "allowed" : "denied";
  } catch {
    return "unavailable";
  }
}

/**
 * An event-access input (the event row, or the caller's event_roles row) could
 * not be read (wave 5). routes/events.ts getEventRole answers a bare role or
 * null and DISCARDED both reads' errors, so a failed read was "no role": a host
 * was told 403 "only the host can…" by a query that never answered. It has no
 * room for a third state across its ~45 callers, so it THROWS this — the
 * TripAccessUnavailableError device (lib/http.ts): the global error handler
 * (lib/errorEnvelope.ts) reads `status` / `code`, so an uncaught one is 503
 * `degraded_unavailable`, retryable, and Express 5 forwards a rejected async
 * handler there with no try/catch in the route.
 */
export class EventAccessUnavailableError extends Error {
  readonly input: string;
  readonly status: number = 503;
  readonly code = "degraded_unavailable";
  constructor(input: string, error: unknown) {
    super(`event access input ${input} unavailable — refusing to answer: ${String((error as { message?: unknown; code?: unknown } | null)?.message ?? (error as { code?: unknown } | null)?.code ?? error)}`);
    this.name = "EventAccessUnavailableError";
    this.input = input;
  }
}
