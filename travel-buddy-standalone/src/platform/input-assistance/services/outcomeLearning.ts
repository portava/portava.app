/**
 * Global Input Intelligence — OUTCOME LEARNING, the client's half (spec §45 /
 * §57; census G320/G370 and the rank term G5/G14/G322/G323). Server half:
 * artifacts/api-server/src/lib/inputAssistance/outcomeLearning.ts.
 *
 * Built to the owner's decisions (docs/ops/owner-decisions-20261004.md):
 *   OD-INPUT-1  explicit opt-in, off by default, purpose-limited, separated
 *               from core assistance;
 *   OD-INPUT-2  per-user outcome counters kept 30 days, then deleted.
 *
 * WHAT THIS MODULE HOLDS
 *   - the DISCLOSURE the person reads before opting in, and its version (the
 *     server refuses a grant whose displayed version is not the stamped one);
 *   - the CONSENT GATE: one bit, bound to the account it was read for, FALSE
 *     until the server says otherwise and reset on every account change;
 *   - `reportInputTaskOutcome`, the one call a screen that completes a task
 *     makes. Without consent it does NOTHING — no event, no request;
 *   - `gateOutcomeEvents`, the per-name filter `installInputTelemetry` puts in
 *     front of the §44 sink, so a direct `emitDownstreamTaskCompleted` that
 *     bypassed the reporter is still dropped without consent.
 *
 * The server is the authority: its ingest drops `downstream_task_completed`
 * for a caller without consent, and `/input-assistance/outcome` refuses one.
 * This gate exists so a device that has not been told "yes" never sends the
 * claim at all.
 *
 * Pure module — no React, no network, no Supabase. The transport lives in
 * `outcomeLearningTransport.ts`; everything here is node:test-safe.
 */
import type { InputContext } from '../types/inputContext.ts';
import type { InputTelemetryPolicy } from '../types/fieldPolicy.ts';
import { emitDownstreamTaskCompleted, type InputTelemetryEvent, type TelemetrySink } from './inputTelemetry.ts';

// ── The disclosure ────────────────────────────────────────────────────────────

/** Must equal the server's INPUT_OUTCOME_DISCLOSURE_VERSION; bump both with the words. */
export const OUTCOME_DISCLOSURE_VERSION = 'input_outcome_learning_v1';

export const OUTCOME_DISCLOSURE_TITLE = 'Learn from what you complete';

/**
 * ENGINEERING DRAFT of OD-INPUT-1's properties, for the owner to approve before
 * `input_outcome_learning_enabled` is turned on. Each sentence carries one
 * clause of the decisions: what is kept, for what, for how long, what is shared
 * and how, that suggestions work without it, and what turning it off does. It
 * says "without your account attached" rather than "anonymous" on purpose: the
 * stream carries a per-app-run session token, and a linkable record must not be
 * called anonymous.
 */
export const OUTCOME_DISCLOSURE_BODY =
  'When you finish something you used a suggestion for — like saving a trip with a destination you picked — ' +
  'Portava can remember that, so the places you actually use come first in your own suggestions. ' +
  'We keep this for 30 days, then delete it, and use it only to order your suggestions. ' +
  'We also note whether the task finished, without your account attached, to check that suggestions help. ' +
  'Suggestions work the same if you leave this off, and turning it off deletes what we kept.';

// ── The tasks ─────────────────────────────────────────────────────────────────

/** Closed vocabulary — mirrors the server's INPUT_OUTCOME_TASKS. */
export const INPUT_OUTCOME_TASKS = [
  'trip_created',
  'trip_destinations_saved',
  'event_created',
  'message_sent',
] as const;
export type InputOutcomeTask = (typeof INPUT_OUTCOME_TASKS)[number];

/** At most this many entities per report (the server refuses more). */
export const MAX_OUTCOME_ENTITIES = 10;

// ── The server's answer, parsed ───────────────────────────────────────────────

export interface OutcomeConsentState {
  /** Is the setting offered at all (the server's flag)? */
  available: boolean;
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  currentDisclosureVersion: string;
  retentionDays: number;
}

/** A body that is not exactly the server's shape is NOT a state — it is unreadable. */
export function parseOutcomeConsentState(body: unknown): OutcomeConsentState | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.available !== 'boolean' || typeof b.enabled !== 'boolean') return null;
  if (typeof b.currentDisclosureVersion !== 'string' || typeof b.retentionDays !== 'number') return null;
  const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    available: b.available,
    enabled: b.enabled,
    consentVersion: strOrNull(b.consentVersion),
    consentedAt: strOrNull(b.consentedAt),
    withdrawnAt: strOrNull(b.withdrawnAt),
    currentDisclosureVersion: b.currentDisclosureVersion,
    retentionDays: b.retentionDays,
  };
}

/** Does this state license sending outcomes? Offered AND opted in. */
export function stateGrantsOutcomes(s: OutcomeConsentState | null): boolean {
  return !!s && s.available && s.enabled;
}

