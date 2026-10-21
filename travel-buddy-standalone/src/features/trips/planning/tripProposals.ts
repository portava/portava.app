/**
 * §9.3 on the client — proposing a change for the crew to decide, under the
 * rule the proposer chooses (census-trips TR154; TR88's table populated).
 *
 * CREATE_PROPOSAL through POST /trips/:tripId/commands, which issues it
 * whatever `trip_kernel_enabled` says; the payload is built in
 * tripProposalPayloads.ts (pure). The new proposal is read back from
 * GET /trips/:tripId/decisions (no flag), where TripBallotsCard votes and
 * decides it. Nothing here writes `trip_proposals`.
 *
 * One key per tap (`proposalKey`); the composer keeps the key AND the input,
 * so a retry after an unreachable kernel re-sends THAT proposal and cannot
 * create it twice.
 */
import { intentKey } from '../shared/tripApi.ts';
import type { TripCommandRequest, TripCommandResult } from '../../../services/tripCommands.ts';
import { proposalCommand, PROPOSAL_TITLE_MAX, PROPOSAL_TEXT_MAX, type ProposalInput } from './tripProposalPayloads.ts';

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

export type ProposalResult =
  | { state: 'recorded'; duplicate: boolean; id: string | null }
  | { state: 'refused'; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

const REFUSAL_TEXT: Record<string, string> = {
  TRIP_AUTH_NOT_CREW: 'only the trip crew can propose a change',
  TRIP_COMMAND_MALFORMED: "the trip didn't accept that proposal",
  LOCAL_INVALID: 'pick one of the offered options',
  LOCAL_NO_TITLE: 'say what you are proposing',
  LOCAL_TOO_LONG: `keep the proposal under ${PROPOSAL_TITLE_MAX} characters and each note under ${PROPOSAL_TEXT_MAX}`,
};

function toResult(r: TripCommandResult): ProposalResult {
  if (r.ok) {
    const id = r.result && typeof r.result === 'object' && typeof (r.result as { id?: unknown }).id === 'string' ? (r.result as { id: string }).id : null;
    return { state: 'recorded', duplicate: r.duplicate, id };
  }
  if (r.kind === 'unavailable') return { state: 'unavailable', detail: r.detail };
  return { state: 'refused', reason: r.reason, detail: REFUSAL_TEXT[r.reason] ?? r.detail ?? r.reason };
}

/** A fresh key for one tap. Keep it to retry that tap; mint a new one for the next. */
export function proposalKey(): string {
  return intentKey('proposal:create');
}

export async function createProposal(tripId: string, input: ProposalInput, idempotencyKey: string): Promise<ProposalResult> {
  const cmd = proposalCommand(input);
  if (!cmd.ok) return { state: 'refused', reason: cmd.reason, detail: REFUSAL_TEXT[cmd.reason] ?? cmd.reason };
  return toResult(await issue(tripId, { type: cmd.type, payload: cmd.payload, idempotencyKey }));
}
