/**
 * Global Input Intelligence — OUTCOME LEARNING (spec §45 / §57; census G320,
 * G370, G5, G14, G322, G323), built to the owner's two decisions of 2026-10-04
 * (docs/ops/owner-decisions-20261004.md):
 *
 *   OD-INPUT-1  "Downstream-outcome telemetry: Explicit opt-in, off by default,
 *                purpose-limited, and separated from core assistance."
 *   OD-INPUT-2  "Per-user outcome counters: Retain for 30 days, then delete or
 *                irreversibly aggregate."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT IT IS FOR
 * ══════════════════════════════════════════════════════════════════════════════
 * §45 says the engine learns from accepted AND ignored suggestions AND
 * successful downstream outcomes, and must not optimise for acceptance alone.
 * Until now acceptance (`input_selection_history.selection_count`) was the ONLY
 * signal that moved rank. This module gives a consenting user's ranking a second
 * input: how often a task they completed actually used an entity they had
 * picked in that field — a trip saved with that destination, an event created
 * at that place. `personalization.ts#boostFor` weighs it against the bare pick.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * HOW EACH CLAUSE OF THE DECISIONS IS MET
 * ══════════════════════════════════════════════════════════════════════════════
 *  - EXPLICIT OPT-IN: `input_outcome_consent` (3780), written only here, only on
 *    a request that names the disclosure version the client DISPLAYED, which
 *    must equal the version the server stamps (the D4 rule, intelConsent.ts).
 *  - OFF BY DEFAULT: an absent row is off; the flag `input_outcome_learning_enabled`
 *    ships FALSE and while it is off a grant is refused (a withdrawal never is).
 *  - PURPOSE-LIMITED: the only reader of the counters is the owner's own ranking
 *    in the field they were recorded in. Nothing aggregates them across users,
 *    nothing exports them, and the shared telemetry stream (2950) still stores
 *    no account id — its `downstream_task_completed` rows are admitted only for
 *    a consenting caller and carry `{task, ok}` and nothing else.
 *  - SEPARATED FROM CORE ASSISTANCE: with no consent, or the flag off, or any
 *    read here failing, the gateway ranks EXACTLY as it did before this module
 *    existed (acceptance-only). Suggestions never depend on the opt-in.
 *  - 30 DAYS THEN DELETE: counters are UTC-day buckets; `runInputOutcomeRetentionSweep`
 *    deletes a bucket whole once it is 30 days old, and `input_outcome_memory`
 *    applies the same window so a late sweep cannot make an expired completion
 *    count. Withdrawing the consent deletes the user's counters at once.
 *
 * The database re-checks consent inside `input_record_outcome` (3780), so a
 * future caller that forgets `hasValidOutcomeConsent` still cannot write.
 *
 * FAILURE HONESTY. supabase-js RESOLVES `{ data, error }`; every read here
 * returns a discriminated result, never a silent empty. A failed consent read
 * is "unreadable" (the route answers 503), never "not consented"; a failed
 * counter read makes the ranking fall back to acceptance-only AND is logged,
 * which is the behaviour of a user without the feature, not a claim about this
 * user's outcomes.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../featureFlags';
import { getServiceClient } from '../supabase';
import { logger } from '../logger';
import type { SweepResult } from '../intelRetentionScheduler';
import { withOutcomes, type SelectionMemory } from './personalization';
import {
  hasValidInputConsent,
  readInputConsent,
  writeInputConsent,
  type InputConsentRead,
  type InputConsentState,
} from './inputConsent';

/** The feature flag (3780, seeded FALSE). */
export const INPUT_OUTCOME_FLAG = 'input_outcome_learning_enabled';

/**
 * The disclosure a grant is recorded under. The client shows exactly these
 * words (travel-buddy-standalone/src/platform/input-assistance/services/
 * outcomeLearning.ts mirrors them) and sends this version with the grant; a
 * mismatch is refused. Bump BOTH when the words change materially.
 *
 * THE TEXT IS THE ENGINEERING DRAFT OF OD-INPUT-1's PROPERTIES and is the one
 * thing the owner must approve before turning the flag on.
 */
export const INPUT_OUTCOME_DISCLOSURE_V1 = 'input_outcome_learning_v1';
export const INPUT_OUTCOME_DISCLOSURE_VERSION = INPUT_OUTCOME_DISCLOSURE_V1;

/** OD-INPUT-2. A completion counts, and is kept, for this many UTC days including today. */
export const INPUT_OUTCOME_RETENTION_DAYS = 30;

