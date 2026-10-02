/**
 * LayoverExternalEventService — the ingest and consume halves of §11's
 * canonical external event.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §11    the canonical event envelope
 *   §11.1  the eight-step replanner pipeline; step 1 is normalise + deduplicate
 *   §23    "Validate all external event payloads and deduplicate by stable
 *          source keys"
 *   §24    "Duplicate events — unique dedup key / source event id"
 * Census: census-layover L31, L90, L92, L194, L198, L259, L263.
 *
 * ── WHICH TABLE, AND WHY NOT THE OTHER ONE ───────────────────────────────────
 * This writes `layover_external_events`, created by migration 2860. It does NOT
 * write `layover_events`, and the distinction is the whole reason 2860 exists.
 *
 * `layover_events` is an in-app AUDIT TRAIL. Its `user_id UUID NOT NULL
 * REFERENCES profiles(id)` (`0127_layover_system.sql:197`) means every row is a
 * thing one identified traveller did. An external event — a gate change, a
 * security-queue reading, an airline cancellation — has no user. Widening that
 * column to carry one would put a nullable identity on an audit table whose
 * entire value is that the identity is never null, and would force every future
 * reader to ask which kind of row it was holding. 2860's header argues this at
 * length; this file is the consequence, not a second opinion.
 *
 * ── THE HEADER THAT USED TO BE HERE IS RETIRED ───────────────────────────────
 * Every module near this one still carries some version of "2860 is written and
 * NOT applied". That was true when those headers were written and is FALSE now.
 * Migration 2860 is applied to production `ajrurzioarfkagpuxfnb`: it is listed
 * in `src/lib/capability/production-applied-migrations.json`, and all twelve
 * columns of `layover_external_events` appear in the capture named by
 * `src/lib/capability/snapshots/current.ts`. The table, its UNIQUE index on
 * `dedup_key` and its partial pending index are live.
 *
 * So the gap this file closes is CODE, not schema. Until now nothing in the
 * tree wrote or read that table, which is why census-layover scored L92
 * ("normalise and deduplicate the external/internal event") NOT-BUILT while the
 * normaliser itself sat finished and tested in `LayoverEventReplanner.ts`.
 *
 * ── DEDUPLICATION SEMANTICS, TAKEN FROM THE SPEC RATHER THAN INVENTED ────────
 * The KEY is computed in exactly one place — `normalizeEvent` in
 * `../airport/LayoverEventReplanner.ts` — and this file never recomputes it:
 *
 *   * `source:sourceEventId` when the producer supplied a source event id. This
 *     is §23's "stable source key", so the same upstream event replayed through
 *     two transports collapses to one.
 *   * `sha256:<digest>` over the content that decides what the event MEANS
 *     (type, occurredAt, sorted subjectRefs, stably-stringified payload) when it
 *     did not. Two producers describing the same fact the same way still
 *     collapse; two genuinely different facts do not.
 *   * `eventId` is deliberately excluded. A producer minting a fresh uuid per
 *     delivery would otherwise defeat deduplication entirely — the exact
 *     failure §24 names.
 *
 * THERE ARE TWO UNIQUENESS CONSTRAINTS AND THEY SAY DIFFERENT THINGS.
 *   * `layover_external_events_pkey` on `event_id` — the SAME DELIVERY arrived
 *     twice. A transport retry.
 *   * `layover_external_events_dedup_uidx` on `dedup_key` — the same FACT
 *     arrived under a different delivery id. A second transport, or a producer
 *     that re-mints ids.
 * Both mean "already ingested, do not replan". They are reported separately
 * because a channel that keeps tripping the second one has a producer bug worth
 * knowing about, and collapsing them into one "duplicate" would hide it.
 *
 * A DUPLICATE IS A NO-OP, NOT A RE-RUN. §24's requirement is not that a
 * duplicate is cheap; it is that it changes nothing. `ingestExternalEvent`
 * therefore reports `duplicate: true` and leaves the stored row — including its
 * `processed_at` — exactly as it found it. It does not UPDATE, it does not
 * re-open a processed event, and it does not enqueue a second replan.
 *
 * ── WHY THE IN-MEMORY DEDUP STILL EXISTS ─────────────────────────────────────
 * `dedupeEvents` (same module as the normaliser) collapses duplicates WITHIN
 * one batch, first occurrence wins. This file collapses them ACROSS batches,
 * across processes and across time. Neither replaces the other: the in-memory
 * pass keeps a duplicate out of a per-session pipeline that has no business
 * seeing it, and the index is what makes the guarantee hold when two API
 * replicas ingest the same webhook concurrently — both compute the same
 * `dedup_key`, exactly one INSERT wins, and the loser is told so by the
 * database rather than by a race it won.
 *
 * ── CLAIMING IS A COMPARE-AND-SWAP, FOR THE SAME REASON ──────────────────────
 * `claimExternalEvent` stamps `processed_at` with a conditional UPDATE whose
 * WHERE clause includes `processed_at IS NULL`, and treats "zero rows updated"
 * as "another worker has it". A read-then-write would let two workers replan
 * the same event and send the traveller two notifications. Census L264 asks for
 * exactly this discipline on the active snapshot; it costs nothing to apply it
 * here too.
 *
 * ── WRITES GO THROUGH THE SERVICE ROLE, AND ONLY THE SERVICE ROLE ────────────
 * 2860 enables RLS on this table and defines NO POLICY AT ALL, which with RLS
 * on means no client can read or write a row. That is deliberate: an external
 * operational event is not a traveller's data. The service role bypasses RLS,
 * which is how this file reaches the table, and an ingest route must therefore
 * authenticate its producer itself — being signed in as a traveller is not
 * authority to publish an airport fact.
 *
 * ── A FAILED READ IS `ok: false`, NEVER AN EMPTY SET ─────────────────────────
 * `readPendingExternalEvents` refuses rather than returning `[]` on an error.
 * An empty pending set and an unreadable table are opposite facts: the first
 * means there is nothing to replan, the second means we do not know. A consumer
 * that cannot tell them apart reports an outage as a quiet day.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  isLayoverEventType,
  normalizeEvent,
  type EventRejection,
  type EventSubjectRef,
  type LayoverEventEnvelope,
  type RawLayoverEvent,
} from "../airport/LayoverEventReplanner.js";
import type { EstimateConfidence } from "../airport/LayoverFeasibility.js";

const logger = rootLogger.child({ service: "LayoverExternalEventService" });

/**
 * The gate. Seeded FALSE by migration 2981, which is the ordering 2860's header
 * sets out: apply the table, confirm its postconditions, THEN land an ingest
 * behind a flag that is off.
 *
 * Written as a literal at every call site for the same reason
 * `LayoverObservationService` writes its table name as a literal: the guard
 * checks resolve a flag only when they can see the string.
 */
