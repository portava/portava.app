/**
 * §11 — the client for `POST /trips/:tripId/commands` and the snapshot read.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Migrations 2764-2777 added ten command families to `trip_kernel_execute`:
 * stages, legs, commitments, goals, decision tasks, risks, presence, proposals,
 * votes, outcomes and plan attendance. Before this file, not one of them could
 * be issued from the app. The endpoint existed and was mounted; no client code
 * named it. A command family nothing can issue is a stored procedure.
 *
 * WHAT THE CALLER MUST SUPPLY, AND WHY NOTHING IS DEFAULTED HERE
 * =============================================================
 * `idempotencyKey` is REQUIRED by the server and is deliberately not generated
 * here. A key minted per call makes every retry a NEW command, which is exactly
 * what the kernel's receipt table exists to prevent: the same key returns the
 * original result with `duplicate: true` instead of applying twice. A caller
 * that cannot say what its key is does not have a retryable operation, and
 * papering over that in a helper would hide it.
 *
 * `actor_user_id` is NOT sent. The server takes the actor from the verified
 * token and REFUSES a body that names one, so sending it is an error rather
 * than a no-op — see the endpoint's own comment on why silently ignoring it
 * would be worse.
 *
 * EVERY REFUSAL IS MODELLED
 * ========================
 * The kernel returns a REASON rather than raising, and this preserves the
 * distinctions the server draws: "you may not" (403), "it is not there" (404),
 * "it moved under you" (409), "that is not a valid command" (400), and "the
 * kernel could not be reached" (503). The last one is the one that must never
 * be collapsed into the others: a command that could not be attempted is not a
 * command that was rejected, and telling a user their input was wrong when the
 * database was unreachable sends them to fix the wrong thing.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/**
 * The command types this endpoint issues — mirrors COMMANDS_ENDPOINT_TYPES in
 * artifacts/api-server/src/routes/tripCommands.ts. Kept as a literal union so a
 * typo is a compile error rather than a 400 at runtime.
 */
export const TRIP_COMMAND_TYPES = [
  'ADD_STAGE', 'UPDATE_STAGE', 'REMOVE_STAGE',
  'ADD_LEG', 'UPDATE_LEG', 'REMOVE_LEG',
  'ADD_COMMITMENT', 'UPDATE_COMMITMENT', 'REMOVE_COMMITMENT',
  'ADD_GOAL', 'UPDATE_GOAL', 'REMOVE_GOAL',
  'ADD_DECISION_TASK', 'UPDATE_DECISION_TASK', 'REMOVE_DECISION_TASK',
  'ADD_RISK', 'UPDATE_RISK', 'REMOVE_RISK',
  'SET_PRESENCE', 'CLEAR_PRESENCE',
  'CREATE_PROPOSAL', 'VOTE_ON_PROPOSAL', 'ACCEPT_PROPOSAL', 'REJECT_PROPOSAL',
  'RECORD_OUTCOME',
  'JOIN_PLAN', 'LEAVE_PLAN', 'SET_PLAN_ATTENDANCE',
  // 2779: §3.3 plan lifecycle and §4.2 stage lifecycle — no legacy twin.
  'START_PLAN', 'SKIP_PLAN', 'START_STAGE', 'COMPLETE_STAGE',
  // 2780 subgroups, 2782 transport segments, 2785 disruptions and the
  // derived events a person may also record.
  'CREATE_SUBGROUP', 'JOIN_SUBGROUP', 'LEAVE_SUBGROUP', 'DISSOLVE_SUBGROUP',
  // 2794: §10.4 meeting checkpoints / §11.3 regroup.
  'CREATE_MEETING_CHECKPOINT', 'SET_MEETING_ARRIVAL', 'CLOSE_MEETING_CHECKPOINT',
  'ADD_TRANSPORT_SEGMENT', 'UPDATE_TRANSPORT_SEGMENT', 'SET_TRANSPORT_STATE', 'REMOVE_TRANSPORT_SEGMENT',
  'DECLARE_DISRUPTION', 'RESOLVE_DISRUPTION',
  'MARK_COMMITMENT_AT_RISK', 'CLEAR_COMMITMENT_RISK', 'OPEN_FREE_WINDOW', 'RECORD_OPPORTUNITY_CHANGE',
] as const;
export type TripCommandType = (typeof TRIP_COMMAND_TYPES)[number];

export interface TripCommandRequest {
  type: TripCommandType;
  payload?: Record<string, unknown>;
  /** REQUIRED. See the header: a generated key defeats the kernel's receipt. */
  idempotencyKey: string;
  /** Optimistic concurrency. Omit to skip the check; the kernel still bumps. */
  expectedTripVersion?: number | null;
  clientObservedAt?: string | null;
  correlationId?: string | null;
}