/** At most this many entities are credited by one completed task. */
export const MAX_OUTCOME_ENTITIES = 10;

/**
 * The closed vocabulary of downstream tasks. A screen that completes a task the
 * list does not name is refused, so the counters cannot quietly start meaning
 * something new. Kept in step with the client's `INPUT_OUTCOME_TASKS`.
 */
export const INPUT_OUTCOME_TASKS = [
  'trip_created',
  'trip_destinations_saved',
  'event_created',
  'message_sent',
] as const;
export type InputOutcomeTask = (typeof INPUT_OUTCOME_TASKS)[number];
const TASKS: ReadonlySet<string> = new Set(INPUT_OUTCOME_TASKS);
export function isOutcomeTask(v: unknown): v is InputOutcomeTask {
  return typeof v === 'string' && TASKS.has(v);
}

// ── Consent (the shared opt-in shape lives in inputConsent.ts) ────────────────

export type OutcomeConsentState = InputConsentState;
export type OutcomeConsentRead = InputConsentRead;

/** Valid = enabled, not withdrawn, and stamped with a version. Fail-closed on anything else. */
export function hasValidOutcomeConsent(state: OutcomeConsentState | null | undefined): boolean {
  return hasValidInputConsent(state);
}

/** May a grant whose client displayed `seen` be recorded under the current version? */
export function displayedOutcomeDisclosureMatches(seen: unknown): boolean {
  return seen === INPUT_OUTCOME_DISCLOSURE_VERSION;
}

/** The owner's consent row. `{ok:true, state:null}` = never asked (off); `{ok:false}` = unreadable. */
export async function readOutcomeConsent(db: SupabaseClient, userId: string): Promise<OutcomeConsentRead> {
  return readInputConsent(db, 'input_outcome_consent', userId);
}

export type OutcomeConsentWrite =
  | {
      ok: true;
      state: OutcomeConsentState;
      /**
       * Withdrawal only: were the user's counters deleted? `false` means the
       * consent IS withdrawn (nothing new is recorded or read) but the delete
       * failed and the 30-day sweep is now what removes them. Never hidden.
       */
      countersErased: boolean | null;
    }
  | { ok: false };

/**
 * Record a grant or a withdrawal. The VERSION and TIMESTAMPS are stamped here,
 * never taken from the client. A withdrawal also deletes the user's counters.
 */
export async function writeOutcomeConsent(
  db: SupabaseClient,
  userId: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<OutcomeConsentWrite> {
  const write = await writeInputConsent(db, 'input_outcome_consent', INPUT_OUTCOME_DISCLOSURE_VERSION, userId, enabled, now);
  if (!write.ok) return { ok: false };
  let countersErased: boolean | null = null;
  if (!enabled) {
    try {
      const { error } = await db.from('input_outcome_counters').delete().eq('user_id', userId);
      countersErased = !error;
      if (error) logger.warn({ err: error }, 'input outcome counters: erase on withdrawal failed; the 30-day sweep remains');
    } catch (err) {
      countersErased = false;
      logger.warn({ err }, 'input outcome counters: erase on withdrawal threw; the 30-day sweep remains');
    }
  }
  return { ok: true, state: write.state, countersErased };
}

/** Is the opt-in OFFERED at all (the capability flag)? Fail-closed. */
export async function outcomeLearningOffered(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, INPUT_OUTCOME_FLAG);
}

/**
 * Is outcome learning ACTIVE for this user right now: flag on AND a valid
 * consent. Any failure answers false. Two reads; used only by the §44 ingest,
 * and only for a batch that carries an outcome event — the ranking path uses
 * the one-round-trip `readOutcomeMemory` instead.
 */
export async function outcomeLearningActive(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  if (!(await outcomeLearningOffered(db))) return false;
  const read = await readOutcomeConsent(db, userId);
  return read.ok && hasValidOutcomeConsent(read.state);
}

// ── Counters ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The oldest UTC day still inside the window: today and the 29 days before it. */
export function outcomeWindowStartDay(now: Date = new Date()): string {
  return utcDay(new Date(now.getTime() - (INPUT_OUTCOME_RETENTION_DAYS - 1) * DAY_MS));
}

export type RecordOutcomeResult = 'recorded' | 'no_consent' | 'failed';