export const LAYOVER_EVENT_INGEST_FLAG = "layover_event_ingest_enabled";

/**
 * The store. Created by migration 2860, applied to production.
 *
 * NOTE FOR ANYONE TIDYING THIS UP: the `.from(...)` call sites below write the
 * table name as a STRING LITERAL rather than using this constant, and replacing
 * them with the constant would be a regression. `check:write-path-columns`
 * resolves a write site only when it can see `.from("<literal>")` in the AST;
 * `.from(CONSTANT)` is a `dynamic table name` blind spot, which is the entire
 * failure class that check exists to catch. The constant stays exported because
 * the tests import it.
 */
export const EXTERNAL_EVENT_TABLE = "layover_external_events";

/** Which unique constraint a 23505 came from, when the database says. */
export type DuplicateKind =
  /** `layover_external_events_pkey` — this exact delivery id is already stored. */
  | "same_delivery"
  /** `layover_external_events_dedup_uidx` — this FACT is already stored under another delivery id. */
  | "same_fact"
  /**
   * A 23505 whose constraint name the driver did not report, or reported under
   * a name this file does not recognise. NOT guessed into one of the two above:
   * a duplicate of unknown provenance is still a duplicate, and saying which
   * one it was when we do not know is how a producer bug gets mis-attributed.
   */
  | "unattributed";

export type IngestResult =
  | {
      ok: true;
      event: LayoverEventEnvelope;
      /** TRUE when the row was already present. Nothing was written or changed. */
      duplicate: boolean;
      /** Set only when `duplicate` is true. */
      duplicateKind: DuplicateKind | null;
    }
  | { ok: false; kind: "rejected"; reason: EventRejection; detail: string }
  | { ok: false; kind: "write_failed"; message: string };

