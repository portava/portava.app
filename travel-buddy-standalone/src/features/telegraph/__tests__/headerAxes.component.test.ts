/**
 * Telegraph §2.2 — the conversation header's three axes.
 *
 *   "HEADER: user/crew name · availability · safe presence"
 *
 * WHAT THIS FILE IS REALLY ABOUT is the string it deleted. The header rendered
 * `'Active recently'` as a CONSTANT for every direct conversation — shown for
 * someone last seen a year ago exactly as for someone typing at that moment,
 * derived from nothing. §4's hard rule is that AVAILABLE, ONLINE, NEARBY and
 * SHARING LOCATION are separate states never collapsed into one; a free-floating
 * "Active recently" collapses them by asserting one of them for nobody.
 *
 * So the property under test is an ABSENCE with teeth: every axis that has
 * nothing to say produces nothing, the subtitle for such a participant is
 * `null` rather than a placeholder, and a failed or withheld read is
 * indistinguishable from a legitimately empty one — because distinguishing them
 * would leak that the person HAS presence the viewer is not allowed to see.
 *
 * SHOWN RED before commit (13 pass green), each mutation reverted:
 *   • `headerSubtitle` falling back to `'Active recently'` when no axis speaks
 *     — i.e. exactly the line this change deleted, put back
 *       -> 5 failed / 8 passed ("says NOTHING when no axis has anything to
 *          say", "returns null, not an empty string or a placeholder", "an
 *          availability-disabled participant contributes nothing", "a withheld
 *          read and an empty one are indistinguishable", "stale presence
 *          contributes no subtitle either")
 *   • the `!p.stale` guard dropped from `headerAxes`
 *       -> 2 failed / 11 passed ("a STALE presence row is not presence",
 *          "stale presence contributes no subtitle either")
 */
import { headerAxes, headerSubtitle, availabilityLabel } from '../header/headerAxes.ts';
import type { ConversationHeaderParticipant } from '../sharedContext/types.ts';

function participant(over: Partial<ConversationHeaderParticipant> = {}): ConversationHeaderParticipant {
  return {
    userId: 'u1',
    availability: { enabled: false, state: null, intents: [], expiresAt: null },
    safePresence: null,
    ...over,
  };
}

describe('§2.2 — an axis with nothing to say says nothing', () => {
  it('says NOTHING when no axis has anything to say', () => {
    expect(headerAxes(participant())).toEqual([]);
    expect(headerSubtitle(participant())).toBeNull();
  });

  it('returns null, not an empty string or a placeholder', () => {
    const s = headerSubtitle(participant());
    expect(s).toBeNull();
    expect(s).not.toBe('');
    expect(s).not.toBe('—');
  });

  it('an availability-disabled participant contributes nothing', () => {
    const p = participant({
      availability: { enabled: false, state: 'FREE_NOW', intents: [], expiresAt: null },
    });
    // The flag is off on this deployment: a state behind it must not leak out.
    expect(headerAxes(p)).toEqual([]);
    expect(headerSubtitle(p)).toBeNull();
  });

  it('a withheld read and an empty one are indistinguishable', () => {
    // null participant == the read failed, or the server disclosed nothing.
    expect(headerSubtitle(null)).toBeNull();
    expect(headerSubtitle(undefined)).toBeNull();
    expect(headerSubtitle(participant())).toBeNull();
  });

  it('"not open to plans" is an answer, not a label', () => {
    const p = participant({
      availability: { enabled: true, state: 'not_open', intents: [], expiresAt: null },
    });
    expect(headerAxes(p)).toEqual([]);
  });
});

describe('§2.2 — the axes that do speak', () => {
  it("renders §4.1's availability states", () => {
    expect(availabilityLabel('FREE_NOW')).toBe('Free now');
    expect(availabilityLabel('FREE_TONIGHT')).toBe('Free tonight');
    expect(availabilityLabel('IM_AROUND')).toBe('Around');
    expect(availabilityLabel('open')).toBe('Open to plans');
    expect(availabilityLabel(null)).toBeNull();
    expect(availabilityLabel('something_new')).toBeNull();
  });

  it('shows availability when the flag is on and a window is current', () => {
    const p = participant({
      availability: { enabled: true, state: 'FREE_TONIGHT', intents: ['food'], expiresAt: null },
    });
    expect(headerAxes(p)).toEqual([{ axis: 'availability', label: 'Free tonight' }]);
  });

  it('shows a coarse venue for a checked-in, fresh presence row', () => {
    const p = participant({
      safePresence: { label: 'An Thuong', venue: 'The Rooftop', checkedIn: true, stale: false },
    });
    expect(headerAxes(p)).toEqual([{ axis: 'presence', label: 'At The Rooftop' }]);
  });

  it('falls back to the approximate label when there is no venue', () => {
    const p = participant({
      safePresence: { label: 'An Thuong', venue: null, checkedIn: false, stale: false },
    });
    expect(headerAxes(p)).toEqual([{ axis: 'presence', label: 'An Thuong' }]);
  });

  it('a STALE presence row is not presence', () => {
    const p = participant({
      safePresence: { label: 'An Thuong', venue: 'The Rooftop', checkedIn: true, stale: true },
    });
    // The row outlives the knowledge; rendering it as current would turn "safe
    // presence" into a location claim nobody made.
    expect(headerAxes(p)).toEqual([]);
  });

  it('stale presence contributes no subtitle either', () => {
    const p = participant({
      safePresence: { label: 'An Thuong', venue: null, checkedIn: false, stale: true },
    });
    expect(headerSubtitle(p)).toBeNull();
  });

  it('joins the axes in §2.2’s order, after any plain facts', () => {
    const p = participant({
      availability: { enabled: true, state: 'FREE_NOW', intents: [], expiresAt: null },
      safePresence: { label: null, venue: 'The Rooftop', checkedIn: true, stale: false },
    });
    expect(headerSubtitle(p, ['Da Nang'])).toBe('Da Nang · Free now · At The Rooftop');
  });

  it('a plain fact alone is still a subtitle', () => {
    // The city is measured and stays; what was removed was the presence claim.
    expect(headerSubtitle(participant(), ['Da Nang'])).toBe('Da Nang');
  });
});
