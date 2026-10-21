/** Request-local proof of a fresh canonical comparison; never changes persisted inputs or their hash. */
type ClockedRecord = { inputs: { nowMs: number } };
const VALIDATED_AT = new WeakMap<ClockedRecord, number>();

/** Only the canonical producer calls this, after a fresh certification has the identical decision. */
export function markCanonicalValidation(record: ClockedRecord, nowMs: number): void {
  if (Number.isFinite(nowMs)) VALIDATED_AT.set(record, nowMs);
}

/** Unvalidated records retain their original instant; copying a record does not copy its proof. */
export function certifiedPlanningInstant(record: ClockedRecord): number {
  return VALIDATED_AT.get(record) ?? record.inputs.nowMs;
}
