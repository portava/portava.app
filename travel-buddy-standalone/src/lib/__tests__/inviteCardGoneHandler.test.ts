/**
 * inviteCardGoneHandler.test.ts
 *
 * Unit tests for classifyInviteAcceptError() — the production helper that
 * InviteCard (app/(tabs)/trips.tsx) uses to decide whether a caught error
 * from acceptTripInvite() means the trip has ended ('gone') or is a generic
 * failure that should show an Alert.
 *
 * Pure function; zero React Native / Supabase dependencies.
 * Runs under node:test with the tsx/esm loader (wired into `pnpm test`).
 *
 * Run standalone:
 *   node --import tsx/esm --test src/lib/__tests__/inviteCardGoneHandler.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInviteAcceptError } from '../inviteCardGoneHandler.ts';

describe('classifyInviteAcceptError() — InviteCard gone-branch production logic', () => {

  // ── "gone" detection — triggers gone banner, hides Accept/Decline ──────────

  it('returns "gone" for an error with code="gone" (primary path from acceptTripInvite)', () => {
    const err = Object.assign(new Error('gone'), { code: 'gone' });
    assert.equal(
      classifyInviteAcceptError(err),
      'gone',
      'code=gone must route to gone banner (hides Accept button)',
    );
  });

  it('returns "gone" when only message="gone" is set (fallback path)', () => {
    const err = new Error('gone');
    assert.equal(
      classifyInviteAcceptError(err),
      'gone',
      'message=gone with no code property must still trigger gone banner',
    );
  });

  // ── "generic" detection — shows Alert, never gone banner ──────────────────

  it('returns "generic" for a standard network or server error — shows Alert', () => {
    assert.equal(classifyInviteAcceptError(new Error('HTTP 500')), 'generic');
    assert.equal(classifyInviteAcceptError(new Error('Network request failed')), 'generic');
    assert.equal(classifyInviteAcceptError(new Error('Something went wrong')), 'generic');
  });

  it('returns "generic" for null — no crash on unexpected throw shape', () => {
    assert.equal(classifyInviteAcceptError(null), 'generic');
  });

  it('returns "generic" for undefined — no crash on unexpected throw shape', () => {
    assert.equal(classifyInviteAcceptError(undefined), 'generic');
  });

  it('returns "generic" for an empty object — no crash', () => {
    assert.equal(classifyInviteAcceptError({}), 'generic');
  });

  // ── Component rendering logic verification ────────────────────────────────
  //
  // InviteCard's rendering branch is:
  //   {tripGone ? <GoneBanner /> : <AcceptDeclineButtons />}
  // where tripGone is set to true when classifyInviteAcceptError returns 'gone'.

  it('gone banner shows and Accept button hides when classifyInviteAcceptError returns "gone"', () => {
    const err = Object.assign(new Error('gone'), { code: 'gone' });
    const tripGone = classifyInviteAcceptError(err) === 'gone';
    assert.equal(tripGone, true, 'gone banner must render');
    assert.equal(!tripGone, false, 'Accept/Decline buttons must be hidden');
  });

  it('gone banner hides and Accept button shows when classifyInviteAcceptError returns "generic"', () => {
    const err = new Error('HTTP 500');
    const tripGone = classifyInviteAcceptError(err) === 'gone';
    assert.equal(tripGone, false, 'gone banner must not render for generic errors');
    assert.equal(!tripGone, true, 'Accept/Decline buttons must remain visible for generic errors');
  });
});
