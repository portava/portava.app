/**
 * Who owns which `memory_*` table, in machine-readable form.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * Migration 2710 was written to create a table called `memory_events`. That
 * table ALREADY EXISTS in CI and in production, as an entirely different thing:
 *
 *   existing  id, user_id, event_type, occurred_at, subject_type, subject_id,
 *             source, visibility, source_ref, metadata, created_at, expires_at
 *   intended  event_id, memory_id, sequence, type, actor_user_id, causation_id,
 *             correlation_id, payload_json, schema_version, occurred_at, recorded_at
 *
 * `CREATE TABLE IF NOT EXISTS` would not have created it and would not have
 * complained. The failure would have surfaced two statements later on a missing
 * column -- or not at all, leaving the command kernel writing domain events into
 * the projection family's table, which the account-deletion cascade reads.
 *
 * The rename to `memory_domain_events` fixed the table. It did NOT initially fix
 * the nine dependent object names (`idx_memory_events_memory_seq`,
 * `trg_memory_events_append_only`, `memory_events_refuse_update` and others),
 * which kept saying `memory_events` while operating on the new table -- a
 * second, quieter version of the same ambiguity. Those are renamed too.
 *
 * This file is the durable answer: the ownership is written down rather than
 * inferred from a name, and checkMemoryTableOwnership.ts enforces it.
 *
 * ── WHAT WAS MEASURED ────────────────────────────────────────────────────────
 * Production enumeration 2026-09-08: eight `memory_*` tables, thirteen
 * `%memory%` functions, three triggers, nine policies, twenty-six indexes.
 * `memory_events` already carries its OWN append-only trigger
 * (`trg_memory_events_no_update` / `memory_events_no_update()`) and four
 * indexes. The new kernel's objects collide with none of them -- verified name
 * by name against production, not assumed from the rename.
 */

export type MemorySubsystem = "projection-family" | "command-kernel" | "scrapbook";

export interface MemoryTableOwnership {
  table: string;
  subsystem: MemorySubsystem;
  /** What writes it. */
  writer: string;
  /** What reads it. */
  reader: string;
  /** Whether rows may be updated after insert. */
  appendOnly: boolean;
  /** Whether it is derived and rebuildable, or canonical truth. */
  canonical: boolean;
  /** Present in production today? */
  liveInProduction: boolean;
  /** The migration that provides it. */
  providedBy: string;
  notes: string;
}

