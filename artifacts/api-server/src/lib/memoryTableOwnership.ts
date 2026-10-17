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
  { table: "memory_visibility_policies", subsystem: "scrapbook", writer: "routes/memoryVisibilityPolicies.ts (the owner, through services/memory/memoryVisibilityPolicies.ts)", reader: "every non-owner Memory read (routes/memories.ts protectMemoryRow via loadMemoryGemContext) and the public search index source read (derivativeRegistry readPublicIndexSources)", appendOnly: false, canonical: true, liveInProduction: false, providedBy: "3997_memory_visibility_policies_and_shared_experiences.sql", notes: "§3.6 (census H33): the owner's per-audience location-precision ceiling; composes stricter-wins with memories.location_precision and the Hidden-Gem ceiling. Service-only, erased with auth.users. Behind memory_visibility_policies_enabled (seeded FALSE). Local and unapplied." },
  { table: "memory_shared_experiences", subsystem: "scrapbook", writer: "memory_shared_experience_respond (created with the first consent) / _end / the dissolve and deleted-Memory triggers", reader: "services/memory/memorySharedExperiences.ts", appendOnly: false, canonical: true, liveInProduction: false, providedBy: "3997_memory_visibility_policies_and_shared_experiences.sql", notes: "§5 (census H53): the shared-experience anchor. Owns no Memory; links separate personal Memories. Erased when no participant remains, by the host, with the host Memory or account. Behind memory_shared_experiences_enabled (seeded FALSE). Local and unapplied." },
  { table: "memory_shared_experience_invitations", subsystem: "scrapbook", writer: "memory_shared_experience_invite / _respond / _leave / _end, and the host's withdrawal (memorySharedExperiences.withdrawInvitation)", reader: "services/memory/memorySharedExperiences.ts", appendOnly: false, canonical: true, liveInProduction: false, providedBy: "3997_memory_visibility_policies_and_shared_experiences.sql", notes: "§5 (census H53): the participant-consent ledger, pending -> accepted | declined; accepted -> left (trigger-enforced). participant_memory_id is the participant's OWN live Memory. Erased with either account, the host Memory, or the experience. Local and unapplied." },
  { table: "memory_resurfacing_policy_heads", subsystem: "command-kernel", writer: "memory_resurfacing_policy_execute", reader: "owner-policy command serialization", appendOnly: false, canonical: false, liveInProduction: false, providedBy: "3993_owner_resurfacing_policy.sql", notes: "Service-only owner-scoped sequence, erased with auth.users. Orders accepted policy commands; does not version direct legacy writes or graph copies. Local and unapplied." },
  { table: "memory_snapshots", subsystem: "command-kernel", writer: "memory_snapshot_append_v1", reader: "MemorySnapshotStore capture/replay RPCs", appendOnly: true, canonical: false, liveInProduction: false, providedBy: "3990_memory_snapshots.sql", notes: "Immutable historical evidence copies, not new facts. Owner-only; erasure and source revocation physically purge copies. Unapplied and disabled by default." },
  { table: "memory_video_segments", subsystem: "scrapbook", writer: "memory_video_segments_execute", reader: "memoryVideoSegmentsService", appendOnly: true, canonical: true, liveInProduction: false, providedBy: "3991_memory_video_segments.sql", notes: "Owner-asserted time bounds on one canonical original. No copied media. Source revisions invalidate segments; Memory/item/asset/account deletion cascades." },
  { table: "memory_video_segment_operations", subsystem: "scrapbook", writer: "memory_video_segments_execute", reader: "memory_video_segments_execute replay protection", appendOnly: true, canonical: false, liveInProduction: false, providedBy: "3991_memory_video_segments.sql", notes: "Idempotency tombstones prevent deleted segment recreation; no media payload. Memory/item/asset/account deletion cascades. Unapplied." },
  { table: "memory_import_batches", subsystem: "command-kernel", writer: "memory_import_batches_create/step/abort", reader: "memoryImportBatches progress API", appendOnly: false, canonical: true, liveInProduction: false, providedBy: "3992_memory_import_batches.sql", notes: "Owner-requested legacy graph backfill with bounded checkpoints. Existing originals remain unchanged. Cascades from auth.users; unapplied and disabled by default." },
  { table: "memory_import_batch_items", subsystem: "command-kernel", writer: "memory_import_batches_create/step and source revocation trigger", reader: "memoryImportBatches progress API", appendOnly: false, canonical: true, liveInProduction: false, providedBy: "3992_memory_import_batches.sql", notes: "Selected existing Memory references and command receipts, not new evidence. Source erasure clears the reference; batch/account deletion cascades." },
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
    liveInProduction: true,
    providedBy: "2710_memory_command_kernel_tables.sql (applied to production 2026-09-15)",
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
    liveInProduction: true,
    providedBy: "2710_memory_command_kernel_tables.sql (applied to production 2026-09-15)",
    notes: "Transactional outbox. Not a duplicate of memory_domain_events: it carries delivery state.",
  },
  {
    table: "memory_command_receipts",
    subsystem: "command-kernel",
    writer: "public.memory_kernel_execute",
    reader: "the command bus, for idempotency replay",
    appendOnly: false,
    canonical: false,
    liveInProduction: true,
    providedBy: "2710_memory_command_kernel_tables.sql (applied to production 2026-09-15)",
    notes: "PK (actor_user_id, idempotency_key). Cascades with the Memory.",
  },
  {
    table: "memory_command_audit",
    subsystem: "command-kernel",
    writer: "public.memory_kernel_execute, one row per command ATTEMPT",
    reader: "operators",
    appendOnly: true,
    canonical: true,
    liveInProduction: true,
    providedBy: "2710_memory_command_kernel_tables.sql (applied to production 2026-09-15)",
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
    liveInProduction: true,
    providedBy: "2730_memory_derivative_registry.sql (applied to production 2026-09-15)",
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
