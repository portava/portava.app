/**
 * CanILeaveCard — where the minutes came from, said where a traveller reads it.
 *
 * ── CENSUS L9 (§2.1) and L250 (§22) ──────────────────────────────────────────
 * Two rows, one gap, stated in almost the same words. L9: *"`publicAirport`
 * still exposes only a `verified` boolean and a generic-buffer session is still
 * indistinguishable from a curated one at the client."* L250: *"the airport's
 * own data maturity is never disclosed, so a curated airport and a
 * generic-fallback one present identical confidence."*
 *
 * The fallback LADDER (DB row → static dataset → `buildFallbackProfile`) has
 * been real since the first census and has never been visible. This file is the
 * pin that it is now: the SAME advice, window and airport, rendered against
 * three different server disclosures, must produce three different cards.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * The failure mode is a disclosure that exists on the wire and reaches no
 * screen — the reachability `W` this census has spent four passes on. So the
 * assertions are about RENDERED TEXT, not about a prop being passed, and the
 * three rungs are asserted to differ from each other rather than each to match
 * a string (a component that rendered one constant sentence would pass a
 * per-rung string check three times if the strings were copied from it).
 *
 * The "no disclosure" case is here for the opposite reason: a card handed
 * nothing must render nothing rather than guess a maturity from
 * `airport.verified`, which is the field that conflated all three rungs.
 *
 * ── MUTATIONS RUN ────────────────────────────────────────────────────────────
 * Recorded in §17.4 of docs/architecture/census-layover.md.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react-native';
import { CanILeaveCard } from '../CanILeaveCard.tsx';
import type {
  LayoverAirportIntelligence,
  LayoverWindow,
  LeaveAdvice,
  PublicAirport,
} from '../../../services/layover.ts';

const AIRPORT: PublicAirport = {
  id: 'airport-tpe',
  iataCode: 'TPE',
  name: 'Taiwan Taoyuan International Airport',
  city: 'Taoyuan',
  country: 'Taiwan',
  countryCode: 'TW',
  timezone: 'Asia/Taipei',
  lat: 25.0797,
  lng: 121.2342,
  verified: false,
};

const WINDOW: LayoverWindow = {
  totalMinutes: 480,
  exitDelayMin: 65,
  usableMinutes: 180,
  earliestOutTime: '2026-09-13T10:05:00.000Z',
  hardReturnTime: '2026-09-13T13:05:00.000Z',
  returnState: 'NORMAL',
  tier: 'city_explore',
  tierLabel: 'City explore',
  breakdown: {
    baseBuffer: 120,
    immigrationExtra: 30,
    bagsExtra: 0,
    trafficExtra: 20,
    timeOfDayExtra: 0,
    liveExtra: 0,
    totalBuffer: 170,
  },
} as unknown as LayoverWindow;

const ADVICE: LeaveAdvice = {
  verdict: 'yes',
  reasons: ['You have three hours outside the terminal.'],
  unknowns: ['Visa or transit-permit requirements for your nationality'],
  reasonCodes: [],
  disclaimer: 'Guidance only — check with your airline.',
} as unknown as LeaveAdvice;

function intel(over: Partial<LayoverAirportIntelligence>): LayoverAirportIntelligence {
  return {
    tier: 'GENERIC',
    airportAddressable: false,
    airportVerified: false,
    liveObserved: false,
    bufferSourceClass: 'STATIC_DEFAULT',
    bufferFallbackLevel: 3,
    confidence: 'LOW',
    sourceRefs: ['StaticAirportData:TPE'],
    ...over,
  };
}

/**
 * Every string the provenance strip actually put on screen, joined.
 *
 * Read out of the RENDERED tree rather than asserted prop-by-prop: a strip that
 * received the right object and rendered nothing is the exact failure this file
 * exists to catch.
 */
function bodyText(): string {
  const strip = screen.getByTestId('layover-airport-intelligence');
  const out: string[] = [];
  const walk = (node: any): void => {
    if (node == null || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    walk(node.props?.children);
  };
  walk(strip.props?.children);
  return out.join(' | ');
}

describe('CanILeaveCard — §2.1 "degrade visibly" (census L9, L250)', () => {
  it('a GENERIC airport says nothing about it went into the numbers', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={WINDOW} airport={AIRPORT} airportIntelligence={intel({})} />);
    const text = bodyText();
    expect(text).toContain('Generic timings');
    expect(text).toContain('Nothing about TPE');
    expect(text).toContain('No live airport conditions');
    expect(screen.getByTestId('layover-airport-intelligence-generic')).toBeTruthy();
  });

  it('an UNVERIFIED airport record says addressable, not curated', async () => {
    await render(
      <CanILeaveCard
        advice={ADVICE}
        window={WINDOW}
        airport={AIRPORT}
        airportIntelligence={intel({
          tier: 'AIRPORT_RECORD',
          airportAddressable: true,
          bufferSourceClass: 'AIRPORT_PROFILE',
          bufferFallbackLevel: 2,
          sourceRefs: ['airport_profiles.international_buffer_min'],
        })}
      />,
    );
    const text = bodyText();
    expect(text).toContain('Unverified airport record');
    expect(text).toContain('nobody has verified it');
    expect(screen.getByTestId('layover-airport-intelligence-partial')).toBeTruthy();
  });

  it('a VERIFIED airport record says the minutes come from it', async () => {
    await render(
      <CanILeaveCard
        advice={ADVICE}
        window={WINDOW}
        airport={AIRPORT}
        airportIntelligence={intel({
          tier: 'VERIFIED_RECORD',
          airportAddressable: true,
          airportVerified: true,
          bufferSourceClass: 'AIRPORT_PROFILE',
          bufferFallbackLevel: 2,
        })}
      />,
    );
    const text = bodyText();
    expect(text).toContain('Verified airport record');
    expect(screen.getByTestId('layover-airport-intelligence-curated')).toBeTruthy();
  });

  /**
   * L250's actual claim, as an inequality. Three renders of the SAME advice,
   * window and airport differ only in the server's disclosure, and the strings
   * on screen must differ too — which is what "do not imply equivalent
   * intelligence globally" asks for and what no string-equality check per rung
   * could establish on its own.
   */
  it('the three rungs do not present identically', async () => {
    const seen: string[] = [];
    for (const over of [
      {},
      { tier: 'AIRPORT_RECORD' as const, airportAddressable: true },
      { tier: 'VERIFIED_RECORD' as const, airportAddressable: true, airportVerified: true },
    ]) {
      await render(
        <CanILeaveCard advice={ADVICE} window={WINDOW} airport={AIRPORT} airportIntelligence={intel(over)} />,
      );
      seen.push(bodyText());
      await cleanup();
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('a card handed NO disclosure renders none — it does not guess one from airport.verified', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={WINDOW} airport={AIRPORT} airportIntelligence={null} />);
    expect(screen.queryByTestId('layover-airport-intelligence')).toBeNull();
    // The rest of the honesty box is untouched: this is a missing disclosure,
    // not a broken card.
    expect(screen.getByText(/Visa or transit-permit/)).toBeTruthy();
  });

  it('a LIVE observation is the only rung that does not say conditions are unmeasured', async () => {
    await render(
      <CanILeaveCard
        advice={ADVICE}
        window={WINDOW}
        airport={AIRPORT}
        airportIntelligence={intel({ tier: 'LIVE', liveObserved: true, airportAddressable: true })}
      />,
    );
    const text = bodyText();
    expect(text).toContain('A current airport observation is folded into these minutes.');
    expect(text).not.toContain('No live airport conditions');
  });
});
