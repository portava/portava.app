/**
 * The §10 precision gate, read so that a failure can never publish MORE.
 *
 * `memory_location_precision_enabled` decides two things at once: whether a
 * Memory read may NAME `memories.location_precision` (the column exists only
 * where 2338 is applied — production does not have it), and whether a
 * non-owner read is CLAMPED to the owner's rung. `isFlagEnabled` answers
 * `false` for an unreadable flag, and every site used that one boolean for
 * both — so a flag read that failed published every Memory to non-owners at
 * 'exact', the widest rung, exactly when the database was unhealthy. A read
 * that protects someone's location must not fail toward showing more
 * (verifier finding 7).
 *
 * So the gate has three states, and they split into two booleans:
 *
 *   on          select the column, clamp to the owner's rung
 *   off         do not name the column, do not clamp (pre-2338 behaviour)
 *   unreadable  do not name the column (it may not exist) and CLAMP ANYWAY:
 *               with the column unselected, `publicationPrecision` reads the
 *               missing key as 'hidden' — the coarsest rung the owner could
 *               have chosen. A WRITE of an owner-chosen rung is refused
 *               retryably rather than dropped, because dropping it would leave
 *               the column's DEFAULT ('exact') standing in for the owner's
 *               choice.
 *
 * An ABSENT row is `off`: the gate has not been created on this database,
 * which is a configuration fact, not a failed read.
 */
import { readFlagState } from "./capability/schemaCapability.js";

export type MemoryPrecisionGate = "on" | "off" | "unreadable";

export async function readMemoryPrecisionGate(sc: unknown): Promise<MemoryPrecisionGate> {
  const s = await readFlagState(sc, "memory_location_precision_enabled");
  if (s === "on") return "on";
  if (s === "unreadable") return "unreadable";
  return "off";
}

/** May the read NAME `location_precision`? Only when the gate is definitely on. */
export function precisionColumnSelectable(g: MemoryPrecisionGate): boolean {
  return g === "on";
}

/** Must a non-owner read be clamped? Yes unless the gate is definitely off. */
export function precisionClampApplies(g: MemoryPrecisionGate): boolean {
  return g !== "off";
}

/** The refusal a write sends when the owner chose a rung and the gate could not be read. */
export const PRECISION_GATE_UNREADABLE_MESSAGE =
  "Your location setting could not be saved right now. Please try again.";
