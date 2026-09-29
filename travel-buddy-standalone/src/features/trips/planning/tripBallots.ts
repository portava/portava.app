/**
 * TRIP-F15 — §9.3 ballots on the client (WP-10).
 *
 * THE ONLY WRITE PATH IS THE KERNEL
 * =================================
 * A ballot is `VOTE_ON_PROPOSAL { proposal_id, vote }` issued through
 * POST /trips/:tripId/commands (server/trips/commandRoute.ts), which runs it
 * in `trip_kernel_execute` (2775): self-only (there is no user_id key, so a
 * vote cannot be cast for someone else), refused once the proposal is no
 * longer pending, and answered with the recomputed `trip_proposal_tally`.
 * Deciding a proposal is ACCEPT_PROPOSAL / REJECT_PROPOSAL, whose capability
 * is the proposal's own rule ('proposal_rule', 2775): the kernel checks the
 * tally and applies the change. Nothing here writes `trip_proposal_votes` or
 * `trip_proposals`, and nothing re-derives a tally.
 *
 * ONE KEY PER INTENT
 * ==================
 * The kernel's receipt answers a repeated idempotency key with the ORIGINAL
 * result. A key derived only from (proposal, vote) would make "yes, then no,
 * then yes again" return the first yes's receipt and silently drop the third
 * vote. So `ballotKey` mints a fresh key per tap, and the card keeps it to
 * retry THAT tap when the kernel could not be reached.
 */
import { intentKey } from '../shared/tripApi.ts';
import type { DecisionBoard } from './tripDecisions.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../services/tripCommands.ts';

export type Ballot = 'yes' | 'no' | 'abstain';
export const BALLOTS: readonly Ballot[] = ['yes', 'no', 'abstain'];
export type BoardProposal = DecisionBoard['proposals'][number];

type Issuer = (tripId: string, cmd: TripCommandRequest) => Promise<TripCommandResult>;
let _testIssuer: Issuer | null = null;
/** Test seam: replace the kernel command client; null restores. */
export function _setTestIssuer(fn: Issuer | null): void { _testIssuer = fn; }

async function issue(tripId: string, cmd: TripCommandRequest): Promise<TripCommandResult> {
  if (_testIssuer) return _testIssuer(tripId, cmd);
  // Lazy: tripCommands.ts reaches lib/supabase.ts, which node:test cannot load.
  const { issueTripCommand } = await import('../../../services/tripCommands.ts');
  return issueTripCommand(tripId, cmd);
}

export type BallotResult =
  | { state: 'recorded'; duplicate: boolean }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

const REFUSAL_TEXT: Record<string, string> = {
  TRIP_PROPOSAL_NOT_PENDING: 'this vote has already been decided',
  TRIP_PROPOSAL_NOT_FOUND: 'this proposal is no longer on the trip',
  TRIP_AUTH_NOT_CREW: 'only the trip crew can vote',
  TRIP_AUTH_NOT_HOST: 'only the host can decide this one',
  TRIP_PROPOSAL_VOTE_NOT_MET: 'the vote has not carried yet',
};

function toResult(r: TripCommandResult): BallotResult {
  if (r.ok) return { state: 'recorded', duplicate: r.duplicate };
  if (r.kind === 'unavailable') return { state: 'unavailable', detail: r.detail };
  return { state: 'refused', reason: r.reason, detail: REFUSAL_TEXT[r.reason] ?? r.detail ?? r.reason };
}

/** A fresh key for one tap. Keep it to retry that tap; mint a new one for the next. */
export function ballotKey(proposalId: string, vote: Ballot | 'accept' | 'reject'): string {
  return intentKey(`ballot:${proposalId}:${vote}`);
}

export async function castBallot(tripId: string, proposalId: string, vote: Ballot, idempotencyKey: string): Promise<BallotResult> {
  return toResult(await issue(tripId, { type: 'VOTE_ON_PROPOSAL', payload: { proposal_id: proposalId, vote }, idempotencyKey }));
}

export async function decideProposal(tripId: string, proposalId: string, decision: 'accept' | 'reject', idempotencyKey: string): Promise<BallotResult> {
  return toResult(await issue(tripId, {
    type: decision === 'accept' ? 'ACCEPT_PROPOSAL' : 'REJECT_PROPOSAL',
    payload: { proposal_id: proposalId },
    idempotencyKey,
  }));
}

/** The proposals still taking votes. A decided proposal is history, not a ballot. */
export function openBallots(board: Pick<DecisionBoard, 'proposals'>): BoardProposal[] {
  return board.proposals.filter((p) => p.status === 'pending');
}

/**
 * Whether to show Accept / Reject. The kernel decides either way; this only
 * avoids offering a button that can only be refused. The owner may always
 * try (HOST rule); anyone may under ANYONE; others once the tally says the
 * rule is met. A null tally licenses nothing.
 */
export function canOfferDecision(p: BoardProposal, isOwner: boolean): boolean {
  if (isOwner) return true;
  if (p.decisionRule === 'anyone') return true;
  if (!p.tally || p.tally.found !== true) return false;
  return p.decisionRule === 'unanimous' ? p.tally.unanimous_met === true : p.tally.majority_met === true;
}

export function proposalTitle(p: BoardProposal): string {
  const payload = (p.payload ?? {}) as Record<string, unknown>;
  for (const k of ['title', 'summary', 'rationale']) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const words = p.type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The tally as the server computed it. Null is "could not count", never 0/0. */
export function tallyLine(p: BoardProposal): string {
  const t = p.tally;
  if (!t || t.found !== true) return "We couldn't count the votes";
  const n = (v: number | undefined) => (typeof v === 'number' ? v : 0);
  const cast = typeof t.cast === 'number' ? t.cast : n(t.yes) + n(t.no) + n(t.abstain);
  const of = typeof t.electorate === 'number' ? ` — ${cast} of ${t.electorate} voted` : '';
  return `${n(t.yes)} yes · ${n(t.no)} no · ${n(t.abstain)} abstain${of}`;
}
