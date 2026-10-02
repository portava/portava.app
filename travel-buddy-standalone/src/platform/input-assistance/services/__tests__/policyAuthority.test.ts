/**
 * G340 — the client obeys the policy authority, and every way that can fail
 * lands on LESS assistance rather than more.
 *
 * Run: node --import tsx --test src/platform/input-assistance/services/__tests__/policyAuthority.test.ts
 *
 * WHAT THIS IS FOR. Deleting `INPUT_CONTEXT_REGISTRY` moved the answer to
 * "what may this field do?" off the device and onto the wire. That is the right
 * place for it, and it introduces five states the local table never had: no
 * policy yet, a policy for someone else, an expired policy, a superseded
 * policy, and a policy containing values this build cannot name. Each one is a
 * chance to accidentally grant something.
 *
 * Every case below is an ASSERTION ABOUT PERMISSION, not about plumbing. The
 * question is never "did the fetch work" — it is "when this goes wrong, is the
 * field less capable or more?".
 *
 * These are pure modules by design: no React, no network, injectable clock. The
 * account-switch and expiry behaviours are exactly the ones that are invisible
 * in a manual pass, so they are the ones that had to be mechanically provable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyStore } from '../policyStore.ts';
import {
  CONSERVATIVE_POLICY,
  UNREACHABLE_MIN_CHARS,
  sanitizeServedPolicy,
  offlineSurfaceAllowed,
} from '../../contexts/policyFallback.ts';
import { refreshPolicies, applyAccountChange } from '../policySync.ts';
import type { PolicyFetchResult } from '../policySync.ts';

/** A permissive served policy — what a real `city_picker` looks like. */
function servedCityPicker(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: 'city_picker',
    mode: 'canonical_picker',
    allowedSuggestionTypes: ['entity', 'recent'],
    entityTypes: ['city', 'country'],
    allowPersonalization: true,
    allowLiveContext: true,
    allowMemoryContext: true,
    allowAI: true,
    minChars: 1,
    maxSuggestions: 8,
    debounceMs: 120,
    offlinePolicy: 'cached_local',
    privacyClass: 'public',
    zeroStateAssistance: true,
    ...over,
  };
}

const ACCOUNT_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ACCOUNT_B = 'bbbbbbbb-0000-0000-0000-00000000000b';

function storeAt(t: { now: number }): PolicyStore {
  return new PolicyStore({ maxAgeMs: 1000 }, () => t.now);
}

/** Every permission a policy can grant, as a flat record — so a test can assert
 *  "nothing is granted" without listing the members and missing a new one. */
function grants(p: {
  mode: string;
  allowedSuggestionTypes: unknown[];
  entityTypes: unknown[];
  allowPersonalization: boolean;
  allowLiveContext: boolean;
  allowMemoryContext: boolean;
  allowAI: boolean;
  minChars: number;
  maxSuggestions: number;
  zeroStateAssistance: boolean;
}): Record<string, unknown> {
  return {
    assisted: p.mode !== 'no_assistance',
    types: p.allowedSuggestionTypes.length,
    entities: p.entityTypes.length,
    personalization: p.allowPersonalization,
    live: p.allowLiveContext,
    memory: p.allowMemoryContext,
    ai: p.allowAI,
    reachableMinChars: p.minChars < UNREACHABLE_MIN_CHARS,
    suggestions: p.maxSuggestions,
    zeroState: p.zeroStateAssistance,
  };
}

const GRANTS_NOTHING = {
  assisted: false,
  types: 0,
  entities: 0,
  personalization: false,
  live: false,
  memory: false,
  ai: false,
  reachableMinChars: false,
  suggestions: 0,
  zeroState: false,
};