// ── The gate ──────────────────────────────────────────────────────────────────

let gate: { account: string | null; consented: boolean } = { account: null, consented: false };

/** A new account (or signed out): the gate closes until THIS account's consent is read. */
export function beginOutcomeAccount(accountId: string | null): void {
  gate = { account: accountId, consented: false };
}

/**
 * Apply a consent answer — only if it is for the CURRENT account. A slow read
 * for the previous account must never open the gate for the next one.
 */
export function applyOutcomeConsent(accountId: string | null, granted: boolean): void {
  if (accountId === null || accountId !== gate.account) return;
  gate = { account: accountId, consented: granted === true };
}

export function currentOutcomeAccount(): string | null {
  return gate.account;
}

export function outcomeLearningConsented(): boolean {
  return gate.consented;
}

/**
 * The per-name filter in front of the §44 sink. Every event passes except
 * `downstream_task_completed` without consent.
 */
export function gateOutcomeEvents(sink: TelemetrySink): TelemetrySink {
  return (e: InputTelemetryEvent) => {
    if (e.name === 'downstream_task_completed' && !outcomeLearningConsented()) return;
    sink(e);
  };
}

// ── The report a task-completing screen makes ─────────────────────────────────

export interface OutcomeEntity {
  entityType: string;
  entityId: string;
}

export interface TaskOutcomeBody {
  context: InputContext;
  fieldId: string;
  task: InputOutcomeTask;
  ok: boolean;
  entities: OutcomeEntity[];
}

export type OutcomePoster = (body: TaskOutcomeBody) => Promise<boolean>;

let poster: OutcomePoster | null = null;

/** Bound at boot by `installOutcomeConsentSync` (outcomeLearningTransport.ts). */
export function setOutcomePoster(p: OutcomePoster | null): void {
  poster = p;
}

export interface TaskOutcomeField {
  fieldId: string;
  context: InputContext;
  policy?: InputTelemetryPolicy;
  requestId?: string | null;
}

export type TaskOutcomeResult = 'not_consented' | 'reported';

/**
 * A task the field served COMPLETED (or failed). Call it from the screen that
 * knows — the input field is long gone by then.
 *
 *   reportInputTaskOutcome(
 *     { fieldId: 'trip.destination', context: 'trip_destination' },
 *     'trip_created', true, [{ entityType: 'city', entityId: cityId }]);
 *
 * Without consent: nothing at all. With it: the §44 event (no identifiers, the
 * shared stream) and — only for a success with entities — the per-user credit.
 * Fire-and-forget: never awaits, never throws, never affects the task.
 */
export function reportInputTaskOutcome(
  field: TaskOutcomeField,
  task: InputOutcomeTask,
  ok: boolean,
  entities: readonly OutcomeEntity[] = [],
  deps: { post?: OutcomePoster | null } = {},
): TaskOutcomeResult {
  if (!outcomeLearningConsented()) return 'not_consented';
  try {
    emitDownstreamTaskCompleted(
      { fieldId: field.fieldId, context: field.context, policy: field.policy, requestId: field.requestId },
      task,
      ok,
    );
    const post = deps.post === undefined ? poster : deps.post;
    const credited = entities
      .filter((e) => typeof e.entityType === 'string' && typeof e.entityId === 'string' && e.entityId.length > 0)
      .slice(0, MAX_OUTCOME_ENTITIES);
    if (ok && credited.length > 0 && post) {
      void post({ context: field.context, fieldId: field.fieldId, task, ok, entities: credited }).catch(() => false);
    }
  } catch {
    // best-effort — an outcome report must never surface to the user
  }
  return 'reported';
}

// ── The account-bound sync, with every impure piece injected ──────────────────

export interface OutcomeConsentSyncDeps {
  subscribeAuth: (cb: (userId: string | null) => void) => () => void;
  currentUserId: () => Promise<string | null>;
  fetchConsent: () => Promise<OutcomeConsentState | null>;
  post: OutcomePoster;
}

/**
 * Bind the gate to the session: on every account change close it, then open it
 * only if THAT account's consent says so. A failed read leaves it closed.
 * Returns the teardown (closes the gate, unbinds the poster).
 */
export function createOutcomeConsentSync(deps: OutcomeConsentSyncDeps): () => void {
  setOutcomePoster(deps.post);
  const onAccount = (userId: string | null): void => {
    beginOutcomeAccount(userId);
    if (userId == null) return;
    void deps
      .fetchConsent()
      .then((state) => applyOutcomeConsent(userId, stateGrantsOutcomes(state)))
      .catch(() => undefined);
  };
  const unsubscribe = deps.subscribeAuth(onAccount);
  void (async () => {
    try {
      onAccount(await deps.currentUserId());
    } catch {
      onAccount(null);
    }
  })();
  return () => {
    try {
      unsubscribe();
    } catch {
      /* never throw out of teardown */
    }
    setOutcomePoster(null);
    beginOutcomeAccount(null);
  };
}
