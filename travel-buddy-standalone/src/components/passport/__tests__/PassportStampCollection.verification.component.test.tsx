/**
 * Component tests for PassportStampCollection — the §12 provenance treatment.
 *
 * Spec §12 hard rule: "Self-reported or decorative stamps must never visually
 * impersonate verified stamps." These tests prove:
 *   1. Each stamp wears a treatment keyed to its provenance — verified,
 *      self-reported and decorative are three visibly DISTINCT markers.
 *   2. Only a 'verified' stamp gets the verified marker; a reported/decorative
 *      stamp never carries it, and a stamp with UNKNOWN provenance defaults to
 *      decorative rather than reading as verified.
 *   3. Tapping a stamp emits the §32 stamp_viewed event with ids/enums only —
 *      never the stamp's label text.
 *   4. deriveStampVerification maps canonical provenance → verified, a
 *      self-reported source → reported, and anything else → decorative.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { PassportStampCollection } from '../PassportStampCollection.tsx';
import { deriveStampVerification } from '../../../services/passportStampMappers.ts';
import {
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../../../features/passport/passportTelemetry.ts';
import type { PassportStamp } from '../../../types/models.ts';

function stamp(overrides: Partial<PassportStamp>): PassportStamp {
  return {
    id: 'stamp-id',
    kind: 'city',
    label: 'DA NANG',
    earnedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  resetPassportTelemetrySink();
});

describe('PassportStampCollection — §12 verification treatment', () => {
  it('shows three visibly distinct markers for verified / reported / decorative', async () => {
    const stamps = [
      stamp({ id: 'v1', label: 'TOKYO', verification: 'verified' }),
      stamp({ id: 'r1', label: 'PARIS', verification: 'reported' }),
      stamp({ id: 'd1', label: 'ROME', verification: 'decorative' }),
    ];

    await render(<PassportStampCollection stamps={stamps} />);

    // Each provenance carries its own labelled marker — three distinct treatments.
    expect(screen.getByLabelText('Verified stamp')).toBeTruthy();
    expect(screen.getByLabelText('Self-reported stamp')).toBeTruthy();
    expect(screen.getByLabelText('Decorative stamp')).toBeTruthy();
    // Exactly ONE verified marker — the reported/decorative stamps don't wear it.
    expect(screen.getAllByLabelText('Verified stamp')).toHaveLength(1);
  });

  it('never lets a self-reported stamp impersonate a verified one', async () => {
    await render(<PassportStampCollection stamps={[stamp({ id: 'r1', verification: 'reported' })]} />);

    expect(screen.queryByLabelText('Verified stamp')).toBeNull();
    expect(screen.getByLabelText('Self-reported stamp')).toBeTruthy();
  });

  it('defaults an unknown-provenance (legacy) stamp to decorative, not verified', async () => {
    // No `verification` field at all — the §12-safe default.
    await render(<PassportStampCollection stamps={[stamp({ id: 'legacy' })]} />);

    expect(screen.queryByLabelText('Verified stamp')).toBeNull();
    expect(screen.getByLabelText('Decorative stamp')).toBeTruthy();
  });

  it('emits §32 stamp_viewed on tap with ids/enums only — never the label text', async () => {
    const events: PassportTelemetryEvent[] = [];
    setPassportTelemetrySink((e) => events.push(e));
    const onStampPress = jest.fn();

    await render(
      <PassportStampCollection
        stamps={[stamp({ id: 'v1', label: 'SECRET CITY', kind: 'city', verification: 'verified' })]}
        onStampPress={onStampPress}
      />,
    );

    fireEvent.press(screen.getByLabelText('SECRET CITY stamp, Verified'));

    expect(onStampPress).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'stamp_viewed',
      payload: { stampId: 'v1', kind: 'city', verification: 'verified' },
    });
    // The stamp's label text must never travel with the telemetry.
    expect(JSON.stringify(events[0])).not.toContain('SECRET CITY');
  });
});

describe('deriveStampVerification — §12 provenance mapping', () => {
  it('maps canonical provenance sources to verified', () => {
    for (const src of ['trip_derived', 'event_verified', 'partner_verified', 'admin_issued', 'system']) {
      expect(deriveStampVerification(src, 'unverified')).toBe('verified');
    }
  });

  it('treats a self-reported source as reported, never verified', () => {
    expect(deriveStampVerification('self_reported', 'unverified')).toBe('reported');
    expect(deriveStampVerification('self', 'none')).toBe('reported');
  });

  it('honours a genuine verification level even when the source is unknown', () => {
    expect(deriveStampVerification('', 'partner_verified')).toBe('verified');
    // …but an unverified/self level does not confer verification.
    expect(deriveStampVerification('self_reported', 'self')).toBe('reported');
    expect(deriveStampVerification('mystery', 'pending')).toBe('decorative');
  });
});
