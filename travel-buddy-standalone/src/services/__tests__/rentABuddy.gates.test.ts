/**
 * Rent a Buddy — a refused gate is its own state (testing mode, lane tm-rab).
 *
 * The rule: when a Rent-a-Buddy gate refuses, the app says exactly WHICH gate
 * refused and WHAT unblocks it — never an empty list, never a generic error.
 * `describeGateRefusal` is the one place a server refusal becomes that
 * sentence. These cases pin:
 *
 *   G1  `feature_disabled` is three gates. The server names the kill switch in
 *       `gate`; each switch is reported by its own name, and a bare
 *       `feature_disabled` is the master switch (its only other source).
 *   G2  every gate the booking path can refuse with maps to a named gate with
 *       an unblock sentence (the KYC readiness gate, global pause, rollout,
 *       beta, launch controls, user limits, MVP flags).
 *   G3  ordinary failures are NOT gates — a conflict, a DB error or an HTTP
 *       status must keep an error-with-retry, not be dressed up as a gate.
 *   G4  the actionable gate (`verification_required`) carries the same route
 *       the checkout door already uses.
 *
 * Run: pnpm --dir travel-buddy-standalone test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeGateRefusal, isGateRefusal, masterSwitchOffRefusal } from '../rentABuddyGates.ts';
import { bookingRefusalAction } from '../rentABuddyBookingErrors.ts';

describe('G1 feature_disabled is three gates, each named', () => {
  it('bare feature_disabled is the master switch', () => {
    const g = describeGateRefusal('feature_disabled');
    assert.ok(g);
    assert.equal(g.gate, 'rent_buddy_enabled');
    assert.match(g.unblock, /rent_buddy_enabled/);
  });

  it('feature_disabled + gate rent_buddy_enabled is the master switch', () => {
    assert.equal(describeGateRefusal('feature_disabled', 'rent_buddy_enabled')?.gate, 'rent_buddy_enabled');
  });

  for (const ks of ['disable_rab_bookings', 'disable_rent_buddy_booking']) {
    it(`feature_disabled + gate ${ks} names ${ks} and how to release it`, () => {
      const g = describeGateRefusal('feature_disabled', ks);
      assert.ok(g);
      assert.equal(g.gate, ks);
      assert.match(g.body, new RegExp(ks));
      assert.match(g.unblock, new RegExp(`${ks} off`));
      assert.match(g.body, /keep working/, 'a kill switch stops NEW bookings only');
    });
  }

  it('the layout state is the master switch', () => {
    assert.equal(masterSwitchOffRefusal().gate, 'rent_buddy_enabled');
  });
});

describe('G2 every booking-path gate is named with an unblock', () => {
  const expectations: Array<[string, RegExp]> = [
    ['verification_unavailable', /rent_buddy_allow_bookings_without_kyc/],
    ['globally_paused', /rent_buddy_global_controls\.all_bookings_paused/],
    ['city_not_available', /rent_buddy_city_rollouts/],
    ['city_not_launched', /rent_buddy_city_rollouts/],
    ['waitlist_only', /waitlist only/],
    ['not_open_for_bookings', /buddy_applications_open/],
    ['internal_testing', /internal_testing/],
    ['city_paused', /paused/],
    ['city_beta_access_required', /^rent_buddy_beta_access$/],
    ['beta_access_required', /RENT_BUDDY_BETA_ONLY_MODE/],
    ['admin_only', /RENT_BUDDY_ADMIN_ONLY_MODE/],
    ['location_unavailable', /^rent_buddy_launch_controls$/],
    ['restrictions_unavailable', /unreadable/],
    ['access_limited', /^rent_buddy_user_limits$/],
    ['offers_unavailable', /RENT_BUDDY_OFFERS_ENABLED/],
    ['packages_unavailable', /RENT_BUDDY_PACKAGES_ENABLED/],
    ['applications_paused', /applications_paused/],
  ];
  for (const [code, gate] of expectations) {
    it(`${code} → ${gate}`, () => {
      const g = describeGateRefusal(code);
      assert.ok(g, code);
      assert.match(g.gate, gate);
      assert.ok(g.title.length > 0 && g.body.length > 0 && g.unblock.length > 0);
      assert.equal(isGateRefusal(code), true);
      // A raw code is never the whole sentence.
      assert.notEqual(g.body.trim(), code);
    });
  }
});

describe('G3 ordinary failures are not gates', () => {
  for (const code of ['invalid_transition', 'db_error', 'not_found', 'forbidden', 'HTTP 500', 'network_error', '', null, undefined]) {
    it(`${String(code)} is not a gate`, () => {
      assert.equal(describeGateRefusal(code as string | null | undefined), null);
      assert.equal(isGateRefusal(code as string | null | undefined), false);
    });
  }
});

describe('G4 the actionable gate keeps the checkout door', () => {
  it('verification_required carries the same route as bookingRefusalAction', () => {
    const g = describeGateRefusal('verification_required');
    assert.ok(g?.action);
    assert.equal(g.action.route, bookingRefusalAction('verification_required')?.route);
  });
});
