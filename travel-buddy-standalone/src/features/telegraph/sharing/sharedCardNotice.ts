/**
 * census-telegraph T448 / T359 (lane w-tg-cardtruth, 2026-10-14) — what a
 * conversation surface says for a shared card the server would not vouch for.
 *
 * A legacy card the thread screen does not draw as a rich card (a meetup card
 * whose source this viewer cannot see, an event card, a hidden-gem card) falls
 * to the centred notice pill. Before the server re-resolved cards, that pill
 * printed whatever the stored body said; now the body carries nothing from the
 * source unless the card is live, so the pill needs a sentence instead —
 * one that names nothing from the source.
 *
 * Returns null when the card is live or there is no server truth: the caller
 * keeps its own behaviour.
 */
import type { SharedCardTruth } from './shareApi.ts';
import { revokedLabel } from './useShareRevocation.ts';
import { SHARED_CARD_UNVERIFIABLE_COPY } from './shareApi.ts';

export function sharedCardNoticeText(card: SharedCardTruth | null | undefined): string | null {
  if (!card || card.state === 'live') return null;
  if (card.state === 'unavailable' && card.reason !== 'unknown') return revokedLabel(card.reason);
  return SHARED_CARD_UNVERIFIABLE_COPY;
}
