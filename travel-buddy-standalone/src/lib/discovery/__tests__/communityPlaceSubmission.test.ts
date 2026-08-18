/**
 * validateCommunityPlace — the empty-city guard Part 1 made necessary.
 *
 * SubmitPlaceSheet's `city` is a prop, not an input: Discovery passes
 * `city={destination}`. While Discovery fell back to a hardcoded 'Paris' that
 * value could never be empty, so submit validated `name` and nothing else.
 * Removing the fallback made an empty destination reachable, and the server
 * keys community places by city, so an empty one is unroutable.
 *
 * Run: node --import tsx/esm --test src/lib/discovery/__tests__/communityPlaceSubmission.test.ts
 * (also auto-discovered by scripts/run-node-tests.mjs via src/**\/*.test.ts)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommunityPlace } from '../communityPlaceSubmission.ts';

describe('validateCommunityPlace — the working path', () => {
  it('accepts a draft with both a name and a city', () => {
    assert.equal(validateCommunityPlace({ name: 'Rooftop Bar', city: 'Rome' }), null);
  });

  it('accepts values that only need trimming', () => {
    assert.equal(validateCommunityPlace({ name: '  Bar  ', city: '  Rome  ' }), null);
  });
});

describe('validateCommunityPlace — the empty city', () => {
  it('rejects an empty city', () => {
    // The state Discovery can now be in: no GPS city and no last known one.
    assert.notEqual(validateCommunityPlace({ name: 'Orphan', city: '' }), null);
  });

  it('rejects a whitespace-only city', () => {
    assert.notEqual(validateCommunityPlace({ name: 'Orphan', city: '   ' }), null);
  });

  it('names the control to tap, since the city is not a field on the sheet', () => {
    // A bare "city is required" sends the user hunting for an input that does
    // not exist — the city comes from the Discover header.
    const msg = validateCommunityPlace({ name: 'Orphan', city: '' });
    assert.match(msg ?? '', /Pick a destination/i);
    assert.match(msg ?? '', /Discover/i);
  });
});

describe('validateCommunityPlace — ordering', () => {
  it('reports the missing name first when both are missing', () => {
    // For a user who has typed nothing, the name is the field in front of them.
    assert.match(validateCommunityPlace({ name: '', city: '' }) ?? '', /name is required/i);
  });

  it('still reports a missing name when the city is fine', () => {
    assert.match(validateCommunityPlace({ name: '', city: 'Rome' }) ?? '', /name is required/i);
  });

  it('reports the city only once the name is satisfied', () => {
    const msg = validateCommunityPlace({ name: 'Orphan', city: '' });
    assert.doesNotMatch(msg ?? '', /name is required/i);
  });
});
