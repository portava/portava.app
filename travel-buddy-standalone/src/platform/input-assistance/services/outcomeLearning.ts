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
 *   - the CONSENT GATE: a current account/grant scope, closed
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
  return !!s && s.available && s.enabled && s.withdrawnAt === null
    && s.consentVersion === OUTCOME_DISCLOSURE_VERSION && validGrant(s.consentedAt);
}

// ── The gate ──────────────────────────────────────────────────────────────────

export interface OutcomeScope {
  readonly account: string | null;
  readonly consented: boolean;
  readonly consentedAt: string | null;
}
let gate: OutcomeScope = { account: null, consented: false, consentedAt: null };
const withdrawalHolds = new Set<string>();
const listeners = new Set<() => void>();
const authorizations = new WeakMap<object, OutcomeScope>();
function validGrant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function replaceGate(next: OutcomeScope): void {
  gate = next;
  for (const listener of listeners) { try { listener(); } catch { /* isolated observer */ } }
}
export function currentOutcomeScope(): OutcomeScope { return gate; }
export function isCurrentOutcomeScope(scope: OutcomeScope): boolean { return scope === gate; }
export function subscribeOutcomeScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Account/session transitions invalidate queued work even for A → B → A. */
export function beginOutcomeAccount(accountId: string | null): void {
  replaceGate({ account: accountId, consented: false, consentedAt: null });
}
/** Missing grant provenance can never open the gate. */
export function applyOutcomeConsent(accountId: string | null, granted: boolean, consentedAt?: string | null): void {
  if (accountId === null || accountId !== gate.account) return;
  const allowed = granted === true && validGrant(consentedAt) && !withdrawalHolds.has(accountId);
  const at = allowed ? consentedAt! : null;
  if (gate.consented === allowed && gate.consentedAt === at) return;
  replaceGate({ account: accountId, consented: allowed, consentedAt: at });
}
/** A failed remote withdrawal still disables collection on this device. */
export function holdOutcomeWithdrawal(accountId: string): void {
  if (withdrawalHolds.has(accountId)) return;
  withdrawalHolds.add(accountId);
  if (gate.account === accountId) replaceGate({ account: accountId, consented: false, consentedAt: null });
}
/** Only an explicitly requested, acknowledged grant may release the hold. */
export function clearOutcomeWithdrawal(accountId: string): void { withdrawalHolds.delete(accountId); }
export function hasOutcomeWithdrawalHold(accountId: string | null): boolean { return !!accountId && withdrawalHolds.has(accountId); }
export function currentOutcomeAccount(): string | null { return gate.account; }
export function outcomeLearningConsented(): boolean { return gate.consented; }

/** Local sidecar proof is never serialized. The timestamp is admission metadata. */
export function copyOutcomeAuthorization(source: object, target: object): string | null {
  const scope = authorizations.get(source);
  if (!scope || !scope.consented || !isCurrentOutcomeScope(scope)) return null;
  authorizations.set(target, scope);
  return scope.consentedAt;
}
export function isCurrentOutcomeAuthorization(value: object): boolean {
  const scope = authorizations.get(value);
  return !!scope && scope.consented && isCurrentOutcomeScope(scope);
}
export function outcomeAuthorizationSignal(values: readonly object[]) {
  const controller = new AbortController();
  const check = () => { if (values.some(value => !isCurrentOutcomeAuthorization(value))) controller.abort(); };
  const stop = subscribeOutcomeScope(check);
  check();
  return { signal: controller.signal, dispose: stop, accountId: values.length ? authorizations.get(values[0]!)?.account ?? null : undefined };
}
export function gateOutcomeEvents(sink: TelemetrySink): TelemetrySink {
  return (e: InputTelemetryEvent) => {
    if (e.name !== 'downstream_task_completed') { sink(e); return; }
    if (!outcomeLearningConsented()) return;
    const bound = { ...e };
    authorizations.set(bound, gate);
    sink(bound);
  };
}

// ── The report a task-completing screen makes ─────────────────────────────────

export interface OutcomeEntity {
  entityType: string;
  entityId: string;
}

export interface TaskOutcomeBody {
  outcomeConsentedAt: string;
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
  const scope = currentOutcomeScope();
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
    if (ok && credited.length > 0 && post && isCurrentOutcomeScope(scope)) {
      const body: TaskOutcomeBody = { context: field.context, fieldId: field.fieldId, task, ok, entities: credited,
        outcomeConsentedAt: scope.consentedAt! };
      authorizations.set(body, scope);
      void post(body).catch(() => false);
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
  let disposed = false;
  let revision = 0;
  const onAccount = (userId: string | null): void => {
    if (disposed) return;
    revision += 1;
    beginOutcomeAccount(userId);
    if (userId == null) return;
    const scope = currentOutcomeScope();
    void deps.fetchConsent().then(state => {
      if (!disposed && isCurrentOutcomeScope(scope)) {
        applyOutcomeConsent(userId, stateGrantsOutcomes(state), state?.consentedAt);
      }
    }).catch(() => undefined);
  };
  const initialRevision = revision;
  const unsubscribe = deps.subscribeAuth(onAccount);
  void deps.currentUserId().then(userId => {
    if (!disposed && revision === initialRevision) onAccount(userId);
  }).catch(() => { if (!disposed && revision === initialRevision) onAccount(null); });
  return () => {
    disposed = true;
    try { unsubscribe(); } catch { /* teardown must remain safe */ }
    setOutcomePoster(null);
    beginOutcomeAccount(null);
  };
}