export type TripCommandResult =
  | {
      ok: true;
      /** True when this exact idempotency key had already been applied. */
      duplicate: boolean;
      version: number;
      eventId: string | null;
      sequence: number | null;
      result: unknown;
      contractVersion: number | null;
    }
  | {
      ok: false;
      /** 'refused' — the kernel considered it and said no. */
      kind: 'refused';
      status: number;
      /** The kernel's reason code, e.g. TRIP_AUTH_NOT_CREW. */
      reason: string;
      detail: string | null;
      currentVersion: number | null;
      expectedVersion: number | null;
    }
  | {
      /** 'unavailable' — the command was NOT attempted, or its fate is unknown.
       *  Never merge this with `refused`: nothing was decided. */
      ok: false;
      kind: 'unavailable';
      detail: string;
    };

export async function issueTripCommand(
  tripId: string,
  cmd: TripCommandRequest,
): Promise<TripCommandResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, kind: 'unavailable', detail: 'not configured' };
  }
  if (!cmd.idempotencyKey) {
    // Refused locally rather than sent: the server rejects it anyway, and
    // failing here names the actual problem instead of surfacing a 400.
    return { ok: false, kind: 'unavailable', detail: 'idempotencyKey is required' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, kind: 'unavailable', detail: 'not signed in' };

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api/trips/${tripId}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: cmd.type,
        payload: cmd.payload ?? {},
        idempotency_key: cmd.idempotencyKey,
        expected_trip_version: cmd.expectedTripVersion ?? null,
        client_observed_at: cmd.clientObservedAt ?? null,
        correlation_id: cmd.correlationId ?? null,
      }),
    });
  } catch (e: any) {
    // The request may or may not have reached the kernel. That is precisely
    // `unavailable`, and it is why idempotencyKey is the caller's to own: the
    // safe recovery is to retry with the SAME key.
    return { ok: false, kind: 'unavailable', detail: String(e?.message ?? 'network error') };
  }

  const body = await res.json().catch(() => null) as Record<string, any> | null;

  if (res.ok && body?.ok === true) {
    return {
      ok: true,
      duplicate: Boolean(body.duplicate),
      version: Number(body.version),
      eventId: body.eventId ?? null,
      sequence: body.sequence ?? null,
      result: body.result ?? null,
      contractVersion: body.contractVersion ?? null,
    };
  }

  // 503 is the kernel being unreachable, not a rejection of the command.
  if (res.status === 503) {
    return { ok: false, kind: 'unavailable', detail: String(body?.reason ?? 'kernel unavailable') };
  }
  // A response we cannot read is not a refusal either — we do not know what
  // happened, and calling it a refusal would tell the user their command was
  // rejected when it may well have applied.
  if (!body || typeof body.reason !== 'string') {
    return { ok: false, kind: 'unavailable', detail: `unreadable response (HTTP ${res.status})` };
  }

  return {
    ok: false,
    kind: 'refused',
    status: res.status,
    reason: body.reason,
    detail: body.detail ?? null,
    currentVersion: body.currentVersion ?? null,
    expectedVersion: body.expectedVersion ?? null,
  };
}

// ── §22 snapshots ───────────────────────────────────────────────────────────

export interface TripSnapshotRead {
  tripId: string;
  aggregateVersion: number;
  snapshot: unknown;
  engineVersions: unknown;
  createdAt: string;
  /**
   * THREE states, not two. `true` the replay matched, `false` it did NOT —
   * the snapshot has drifted from the event log — and `null` the check could
   * not run. A consumer that treats null as true is asserting a verification
   * nobody performed.
   */
  replayVerified: boolean | null;
  verification: unknown;
}

export type SnapshotFetch =
  | { state: 'ok'; snapshot: TripSnapshotRead }
  /** No snapshot exists at that version. An answer, not a failure. */
  | { state: 'absent' }
  | { state: 'unavailable'; detail: string };

export async function fetchTripSnapshot(
  tripId: string,
  version: number | 'latest' = 'latest',
): Promise<SnapshotFetch> {
  if (!isSupabaseConfigured || !apiBase()) return { state: 'unavailable', detail: 'not configured' };
  const token = await freshToken();
  if (!token) return { state: 'unavailable', detail: 'not signed in' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/snapshots/${version}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 is the ONE status that means "there is no snapshot here". Everything
    // else that is not ok is a read that did not answer.
    if (res.status === 404) return { state: 'absent' };
    if (!res.ok) return { state: 'unavailable', detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null) as TripSnapshotRead | null;
    if (!body || typeof body.aggregateVersion !== 'number') {
      return { state: 'unavailable', detail: 'unreadable response' };
    }
    return { state: 'ok', snapshot: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}