export const MEMORY_TABLE_OWNERSHIP: readonly MemoryTableOwnership[] = [
  {
    table: "memory_events",
    subsystem: "projection-family",
    writer: "the Memory + Experience Intelligence projector (migrations 2183-2214)",
    reader: "project_user_memory / project_all_memory / memory_retrieve, and the account-deletion cascade",
    appendOnly: true,
    canonical: true,
    liveInProduction: true,
    providedBy: "2183_memory_projection_contract.sql",
    notes:
      "THE LEGACY TABLE, and it is load-bearing: ten migrations build on it and both " +
      "AccountDeletionService and lib/deletionDispositions reach user erasure through it. " +
      "It already has its own append-only trigger (trg_memory_events_no_update). " +
      "Nothing in the Highlights/Memories command kernel may write it.",
  },
  {
    table: "memory_domain_events",
    subsystem: "command-kernel",
    writer: "public.memory_kernel_execute ONLY, inside the command transaction",
    reader: "lib/memoryOutbox.ts, and projection rebuilds",
    appendOnly: true,
    canonical: true,
    liveInProduction: false,
    providedBy: "2710_memory_command_kernel_tables.sql (NOT APPLIED)",
    notes:
      "The Highlights/Memories spec §17 domain event log. Distinct from memory_events in " +
      "every column. Named memory_domain_events precisely so no reader can confuse the two.",
  },
  {
    table: "memory_event_outbox",
    subsystem: "command-kernel",
    writer: "public.memory_kernel_execute, same transaction as the state change",
    reader: "the outbox consumer",
    appendOnly: false,
    canonical: false,
    liveInProduction: false,
    providedBy: "2710_memory_command_kernel_tables.sql (NOT APPLIED)",
    notes: "Transactional outbox. Not a duplicate of memory_domain_events: it carries delivery state.",
  },
  {
    table: "memory_command_receipts",
    subsystem: "command-kernel",
    writer: "public.memory_kernel_execute",
    reader: "the command bus, for idempotency replay",
    appendOnly: false,
    canonical: false,
    liveInProduction: false,
    providedBy: "2710_memory_command_kernel_tables.sql (NOT APPLIED)",
    notes: "PK (actor_user_id, idempotency_key). Cascades with the Memory.",
  },
  {
    table: "memory_command_audit",
    subsystem: "command-kernel",
    writer: "public.memory_kernel_execute, one row per command ATTEMPT",
    reader: "operators",
    appendOnly: true,
    canonical: true,
    liveInProduction: false,
    providedBy: "2710_memory_command_kernel_tables.sql (NOT APPLIED)",
    notes:
      "Deliberately separate from the receipt: the receipt cascades with the Memory, the audit " +
      "survives it. Records rejected attempts too, which is the half an outcome-only log loses.",
  },
  {
    table: "memory_derivative_registry",
    subsystem: "command-kernel",
    writer: "the projection builders",
    reader: "retrieval, staleness and revocation",
    appendOnly: false,
    canonical: false,
    liveInProduction: false,
    providedBy: "2730_memory_derivative_registry.sql (NOT APPLIED)",
    notes: "Every row rebuildable from memories; a DROP loses nothing that cannot be regenerated.",
  },
  {
    table: "memory_projections",
    subsystem: "projection-family",
    writer: "project_user_memory and friends",
    reader: "memory_feedback, compass surfaces",
    appendOnly: false,
    canonical: false,
    liveInProduction: true,
    providedBy: "2183_memory_projection_contract.sql",
    notes:
      "A derived-FACT store with a retention class, keyed UNIQUE(user_id, memory_type, subject_type, subject_id). " +
      "It is NOT a registry of generated artifacts: no destination, no source version, no revocation state, " +
      "no payload, and a key that cannot express 'same projection, different audience'. " +
      "That is why memory_derivative_registry is built BESIDE it rather than on it.",
  },
  { table: "memory_items",    subsystem: "scrapbook", writer: "routes/memories.ts", reader: "routes/memories.ts",
    appendOnly: false, canonical: true, liveInProduction: true, providedBy: "0067", notes: "The original Memories scrapbook." },
  { table: "memory_tags",     subsystem: "scrapbook", writer: "routes/memories.ts", reader: "routes/memories.ts",
    appendOnly: false, canonical: true, liveInProduction: true, providedBy: "0067", notes: "Participant tags; consent lives here." },
  { table: "memory_likes",    subsystem: "scrapbook", writer: "routes/memories.ts", reader: "routes/memories.ts",
    appendOnly: false, canonical: true, liveInProduction: true, providedBy: "0067", notes: "" },
  { table: "memory_saves",    subsystem: "scrapbook", writer: "routes/memories.ts", reader: "routes/memories.ts",
    appendOnly: false, canonical: true, liveInProduction: true, providedBy: "0067", notes: "" },
  { table: "memory_feedback", subsystem: "projection-family", writer: "compass feedback", reader: "memory_feedback_apply_state trigger",
    appendOnly: false, canonical: true, liveInProduction: true, providedBy: "2183 family", notes: "FK to memory_projections." },
  { table: "memory_policy",   subsystem: "projection-family", writer: "operators", reader: "the projector",
    appendOnly: false, canonical: true, liveInProduction: true, providedBy: "2183 family", notes: "Retention classes." },
];

/**
 * The ONE module permitted to name `memory_domain_events` in application code.
 * Spec §17 asks for a command boundary; a boundary that any file may write
 * around is not one. Scattered raw table strings are how the two event logs
 * would get confused again.
 */
export const MEMORY_DOMAIN_EVENTS_CANONICAL_WRITER = "src/lib/memoryOutbox.ts";

export function ownershipOf(table: string): MemoryTableOwnership | undefined {
  return MEMORY_TABLE_OWNERSHIP.find((o) => o.table === table);
}