/**
 * Normalise an untrusted producer payload and store it, exactly once.
 *
 * `receivedAtMs` is passed in rather than read from the clock here, so the
 * instant that lands in `received_at` is the one the caller timed the request
 * at and the whole path stays deterministic under test. It is also the bound
 * `normalizeEvent` judges `occurredAt` against — a future-dated event is a
 * clock fault or a forgery, and the table's own
 * `layover_external_events_not_future` CHECK refuses it a second time.
 */
export async function ingestExternalEvent(
  db: SupabaseClient,
  raw: RawLayoverEvent,
  receivedAtMs: number,
): Promise<IngestResult> {
  const normalized = normalizeEvent(raw, { receivedAtMs });
  if (!normalized.ok) {
    // Not logged as a fault. A refused event is the producer having sent
    // something this channel will not hold, and the reason travels back to it.
    return { ok: false, kind: "rejected", reason: normalized.reason, detail: normalized.detail };
  }
  const event = normalized.event;

  const { error } = await db
    .from("layover_external_events")
    .insert({
      event_id: event.eventId,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
      received_at: event.receivedAt,
      source: event.source,
      source_event_id: event.sourceEventId,
      subject_refs: event.subjectRefs,
      payload: event.payload,
      dedup_key: event.dedupKey,
      confidence: event.confidence,
      // `processed_at` is deliberately absent from this payload rather than
      // written as null. It is the CONSUMER's column; naming it here would
      // make an ingest look like something that could also un-process a row.
    });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      const kind = duplicateKindOf(error as { message?: string; details?: string });
      logger.info(
        { eventType: event.eventType, source: event.source, dedupKey: event.dedupKey, kind },
        "duplicate external event — already ingested, no replan",
      );
      return { ok: true, event, duplicate: true, duplicateKind: kind };
    }
    logger.warn(
      { err: error.message, code, eventType: event.eventType, source: event.source },
      "external event insert failed",
    );
    return { ok: false, kind: "write_failed", message: error.message };
  }

  return { ok: true, event, duplicate: false, duplicateKind: null };
}

/**
 * Which constraint a unique violation names, read from the driver's own text.
 *
 * Postgres puts the constraint name in the message ("duplicate key value
 * violates unique constraint \"…\"") and PostgREST forwards it, usually in
 * `message` and sometimes in `details`. Both are searched, and a message naming
 * neither constraint returns `unattributed` rather than a guess.
 */
function duplicateKindOf(error: { message?: string; details?: string }): DuplicateKind {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  if (text.includes("layover_external_events_dedup_uidx")) return "same_fact";
  if (text.includes("layover_external_events_pkey")) return "same_delivery";
  return "unattributed";
}

// ── the consume side ─────────────────────────────────────────────────────────

/** The columns the envelope is rebuilt from. One place, so a read cannot drift. */
const ENVELOPE_COLUMNS =
  "event_id,event_type,occurred_at,received_at,source,source_event_id,subject_refs,payload,dedup_key,confidence";

interface ExternalEventRow {
  event_id: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  source: string;
  source_event_id: string;
  subject_refs: unknown;
  payload: unknown;
  dedup_key: string;
  confidence: string;
}

export type PendingRead =
  | { ok: true; events: LayoverEventEnvelope[]; unreadable: number }
  | { ok: false; reason: "read_failed"; message: string };

/**
 * Unprocessed events, oldest first — §11.1's fanout input.
 *
 * Served by 2860's `layover_external_events_pending_idx`, which is a PARTIAL
 * index `ON (occurred_at) WHERE processed_at IS NULL`. The `.is("processed_at",
 * null)` filter below is what makes the planner able to use it; an
 * `.or("processed_at.is.null,…")` would not.
 *
 * ORDERED BY `occurred_at`, NOT `created_at`. A replan must see the world in
 * the order it happened, not in the order two transports happened to deliver.
 */