describe('G340 — the authoritative path, end to end', () => {
  it('a fetched table is what the resolver serves, field for field', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    assert.equal(
      store.install(ACCOUNT_A, 'input-2026-09', { city_picker: servedCityPicker() }),
      true,
    );

    const r = store.readActive('city_picker');
    assert.equal(r.authoritative, true, 'a freshly installed table must read as authoritative');
    assert.equal(r.policy.mode, 'canonical_picker');
    assert.equal(r.policy.minChars, 1);
    assert.equal(r.policy.privacyClass, 'public');
    assert.equal(r.policy.offlinePolicy, 'cached_local');
    assert.deepEqual(r.policy.entityTypes, ['city', 'country']);
    assert.equal(r.policy.zeroStateAssistance, true);
  });

  it('COLD START grants nothing — not "sensible defaults"', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    const r = store.readActive('city_picker');
    assert.equal(r.authoritative, false);
    assert.equal(r.reason, 'never_fetched');
    assert.deepEqual(grants(r.policy), GRANTS_NOTHING);
  });

  it('a context the authority did not send grants nothing', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    const r = store.readActive('telegraph_message');
    assert.equal(r.reason, 'context_absent');
    assert.deepEqual(grants(r.policy), GRANTS_NOTHING);
  });
});

describe('G340 — account and session isolation', () => {
  it("ACCOUNT SWITCH: B never reads A's policy", () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    assert.equal(store.readActive('city_picker').authoritative, true);

    store.setActiveAccount(ACCOUNT_B);
    const r = store.readActive('city_picker');
    assert.equal(r.authoritative, false, "B must not inherit A's permissions");
    assert.deepEqual(grants(r.policy), GRANTS_NOTHING);
    assert.equal(store.heldAccount(), null, 'the switch must DROP the snapshot, not merely refuse it');
  });

  it('SIGN-OUT drops the snapshot, and signed-out reads grant nothing', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });

    store.setActiveAccount(null);
    assert.equal(store.heldAccount(), null);
    const r = store.readActive('city_picker');
    // `never_fetched`, not `account_mismatch`: signing out DROPS the snapshot
    // rather than leaving it in memory to be refused on each read. Stricter
    // than a mismatch, and deliberately so — the previous viewer's table is
    // the record of what that viewer was permitted, and it should not outlive
    // their session inside the process.
    assert.equal(r.reason, 'never_fetched');
    assert.deepEqual(grants(r.policy), GRANTS_NOTHING);
  });

  it('a direct read for the WRONG account is refused even if a snapshot is held', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    assert.equal(store.read('city_picker', ACCOUNT_A).authoritative, true);
    assert.equal(store.read('city_picker', ACCOUNT_B).authoritative, false);
    assert.equal(store.read('city_picker', null).authoritative, false);
  });

  it('a snapshot for a null or empty account is REFUSED, not filed under a placeholder', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    assert.equal(store.install(null, 'v1', { city_picker: servedCityPicker() }), false);
    assert.equal(store.install('', 'v1', { city_picker: servedCityPicker() }), false);
    assert.equal(store.heldAccount(), null);
  });

  it('a token refresh reporting the SAME account keeps the snapshot', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    store.setActiveAccount(ACCOUNT_A);
    assert.equal(store.readActive('city_picker').authoritative, true);
  });
});

describe('G340 — policyVersion invalidation', () => {
  it('a suggest response naming a NEWER version supersedes the held table', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'input-2026-08', { city_picker: servedCityPicker() });
    assert.equal(store.readActive('city_picker').authoritative, true);

    store.noteServedVersion('input-2026-09');
    const r = store.readActive('city_picker');
    assert.equal(r.reason, 'version_superseded');
    assert.deepEqual(grants(r.policy), GRANTS_NOTHING, 'a superseded table must not keep granting');
    assert.equal(store.needsRefresh(ACCOUNT_A), true);
  });

  it('the SAME version changes nothing', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    store.noteServedVersion('v1');
    assert.equal(store.readActive('city_picker').authoritative, true);
    assert.equal(store.needsRefresh(ACCOUNT_A), false);
  });

  it('installing the new table clears the supersession', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    store.noteServedVersion('v2');
    assert.equal(store.readActive('city_picker').authoritative, false);

    store.install(ACCOUNT_A, 'v2', { city_picker: servedCityPicker({ minChars: 3 }) });
    const r = store.readActive('city_picker');
    assert.equal(r.authoritative, true);
    assert.equal(r.policy.minChars, 3, 'the NEW table must be what is served, not the old one');
  });

  it('a superseded version does not survive a logout into the next session', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });
    store.noteServedVersion('v2');

    store.setActiveAccount(ACCOUNT_B);
    store.install(ACCOUNT_B, 'v2', { city_picker: servedCityPicker() });
    assert.equal(
      store.readActive('city_picker').authoritative,
      true,
      "B's fresh table must not look superseded by a version A's session reported",
    );
  });
});