/** One completed task credited to one entity. The database re-checks consent. */
export async function recordOutcome(
  db: SupabaseClient,
  o: { userId: string; context: string; entityType: string; entityId: string },
): Promise<RecordOutcomeResult> {
  try {
    const { data, error } = await db.rpc('input_record_outcome', {
      p_user_id: o.userId,
      p_context: o.context,
      p_entity_type: o.entityType,
      p_entity_id: o.entityId,
    });
    if (error) return 'failed';
    if (data === true) return 'recorded';
    if (data === false) return 'no_consent';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** `entityType:entityId` — the SAME key personalization.ts uses for selection memory. */
export function outcomeKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export type OutcomeMemoryRead =
  | { ok: true; active: false }
  | { ok: true; active: true; counts: Map<string, number> }
  | { ok: false };

/**
 * ONE round trip (OD-INPUT-7): `input_outcome_memory` (3780) answers whether
 * outcome learning is active for this user — flag on AND a valid consent,
 * both checked in the database — and, only if so, their windowed completion
 * counts for one context. Owner scope comes from the session. A failed call,
 * or an answer that is not exactly that shape, is `{ ok: false }`.
 */
export async function readOutcomeMemory(
  db: SupabaseClient,
  o: { userId: string; context: string; now?: Date },
): Promise<OutcomeMemoryRead> {
  if (!o.userId) return { ok: false };
  try {
    const { data, error } = await db.rpc('input_outcome_memory', {
      p_user_id: o.userId, // OWNER SCOPE — from the session, never the request.
      p_context: o.context,
      p_since: outcomeWindowStartDay(o.now),
    });
    if (error || !data || typeof data !== 'object') return { ok: false };
    const d = data as { active?: unknown; counts?: unknown };
    if (d.active === false) return { ok: true, active: false };
    if (d.active !== true || !Array.isArray(d.counts)) return { ok: false };
    const counts = new Map<string, number>();
    for (const r of d.counts as Array<Record<string, unknown>>) {
      if (!r || typeof r.entity_type !== 'string' || typeof r.entity_id !== 'string') continue;
      const n = typeof r.completed === 'number' && r.completed > 0 ? r.completed : 0;
      if (n > 0) counts.set(outcomeKey(r.entity_type, r.entity_id), n);
    }
    return { ok: true, active: true, counts };
  } catch {
    return { ok: false };
  }
}

/**
 * The gateway's single entry point — ONE round trip. Returns `memory` UNCHANGED
 * (acceptance-only ranking) unless outcome learning is active for this user, in
 * which case the user's windowed counts for this context are attached. A failed
 * read is logged and also returns `memory` unchanged: the user gets the ranking
 * a user without the feature gets, never a fabricated one.
 */
export async function attachOutcomeMemory(
  db: SupabaseClient,
  memory: SelectionMemory,
  userId: string,
  context: string,
  now: Date = new Date(),
): Promise<SelectionMemory> {
  const read = await readOutcomeMemory(db, { userId, context, now });
  if (!read.ok) {
    // Acceptance-only — the SAME memory object, not the outcome formula with
    // empty counts (that would halve every acceptance for a read that failed).
    logger.warn({ context }, 'input outcome memory unreadable; ranking falls back to acceptance-only');
    return memory;
  }
  return read.active ? withOutcomes(memory, read.counts) : memory;
}

/**
 * OD-INPUT-2's deletion. Every bucket older than the window, for every user.
 *
 * FLAGLESS, for the reason `runInputTelemetryRetentionSweep` gives: a retention
 * control shipped switched off declares a promise and does not keep it. The
 * FEATURE flag decides whether counters are written; it must never decide
 * whether expired ones are deleted.
 */
export async function runInputOutcomeRetentionSweep(
  opts: { client?: unknown; now?: Date } = {},
): Promise<SweepResult> {
  const db = ('client' in opts && opts.client !== undefined ? opts.client : getServiceClient()) as SupabaseClient | null;
  if (!db) return { purged: 0, skipped: true, reason: 'no_client' };
  const cutoff = outcomeWindowStartDay(opts.now ?? new Date());
  try {
    const { data, error } = await db
      .from('input_outcome_counters')
      .delete()
      .lt('bucket_day', cutoff)
      .select('user_id');
    if (error) {
      logger.warn({ err: error }, 'input outcome retention sweep failed');
      return { purged: 0, skipped: true, reason: 'error' };
    }
    const purged = Array.isArray(data) ? data.length : 0;
    // A count and nothing else: WHOSE counters expired is not a log fact.
    if (purged > 0) logger.info({ purged }, 'input outcome retention removed expired buckets');
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, 'input outcome retention sweep threw');
    return { purged: 0, skipped: true, reason: 'error' };
  }
}