export async function readPendingExternalEvents(
  db: SupabaseClient,
  limit: number,
): Promise<PendingRead> {
  const { data, error } = await db
    .from("layover_external_events")
    .select(ENVELOPE_COLUMNS)
    .is("processed_at", null)
    .order("occurred_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.warn(
      { err: error.message },
      "pending external event read failed — refusing rather than reporting an empty queue",
    );
    return { ok: false, reason: "read_failed", message: error.message };
  }

  const events: LayoverEventEnvelope[] = [];
  let unreadable = 0;
  for (const row of data ?? []) {
    const envelope = rowToEnvelope(row as unknown as ExternalEventRow);
    if (envelope === null) {
      unreadable += 1;
      continue;
    }
    events.push(envelope);
  }
  if (unreadable > 0) {
    // Counted and reported rather than silently skipped. A row this code cannot
    // rebuild is a row the replanner will never act on, and a queue that
    // quietly drops those looks drained when it is stuck.
    logger.warn({ unreadable }, "pending external events could not be rebuilt into envelopes");
  }
  return { ok: true, events, unreadable };
}

/**
 * A stored row back into the canonical envelope, or null if it is not one.
 *
 * The table's CHECK constraints already restrict `event_type` and `confidence`,
 * so a row failing these tests means the vocabulary moved in code without a
 * migration — which is worth surfacing, not coercing. Nothing is defaulted:
 * an unknown `confidence` does NOT become MEDIUM here, because the stored row
 * is evidence and inventing a band for it would make a safety input up.
 */
export function rowToEnvelope(row: ExternalEventRow): LayoverEventEnvelope | null {
  if (!isLayoverEventType(row.event_type)) return null;
  if (!CONFIDENCE_BANDS.has(row.confidence)) return null;
  const subjectRefs = parseSubjectRefs(row.subject_refs);
  if (subjectRefs === null) return null;
  const payload =
    row.payload !== null && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>)
      : null;
  if (payload === null) return null;

  return {
    eventId: row.event_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    source: row.source,
    sourceEventId: row.source_event_id,
    subjectRefs,
    payload,
    dedupKey: row.dedup_key,
    confidence: row.confidence as EstimateConfidence,
  };
}

const CONFIDENCE_BANDS: ReadonlySet<string> = new Set(["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"]);

/**
 * `subject_refs` is JSONB and the table does not constrain its shape, so it is
 * validated here. An empty list is REFUSED rather than allowed through: §11
 * requires at least one subject and `normalizeEvent` will not mint an envelope
 * without one, so a stored row with none was not written by this path.
 */
function parseSubjectRefs(v: unknown): EventSubjectRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: EventSubjectRef[] = [];
  for (const item of v) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const { kind, ref } = item as { kind?: unknown; ref?: unknown };
    if (typeof kind !== "string" || typeof ref !== "string" || ref.length === 0) return null;
    if (!SUBJECT_KINDS.has(kind)) return null;
    out.push({ kind: kind as EventSubjectRef["kind"], ref });
  }
  return out.length === 0 ? null : out;
}

const SUBJECT_KINDS: ReadonlySet<string> = new Set(["airport", "session", "flight", "route", "user"]);

export type ClaimResult =
  /** This worker owns the event. Replan it. */
  | { ok: true; claimed: true }
  /** Another worker stamped `processed_at` first, or it was already processed. */
  | { ok: true; claimed: false }
  | { ok: false; reason: "claim_failed"; message: string };

/**
 * Take ownership of one pending event by stamping `processed_at`.
 *
 * COMPARE-AND-SWAP, not read-then-write. `processed_at IS NULL` is part of the
 * WHERE clause, so two workers reading the same pending page both attempt the
 * UPDATE and exactly one of them matches a row. The loser is told `claimed:
 * false` and moves on; without this both would replan the event and the
 * traveller would get two notifications for one gate change.
 *
 * The stamp happens BEFORE the replan, which is the deliberate direction: an
 * event claimed and then lost to a crash is not replanned, whereas an event
 * replanned and then lost before the stamp is replanned twice. §24's guarantee
 * is about duplicates, so the failure this trades toward is the one the spec
 * names — and an unprocessed-but-stamped row is visible as a gap in the
 * replan log rather than as a second notification to a traveller.
 */
export async function claimExternalEvent(
  db: SupabaseClient,
  eventId: string,
  processedAtMs: number,
): Promise<ClaimResult> {
  const { data, error } = await db
    .from("layover_external_events")
    .update({ processed_at: new Date(processedAtMs).toISOString() })
    .eq("event_id", eventId)
    .is("processed_at", null)
    .select("event_id");

  if (error) {
    logger.warn({ err: error.message, eventId }, "external event claim failed");
    return { ok: false, reason: "claim_failed", message: error.message };
  }
  return { ok: true, claimed: (data ?? []).length === 1 };
}