describe("G340 — the row's own acceptance criterion", () => {
  it('A POLICY CHANGE ON THE SERVER REACHES A CLIENT THAT WAS BUILT BEFORE IT', () => {
    // This is G340's `TURNS GREEN WHEN` clause, stated as executable code:
    // "a test shows a policy change on the server reaching a client that was
    // built before it."
    //
    // The scenario is the one §48 exists for. A build ships. Later — with no
    // app release — the authority TIGHTENS `caption`: personalization is
    // withdrawn and the field is reclassified from `public` to `viewer_scoped`,
    // which on this side also makes it uncacheable. The running client must
    // pick that up.
    //
    // Before G340 this was impossible in principle, not merely unimplemented:
    // the client re-declared all 29 contexts in its own bundle, so the only way
    // to change `caption` on a device was to ship a new binary.
    const t = { now: 0 };
    const store = new PolicyStore({ maxAgeMs: 10_000 }, () => t.now);
    store.setActiveAccount(ACCOUNT_A);

    // The table this build shipped against.
    store.install(ACCOUNT_A, 'input-2026-08', {
      caption: servedCityPicker({ context: 'caption', allowPersonalization: true, privacyClass: 'public' }),
    });
    const before = store.readActive('caption');
    assert.equal(before.policy.allowPersonalization, true);
    assert.equal(before.policy.privacyClass, 'public');

    // The server changes the policy. The client learns of it the way it always
    // can: every suggest response carries the authority's version.
    store.noteServedVersion('input-2026-12');
    const during = store.readActive('caption');
    assert.equal(
      during.reason,
      'version_superseded',
      'between learning and refetching, the client must not keep granting on a retired table',
    );
    assert.equal(during.policy.allowPersonalization, false, 'and the gap must fail CLOSED');

    // The refetch lands.
    store.install(ACCOUNT_A, 'input-2026-12', {
      caption: servedCityPicker({ context: 'caption', allowPersonalization: false, privacyClass: 'viewer_scoped' }),
    });
    const after = store.readActive('caption');
    assert.equal(after.authoritative, true);
    assert.equal(after.policy.allowPersonalization, false, 'the withdrawal reached the client');
    assert.equal(after.policy.privacyClass, 'viewer_scoped', 'and so did the reclassification');
    // Which is the thing that matters: `viewer_scoped` is not in
    // `suggestionCache.ts#CACHEABLE_PRIVACY_CLASSES`, so this field's
    // suggestions stop entering the process-global cache — without a release.
  });
});

describe('G340 — expiry', () => {
  it('an EXPIRED snapshot stops granting rather than being trusted a little longer', () => {
    const t = { now: 0 };
    const store = storeAt(t); // maxAgeMs 1000
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', { city_picker: servedCityPicker() });

    t.now = 999;
    assert.equal(store.readActive('city_picker').authoritative, true);

    t.now = 1000;
    const r = store.readActive('city_picker');
    assert.equal(r.reason, 'expired');
    assert.deepEqual(grants(r.policy), GRANTS_NOTHING);
    assert.equal(store.needsRefresh(ACCOUNT_A), true);
  });
});

