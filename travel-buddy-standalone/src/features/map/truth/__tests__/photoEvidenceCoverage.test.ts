/**
 * photoStepOffered — the §22 photo step is offered only on the server's explicit
 * "a photo would be kept for this account" (census-map §45.12).
 *
 * WATCHED IT FAIL: with the predicate returning `state?.enabled === true` (the
 * consent gate alone), "a valid v1 grant without the server's yes offers no
 * photo step" goes red; with `!!state.coversPhotoEvidence`, "only a boolean
 * true counts" goes red.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { photoStepOffered } from '../photoEvidenceCoverage.ts';

const grant = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  consentVersion: 'intel_contributions_v1',
  consentedAt: '2026-09-01T00:00:00.000Z',
  withdrawnAt: null,
  currentDisclosureVersion: 'intel_contributions_v1',
  ...over,
});

describe('photoStepOffered', () => {
  test('a valid v1 grant without the server\'s yes offers no photo step', () => {
    assert.equal(photoStepOffered(grant()), false, 'absent (an older server) is no');
    assert.equal(photoStepOffered(grant({ coversPhotoEvidence: false })), false);
  });

  test('the server\'s explicit yes on a live grant offers it', () => {
    assert.equal(photoStepOffered(grant({ coversPhotoEvidence: true })), true);
  });

  test('only a boolean true counts', () => {
    for (const v of ['true', 1, {}, [], 'yes']) {
      assert.equal(photoStepOffered(grant({ coversPhotoEvidence: v })), false, JSON.stringify(v));
    }
  });

  test('no state, a disabled grant or a withdrawn one offers nothing, whatever the bit says', () => {
    assert.equal(photoStepOffered(null), false);
    assert.equal(photoStepOffered(undefined), false);
    assert.equal(photoStepOffered(grant({ enabled: false, coversPhotoEvidence: true })), false);
    assert.equal(photoStepOffered(grant({ withdrawnAt: '2026-09-02T00:00:00.000Z', coversPhotoEvidence: true })), false);
  });
});
