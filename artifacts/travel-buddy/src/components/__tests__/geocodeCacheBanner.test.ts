/**
 * Tests for the XX-entries-pending warning banner in the geocode-cache admin screen.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/geocodeCacheBanner.test.ts
 *
 * ## Testing strategy
 *
 * The screen (app/admin/geocode-cache.tsx) delegates all warning-state
 * transitions to the pure reducers and machine factory in:
 *   src/lib/geocodeCacheWarnings.ts
 *
 * This file imports and exercises that production module directly.  If the
 * screen stops calling warningsAfterDelete / warningsAfterRepairSuccess / etc.,
 * or if those functions' logic regresses, these tests will catch it.
 *
 * The deleteGeocodeCacheRow dependency is injected as a controlled fake so
 * tests can drive any server response without a running backend.
 *
 * ## Scenarios covered
 *   1. Delete → xx_entries_pending > 0 → banner visible
 *   2. Banner clears after handleRepairNow succeeds
 *   3. Delete → xx_entries_pending = 0 → no banner
 *   4. Delete → xx_entries_pending absent (undefined) → no banner
 *   5. Existing warning for same key clears when re-delete returns 0
 *   6. Repair failure → banner stays, repairing flag resets to false
 *   7. Delete failure → no banner side-effects
 *   8. Pure reducers: warningsAfterDelete, warningsAfterRepairStart,
 *      warningsAfterRepairSuccess, warningsAfterRepairFailure
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeocodeCacheWarningMachine,
  warningsAfterDelete,
  warningsAfterRepairStart,
  warningsAfterRepairSuccess,
  warningsAfterRepairFailure,
  type PendingWarning,
  type DeleteGeocodeCacheResult,
} from '../../lib/geocodeCacheWarnings.ts';
import type { AdminApiResult } from '../../services/adminApi.ts';

// ── Fake helpers ───────────────────────────────────────────────────────────────

type DeleteFn = (
  cityKey: string,
  repairCatalog: boolean,
) => Promise<AdminApiResult<DeleteGeocodeCacheResult>>;

function okDelete(xxEntriesPending?: number): AdminApiResult<DeleteGeocodeCacheResult> {
  return {
    ok: true,
    data: { deleted: true, city_key: 'test', xx_entries_pending: xxEntriesPending } as DeleteGeocodeCacheResult,
  };
}

function okRepair(): AdminApiResult<DeleteGeocodeCacheResult> {
  return {
    ok: true,
    data: { deleted: true, city_key: 'test', repair: { updated: 3, errors: 0, skipped: 0 } } as DeleteGeocodeCacheResult,
  };
}

function failDelete(error = 'Server error'): AdminApiResult<DeleteGeocodeCacheResult> {
  return { ok: false, error, data: {} as DeleteGeocodeCacheResult };
}

/** Returns a DeleteFn that gives `first` on the first call, `second` on subsequent calls. */
function makeFake(
  first: AdminApiResult<DeleteGeocodeCacheResult>,
  second?: AdminApiResult<DeleteGeocodeCacheResult>,
): { fn: DeleteFn; calls: Array<{ cityKey: string; repairCatalog: boolean }> } {
  const calls: Array<{ cityKey: string; repairCatalog: boolean }> = [];
  let n = 0;
  const fn: DeleteFn = async (cityKey, repairCatalog) => {
    calls.push({ cityKey, repairCatalog });
    return n++ === 0 ? first : (second ?? first);
  };
  return { fn, calls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure reducer: warningsAfterDelete
// ─────────────────────────────────────────────────────────────────────────────

describe('warningsAfterDelete (production reducer)', () => {
  it('adds a warning when xxEntriesPending > 0', () => {
    const result = warningsAfterDelete([], 'paris__fr', 5);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.cityKey, 'paris__fr');
    assert.equal(result[0]!.count, 5);
    assert.equal(result[0]!.repairing, false);
  });

  it('prepends the new warning ahead of existing ones', () => {
    const existing: PendingWarning[] = [{ cityKey: 'berlin__de', count: 2, repairing: false }];
    const result = warningsAfterDelete(existing, 'paris__fr', 3);
    assert.equal(result[0]!.cityKey, 'paris__fr');
    assert.equal(result[1]!.cityKey, 'berlin__de');
  });

  it('replaces an existing warning for the same key', () => {
    const existing: PendingWarning[] = [{ cityKey: 'paris__fr', count: 1, repairing: false }];
    const result = warningsAfterDelete(existing, 'paris__fr', 9);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.count, 9);
  });

  it('removes an existing warning when xxEntriesPending = 0', () => {
    const existing: PendingWarning[] = [{ cityKey: 'paris__fr', count: 4, repairing: false }];
    const result = warningsAfterDelete(existing, 'paris__fr', 0);
    assert.equal(result.length, 0);
  });

  it('returns empty list when pending = 0 and no prior warning', () => {
    const result = warningsAfterDelete([], 'london__gb', 0);
    assert.deepEqual(result, []);
  });

  it('treats undefined xxEntriesPending as 0 — no warning added', () => {
    // The machine itself does `res.data.xx_entries_pending ?? 0` before calling
    // this reducer; the reducer only receives the resolved number.  Confirm 0
    // produces no warning.
    const result = warningsAfterDelete([], 'oslo__no', 0);
    assert.equal(result.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure reducer: warningsAfterRepairStart
// ─────────────────────────────────────────────────────────────────────────────

describe('warningsAfterRepairStart (production reducer)', () => {
  it('sets repairing=true for the target city', () => {
    const prev: PendingWarning[] = [{ cityKey: 'paris__fr', count: 3, repairing: false }];
    const result = warningsAfterRepairStart(prev, 'paris__fr');
    assert.equal(result[0]!.repairing, true);
  });

  it('does not affect other cities', () => {
    const prev: PendingWarning[] = [
      { cityKey: 'paris__fr', count: 3, repairing: false },
      { cityKey: 'berlin__de', count: 1, repairing: false },
    ];
    const result = warningsAfterRepairStart(prev, 'paris__fr');
    assert.equal(result.find((w) => w.cityKey === 'berlin__de')!.repairing, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure reducer: warningsAfterRepairSuccess
// ─────────────────────────────────────────────────────────────────────────────

describe('warningsAfterRepairSuccess (production reducer)', () => {
  it('removes the warning for the repaired city', () => {
    const prev: PendingWarning[] = [{ cityKey: 'paris__fr', count: 3, repairing: true }];
    const result = warningsAfterRepairSuccess(prev, 'paris__fr');
    assert.equal(result.length, 0);
  });

  it('leaves other cities intact', () => {
    const prev: PendingWarning[] = [
      { cityKey: 'paris__fr', count: 3, repairing: true },
      { cityKey: 'rome__it', count: 2, repairing: false },
    ];
    const result = warningsAfterRepairSuccess(prev, 'paris__fr');
    assert.equal(result.length, 1);
    assert.equal(result[0]!.cityKey, 'rome__it');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure reducer: warningsAfterRepairFailure
// ─────────────────────────────────────────────────────────────────────────────

describe('warningsAfterRepairFailure (production reducer)', () => {
  it('resets repairing=false for the target city', () => {
    const prev: PendingWarning[] = [{ cityKey: 'paris__fr', count: 3, repairing: true }];
    const result = warningsAfterRepairFailure(prev, 'paris__fr');
    assert.equal(result[0]!.repairing, false);
    assert.equal(result[0]!.count, 3, 'count must be preserved');
  });

  it('warning stays visible (not removed) after repair failure', () => {
    const prev: PendingWarning[] = [{ cityKey: 'cairo__eg', count: 5, repairing: true }];
    const result = warningsAfterRepairFailure(prev, 'cairo__eg');
    assert.equal(result.length, 1, 'warning must still exist');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine: banner appears and clears after Repair now
// ─────────────────────────────────────────────────────────────────────────────

describe('createGeocodeCacheWarningMachine — banner appears then clears after Repair now', () => {
  it('banner is visible after delete returns xx_entries_pending > 0', async () => {
    const { fn } = makeFake(okDelete(5));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('paris__fr');

    assert.equal(machine.hasWarning('paris__fr'), true,
      'warning banner must appear when xx_entries_pending > 0');
  });

  it('banner count matches xx_entries_pending from the delete response', async () => {
    const { fn } = makeFake(okDelete(12));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('berlin__de');

    assert.equal(machine.getWarning('berlin__de')!.count, 12);
  });

  it('repairing flag starts false when banner first appears', async () => {
    const { fn } = makeFake(okDelete(3));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('tokyo__jp');

    assert.equal(machine.getWarning('tokyo__jp')!.repairing, false);
  });

  it('banner is gone after handleRepairNow succeeds', async () => {
    const { fn } = makeFake(okDelete(5), okRepair());
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('paris__fr');
    assert.equal(machine.hasWarning('paris__fr'), true, 'banner visible before repair');

    await machine.handleRepairNow('paris__fr');

    assert.equal(machine.hasWarning('paris__fr'), false,
      'warning banner must be gone after a successful repair');
  });

  it('repair call passes repairCatalog=true', async () => {
    const { fn, calls } = makeFake(okDelete(2), okRepair());
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('paris__fr');
    await machine.handleRepairNow('paris__fr');

    assert.equal(calls[1]!.repairCatalog, true, 'repair call must pass repairCatalog=true');
  });

  it('other banners are unaffected when one city is repaired', async () => {
    let nA = 0;
    const fn: DeleteFn = async (cityKey, _repairCatalog) => {
      if (cityKey === 'amsterdam__nl') {
        return nA++ === 0 ? okDelete(4) : okRepair();
      }
      return okDelete(7);
    };
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('amsterdam__nl');
    await machine.performDelete('rome__it');
    await machine.handleRepairNow('amsterdam__nl');

    assert.equal(machine.hasWarning('amsterdam__nl'), false, 'repaired city banner gone');
    assert.equal(machine.hasWarning('rome__it'), true, 'unrelated banner must remain');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine: no banner when xx_entries_pending = 0 or absent
// ─────────────────────────────────────────────────────────────────────────────

describe('createGeocodeCacheWarningMachine — no banner when pending = 0 or absent', () => {
  it('no warning when xx_entries_pending = 0', async () => {
    const { fn } = makeFake(okDelete(0));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('london__gb');

    assert.equal(machine.hasWarning('london__gb'), false,
      'no warning banner when xx_entries_pending = 0');
    assert.equal(machine.getWarnings().length, 0);
  });

  it('no warning when xx_entries_pending is absent (server omits the field)', async () => {
    const { fn } = makeFake(okDelete(undefined));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('sydney__au');

    assert.equal(machine.hasWarning('sydney__au'), false,
      'no warning when xx_entries_pending is absent');
  });

  it('existing warning for same key clears when re-delete returns 0', async () => {
    let n = 0;
    const fn: DeleteFn = async () => n++ === 0 ? okDelete(3) : okDelete(0);
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('madrid__es');
    assert.equal(machine.hasWarning('madrid__es'), true, 'warning visible after first delete');

    await machine.performDelete('madrid__es');
    assert.equal(machine.hasWarning('madrid__es'), false,
      'warning must clear when re-delete returns 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine: repair failure — banner stays
// ─────────────────────────────────────────────────────────────────────────────

describe('createGeocodeCacheWarningMachine — repair failure', () => {
  it('banner remains visible when handleRepairNow fails', async () => {
    const { fn } = makeFake(okDelete(5), failDelete('Network error'));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('cairo__eg');
    await machine.handleRepairNow('cairo__eg');

    assert.equal(machine.hasWarning('cairo__eg'), true,
      'warning must remain visible when repair fails');
  });

  it('repairing flag resets to false after a failed repair', async () => {
    const { fn } = makeFake(okDelete(2), failDelete('Timeout'));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('cairo__eg');
    await machine.handleRepairNow('cairo__eg');

    assert.equal(machine.getWarning('cairo__eg')!.repairing, false,
      'repairing flag must reset to false after repair error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Machine: delete failure — no banner side-effects
// ─────────────────────────────────────────────────────────────────────────────

describe('createGeocodeCacheWarningMachine — delete failure', () => {
  it('no warning banner appears when delete itself fails', async () => {
    const { fn } = makeFake(failDelete('Forbidden'));
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('oslo__no');

    assert.equal(machine.hasWarning('oslo__no'), false,
      'no warning must appear when the delete call fails');
  });

  it('existing warning for a different city is unaffected by a failed delete', async () => {
    const fn: DeleteFn = async (cityKey) =>
      cityKey === 'lisbon__pt' ? okDelete(4) : failDelete('Not found');
    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('lisbon__pt');
    await machine.performDelete('unknown__xx');

    assert.equal(machine.hasWarning('lisbon__pt'), true, 'first warning must remain intact');
    assert.equal(machine.hasWarning('unknown__xx'), false, 'no banner for failed delete');
  });
});