describe('G340 — values this build cannot name', () => {
  it('an unknown MODE collapses the WHOLE policy, not just the mode', () => {
    const p = sanitizeServedPolicy('city_picker', servedCityPicker({ mode: 'telepathic_assist' }));
    assert.deepEqual(
      grants(p),
      GRANTS_NOTHING,
      'keeping minChars/privacyClass/personalization from a policy whose mode is unreadable is acting on half an instruction',
    );
    assert.equal(p.privacyClass, 'private_message');
    assert.equal(p.offlinePolicy, 'unavailable');
  });

  it('unknown members of a LIST are dropped, never the list accepted whole', () => {
    const p = sanitizeServedPolicy(
      'city_picker',
      servedCityPicker({
        allowedSuggestionTypes: ['entity', 'mind_reading', 'recent'],
        entityTypes: ['city', 'wormhole'],
      }),
    );
    assert.deepEqual(p.allowedSuggestionTypes, ['entity', 'recent']);
    assert.deepEqual(p.entityTypes, ['city']);
  });

  it('an unknown privacyClass becomes the STRICTEST, so the field is uncacheable', () => {
    const p = sanitizeServedPolicy('city_picker', servedCityPicker({ privacyClass: 'crew_scoped' }));
    assert.equal(p.privacyClass, 'private_message');
  });

  it('an unknown offlinePolicy becomes `unavailable`, so it has no offline surface', () => {
    const p = sanitizeServedPolicy('city_picker', servedCityPicker({ offlinePolicy: 'peer_mesh' }));
    assert.equal(p.offlinePolicy, 'unavailable');
    assert.equal(offlineSurfaceAllowed(p.offlinePolicy), false);
  });

  it('a permission must be a literal true — truthy strings and numbers do NOT grant', () => {
    const p = sanitizeServedPolicy(
      'city_picker',
      servedCityPicker({
        allowPersonalization: 'true',
        allowAI: 1,
        allowLiveContext: 'yes',
        allowMemoryContext: {},
        zeroStateAssistance: 'true',
      }),
    );
    assert.equal(p.allowPersonalization, false);
    assert.equal(p.allowAI, false);
    assert.equal(p.allowLiveContext, false);
    assert.equal(p.allowMemoryContext, false);
    assert.equal(p.zeroStateAssistance, false);
  });

  it('a missing or garbage minChars becomes UNREACHABLE, never 0', () => {
    for (const bad of [undefined, null, 'two', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = sanitizeServedPolicy('city_picker', servedCityPicker({ minChars: bad }));
      assert.equal(
        p.minChars,
        UNREACHABLE_MIN_CHARS,
        `minChars ${String(bad)} must not become 0 — 0 is the MOST permissive value in the range`,
      );
    }
  });

  it('a null, non-object or array policy is the conservative one', () => {
    for (const bad of [null, undefined, 'policy', 42]) {
      assert.deepEqual(grants(sanitizeServedPolicy('city_picker', bad)), GRANTS_NOTHING);
    }
  });

  it('nothing unrecognised is ever STORED — the store narrows on the way in', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', {
      city_picker: servedCityPicker({ privacyClass: 'crew_scoped', allowPersonalization: 'true' }),
    });
    const r = store.readActive('city_picker');
    assert.equal(r.authoritative, true, 'the table is valid; only two members were narrowed');
    assert.equal(r.policy.privacyClass, 'private_message');
    assert.equal(r.policy.allowPersonalization, false);
  });

  it('the shared fallback cannot be turned into a permission by mutating it', () => {
    // Asserts the PROPERTY, not the throw. A write to a frozen object throws
    // in strict mode and silently no-ops otherwise, and which one this module
    // gets depends on how the test loader transpiles it — so asserting
    // `throws` would have been a test of the toolchain. What must hold either
    // way is that the value does not change, since this object is shared by
    // every unresolved context in the process.
    assert.equal(Object.isFrozen(CONSERVATIVE_POLICY), true);
    try {
      (CONSERVATIVE_POLICY as { allowPersonalization: boolean }).allowPersonalization = true;
    } catch {
      /* strict mode throws; non-strict no-ops. Either is fine. */
    }
    assert.equal(
      CONSERVATIVE_POLICY.allowPersonalization,
      false,
      'the fallback granted a permission after a stray write',
    );
    assert.equal(CONSERVATIVE_POLICY.minChars, UNREACHABLE_MIN_CHARS);
  });

  it('a caller mutating a RESOLVED policy cannot reach the shared fallback', () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    const first = store.readActive('city_picker').policy; // conservative
    first.allowedSuggestionTypes.push('entity');
    first.entityTypes.push('user');
    const second = store.readActive('city_picker').policy;
    assert.deepEqual(second.allowedSuggestionTypes, [], 'each miss must get its own arrays');
    assert.deepEqual(second.entityTypes, []);
  });
});

