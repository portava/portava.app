/**
 * Client capture SHAPE — the request body + input factories for the new writes.
 *
 * Pins the client half of slices 2 (commercial disclosure) and 3 (Trail
 * movement) at the pure layer (intelCaptureShape has no supabase/react-native
 * import, so it runs under node:test):
 *   - a non-'none' disclosure is included; 'none' / omitted is NOT (server default);
 *   - submitMusic's input is the direct music.current claim (a canonical genre);
 *   - submitTrailMovement's input is captureSurface:'trail' + context:'movement' +
 *     the coarse destination AREA (never coordinates), the mapping to next_move.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObservationBody,
  quickSignalInput,
  walkInInput,
  musicInput,
  trailMovementInput,
} from '../intelCaptureShape.ts';

const SUBJECT = '22222222-2222-4222-8222-222222222222';

describe('commercial disclosure in the request body (§22)', () => {
  it('includes a declared disclosure', () => {
    const body = buildObservationBody(quickSignalInput({ subjectId: SUBJECT, context: 'arrival', option: 'busy', commercialDisclosure: 'owner' }));
    assert.equal(body.commercialDisclosure, 'owner');
  });
  it("omits 'none' (the server default) — an untouched control adds nothing", () => {
    const body = buildObservationBody(quickSignalInput({ subjectId: SUBJECT, context: 'arrival', option: 'busy', commercialDisclosure: 'none' }));
    assert.equal('commercialDisclosure' in body, false);
  });
  it('omits the field entirely when undefined', () => {
    const body = buildObservationBody(quickSignalInput({ subjectId: SUBJECT, context: 'arrival', option: 'busy' }));
    assert.equal('commercialDisclosure' in body, false);
  });
});

describe('submitMusic input — direct music.current claim (§29 Included)', () => {
  it('is a canonical genre and carries a disclosure through', () => {
    const body = buildObservationBody(musicInput({ subjectId: SUBJECT, genre: 'house', commercialDisclosure: 'employee' }));
    assert.equal(body.claimType, 'music.current');
    assert.deepEqual(body.value, { genre: 'house' });
    assert.equal(body.commercialDisclosure, 'employee');
    assert.equal('context' in body, false, 'music is a direct claim, not a context form');
  });
});

describe('submitTrailMovement input — the IG-06 Trail surface (slice 3)', () => {
  it('is captureSurface trail + context movement + the coarse destination AREA', () => {
    const body = buildObservationBody(trailMovementInput({ subjectId: SUBJECT, destinationArea: 'Shoreditch', visibility: 'aggregate_only' }));
    assert.equal(body.captureSurface, 'trail');
    assert.equal(body.context, 'movement');
    assert.equal(body.option, 'Shoreditch');
    assert.equal(body.visibility, 'aggregate_only');
    // NEVER coordinates, and no exit-reason field (uncontracted — owner ruling).
    assert.equal('lat' in body, false);
    assert.equal('lng' in body, false);
    assert.equal('reason' in body, false);
    assert.equal('exitReason' in body, false);
  });
  it('carries a disclosure through when declared', () => {
    const body = buildObservationBody(trailMovementInput({ subjectId: SUBJECT, destinationArea: 'Ginza', commercialDisclosure: 'affiliate' }));
    assert.equal(body.commercialDisclosure, 'affiliate');
  });
});

describe('a walk-in still carries a disclosure when declared', () => {
  it('shapes access.walk_in with the disclosure', () => {
    const body = buildObservationBody(walkInInput({ subjectId: SUBJECT, accepted: true, commercialDisclosure: 'paid' }));
    assert.equal(body.claimType, 'access.walk_in');
    assert.deepEqual(body.value, { accepted: true });
    assert.equal(body.commercialDisclosure, 'paid');
  });
});
