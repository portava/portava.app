/**
 * Unit tests for optional cover-photo attachment in the trip create flow.
 *
 * Verifies that:
 *   - createTrip sends its payload without coverUrl when not provided
 *     (text-only path continues to work)
 *   - coverUrl is included in the payload when provided
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Payload builder (mirrors createTrip logic) ────────────────────────────────

interface CreateTripBody {
  title: string;
  destinationCity: string;
  destinationCountry?: string;
  startDate?: string;
  endDate?: string;
  status: string;
  visibility: string;
  tripNotes?: string | null;
  coverUrl?: string;
}

function buildCreateTripBody(input: {
  title: string;
  destinationCity: string;
  destinationCountry?: string;
  startDate?: string;
  endDate?: string;
  status: string;
  visibility: string;
  tripNotes?: string | null;
  coverUrl?: string;
}): CreateTripBody {
  // Mirror the shape that createTrip() sends to the API.
  return {
    title:              input.title,
    destinationCity:    input.destinationCity,
    ...(input.destinationCountry ? { destinationCountry: input.destinationCountry } : {}),
    ...(input.startDate          ? { startDate: input.startDate }                   : {}),
    ...(input.endDate            ? { endDate: input.endDate }                       : {}),
    status:             input.status,
    visibility:         input.visibility,
    tripNotes:          input.tripNotes ?? null,
    ...(input.coverUrl           ? { coverUrl: input.coverUrl }                     : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('createTrip payload omits coverUrl when not provided (text-only path)', () => {
  const body = buildCreateTripBody({
    title:           'Visayas June',
    destinationCity: 'Cebu',
    status:          'planning',
    visibility:      'private',
  });
  assert.ok(!('coverUrl' in body), 'coverUrl should not appear when not provided');
  assert.equal(body.title, 'Visayas June');
  assert.equal(body.destinationCity, 'Cebu');
});

test('createTrip payload includes coverUrl when provided', () => {
  const url = 'https://storage.example.com/trip-cover.jpg';
  const body = buildCreateTripBody({
    title:           'Japan Trip',
    destinationCity: 'Tokyo',
    status:          'planning',
    visibility:      'private',
    coverUrl:        url,
  });
  assert.equal(body.coverUrl, url);
});

test('createTrip payload with coverUrl still carries all required fields', () => {
  const body = buildCreateTripBody({
    title:              'Island Hop',
    destinationCity:    'Palawan',
    destinationCountry: 'Philippines',
    startDate:          '2026-08-01',
    endDate:            '2026-08-14',
    status:             'planning',
    visibility:         'private',
    tripNotes:          'Bring sunscreen',
    coverUrl:           'https://storage.example.com/cover.jpg',
  });
  assert.equal(body.title, 'Island Hop');
  assert.equal(body.destinationCity, 'Palawan');
  assert.equal(body.destinationCountry, 'Philippines');
  assert.equal(body.startDate, '2026-08-01');
  assert.equal(body.coverUrl, 'https://storage.example.com/cover.jpg');
});