describe('G340 — offline surface, which is what `server_required` actually means', () => {
  it('only the three policies that name an offline source permit retention', () => {
    assert.equal(offlineSurfaceAllowed('static_dictionary'), true);
    assert.equal(offlineSurfaceAllowed('cached_local'), true);
    assert.equal(offlineSurfaceAllowed('recent_only'), true);
    assert.equal(offlineSurfaceAllowed('server_required'), false);
    assert.equal(offlineSurfaceAllowed('unavailable'), false);
  });

  it('fails CLOSED on a missing or unnameable value', () => {
    assert.equal(offlineSurfaceAllowed(null), false);
    assert.equal(offlineSurfaceAllowed(undefined), false);
    assert.equal(offlineSurfaceAllowed('peer_mesh' as never), false);
  });
});

describe('G340 — a failed fetch can only ever reduce', () => {
  const heldTable = { city_picker: servedCityPicker() };

  function depsReturning(res: PolicyFetchResult) {
    return { fetchPolicies: async (): Promise<PolicyFetchResult> => res };
  }

  it('an UNAVAILABLE server leaves a good snapshot exactly as it was', async () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', heldTable);
    store.noteServedVersion('v2'); // force needsRefresh

    const out = await refreshPolicies(ACCOUNT_A, store, depsReturning({ ok: false, unavailable: true, error: 'HTTP 404' }).fetchPolicies);
    assert.equal(out, 'failed');
    assert.equal(store.heldVersion(), 'v1', 'a failed fetch must not discard what was held');
    // It is still superseded — the client knows it is stale and could not fix it.
    assert.equal(store.readActive('city_picker').reason, 'version_superseded');
  });

  it('an unavailable server with NOTHING held leaves every field unassisted', async () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    const out = await refreshPolicies(ACCOUNT_A, store, depsReturning({ ok: false, unavailable: true, error: 'Network error' }).fetchPolicies);
    assert.equal(out, 'failed');
    assert.deepEqual(grants(store.readActive('city_picker').policy), GRANTS_NOTHING);
  });

  it('a 200 carrying an unusable table is a FAILURE, not a partial install', async () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    const out = await refreshPolicies(ACCOUNT_A, store, depsReturning({ ok: true, policyVersion: 'v1', contexts: {} }).fetchPolicies);
    assert.equal(out, 'failed');
    assert.equal(store.heldVersion(), null);
  });

  it('a signed-out refresh is skipped and fetches nothing', async () => {
    const t = { now: 0 };
    const store = storeAt(t);
    let called = 0;
    const out = await refreshPolicies(null, store, async () => {
      called += 1;
      return { ok: true, policyVersion: 'v1', contexts: heldTable };
    });
    assert.equal(out, 'skipped');
    assert.equal(called, 0, 'policy is per-viewer; there is no one to fetch it for');
  });

  it('a fresh snapshot is not refetched', async () => {
    const t = { now: 0 };
    const store = storeAt(t);
    store.setActiveAccount(ACCOUNT_A);
    store.install(ACCOUNT_A, 'v1', heldTable);
    let called = 0;
    const out = await refreshPolicies(ACCOUNT_A, store, async () => {
      called += 1;
      return { ok: true, policyVersion: 'v1', contexts: heldTable };
    });
    assert.equal(out, 'skipped');
    assert.equal(called, 0);
  });
});
