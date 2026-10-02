/**
 * candidateProjection — DSV2-04's second clause, at the DEVICE's clock.
 * census-discovery DSV2-04 (the client leg split off A03), §50.
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/upgrades-v2/02-DISCOVERY-v2.md` DSV2-04:
 *   "Observed and predicted recommendations render distinctly; expired why-now
 *    claims disappear or become explicitly stale."
 *
 * WHAT WAS WRONG
 * ==============
 * `whyNowPresentation` marked a claim stale only when the SERVE said so
 * (freshness `stale` / truth class `stale`). A claim that was fresh at the serve
 * and expired afterwards — while the card sat on screen, or while the page sat
 * in the 4-minute device cache and was painted again — went on being shown as a
 * current claim indefinitely. The module said so itself: "this module invents no
 * clock of its own". A claim cannot expire at a clock nobody reads.
 *
 * WHAT IS PINNED HERE
 * ===================
 *   • the boundary: current strictly BEFORE the horizon, stale AT it;
 *   • the horizon is the device's receipt instant + the server's duration, so
 *     the device clock decides, and a device clock that disagrees with the
 *     server's wall clock cannot move it;
 *   • no validity on the wire ⇒ the claim DISAPPEARS — nothing establishes it is
 *     current, and nothing says it expired;
 *   • a serve-stale claim is still explicitly stale without any validity;
 *   • `stampCandidateReceipt` stamps every candidate, overwrites a wire value,
 *     and leaves a page with nothing to stamp as the SAME object.
 *
 * Run with: pnpm test:component
 */

import {
  parseDiscoveryCandidate,
  stampCandidateReceipt,
  whyNowPresentation,
} from '../candidateProjection.ts';

const RECEIVED = 1_700_000_000_000;
const VALID_FOR = 90_000;
const HORIZON = RECEIVED + VALID_FOR;

function raw(over: Record<string, unknown> = {}) {
  return {
    id: 'node/1',
    whyNow: ['crowd_busy'],
    whyForUser: [],
    rankedBy: 'none',
    confidence: 0.6,
    freshness: { state: 'fresh', ageMs: 10, servedFrom: 'L1' },
    truthClass: 'observed',
    provenance: null,
    reasons: [],
    whyNowValidForMs: VALID_FOR,
    receivedAtMs: RECEIVED,
    ...over,
  };
}

describe('DSV2-04 — why-now expiry at the device clock', () => {
  it('derives the horizon from the device receipt instant plus the server duration', () => {
    expect(parseDiscoveryCandidate(raw())!.whyNowExpiresAtMs).toBe(HORIZON);
  });

  it('is CURRENT one millisecond before the horizon, and says when it stops being so', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw()), HORIZON - 1);
    expect(p.claims).toEqual(['crowd busy']);
    expect(p.stale).toBe(false);
    expect(p.expiresAtMs).toBe(HORIZON);
  });

  it('is explicitly STALE at the horizon itself — never current AT it', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw()), HORIZON);
    expect(p.stale).toBe(true);
    // The claim is kept and marked, not dropped: "we saw this" ≠ "we have nothing".
    expect(p.claims).toEqual(['crowd busy']);
    expect(p.expiresAtMs).toBeNull();
  });

  it('stays stale long after the horizon (a page repainted from the device cache)', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw()), HORIZON + 10 * 60_000);
    expect(p.stale).toBe(true);
  });

  it('ignores the server wall clock: only the device receipt instant anchors the window', () => {
    // No server timestamp is read — only the server's DURATION. So a server
    // clock an hour BEHIND the phone's cannot expire the claim early…
    const behind = parseDiscoveryCandidate(raw({ servedAt: new Date(RECEIVED - 3_600_000).toISOString() }));
    expect(whyNowPresentation(behind, HORIZON - 1).stale).toBe(false);
    // …and one an hour AHEAD cannot keep it current past its horizon.
    const ahead = parseDiscoveryCandidate(raw({ servedAt: new Date(RECEIVED + 3_600_000).toISOString() }));
    expect(whyNowPresentation(ahead, HORIZON).stale).toBe(true);
  });

  it.each([
    ['no validity on the wire', { whyNowValidForMs: undefined }],
    ['a null validity', { whyNowValidForMs: null }],
    ['a negative validity', { whyNowValidForMs: -1 }],
    ['a non-finite validity', { whyNowValidForMs: Number.POSITIVE_INFINITY }],
    ['a string validity', { whyNowValidForMs: '90000' }],
    ['no device receipt stamp', { receivedAtMs: undefined }],
  ])('DISAPPEARS with %s — nothing establishes it is current', (_label, over) => {
    const c = parseDiscoveryCandidate(raw(over));
    expect(c!.whyNowExpiresAtMs).toBeNull();
    const p = whyNowPresentation(c, RECEIVED);
    expect(p.claims).toEqual([]);
    // …and it is not labelled stale either: nothing said it expired.
    expect(p.stale).toBe(false);
  });

  it('a claim the SERVE marked stale is explicitly stale even with no validity at all', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw({
      whyNowValidForMs: undefined,
      freshness: { state: 'stale', ageMs: 900_000, servedFrom: 'L2_stale' },
    })), RECEIVED);
    expect(p.stale).toBe(true);
    expect(p.claims).toEqual(['crowd busy']);
  });

  it('a zero-length validity is already expired at receipt', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw({ whyNowValidForMs: 0 })), RECEIVED);
    expect(p.stale).toBe(true);
  });
});

describe('stampCandidateReceipt — the device receipt instant', () => {
  it('stamps every served candidate and overwrites any wire value', () => {
    const page = {
      places: [
        { id: 'node/1', candidate: { truthClass: 'observed', receivedAtMs: 1 } },
        { id: 'node/2', candidate: { truthClass: 'observed' } },
        { id: 'node/3' },
      ],
      total: 3,
    };
    const out = stampCandidateReceipt(page, RECEIVED);
    const places = out.places as Array<{ candidate?: { receivedAtMs?: number } }>;
    expect(places[0].candidate!.receivedAtMs).toBe(RECEIVED);
    expect(places[1].candidate!.receivedAtMs).toBe(RECEIVED);
    expect(places[2].candidate).toBeUndefined();
    // The wire object is not mutated.
    expect(page.places[0].candidate!.receivedAtMs).toBe(1);
  });

  it('returns the SAME object when there is nothing to stamp', () => {
    const page = { places: [{ id: 'node/1' }], total: 1 };
    expect(stampCandidateReceipt(page, RECEIVED)).toBe(page);
    const refused = { places: [] as unknown[], total: 0 };  // a refused page: nothing to stamp
    expect(stampCandidateReceipt(refused, RECEIVED)).toBe(refused);
  });
});
