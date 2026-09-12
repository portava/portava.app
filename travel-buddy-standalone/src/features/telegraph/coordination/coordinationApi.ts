/**
 * Telegraph §8 + §9 API client.
 *
 *   GET  /api/threads/:id/coordination   the live coordination view
 *   POST /api/threads/:id/coordination   a quick state, decision, vote,
 *                                        rendezvous, commitment or action
 *
 * §9.1's rule travels with the data: `quickStates[].provenance` is always
 * `USER_DECLARED`, and `state` is DERIVED — the response says so in
 * `stateProvenance`. The panel renders them in separate places for that
 * reason, and this module keeps them separate in the types.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export const QUICK_STATES = [
  'ON_MY_WAY',
  'ARRIVED',
  'RUNNING_LATE',
  'CANT_MAKE_IT',
  'START_WITHOUT_ME',
  'HEADING_BACK',
  'NEED_HELP',
] as const;
export type QuickState = (typeof QUICK_STATES)[number];

export type CoordinationState =
  | 'PREPARING'
  | 'ASSEMBLING'
  | 'ACTIVE'
  | 'RETURNING'
  | 'COMPLETE'
  | 'DISRUPTED'
  | 'CANCELLED';

export interface QuickStateRow {
  userId: string;
  state: QuickState;
  at: string;
  approximateLabel: string | null;
  note: string | null;
  provenance: 'USER_DECLARED';
}

export interface ConversationDecisionView {
  decisionId: string;
  askedBy: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  resolutionRule: string;
  deadlineAt: string | null;
  votes: Array<{ userId: string; optionId: string; at: string; late: boolean }>;
  tally: Record<string, number>;
  resolved: boolean;
  result: string | null;
  reason: string;
}

export interface ConversationCommitmentView {
  commitmentId: string;
  askedBy: string;
  what: string;
  byWhen: string | null;
  agreedBy: Array<{ userId: string; at: string }>;
  declinedBy: Array<{ userId: string; at: string }>;
  completedBy: string | null;
  completedAt: string | null;
  overdue: boolean;
}

export interface ThreadCoordinationView {
  threadId: string;
  generatedAt: string;
  plan: { objectId: string; title: string; startsAt: string | null; endsAt: string | null; leaveByAt: string | null } | null;
  state: CoordinationState | null;
  coordinating: boolean;
  legalNext: CoordinationState[];
  quickStates: QuickStateRow[];
  arrivedCount: number;
  onMyWayCount: number;
  decisions: ConversationDecisionView[];
  commitments: ConversationCommitmentView[];
  rendezvous: Array<{ messageId: string; setBy: string; at: string; payload: any }>;
}

export interface CoordinationResponse {
  coordination: ThreadCoordinationView;
  stateProvenance: 'DERIVED_FROM_PLAN_TIMELINE';
  scanned: number;
}

export type CoordinationResult<T> = { ok: true; data: T } | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call<T>(path: string, init?: RequestInit): Promise<CoordinationResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

export async function fetchCoordination(threadId: string): Promise<CoordinationResult<CoordinationResponse>> {
  return call<CoordinationResponse>(`/api/threads/${threadId}/coordination`);
}

export async function postQuickState(
  threadId: string,
  state: QuickState,
  extra?: { approximateLabel?: string | null; note?: string | null; objectId?: string | null },
): Promise<CoordinationResult<{ id: string }>> {
  return call(`/api/threads/${threadId}/coordination`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'COORDINATION', payload: { state, ...(extra ?? {}) } }),
  });
}

export async function postVote(
  threadId: string,
  decisionId: string,
  optionId: string,
): Promise<CoordinationResult<{ id: string }>> {
  return call(`/api/threads/${threadId}/coordination`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'VOTE', payload: { decisionId, optionId } }),
  });
}

export async function postCoordinationKind(
  threadId: string,
  kind: string,
  payload: unknown,
): Promise<CoordinationResult<{ id: string }>> {
  return call(`/api/threads/${threadId}/coordination`, {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  });
}

/** §9's per-state affordances, as data — §9's table, one row each. */
export const STATE_AFFORDANCES: Readonly<Record<CoordinationState, readonly QuickState[]>> = {
  PREPARING: ['CANT_MAKE_IT', 'RUNNING_LATE'],
  ASSEMBLING: ['ON_MY_WAY', 'RUNNING_LATE', 'ARRIVED', 'CANT_MAKE_IT', 'START_WITHOUT_ME'],
  ACTIVE: ['ARRIVED', 'NEED_HELP', 'HEADING_BACK'],
  RETURNING: ['HEADING_BACK', 'NEED_HELP'],
  COMPLETE: [],
  DISRUPTED: ['RUNNING_LATE', 'CANT_MAKE_IT', 'NEED_HELP'],
  CANCELLED: [],
};

export function quickStateLabel(state: QuickState): string {
  switch (state) {
    case 'ON_MY_WAY':
      return 'On my way';
    case 'ARRIVED':
      return 'Arrived';
    case 'RUNNING_LATE':
      return 'Running late';
    case 'CANT_MAKE_IT':
      return "Can't make it";
    case 'START_WITHOUT_ME':
      return 'Start without me';
    case 'HEADING_BACK':
      return 'Heading back';
    case 'NEED_HELP':
      return 'Need help';
    default:
      return state;
  }
}

export function coordinationStateLabel(state: CoordinationState | null): string {
  switch (state) {
    case 'PREPARING':
      return 'Preparing';
    case 'ASSEMBLING':
      return 'Assembling';
    case 'ACTIVE':
      return 'Happening now';
    case 'RETURNING':
      return 'Heading back';
    case 'COMPLETE':
      return 'Complete';
    case 'DISRUPTED':
      return 'Disrupted';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return '';
  }
}
