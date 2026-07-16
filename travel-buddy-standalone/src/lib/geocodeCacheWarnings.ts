/**
 * Geocode-cache warning banner state machine.
 *
 * Encapsulates the warning-state logic for the geocode-cache admin screen so
 * it can be unit-tested independently of React Native rendering.
 *
 * Usage in the screen:
 *   const machine = createGeocodeCacheWarningMachine(deleteGeocodeCacheRow);
 *   await machine.performDelete(cityKey);          // updates warnings internally
 *   await machine.handleRepairNow(cityKey);        // clears warning on success
 *   const warnings = machine.getWarnings();        // read-only snapshot
 *
 * The machine's `deleteGeocodeCacheRow` dep is injected so tests can supply a
 * controlled fake and verify state transitions without a running server.
 */

import type { AdminApiResult } from '../services/adminApi.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PendingWarning {
  cityKey: string;
  count: number;
  repairing: boolean;
}

export interface DeleteGeocodeCacheResult {
  deleted: true;
  city_key: string;
  /** Present when repair_catalog was NOT requested. */
  xx_entries_pending?: number;
  /** Present when repair_catalog=true was sent. */
  repair?: {
    updated: number;
    errors: number;
    skipped: number;
  };
}

export interface PutGeocodeCacheResult {
  updated: true;
  city_key: string;
  country_code: string;
  country: string;
  /** Present when repair_catalog was NOT sent. */
  xx_entries_pending?: number;
  /** Present when repair_catalog=true was sent. */
  repair?: {
    updated: number;
    errors: number;
    skipped: number;
  };
}

type DeleteFn = (
  cityKey: string,
  repairCatalog: boolean,
) => Promise<AdminApiResult<DeleteGeocodeCacheResult>>;

type PutFn = (
  cityKey: string,
  fields: { country_code: string; country: string; repair_catalog?: boolean },
) => Promise<AdminApiResult<PutGeocodeCacheResult>>;

// ── Pure state reducers ────────────────────────────────────────────────────────
// These are exported so they can be tested directly.

/** Compute updated warnings after a delete call resolves successfully. */
export function warningsAfterDelete(
  prev: readonly PendingWarning[],
  cityKey: string,
  xxEntriesPending: number,
): PendingWarning[] {
  if (xxEntriesPending > 0) {
    const without = prev.filter((w) => w.cityKey !== cityKey);
    return [{ cityKey, count: xxEntriesPending, repairing: false }, ...without];
  }
  return prev.filter((w) => w.cityKey !== cityKey);
}

/** Mark a warning as repairing (spinner) while the repair call is in-flight. */
export function warningsAfterRepairStart(
  prev: readonly PendingWarning[],
  cityKey: string,
): PendingWarning[] {
  return prev.map((w) => (w.cityKey === cityKey ? { ...w, repairing: true } : w));
}

/** Dismiss the warning after a successful repair. */
export function warningsAfterRepairSuccess(
  prev: readonly PendingWarning[],
  cityKey: string,
): PendingWarning[] {
  return prev.filter((w) => w.cityKey !== cityKey);
}

/** Reset the repairing flag after a failed repair — banner stays visible. */
export function warningsAfterRepairFailure(
  prev: readonly PendingWarning[],
  cityKey: string,
): PendingWarning[] {
  return prev.map((w) => (w.cityKey === cityKey ? { ...w, repairing: false } : w));
}

// ── Machine factory ────────────────────────────────────────────────────────────

export interface GeocodeCacheWarningMachine {
  /** Run a delete, then update warning state based on xx_entries_pending. */
  performDelete(
    cityKey: string,
    repairCatalog?: boolean,
  ): Promise<AdminApiResult<DeleteGeocodeCacheResult>>;
  /**
   * Run a PUT overwrite, then update warning state based on xx_entries_pending.
   * The PUT endpoint returns xx_entries_pending when repair_catalog is omitted,
   * just like the DELETE endpoint — so the same banner logic applies.
   */
  performPut(
    cityKey: string,
    fields: { country_code: string; country: string; repair_catalog?: boolean },
  ): Promise<AdminApiResult<PutGeocodeCacheResult>>;
  /** Initiate a repair-catalog delete, clearing the warning on success. */
  handleRepairNow(cityKey: string): Promise<AdminApiResult<DeleteGeocodeCacheResult>>;
  /** Read-only snapshot of current warnings. */
  getWarnings(): readonly PendingWarning[];
  /** True if a warning exists for the given cityKey. */
  hasWarning(cityKey: string): boolean;
  /** The warning record for a city, or undefined. */
  getWarning(cityKey: string): PendingWarning | undefined;
}

/**
 * Create a warning-state machine backed by the injected delete function.
 *
 * The screen passes the real `deleteGeocodeCacheRow` from adminGeocode.ts.
 * Tests pass a controlled fake.
 */
export function createGeocodeCacheWarningMachine(
  deleteFn: DeleteFn,
  putFn?: PutFn,
): GeocodeCacheWarningMachine {
  let warnings: PendingWarning[] = [];

  async function performDelete(
    cityKey: string,
    repairCatalog = false,
  ): Promise<AdminApiResult<DeleteGeocodeCacheResult>> {
    const res = await deleteFn(cityKey, repairCatalog);
    if (!res.ok) return res;

    const pending = res.data.xx_entries_pending ?? 0;
    warnings = warningsAfterDelete(warnings, cityKey, pending);
    return res;
  }

  async function performPut(
    cityKey: string,
    fields: { country_code: string; country: string; repair_catalog?: boolean },
  ): Promise<AdminApiResult<PutGeocodeCacheResult>> {
    if (!putFn) return { ok: false, error: 'No PUT function configured' };
    const res = await putFn(cityKey, fields);
    if (!res.ok) return res;

    // The PUT endpoint returns xx_entries_pending when repair_catalog is
    // omitted — same field, same banner logic as the DELETE path.
    const pending = res.data.xx_entries_pending ?? 0;
    warnings = warningsAfterDelete(warnings, cityKey, pending);
    return res;
  }

  async function handleRepairNow(
    cityKey: string,
  ): Promise<AdminApiResult<DeleteGeocodeCacheResult>> {
    warnings = warningsAfterRepairStart(warnings, cityKey);

    const res = await deleteFn(cityKey, true);

    if (!res.ok) {
      warnings = warningsAfterRepairFailure(warnings, cityKey);
      return res;
    }

    warnings = warningsAfterRepairSuccess(warnings, cityKey);
    return res;
  }

  return {
    performDelete,
    performPut,
    handleRepairNow,
    getWarnings: () => warnings,
    hasWarning: (cityKey) => warnings.some((w) => w.cityKey === cityKey),
    getWarning: (cityKey) => warnings.find((w) => w.cityKey === cityKey),
  };
}
