/**
 * Trips v4 kernel — public surface.
 *
 * Import the kernel from here, not from the files inside. The direct-trip-write
 * ratchet (src/scripts/checkDirectTripWrites.ts) exempts this directory and
 * nothing else, so a trip write that does not come through
 * `executeTripCommand` is counted as debt wherever it lives.
 */
export { executeTripCommand, derivedIdempotencyKey } from "./kernel.js";
export type {
  TripCommand,
  TripCommandBase,
  CompleteTripCommand,
  TripCommandResult,
  TripEventRecord,
  TripEventType,
  TripKernelError,
  TripKernelErrorCode,
  TripStatus,
} from "./types.js";
