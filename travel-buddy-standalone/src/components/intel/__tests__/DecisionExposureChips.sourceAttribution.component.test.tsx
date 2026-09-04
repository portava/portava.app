/**
 * §37 — the synthesised bare-crowdLevel claim must not be attributed to a
 * traveller.
 *
 * buildLiveClaims has two paths. When the place DTO carries a rich `liveClaims`
 * array it maps those through dtoToClaim (covered by
 * src/lib/intel/__tests__/sourceAttribution.test.ts). When it carries only a
 * bare `crowdLevel` string it SYNTHESISES one claim, and that path used to
 * hardcode `sourceClass: 'firsthand_unverified'`.
 *
 * It had a written justification — "the gated read path only returns a crowd
 * level once it cleared the live floor + privacy gate" — and that justification
 * is about FRESHNESS and PRIVACY. It says nothing about who is speaking, and
 * those are different gates.
 *
 * Checked against the producer rather than inferred: api-server's
 * readLiveCrowdLevel calls readLiveClaims for claimTypes ['crowd.level'] and
 * takes the first match, with NO source-class filter anywhere on that path. A
 * SPONSORED crowd.level claim can therefore be the one returned, and labelling
 * it firsthand is the §37 violation reached by a route the comment did not
 * cover.
 *
 * These live in jest rather than node:test because buildLiveClaims is exported
 * from a .tsx and pulls in react-native, which the node runner cannot transform.
 */
import { buildLiveClaims } from '../DecisionExposureChips.tsx';
import { sourceLabel } from '../../../lib/intel/display.ts';

describe('§37 — the synthesised crowd-level claim', () => {
  it('is NOT attributed to a traveller', () => {
    const claims = buildLiveClaims({ crowdLevel: 'busy' } as any);
    expect(claims).toHaveLength(1);
    expect(claims[0].sourceClass).toBeNull();
    expect(sourceLabel(claims[0].sourceClass)).toBe('Source not attributed');
  });

  it('is still marked synthesised and still degrades honestly', () => {
    // Guards the fix from being "solved" by deleting the path: the claim must
    // still exist, still be flagged, and still not be overstated as live.
    const claims = buildLiveClaims({ crowdLevel: 'busy' } as any);
    expect(claims[0].synthesized).toBe(true);
    expect(claims[0].band).toBe('likely_current');
  });

  it('does not change which path runs — a rich array still wins', () => {
    const claims = buildLiveClaims({
      crowdLevel: 'busy',
      liveClaims: [
        { claimType: 'crowd.level', value: { level: 'quiet' }, sourceClass: 'sponsored' },
      ],
    } as any);
    expect(claims).toHaveLength(1);
    expect(claims[0].sourceClass).toBe('sponsored');
    expect(claims[0].synthesized).toBe(false);
  });
});
