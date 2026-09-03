/**
 * Phase 8 (Personalization) — the explicit-selection recorder (spec §35/§15/§14).
 *
 * Pure logic — runs under node:test. Proves the three invariants that make
 * selection-memory recording privacy-safe and additive:
 *   1. it fires ONLY on an explicit real-entity accept (never on a view/type or
 *      on an action / AI / correction / validation row, and never for a
 *      personalization-disabled or private-message context);
 *   2. the wire payload shape matches the merged backend route exactly;
 *   3. the network core is fail-soft — a failed record can never throw and never
 *      breaks the selection the user made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectionFromSuggestion,
  buildSelectBody,
  recordSelectionWith,
  type SelectDeps,
  type SelectRequest,
} from '../selectBody.ts';
import { buildDefaultPolicy } from '../../contexts/inputPolicies.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { InputFieldPolicy } from '../../types/fieldPolicy.ts';

// A personalization-enabled canonical picker (city_picker: allowPersonalization,
// privacyClass 'personal', entityTypes include city/country).
const cityPolicy: InputFieldPolicy = buildDefaultPolicy('city.test', 'city_picker', {
  entityTypes: ['city', 'country'],
});

function sug(over: Partial<InputSuggestion> = {}): InputSuggestion {
  return {
    id: over.id ?? 'city:bkk',
    type: over.type ?? 'entity',
    context: over.context ?? 'city_picker',
    label: over.label ?? 'Bangkok',
    source: over.source ?? 'canonical',
    policyVersion: 'input-2026-08',
    entityType: 'entityType' in over ? over.entityType : 'city',
    entityId: 'entityId' in over ? over.entityId : 'bkk-1',
    ...over,
  };
}

// ── (1) EXPLICIT real-entity accepts only ─────────────────────────────────────

test('an explicit entity accept produces a payload (context/entity/query/label)', () => {
  const req = selectionFromSuggestion(sug({ label: 'Bangkok' }), {
    policy: cityPolicy,
    query: 'bkk',
  });
  assert.ok(req, 'an accepted entity suggestion must yield a payload');
  assert.equal(req!.context, 'city_picker');
  assert.equal(req!.fieldId, 'city.test');
  assert.equal(req!.entityType, 'city');
  assert.equal(req!.entityId, 'bkk-1');
  assert.equal(req!.query, 'bkk'); // the RAW text that led to the pick (§35)
  assert.equal(req!.label, 'Bangkok');
});

test('recent / personalized / disambiguation accepts are recordable entity picks', () => {
  for (const type of ['recent', 'personalized', 'disambiguation'] as const) {
    assert.ok(
      selectionFromSuggestion(sug({ type }), { policy: cityPolicy, query: 'bkk' }),
      `${type} row carrying an entity must be recordable`,
    );
  }
});

test('NON-entity rows are never recorded (action / AI / correction / validation)', () => {
  // These represent a command, an opt-in text insertion, or a hint — not "the
  // user chose THIS canonical entity" — so they must yield no payload.
  for (const type of ['action', 'ai_suggestion', 'correction', 'validation'] as const) {
    assert.equal(
      selectionFromSuggestion(sug({ type }), { policy: cityPolicy, query: 'bkk' }),
      null,
      `${type} must not record a selection`,
    );
  }
});

test('a row with no canonical entity id is not a selection (e.g. a query completion)', () => {
  const completion = sug({ type: 'completion', entityType: undefined, entityId: undefined });
  assert.equal(selectionFromSuggestion(completion, { policy: cityPolicy, query: 'bkk' }), null);
});

test('the open_entity action supplies identity when top-level fields are absent', () => {
  const s = sug({
    entityType: undefined,
    entityId: undefined,
    action: { type: 'open_entity', entityType: 'city', entityId: 'bkk-1' },
  });
  const req = selectionFromSuggestion(s, { policy: cityPolicy, query: 'bkk' });
  assert.ok(req, 'open_entity identity must be recoverable');
  assert.equal(req!.entityType, 'city');
  assert.equal(req!.entityId, 'bkk-1');
});

test('a personalization-disabled context records nothing (username)', () => {
  const usernamePolicy = buildDefaultPolicy('username', 'username');
  assert.equal(usernamePolicy.allowPersonalization, false, 'precondition');
  assert.equal(
    selectionFromSuggestion(sug({ entityType: 'user', entityId: 'u1' }), {
      policy: usernamePolicy,
      query: 'ann',
    }),
    null,
  );
});

test('a private_message context is never tracked (mirrors the backend)', () => {
  const msgPolicy = buildDefaultPolicy('telegraph.message', 'telegraph_message');
  assert.equal(msgPolicy.privacyClass, 'private_message', 'precondition');
  assert.equal(
    selectionFromSuggestion(sug({ entityType: 'user', entityId: 'u1' }), {
      policy: msgPolicy,
      query: '@a',
    }),
    null,
  );
});

test('an entityType the field policy disallows is not recorded', () => {
  // city_picker allows city/country — a user entity must be rejected.
  assert.equal(
    selectionFromSuggestion(sug({ entityType: 'user', entityId: 'u1' }), {
      policy: cityPolicy,
      query: 'x',
    }),
    null,
  );
});

test('a missing policy records nothing (no context to attribute the pick to)', () => {
  assert.equal(selectionFromSuggestion(sug(), { policy: null, query: 'bkk' }), null);
  assert.equal(selectionFromSuggestion(sug(), { policy: undefined, query: 'bkk' }), null);
});

// ── (2) payload shape matches the backend route ──────────────────────────────

test('buildSelectBody emits exactly the fields the backend reads', () => {
  const body = buildSelectBody({
    context: 'city_picker',
    fieldId: 'city.test',
    entityType: 'city',
    entityId: 'bkk-1',
    query: 'bkk',
    label: 'Bangkok',
  });
  assert.deepEqual(body, {
    context: 'city_picker',
    fieldId: 'city.test',
    entityType: 'city',
    entityId: 'bkk-1',
    query: 'bkk',
    label: 'Bangkok',
  });
});

test('buildSelectBody omits optional fields when unset, and never sends a user id', () => {
  const body = buildSelectBody({
    context: 'city_picker',
    entityType: 'city',
    entityId: 'bkk-1',
    query: null,
    label: null,
  });
  assert.equal('query' in body, false);
  assert.equal('label' in body, false);
  assert.equal('fieldId' in body, false);
  // Owner scope is session-derived server-side — the client must NEVER send ids.
  assert.equal('userId' in body, false);
  assert.equal('user_id' in body, false);
  assert.deepEqual(body, { context: 'city_picker', entityType: 'city', entityId: 'bkk-1' });
});

test('buildSelectBody trims + caps query and label at 200 chars', () => {
  const long = 'x'.repeat(500);
  const body = buildSelectBody({
    context: 'city_picker',
    entityType: 'city',
    entityId: 'bkk-1',
    query: `  ${long}  `,
    label: `  ${long}  `,
  });
  assert.equal((body.query as string).length, 200);
  assert.equal((body.label as string).length, 200);
});

// ── (3) fail-soft network core ───────────────────────────────────────────────

const req: SelectRequest = {
  context: 'city_picker',
  fieldId: 'city.test',
  entityType: 'city',
  entityId: 'bkk-1',
  query: 'bkk',
  label: 'Bangkok',
};

function deps(over: Partial<SelectDeps> = {}): SelectDeps {
  return {
    apiBase: () => 'https://api.example.test',
    getToken: async () => 'tok-123',
    fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    ...over,
  };
}

test('a happy-path record posts the built body to the select endpoint with auth', async () => {
  let calledUrl = '';
  let calledInit: RequestInit | undefined;
  const d = deps({
    fetchImpl: (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledInit = init;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch,
  });
  const res = await recordSelectionWith(d, req);
  assert.equal(res.recorded, true);
  assert.equal(calledUrl, 'https://api.example.test/input-assistance/select');
  assert.equal(calledInit?.method, 'POST');
  assert.equal((calledInit?.headers as Record<string, string>).Authorization, 'Bearer tok-123');
  assert.deepEqual(JSON.parse(calledInit?.body as string), buildSelectBody(req));
});

test('a throwing fetch is swallowed — recorded:false, never rejects', async () => {
  const d = deps({
    fetchImpl: (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
  });
  const res = await recordSelectionWith(d, req); // must not throw
  assert.equal(res.recorded, false);
  assert.equal(res.reason, 'error');
});

test('a non-2xx response records nothing (still fail-soft, no throw)', async () => {
  const d = deps({
    fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
  });
  const res = await recordSelectionWith(d, req);
  assert.equal(res.recorded, false);
  assert.equal(res.reason, 'http_404');
});

test('no token → the request is never sent', async () => {
  let called = false;
  const d = deps({
    getToken: async () => null,
    fetchImpl: (async () => {
      called = true;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch,
  });
  const res = await recordSelectionWith(d, req);
  assert.equal(res.recorded, false);
  assert.equal(res.reason, 'no_token');
  assert.equal(called, false, 'fetch must not run without a token');
});

test('a getToken that throws is swallowed (fail-soft), request not sent', async () => {
  let called = false;
  const d = deps({
    getToken: async () => {
      throw new Error('token refresh failed');
    },
    fetchImpl: (async () => {
      called = true;
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch,
  });
  const res = await recordSelectionWith(d, req); // must not throw
  assert.equal(res.recorded, false);
  assert.equal(called, false);
});

test('no api base configured → nothing is sent', async () => {
  const d = deps({ apiBase: () => '' });
  const res = await recordSelectionWith(d, req);
  assert.equal(res.recorded, false);
  assert.equal(res.reason, 'no_api_base');
});
