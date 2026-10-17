/**
 * §24's PROJECTION log — the line the eighth field lives on.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1,
 *       §24 (.txt:640): "Operational logs must include memoryId, commandId,
 *       eventId, source version, engine version, reason codes, projection
 *       name, and failure class. Do not log sensitive raw content unless
 *       strictly necessary."
 *
 * CENSUS: H223. The COMMAND log (services/memory/MemoryDomainService.ts
 * `auditCommand`) carries seven of the eight and an explicit null
 * `projectionName`, because a command is not a projection. This module is the
 * line a PROJECTION operation writes:
 *
 *   - every registration the §18 registry rebuilds —
 *     derivativeRegistry.rebuildProjection, reached by the privacy-change and
 *     deletion re-derivation (narrowingReprojection), the search's
 *     ensure-fresh (memorySearchService) and the outbox consumer;
 *   - every fail-closed revocation narrowingReprojection writes when a
 *     re-derivation cannot be completed.
 *
 * SAME EIGHT KEYS, SAME NAMES as the command line, so one query reads both
 * logs and joins them on `commandId` / `eventId`: a privacy change's command
 * line and the re-derivations it caused carry the same command id.
 *
 * NEVER LOGGED: the payload, a title, a caption, a place. Ids, versions and
 * codes only — a projection's rows are exactly the "sensitive raw content"
 * §24 says not to log.
 */
import { logger } from "../../lib/logger.js";

/** What caused a projection operation. Every field is optional; an absent one is logged as null. */
export interface ProjectionTrace {
  /** The Memory whose change caused the operation; null for a scope-wide rebuild (a search's ensure-fresh). */
  memoryId?: string | null;
  /** The §17 command that caused it (a PATCH or DELETE), when there was one. */
  commandId?: string | null;
  /** The domain event that caused it (the outbox consumer), or the command's event; null while the kernel is off. */
  eventId?: string | null;
  /** Why it ran, as a code: `memory_visibility_changed`, `memory_deleted`, an event type. */
  reason?: string | null;
}

export type ProjectionOperation = "rebuild" | "revoke";

/**
 * `rebuilt` — derived and registered. `kept_revoked` — the rebuild declined to
 * overwrite a REVOKED registration, which is the rule, not a failure.
 * `revoked` — the registration was emptied. `refused` — the operation did not
 * complete; the line carries a failure class.
 */
export type ProjectionOutcome = "rebuilt" | "kept_revoked" | "revoked" | "refused";

/**
 * The CLASS of a refusal, in auditCommand's vocabulary where one fits, so a
 * dashboard reads one set of classes across both logs. An unknown reason is
 * `unclassified` — never folded into the nearest class.
 */
const PROJECTION_FAILURE_CLASSES: Readonly<Record<string, string>> = Object.freeze({
  unknown_projection: "validation",
  projection_not_configured: "not_configured",
  not_registered: "not_found",
  source_unavailable: "infrastructure",
  registry_unavailable: "infrastructure",
  registry_write_unconfirmed: "infrastructure",
  rebuild_threw: "infrastructure",
  revocation_unconfirmed: "infrastructure",
});

export function projectionFailureClassOf(reason: string | null | undefined): string {
  return (reason && PROJECTION_FAILURE_CLASSES[reason]) || "unclassified";
}

export interface ProjectionLogEntry {
  operation: ProjectionOperation;
  outcome: ProjectionOutcome;
  projectionName: string;
  scopeKey: string | null;
  /** The source version the registration now records; null when nothing was registered. */
  sourceVersion: string | null;
  /** The builder that produced (or produced, before revocation) the derivative; null when none is defined. */
  engineVersion: string | null;
  /** A refusal's reason code; a revocation's reason. Defaults to the trace's reason. */
  reason?: string | null;
  rowCount?: number | null;
  trace?: ProjectionTrace | undefined;
}

/** Write one projection log line. Never throws: logging must not turn a completed operation into a failure. */
export function logProjectionOperation(e: ProjectionLogEntry): void {
  try {
    const refused = e.outcome === "refused";
    const line = {
      memoryId: e.trace?.memoryId ?? null,
      commandId: e.trace?.commandId ?? null,
      eventId: e.trace?.eventId ?? null,
      sourceVersion: e.sourceVersion,
      engineVersion: e.engineVersion,
      reason: e.reason ?? e.trace?.reason ?? null,
      projectionName: e.projectionName,
      failureClass: refused ? projectionFailureClassOf(e.reason) : null,
      operation: e.operation,
      outcome: e.outcome,
      scopeKey: e.scopeKey,
      rowCount: e.rowCount ?? null,
      triggerReason: e.trace?.reason ?? null,
    };
    if (refused) logger.warn(line, "memory projection refused");
    else logger.info(line, "memory projection applied");
  } catch {
    // A logger that throws is not a reason to fail the projection it describes.
  }
}

/** The projection id a registry scope key names (`scopeKeyOf` writes `<projection>|owner:…`). */
export function projectionNameOfScopeKey(scopeKey: string): string {
  return String(scopeKey ?? "").split("|")[0] ?? "";
}
