/**
 * SafeReturnSetupSheet — contact-load behaviour tests.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/SafeReturnSetupSheet.contactLoad.test.ts
 *
 * ## Testing strategy
 *
 * The contact-loading phase of `useEffect([visible])` was extracted into the
 * pure helper `runContactLoad` (SafeReturnSetupSheet.contactLoad.ts).
 *
 * The critical invariant: runContactLoad NEVER throws.
 * Why this matters: the component calls `setContactsLoading(false)` right after
 * `await runContactLoad(...)` — no try/catch or finally needed. If the helper
 * ever threw, the spinner would get stuck.  We prove the invariant holds for:
 *
 *   A) Both calls succeed  → correct contacts returned, loadError: false
 *   B) getTrustedContacts throws only  → empty lists, loadError: true, no throw
 *   C) listEmergencyContacts throws only  → empty lists, loadError: true, no throw
 *   D) Both throw together  → empty lists, loadError: true, no throw
 *   E) Successive calls — error then success — behave independently
 *   F) getTrustedContacts resolves null (unreadable, not empty) → loadError
 *   G) listEmergencyContacts reports { error } (unreadable)     → loadError
 *
 * F and G are the reason this contract exists at all. Neither service ever
 * threw: getTrustedContacts returned `[]` on an outage and listEmergencyContacts
 * returned `{ contacts: [], error }` whose error nobody read — so every
 * loadError branch above was unreachable, and a failed read reached the user as
 * "No contacts saved yet" while they armed a safety timer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runContactLoad } from '../safeReturn/SafeReturnSetupSheet.contactLoad.ts';

// ── Stub types for tests ───────────────────────────────────────────────────────

interface StubTC { userId: string; displayName: string }
interface StubEC { id: string; name: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeps(overrides: {
  getTrustedContacts?: () => Promise<StubTC[] | null>;
  listEmergencyContacts?: () => Promise<{ contacts: StubEC[]; error?: string }>;
}) {
  return {
    getTrustedContacts: overrides.getTrustedContacts ?? (async () => []),
    listEmergencyContacts: overrides.listEmergencyContacts ?? (async () => ({ contacts: [] })),
  };
}

const TRUSTED = [{ userId: 'u1', displayName: 'Alice' }];
const EMERGENCY = [{ id: 'ec1', name: 'Bob' }];

// ── A) Happy path ──────────────────────────────────────────────────────────────

describe('runContactLoad — both calls succeed', () => {
  it('returns the trusted contacts list from getTrustedContacts', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => TRUSTED,
    });

    const result = await runContactLoad(deps);

    assert.deepEqual(result.trustedContacts, TRUSTED);
  });

  it('returns the emergency contacts list from listEmergencyContacts', async () => {
    const deps = makeDeps({
      listEmergencyContacts: async () => ({ contacts: EMERGENCY }),
    });

    const result = await runContactLoad(deps);

    assert.deepEqual(result.emergencyContacts, EMERGENCY);
  });

  it('sets loadError to false on success', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => TRUSTED,
      listEmergencyContacts: async () => ({ contacts: EMERGENCY }),
    });

    const result = await runContactLoad(deps);

    assert.equal(result.loadError, false);
  });

  it('returns empty arrays when both services return empty lists', async () => {
    const deps = makeDeps({});

    const result = await runContactLoad(deps);

    assert.deepEqual(result.trustedContacts, []);
    assert.deepEqual(result.emergencyContacts, []);
    assert.equal(result.loadError, false);
  });
});

// ── B) getTrustedContacts throws ──────────────────────────────────────────────

describe('runContactLoad — getTrustedContacts throws', () => {
  it('does NOT re-throw (contactsLoading spinner will always clear)', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => { throw new Error('network error'); },
    });

    await assert.doesNotReject(
      () => runContactLoad(deps),
      'runContactLoad must swallow getTrustedContacts errors so the spinner clears',
    );
  });

  it('returns empty trustedContacts on error', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => { throw new Error('timeout'); },
    });

    const result = await runContactLoad(deps);

    assert.deepEqual(result.trustedContacts, []);
  });

  it('returns empty emergencyContacts even though listEmergencyContacts would have succeeded', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => { throw new Error('500'); },
      listEmergencyContacts: async () => ({ contacts: EMERGENCY }),
    });

    const result = await runContactLoad(deps);

    // Promise.all rejects when either promise rejects — both lists are empty.
    assert.deepEqual(result.emergencyContacts, []);
  });

  it('sets loadError to true', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => { throw new Error('forbidden'); },
    });

    const result = await runContactLoad(deps);

    assert.equal(result.loadError, true);
  });
});

// ── C) listEmergencyContacts throws ───────────────────────────────────────────

describe('runContactLoad — listEmergencyContacts throws', () => {
  it('does NOT re-throw (contactsLoading spinner will always clear)', async () => {
    const deps = makeDeps({
      listEmergencyContacts: async () => { throw new Error('network error'); },
    });

    await assert.doesNotReject(
      () => runContactLoad(deps),
      'runContactLoad must swallow listEmergencyContacts errors so the spinner clears',
    );
  });

  it('returns empty emergencyContacts on error', async () => {
    const deps = makeDeps({
      listEmergencyContacts: async () => { throw new Error('timeout'); },
    });

    const result = await runContactLoad(deps);

    assert.deepEqual(result.emergencyContacts, []);
  });

  it('returns empty trustedContacts even though getTrustedContacts would have succeeded', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => TRUSTED,
      listEmergencyContacts: async () => { throw new Error('server error'); },
    });

    const result = await runContactLoad(deps);

    // Promise.all rejects when either promise rejects — both lists are empty.
    assert.deepEqual(result.trustedContacts, []);
  });

  it('sets loadError to true', async () => {
    const deps = makeDeps({
      listEmergencyContacts: async () => { throw new TypeError('fetch is not defined'); },
    });

    const result = await runContactLoad(deps);

    assert.equal(result.loadError, true);
  });
});

// ── D) Both throw together ────────────────────────────────────────────────────

describe('runContactLoad — both services throw', () => {
  it('does NOT re-throw when both services fail', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => { throw new Error('TC error'); },
      listEmergencyContacts: async () => { throw new Error('EC error'); },
    });

    await assert.doesNotReject(
      () => runContactLoad(deps),
      'spinner must always clear even when both contact services fail',
    );
  });

  it('returns empty lists when both services fail', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => { throw new Error('TC error'); },
      listEmergencyContacts: async () => { throw new Error('EC error'); },
    });

    const result = await runContactLoad(deps);

    assert.deepEqual(result.trustedContacts, []);
    assert.deepEqual(result.emergencyContacts, []);
    assert.equal(result.loadError, true);
  });
});

// ── E) Successive calls behave independently ──────────────────────────────────

describe('runContactLoad — successive calls', () => {
  it('first call fails, second call succeeds independently', async () => {
    let callCount = 0;
    const deps = makeDeps({
      getTrustedContacts: async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient failure');
        return TRUSTED;
      },
    });

    const r1 = await runContactLoad(deps);
    const r2 = await runContactLoad(deps);

    assert.equal(r1.loadError, true, 'first call: error path');
    assert.deepEqual(r1.trustedContacts, []);

    assert.equal(r2.loadError, false, 'second call: success path');
    assert.deepEqual(r2.trustedContacts, TRUSTED);
  });

  it('two consecutive successful calls both return correct data', async () => {
    const deps = makeDeps({
      getTrustedContacts: async () => TRUSTED,
      listEmergencyContacts: async () => ({ contacts: EMERGENCY }),
    });

    const r1 = await runContactLoad(deps);
    const r2 = await runContactLoad(deps);

    assert.equal(r1.loadError, false);
    assert.equal(r2.loadError, false);
    assert.deepEqual(r1.trustedContacts, TRUSTED);
    assert.deepEqual(r2.trustedContacts, TRUSTED);
  });
});

// ── F/G) Unreadable, as opposed to empty ──────────────────────────────────────

describe('runContactLoad — the read fails without throwing', () => {
  it('treats a null trusted list as a load error, not as "no contacts"', async () => {
    const r = await runContactLoad(makeDeps({
      getTrustedContacts: async () => null,
      listEmergencyContacts: async () => ({ contacts: EMERGENCY }),
    }));

    assert.equal(r.loadError, true, 'null means unreadable, not empty');
    assert.deepEqual(r.trustedContacts, []);
    assert.deepEqual(r.emergencyContacts, []);
  });

  it('treats an emergency-contact error field as a load error', async () => {
    const r = await runContactLoad(makeDeps({
      getTrustedContacts: async () => TRUSTED,
      listEmergencyContacts: async () => ({ contacts: [], error: 'network_error' }),
    }));

    assert.equal(r.loadError, true);
    assert.deepEqual(r.trustedContacts, []);
  });

  it('still reports loadError:false when both lists are genuinely empty', async () => {
    const r = await runContactLoad(makeDeps({
      getTrustedContacts: async () => [],
      listEmergencyContacts: async () => ({ contacts: [] }),
    }));

    assert.equal(r.loadError, false, 'a real "you have none" must stay distinguishable');
    assert.deepEqual(r.trustedContacts, []);
    assert.deepEqual(r.emergencyContacts, []);
  });
});
