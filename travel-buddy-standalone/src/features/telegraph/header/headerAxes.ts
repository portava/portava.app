/**
 * Telegraph §2.2 — the conversation header's three axes.
 *
 *   HEADER: user/crew name · availability · safe presence
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 * The header used to render a hard-coded subtitle: `'Active recently'` for every
 * direct conversation, and `City · Active recently` when a city was known. That
 * string was not derived from anything. It was shown for a person last seen a
 * year ago exactly as for one typing at that moment, which is a presence claim
 * the app had no evidence for — the plainest possible violation of §4's "hard
 * rule" that AVAILABLE, ONLINE, NEARBY and SHARING LOCATION are separate
 * states, because it asserted one of them for free.
 *
 * ── THE THREE AXES, AND WHEN EACH IS ALLOWED TO SAY ANYTHING ────────────────
 * `GET /api/threads/:id/conversation-header` returns availability and safe
 * presence separately, each behind its own consent path (availability behind
 * `open_to_plans_windows_enabled` and the window's own visibility; safe presence
 * behind `canViewCirclePresenceBatch` and only inside the thread's canonical
 * trip context). This module turns that into a subtitle, under one rule:
 *
 *   AN AXIS WITH NOTHING TO SAY SAYS NOTHING.
 *
 * No fallback, no "Active recently", no em-dash placeholder. A header that
 * carries only a name is the correct rendering of a conversation about which
 * the server disclosed nothing, and `headerAxes` returns an empty list for it.
 */
import type { ConversationHeaderParticipant } from '../sharedContext/types.ts';

export interface HeaderAxis {
  /** Which of §2.2's axes this is. The name axis is supplied by the screen. */
  axis: 'availability' | 'presence';
  label: string;
}

/** §4.1's states, in the words a header should use. */
export function availabilityLabel(state: string | null | undefined): string | null {
  switch (state) {
    case 'FREE_NOW':
    case 'free_now':
      return 'Free now';
    case 'FREE_TONIGHT':
    case 'free_tonight':
      return 'Free tonight';
    case 'FREE_TODAY':
    case 'free_today':
      return 'Free today';
    case 'IM_AROUND':
    case 'im_around':
      return 'Around';
    case 'OPEN_TO_JOINING':
    case 'open_to_joining':
    case 'open':
      return 'Open to plans';
    case 'AVAILABLE_WINDOW':
    case 'available_window':
      return 'Available';
    // "not_open" is a real answer and it is NOT a header claim: a person who is
    // not open to plans is simply not described, rather than labelled.
    default:
      return null;
  }
}

/**
 * The axes a header may show for one participant.
 *
 * STALE PRESENCE IS NOT PRESENCE. `circle_presence.is_stale` exists because the
 * row outlives the knowledge; rendering a stale venue as a current one is how
 * "safe presence" becomes a location claim nobody made. A stale row contributes
 * nothing here.
 */
export function headerAxes(
  participant: ConversationHeaderParticipant | null | undefined,
): HeaderAxis[] {
  if (!participant) return [];
  const axes: HeaderAxis[] = [];

  if (participant.availability?.enabled) {
    const label = availabilityLabel(participant.availability.state);
    if (label) axes.push({ axis: 'availability', label });
  }

  const p = participant.safePresence;
  if (p && !p.stale) {
    // The venue is the more specific of the two, and is only ever the coarse
    // `venue_label` the presence row carries — never a coordinate.
    const label = p.venue ?? p.label;
    if (label) axes.push({ axis: 'presence', label: p.checkedIn ? `At ${label}` : label });
  }

  return axes;
}

/**
 * §2.2's subtitle: the axes that have something to say, joined.
 *
 * Returns null — not an empty string and not a placeholder — when no axis does.
 * The caller renders the name alone in that case.
 */
export function headerSubtitle(
  participant: ConversationHeaderParticipant | null | undefined,
  fallbackFacts: string[] = [],
): string | null {
  const parts = [...fallbackFacts.filter(Boolean), ...headerAxes(participant).map((a) => a.label)];
  return parts.length > 0 ? parts.join(' · ') : null;
}
