/**
 * Memory domain events and the transactional outbox contract.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §17 "Domain events" — the fourteen names below, verbatim and in order.
 *   §17 "Use an outbox pattern: canonical mutation and event-outbox insert
 *        occur in one database transaction. Consumers must be idempotent and
 *        may rebuild disposable projections asynchronously."
 *   §18 Projections and Derived Artifact Registry — the consumers this payload
 *        is shaped for.
 *   §23 "Search/index workers consume privacy-filtered event payloads where
 *        possible rather than raw entire rows."
 *   §24 "Operational logs must include memoryId, commandId, eventId, source
 *        version, engine version, reason codes, projection name, failure class."
 *
 * MEASURED STARTING POINT: `memory_event_outbox` had zero occurrences in this
 * repository (census §17, re-measured in this lane). No Memory or Highlight
 * write path emitted any of the fourteen events.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHERE THE EMIT ACTUALLY HAPPENS — AND WHY NOT HERE
 * ══════════════════════════════════════════════════════════════════════════════
 * Nothing in this module writes. That is the whole design.
 *
 * §17 requires the canonical mutation and the outbox insert to be ONE database
 * transaction. supabase-js has no transactions, so any TypeScript that wrote
 * `memories` and then `memory_event_outbox` in two calls would produce exactly
 * the two failures the outbox pattern exists to prevent: a memory changed with
 * no event (the second call failed), or an event for a change that never landed
 * (the first call failed after the second was queued). Both writes therefore
 * live inside public.memory_kernel_execute (migration 2710) and this module
 * holds only the CONTRACT: the vocabulary, the payload shape, and the reader a
 * consumer will use.
 *
 * Three measured facts about supabase-js make the alternative worse than it
 * looks, and are recorded here because each one has already produced a silent
 * failure in this codebase:
 *   1. `void sc.from(t).insert(r)` with no `.then`/`.catch`/`await` issues ZERO
 *      HTTP requests — PostgrestBuilder calls `_fetch` inside `then()`. A
 *      fire-and-forget emit does not emit.
 *   2. The client RESOLVES on a database error, so `const { data } = await ...`
 *      with `.error` unbound makes a FAILED insert indistinguishable from a
 *      successful one, and a try/catch around it is dead code.
 *   3. `.then(undefined, cb)` is a REJECTION handler on a client that resolves,
 *      so it never runs for a database error. routes/memories.ts had two of
 *      these on its participant writes; this lane removed both.
 *
 * src/test/memoryOutbox.test.ts asserts STATICALLY that no file this lane owns
 * contains a write to the event or outbox tables outside the RPC, so a future
 * edit cannot reintroduce a fire-and-forget path without going red.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * NO CONSUMER EXISTS
 * ══════════════════════════════════════════════════════════════════════════════
 * §18's projections are NOT built by this lane. Rows accumulate in
 * `memory_event_outbox` with `published_at IS NULL`. `readUnpublishedOutbox`
 * below is the reader a worker will use and is exercised only by tests today;
 * it is included because a projections lane needs the payload contract fixed
 * before it can consume, and because a reader that fails honestly is the point
 * of the exercise — it returns a discriminated result rather than an empty
 * array, so "the outbox is unreadable" can never be served as "there is nothing
 * to publish" (§28.11).
 */

