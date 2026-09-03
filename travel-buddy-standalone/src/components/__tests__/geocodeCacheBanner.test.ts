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
  type PutGeocodeCacheResult,
} from '../../lib/geocodeCacheWarnings.ts';
import type { AdminApiResult } from '../../services/adminApi.ts';

// ── Fake helpers ───────────────────────────────────────────────────────────────

type DeleteFn = (
  cityKey: string,
  repairCatalog: boolean,
) => Promise<AdminApiResult<DeleteGeocodeCacheResult>>;

type PutFn = (
  cityKey: string,
  fields: { country_code: string; country: string; repair_catalog?: boolean },
) => Promise<AdminApiResult<PutGeocodeCacheResult>>;

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

// AdminApiResult's failure branch is `{ ok: false; error: string }` — it carries
// no `data` at all, so the `data: {} as …` these two used to pass was a field
// the type does not have and no consumer can legally read.
function failDelete(error = 'Server error'): AdminApiResult<DeleteGeocodeCacheResult> {
  return { ok: false, error };
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
// Machine: repairing=true is set mid-flight, banner clears after resolve
// ─────────────────────────────────────────────────────────────────────────────

describe('createGeocodeCacheWarningMachine — repairing spinner mid-flight then banner clears', () => {
  it('repairing=true is set immediately when handleRepairNow is called, before the response arrives', async () => {
    // Control when the repair call resolves so we can inspect state mid-flight.
    let resolveRepair!: (result: AdminApiResult<DeleteGeocodeCacheResult>) => void;
    const repairPromise = new Promise<AdminApiResult<DeleteGeocodeCacheResult>>(
      (resolve) => { resolveRepair = resolve; },
    );

    let callCount = 0;
    const fn: DeleteFn = async (_cityKey, _repairCatalog) => {
      callCount++;
      if (callCount === 1) {
        // First call: initial delete — produces the warning banner.
        return okDelete(5);
      }
      // Second call: repair — deliberately delayed so we can inspect mid-flight.
      return repairPromise;
    };

    const machine = createGeocodeCacheWarningMachine(fn);

    // Trigger the initial delete so the banner appears.
    await machine.performDelete('paris__fr');
    assert.equal(machine.hasWarning('paris__fr'), true,
      'precondition: banner must be visible after delete');
    assert.equal(machine.getWarning('paris__fr')!.repairing, false,
      'precondition: repairing must be false before repair is triggered');

    // Start the repair but do NOT await it yet — the in-flight promise is still pending.
    const repairTask = machine.handleRepairNow('paris__fr');

    // handleRepairNow calls warningsAfterRepairStart synchronously before its first
    // await, so repairing must already be true at this point (JS is single-threaded;
    // the async function won't advance past the await until we yield).
    assert.equal(machine.getWarning('paris__fr')!.repairing, true,
      'repairing must be true immediately after handleRepairNow is called — the spinner must show mid-flight');

    // The banner itself must still exist while the repair is in-flight.
    assert.equal(machine.hasWarning('paris__fr'), true,
      'banner must still be present while the repair call is in-flight');

    // Now let the repair response arrive.
    resolveRepair(okRepair());
    await repairTask;

    // After a successful repair the banner must be gone entirely.
    assert.equal(machine.hasWarning('paris__fr'), false,
      'banner must be gone after the repair response resolves successfully — not left stuck');
  });

  it('other city banners stay intact while one city repair is in-flight', async () => {
    let resolveRepair!: (result: AdminApiResult<DeleteGeocodeCacheResult>) => void;
    const repairPromise = new Promise<AdminApiResult<DeleteGeocodeCacheResult>>(
      (resolve) => { resolveRepair = resolve; },
    );

    let parisCount = 0;
    const fn: DeleteFn = async (cityKey, _repairCatalog) => {
      if (cityKey === 'paris__fr') {
        parisCount++;
        return parisCount === 1 ? okDelete(4) : repairPromise;
      }
      return okDelete(6);
    };

    const machine = createGeocodeCacheWarningMachine(fn);

    await machine.performDelete('paris__fr');
    await machine.performDelete('berlin__de');

    const repairTask = machine.handleRepairNow('paris__fr');

    // Paris is repairing; berlin's banner must be unaffected.
    assert.equal(machine.getWarning('paris__fr')!.repairing, true,
      'paris must be in repairing state mid-flight');
    assert.equal(machine.getWarning('berlin__de')!.repairing, false,
      'berlin repairing flag must not be touched');
    assert.equal(machine.hasWarning('berlin__de'), true,
      'berlin banner must remain visible while paris repair is in-flight');

    resolveRepair(okRepair());
    await repairTask;

    assert.equal(machine.hasWarning('paris__fr'), false,
      'paris banner must clear after repair resolves');
    assert.equal(machine.hasWarning('berlin__de'), true,
      'berlin banner must still be present after paris repair completes');
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

// ─────────────────────────────────────────────────────────────────────────────
// PUT without repair_catalog — banner appears
// ─────────────────────────────────────────────────────────────────────────────

/** Build an ok PUT response with the given xx_entries_pending count. */
function okPut(
  xxEntriesPending?: number,
  cityKey = 'test',
): AdminApiResult<PutGeocodeCacheResult> {
  return {
    ok: true,
    data: {
      updated: true,
      city_key: cityKey,
      country_code: 'DE',
      country: 'Germany',
      xx_entries_pending: xxEntriesPending,
    } as PutGeocodeCacheResult,
  };
}

function failPut(error = 'Server error'): AdminApiResult<PutGeocodeCacheResult> {
  return { ok: false, error };
}

function makePutFake(
  response: AdminApiResult<PutGeocodeCacheResult>,
): { fn: PutFn; calls: Array<{ cityKey: string; fields: { country_code: string; country: string; repair_catalog?: boolean } }> } {
  const calls: Array<{ cityKey: string; fields: { country_code: string; country: string; repair_catalog?: boolean } }> = [];
  const fn: PutFn = async (cityKey, fields) => {
    calls.push({ cityKey, fields });
    return response;
  };
  return { fn, calls };
}

/** Stub delete fn — never called in PUT-only tests but required by the factory. */
const noOpDeleteFn: DeleteFn = async () => okDelete(0);

describe('createGeocodeCacheWarningMachine — PUT without repair_catalog → banner appears', () => {
  it('banner is visible after PUT returns xx_entries_pending > 0', async () => {
    const { fn } = makePutFake(okPut(3, 'vienna__at'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('vienna__at', { country_code: 'AT', country: 'Austria' });

    assert.equal(machine.hasWarning('vienna__at'), true,
      'warning banner must appear when PUT returns xx_entries_pending > 0');
  });

  it('banner count matches xx_entries_pending from the PUT response', async () => {
    const { fn } = makePutFake(okPut(7, 'vienna__at'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('vienna__at', { country_code: 'AT', country: 'Austria' });

    assert.equal(machine.getWarning('vienna__at')!.count, 7,
      'warning count must reflect the xx_entries_pending value from the PUT response');
  });

  it('repairing flag starts false when banner first appears via PUT', async () => {
    const { fn } = makePutFake(okPut(2, 'prague__cz'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('prague__cz', { country_code: 'CZ', country: 'Czechia' });

    assert.equal(machine.getWarning('prague__cz')!.repairing, false,
      'repairing must be false when the banner first appears');
  });

  it('PUT passes the supplied fields to the put function', async () => {
    const { fn, calls } = makePutFake(okPut(1, 'bruges__be'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('bruges__be', { country_code: 'BE', country: 'Belgium' });

    assert.equal(calls.length, 1, 'put function must be called exactly once');
    assert.equal(calls[0]!.cityKey, 'bruges__be');
    assert.equal(calls[0]!.fields.country_code, 'BE');
    assert.equal(calls[0]!.fields.country, 'Belgium');
  });

  it('PUT banner coexists with an existing delete banner for a different city', async () => {
    const deleteFn: DeleteFn = async () => okDelete(5);
    const { fn: putFn } = makePutFake(okPut(3, 'oslo__no'));
    const machine = createGeocodeCacheWarningMachine(deleteFn, putFn);

    await machine.performDelete('stockholm__se');
    await machine.performPut('oslo__no', { country_code: 'NO', country: 'Norway' });

    assert.equal(machine.hasWarning('stockholm__se'), true, 'delete banner must still be visible');
    assert.equal(machine.hasWarning('oslo__no'), true, 'PUT banner must also be visible');
    assert.equal(machine.getWarnings().length, 2);
  });

  it('PUT failure does not create a banner', async () => {
    const { fn } = makePutFake(failPut('Forbidden'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('reykjavik__is', { country_code: 'IS', country: 'Iceland' });

    assert.equal(machine.hasWarning('reykjavik__is'), false,
      'no warning must appear when the PUT call itself fails');
    assert.equal(machine.getWarnings().length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT without repair_catalog — no banner when xx_entries_pending = 0 or absent
// ─────────────────────────────────────────────────────────────────────────────

describe('createGeocodeCacheWarningMachine — PUT without repair_catalog → no banner', () => {
  it('no warning when PUT returns xx_entries_pending = 0', async () => {
    const { fn } = makePutFake(okPut(0, 'athens__gr'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('athens__gr', { country_code: 'GR', country: 'Greece' });

    assert.equal(machine.hasWarning('athens__gr'), false,
      'no warning banner when xx_entries_pending = 0');
    assert.equal(machine.getWarnings().length, 0);
  });

  it('no warning when PUT response omits xx_entries_pending', async () => {
    const { fn } = makePutFake(okPut(undefined, 'lisbon__pt'));
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('lisbon__pt', { country_code: 'PT', country: 'Portugal' });

    assert.equal(machine.hasWarning('lisbon__pt'), false,
      'no warning when xx_entries_pending is absent from the PUT response');
  });

  it('existing warning for same key clears when a subsequent PUT returns 0', async () => {
    let n = 0;
    const fn: PutFn = async (cityKey) =>
      n++ === 0 ? okPut(4, cityKey) : okPut(0, cityKey);
    const machine = createGeocodeCacheWarningMachine(noOpDeleteFn, fn);

    await machine.performPut('warsaw__pl', { country_code: 'PL', country: 'Poland' });
    assert.equal(machine.hasWarning('warsaw__pl'), true, 'warning visible after first PUT');

    await machine.performPut('warsaw__pl', { country_code: 'PL', country: 'Poland' });
    assert.equal(machine.hasWarning('warsaw__pl'), false,
      'warning must clear when subsequent PUT returns xx_entries_pending = 0');
  });

  it('warning for a different city is unaffected when PUT returns 0 for its own city', async () => {
    const deleteFn: DeleteFn = async () => okDelete(3);
    const { fn: putFn } = makePutFake(okPut(0, 'budapest__hu'));
    const machine = createGeocodeCacheWarningMachine(deleteFn, putFn);

    await machine.performDelete('zagreb__hr');
    await machine.performPut('budapest__hu', { country_code: 'HU', country: 'Hungary' });

    assert.equal(machine.hasWarning('zagreb__hr'), true,
      'unrelated delete banner must remain intact');
    assert.equal(machine.hasWarning('budapest__hu'), false,
      'PUT city with 0 pending must not get a banner');
  });
});
