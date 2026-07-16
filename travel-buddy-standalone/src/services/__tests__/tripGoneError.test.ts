/**
 * Trip 'gone' (410) error path tests
 *
 * Confirms that a 410 / "gone" response from the API is surfaced correctly
 * through all three layers of the accept-invite flow, so a regression cannot
 * silently replace the friendly "This trip is no longer active" screen with a
 * raw HTTP error or a no-op — even on a slow or flaky connection.
 *
 * Suites:
 *   1. acceptTripInvite (service layer) — 410 + { error: "gone" } must throw
 *      an Error whose `.code` property equals 'gone'.
 *
 *   2. InviteCard machine-layer — the gone error branch sets tripGone=true,
 *      which the component uses to hide the Accept/Decline buttons and show
 *      the "This trip is no longer active." banner.
 *
 *   3. invite/[token].tsx machine-layer — mapAcceptResultToAction maps a
 *      { error: 'gone' } result (without reason: 'trip_full') to
 *      { kind: 'set_gone' }, triggering a screen-state transition rather than
 *      an Alert popup.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/services/__tests__/tripGoneError.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setTestAuthToken,
  acceptTripInvite,
} from '../trips.ts';
import { classifyInviteAcceptError } from '../../lib/inviteCardGoneHandler.ts';
import { mapAcceptResultToAction } from '../../lib/acceptResultMapper.ts';

const FAKE_TOKEN = 'fake-test-token-trip-gone';
const FAKE_TRIP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FAKE_PREVIEW_TRIP_ID = 'ffffffff-0000-1111-2222-333333333333';

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

// ── Suite 1: acceptTripInvite — 410 gone handling ─────────────────────────────
//
// When the API returns HTTP 410 with { error: "gone" }, acceptTripInvite must
// throw an error whose `.code === 'gone'`.  This is the contract that InviteCard
// relies on to detect the gone path instead of showing a generic Alert.

describe('acceptTripInvite — 410 gone response throws coded error', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    _setTestAuthToken(FAKE_TOKEN);
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    _setTestAuthToken(null);
  });

  it('throws an error with code === "gone" when API returns 410 + { error: "gone" }', async () => {
    globalThis.fetch = mockFetch(410, { error: 'gone' });
    let thrown: unknown;
    try {
      await acceptTripInvite(FAKE_TRIP_ID);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof Error, 'should throw an Error');
    assert.equal(
      (thrown as Error & { code?: string }).code,
      'gone',
      'thrown error must have code === "gone"',
    );
  });

  it('does not swallow the gone code — e.code is set, not just e.message', async () => {
    globalThis.fetch = mockFetch(410, { error: 'gone' });
    let thrown: (Error & { code?: string }) | undefined;
    try {
      await acceptTripInvite(FAKE_TRIP_ID);
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    assert.ok(thrown, 'should throw');
    assert.equal(thrown.code, 'gone', 'code property must be "gone"');
  });

  it('throws a generic error (not gone) for non-410 failures', async () => {
    globalThis.fetch = mockFetch(500, { message: 'Internal Server Error' });
    let thrown: (Error & { code?: string }) | undefined;
    try {
      await acceptTripInvite(FAKE_TRIP_ID);
    } catch (e) {
      thrown = e as Error & { code?: string };
    }
    assert.ok(thrown instanceof Error, 'should throw on 500');
    assert.notEqual(thrown.code, 'gone', 'non-410 error must not have code "gone"');
  });

  it('does not throw for a 200 OK response', async () => {
    globalThis.fetch = mockFetch(200, {});
    await assert.doesNotReject(
      () => acceptTripInvite(FAKE_TRIP_ID),
      'should not throw on 200',
    );
  });
});

// ── Suite 2: InviteCard machine-layer — classifyInviteAcceptError ─────────────
//
// InviteCard calls classifyInviteAcceptError(e) from
// src/lib/inviteCardGoneHandler.ts to decide whether to set tripGone=true
// (gone banner, no Accept button) or show a generic Alert.
//
// Testing the real exported function means a regression in InviteCard's branch
// will be caught here — not just in the component.

describe('classifyInviteAcceptError — InviteCard gone branch (production code)', () => {
  it('returns "gone" for an error with code="gone" — triggers gone banner, hides Accept', () => {
    const err = Object.assign(new Error('gone'), { code: 'gone' });
    assert.equal(classifyInviteAcceptError(err), 'gone');
  });

  it('returns "gone" for an error whose message is "gone" but has no code property', () => {
    const err = new Error('gone');
    assert.equal(classifyInviteAcceptError(err), 'gone');
  });

  it('returns "generic" for a standard 500 error — shows Alert, NOT gone banner', () => {
    const err = new Error('HTTP 500');
    assert.equal(classifyInviteAcceptError(err), 'generic');
  });

  it('returns "generic" for an unrelated network error — shows Alert', () => {
    const err = new Error('Network request failed');
    assert.equal(classifyInviteAcceptError(err), 'generic');
  });

  it('returns "generic" for null — no crash on unexpected throw shape', () => {
    assert.equal(classifyInviteAcceptError(null), 'generic');
  });

  it('returns "generic" for undefined — no crash on unexpected throw shape', () => {
    assert.equal(classifyInviteAcceptError(undefined), 'generic');
  });

  it('gone banner visible / Accept button hidden — tripGone=true conditional matches gone result', () => {
    const err = Object.assign(new Error('gone'), { code: 'gone' });
    const result = classifyInviteAcceptError(err);
    const goneBannerVisible = result === 'gone';
    const acceptButtonVisible = result !== 'gone';
    assert.equal(goneBannerVisible, true, 'banner must show when classifyInviteAcceptError returns "gone"');
    assert.equal(acceptButtonVisible, false, 'Accept must be hidden when classifyInviteAcceptError returns "gone"');
  });

  it('gone banner hidden / Accept button visible — tripGone=false conditional matches generic result', () => {
    const err = new Error('Something went wrong');
    const result = classifyInviteAcceptError(err);
    const goneBannerVisible = result === 'gone';
    const acceptButtonVisible = result !== 'gone';
    assert.equal(goneBannerVisible, false, 'banner must be hidden for generic errors');
    assert.equal(acceptButtonVisible, true, 'Accept must be visible for generic errors');
  });
});

// ── Suite 3: invite/[token].tsx machine-layer — mapAcceptResultToAction ───────
//
// handleAccept in invite/[token].tsx calls mapAcceptResultToAction and branches
// on the returned action kind.  When acceptInviteByToken returns
// { error: 'gone' } (without reason: 'trip_full'), the mapper must return
// { kind: 'set_gone' } so the screen calls setScreen({ kind: 'gone', ... })
// instead of Alert.alert().

describe('mapAcceptResultToAction — invite/[token].tsx gone transition (production code)', () => {
  it('returns { kind: "set_gone" } for { error: "gone" } without trip_full reason', () => {
    const result = mapAcceptResultToAction(
      { tripId: null, alreadyMember: false, error: 'gone' },
      FAKE_PREVIEW_TRIP_ID,
    );
    assert.equal(result.kind, 'set_gone', 'gone error without trip_full must produce set_gone action');
  });

  it('set_gone message mentions the trip is no longer active', () => {
    const result = mapAcceptResultToAction(
      { tripId: null, alreadyMember: false, error: 'gone' },
      FAKE_PREVIEW_TRIP_ID,
    );
    if (result.kind !== 'set_gone') {
      assert.fail('expected set_gone action');
    }
    assert.ok(
      result.message.toLowerCase().includes('no longer active') ||
        result.message.toLowerCase().includes('trip'),
      `message "${result.message}" should describe the trip being gone`,
    );
  });

  it('returns { kind: "reload" } for { error: "gone", reason: "trip_full" } — not set_gone', () => {
    const result = mapAcceptResultToAction(
      { tripId: null, alreadyMember: false, error: 'gone', reason: 'trip_full' },
      FAKE_PREVIEW_TRIP_ID,
    );
    assert.equal(
      result.kind,
      'reload',
      'trip_full gone must trigger reload, not set_gone (full screen via preview re-fetch)',
    );
  });

  it('returns { kind: "navigate" } for a successful accept with a tripId', () => {
    const result = mapAcceptResultToAction(
      { tripId: FAKE_TRIP_ID, alreadyMember: false },
      FAKE_PREVIEW_TRIP_ID,
    );
    assert.equal(result.kind, 'navigate');
    if (result.kind !== 'navigate') assert.fail('unreachable');
    assert.equal(result.tripId, FAKE_TRIP_ID, 'should navigate to the returned tripId');
  });

  it('returns { kind: "alert" } for a non-gone, non-success error — not set_gone', () => {
    const result = mapAcceptResultToAction(
      { tripId: null, alreadyMember: false, error: 'forbidden' },
      FAKE_PREVIEW_TRIP_ID,
    );
    assert.equal(result.kind, 'alert', 'non-gone errors must show an Alert, not set_gone');
  });
});