/** §17's fourteen domain events, verbatim. */
export const MEMORY_EVENT_TYPES = [
  "memory.created",
  "memory.confirmed",
  "memory.corrected",
  "memory.merged",
  "memory.split",
  "memory.archived",
  "memory.deleted",
  "memory.visibility_changed",
  "highlight.created",
  "highlight.published",
  "highlight.expired",
  "highlight.pinned",
  "highlight.hidden",
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

/**
 * The eight Memory-domain events this lane's kernel can emit. The five
 * `highlight.*` names are declared in the vocabulary above because §17 lists
 * them and a consumer must be able to switch on the complete set, but
 * routes/highlights.ts and routes/stories.ts belong to another lane and nothing
 * here emits them. Two of the eight (`memory.merged`, `memory.split`) have no
 * command either — see MEMORY_COMMAND_TYPES_NOT_DECLARED.
 */
export const MEMORY_DOMAIN_EVENT_TYPES = MEMORY_EVENT_TYPES.filter((t) => t.startsWith("memory."));

export function isMemoryEventType(v: unknown): v is MemoryEventType {
  return typeof v === "string" && (MEMORY_EVENT_TYPES as readonly string[]).includes(v);
}

/** The outbox table (migration 2710) and the event store beside it. */
export const MEMORY_OUTBOX_TABLE = "memory_event_outbox";
export const MEMORY_EVENT_TABLE = "memory_events";

/**
 * The event payload a §18 consumer reads.
 *
 * PRIVACY-FILTERED BY CONSTRUCTION (§23). The payload carries ids, the command
 * that caused it, the lifecycle transition and the audience CLASS — never the
 * Memory's title, caption, coordinates, allow/hide lists or media URLs. A
 * search or index worker that needs the body must read the canonical row under
 * its own authorization; it may not learn it by subscribing. This is the
 * inverse of the mistake §28.6 names ("never expose private canonical Memory
 * records to public search and rely on post-filtering") — the filter is in the
 * event's shape, not in the consumer's discipline.
 *
 * The SQL function builds this object; the type is the contract both sides
 * compile against, and src/test/memoryOutbox.test.ts asserts the forbidden keys
 * are absent from every event this lane's fake kernel produces.
 */
export interface MemoryDomainEventPayload {
  /** §17 command that caused this event. */
  command_type: string;
  /** §5 lifecycle state before the command, in SPEC vocabulary, or null. */
  from_state: string | null;
  /** §5 lifecycle state after the command, in SPEC vocabulary. */
  to_state: string | null;
  /** §4 VisibilityClass-equivalent stored audience, when the command changed it. */
  visibility: string | null;
  /** ids only — never the row. */
  refs: Record<string, string | null>;
}

/**
 * Keys a Memory domain event payload must NEVER carry (§23, §28.6, §10 "public
 * location precision above the owner's publication policy"). Exported so the
 * assertion lives in one place and the test cannot drift from the rule.
 */
export const FORBIDDEN_EVENT_PAYLOAD_KEYS = [
  "title", "caption", "summary",
  "location_lat", "location_lng", "lat", "lng",
  "allowed_user_ids", "hidden_user_ids",
  "media_url", "media_urls",
] as const;

/**
 * True when `payload` carries none of the forbidden keys, at any depth.
 * Recursive because `refs` and `result` are objects and a leak one level down
 * is still a leak.
 */
export function eventPayloadIsPrivacyFiltered(payload: unknown): boolean {
  const forbidden = new Set<string>(FORBIDDEN_EVENT_PAYLOAD_KEYS);
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 8 || v === null || typeof v !== "object") return true;
    if (Array.isArray(v)) return v.every((e) => walk(e, depth + 1));
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (forbidden.has(k)) return false;
      if (!walk(child, depth + 1)) return false;
    }
    return true;
  };
  return walk(payload, 0);
}

export interface MemoryOutboxRow {
  id: number;
  event_id: string;
  memory_id: string;
  type: MemoryEventType;
  created_at: string;
  published_at: string | null;
  attempts: number;
}

export type OutboxReadResult =
  | { ok: true; rows: MemoryOutboxRow[] }
  | { ok: false; reason: "outbox_unavailable"; detail: string };

/**
 * Read unpublished outbox rows, oldest first.
 *
 * Returns a DISCRIMINATED RESULT rather than an array, and this is the whole
 * reason the function exists in a module that otherwise only holds types.
 * supabase-js RESOLVES on a database error: `const { data } = await sc.from(
 * 'memory_event_outbox')...` binds `data` to null for a table that is absent
 * (migration 2710 unapplied), for an RLS refusal, and for a transient outage —
 * and `data ?? []` then reads at the call site exactly like "the outbox is
 * empty, nothing to publish". A worker built on that would report a clean run
 * forever while every projection went stale, which is §24's `projection_lag`
 * measured as zero because nothing was measured.
 *
 * `.error` is therefore bound and checked, and an unreadable outbox is
 * `{ ok:false, reason:'outbox_unavailable' }` — never an empty batch.
 */
export async function readUnpublishedOutbox(
  sc: any,
  limit = 100,
): Promise<OutboxReadResult> {
  const { data, error } = await sc
    .from(MEMORY_OUTBOX_TABLE)
    .select("id, event_id, memory_id, type, created_at, published_at, attempts")
    .is("published_at", null)
    .order("id", { ascending: true })
    .limit(limit);

  if (error) {
    return { ok: false, reason: "outbox_unavailable", detail: error.message ?? String(error) };
  }
  if (!Array.isArray(data)) {
    // Neither an error nor rows. Not "empty": a non-array body from PostgREST
    // means the shape changed under us, and guessing is how a schema surprise
    // becomes a plausible-looking empty history (§28.11).
    return { ok: false, reason: "outbox_unavailable", detail: "outbox read returned a non-array body" };
  }
  return { ok: true, rows: data as MemoryOutboxRow[] };
}
