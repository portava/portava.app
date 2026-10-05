/**
 * Telegraph §30A.10 / §30A.20 for the two LEGACY shared cards
 * (`components/PostCardMessage.tsx`, `components/DiscoveryCardMessage.tsx`).
 *
 * census-telegraph T413 / T448: "PostCardMessage.tsx and DiscoveryCardMessage.tsx
 * branch on `revocation.state === 'unavailable'` and then render `payload.*`
 * throughout — the sender's snapshot." And T411: "the action row is static
 * markup over a frozen payload with no capability read."
 *
 * §30A.20: "A source object shared in Telegraph cannot grant broader access than
 * its authorized share projection." §30A.10: "Action buttons are derived from
 * current capabilities. An old rendered card must not authorize a stale action."
 *
 * So a legacy card is drawn in exactly one of five modes, decided here once for
 * both components:
 *
 *   live      — the server resolved the source FOR THIS VIEWER, now. The card
 *               draws the server's projection (title, subtitle, image, deep link)
 *               and nothing the sender serialised except the sender's own
 *               caption. Its actions are the server's current `actions`.
 *   revoked   — the source is gone or no longer this viewer's to see.
 *   loading   — the answer is not in yet. Nothing from the source is drawn.
 *   reference — a resolve was ATTEMPTED and could not answer (network, 5xx,
 *               unsupported). The card draws what PortavaObjectMessage draws in
 *               the same state: the kind of thing, the sender's caption and a
 *               way to open it — the destination authorizes for itself. Not the
 *               snapshot: a resolve that fails is exactly when a revoked post
 *               would otherwise still be shown in full.
 *   legacy    — no resolve is possible (no thread id, or a source type with no
 *               §5 family — `for_you`, `traveler_pick`). The pre-§5 card, with
 *               View and the server-authorized Save (see offeredCardActions);
 *               there is no capability to derive any other action from.
 */
import type { TelegraphAction } from '../sharedContext/types.ts';
import type { ShareRevocation } from './useShareRevocation.ts';

export type LegacyCardMode = 'live' | 'revoked' | 'loading' | 'reference' | 'legacy';

/**
 * @param attempted true when the card handed the hook a thread id AND a source
 *   type that maps to a §5 family — i.e. a resolve was possible.
 */
export function legacyCardMode(revocation: ShareRevocation, attempted: boolean): LegacyCardMode {
  if (revocation.state === 'unavailable') return 'revoked';
  if (revocation.state === 'available' && revocation.resolved?.available) return 'live';
  if (revocation.state === 'loading') return 'loading';
  return attempted ? 'reference' : 'legacy';
}

export interface OfferedCardActions {
  view: boolean;
  addToTrip: boolean;
  meetHere: boolean;
  save: boolean;
}

const NONE: OfferedCardActions = { view: false, addToTrip: false, meetHere: false, save: false };

/**
 * What the card may OFFER. Only `live` derives anything beyond View, and it
 * derives it from the server's current `actions` for this viewer in this
 * conversation. Save is the viewer's own bookmark, authorized by Discovery's
 * save path itself; it is offered only while the source is live.
 */
export function offeredCardActions(mode: LegacyCardMode, actions: readonly TelegraphAction[] = []): OfferedCardActions {
  switch (mode) {
    case 'live':
      return {
        view: true,
        addToTrip: actions.includes('ADD_TO_TRIP'),
        meetHere: actions.includes('MEET_HERE'),
        save: true,
      };
    case 'reference':
      return { ...NONE, view: true };
    case 'legacy':
      // Save stays on the pre-§5 card because its press is NOT a client-side
      // authorization: it goes through the server's discovery-card command,
      // which proposes the save only when the server's own authorize says yes
      // (census-discovery §95 / A21, services/discoveryCardSave.ts). Add to Plan
      // has no such server-side capability step behind it here, so it is not
      // offered on a card nothing could resolve.
      return { ...NONE, view: true, save: true };
    default:
      return NONE;
  }
}

/** The kind of a shared object, for a card that may not draw its content. */
export function objectKindLabel(objectType: string): string {
  return objectType
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Copy for `reference` mode. Says what happened; claims nothing about the source. */
export const REFERENCE_COPY = "Couldn't load the latest version. Open it to see what's there now.";
