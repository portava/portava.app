/**
 * Telegraph §22 — the wording of a message request's origin.
 *
 * census T278: "`message_requests` has no origin column at all — only
 * `preview_text`. A recipient cannot be told why a stranger is reaching out."
 * The server now records one; this is the half the recipient reads.
 *
 * THE ONE MISTAKE AVAILABLE HERE
 * ==============================
 * Printing "In your trip crew" for an UNVERIFIED trip claim. A stranger who
 * wants to be trusted asserts "Trip", and a recipient who reads that as a fact
 * has been told something the product does not know, at the exact moment they
 * are deciding whether to let a stranger talk to them.
 *
 * Every case below is about that line: the product STATES what it checked and
 * ATTRIBUTES what it did not, and the difference lives in the grammar rather
 * than in a badge colour, because a colour does not survive a screenshot, a
 * description aloud, or a person in a hurry.
 *
 * WHAT TURNS THIS RED — both were run:
 *   • the verified wording used for an unverified claim → six cases fail.
 *   • an absent origin rendered as a sentence → the absent case fails, and an
 *     "unknown origin" label on every historical request would make each of
 *     them look suspicious.
 */
import { originLabel, type RequestOriginType } from '../requestOriginLabel.ts';

const ALL: RequestOriginType[] = ['event', 'trip', 'nearby', 'bump', 'buddy', 'profile'];

describe('§22 request origin wording', () => {
  it('says nothing when there is no origin — which is every request today', () => {
    expect(originLabel(null)).toBeNull();
    expect(originLabel(undefined)).toBeNull();
  });

  it('states a VERIFIED trip as a fact', () => {
    const l = originLabel({ type: 'trip', id: 't1', verified: true })!;
    expect(l.verified).toBe(true);
    expect(l.text).toBe('In your trip crew');
  });

  it('ATTRIBUTES an unverified trip claim — this is the whole point', () => {
    const l = originLabel({ type: 'trip', id: 't1', verified: false })!;
    expect(l.verified).toBe(false);
    expect(l.text).toBe('They say you share a trip');
    expect(l.text).not.toBe('In your trip crew');
  });

  it('every unverified origin is attributed, never asserted', () => {
    for (const type of ALL) {
      const l = originLabel({ type, id: null, verified: false })!;
      expect(l.verified).toBe(false);
      expect(l.text.startsWith('They say')).toBe(true);
    }
  });

  it('an origin that claims verification but has no verified wording UNDERSTATES', () => {
    // Reachable the day a second origin becomes verifiable server-side and this
    // table has not been updated. Falling back to the claim wording is the safe
    // direction; inventing a statement of fact is not.
    for (const type of ALL) {
      if (type === 'trip') continue;
      const l = originLabel({ type, id: null, verified: true })!;
      expect(l.verified).toBe(false);
      expect(l.text.startsWith('They say')).toBe(true);
    }
  });

  it('an origin type outside §22\'s six says nothing at all', () => {
    expect(originLabel({ type: 'telegram' as RequestOriginType, id: null, verified: true })).toBeNull();
  });

  it('covers exactly §22\'s six and no more', () => {
    for (const type of ALL) {
      expect(originLabel({ type, id: null, verified: false })).not.toBeNull();
    }
  });
});
