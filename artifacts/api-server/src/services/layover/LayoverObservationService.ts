/**
 * LayoverObservationService — the §10 observation channel's missing writer.
 *
 * Census-layover L82 ("Traveler observation — checkpoint timing, queue report,
 * closure; confidence-weighted") has read, for every pass this document
 * records: "The class exists and is confidence-weighted the way the spec asks
 * (trust × decay), with a corroboration floor above it. There is NO SUBMISSION
 * SURFACE — no route, no screen, nothing a traveller can report from."
 *
 * This module is the persistence half of that surface. The DECISION half is
 * already built and is not duplicated here: `services/airport/LayoverAirportTruth.ts`
 * owns screening, decay, the plausibility range, the rate limit, the
 * corroboration floor and the §10.1 contradiction rules, and it is pure. This
 * file does exactly three things that a pure module cannot:
 *
 *   1. derives the pseudonymous observer handle a traveller's report is filed
 *      under (`travellerObserverHandle`),
 *   2. reads the corpus a reconciliation needs (`readObservationCorpus`),
 *   3. writes an accepted observation (`submitTravellerObservation`).
 *
 * ── THE IDENTITY RULE, WHICH IS THE WHOLE PRIVACY ARGUMENT ───────────────────
 * Migration 2860, which created `airport_fact_observations`, is explicit:
 *
 *   "The only identity on the row is `observer_id`, a free TEXT handle for the
 *    FEED or SENSOR that reported it — it is NOT a profiles FK and must never
 *    become one. A traveller-sourced observation is attributed to the ingest
 *    channel, not to the traveller, so this table cannot become a record of who
 *    was standing in which queue."
 *
 * and enforces it with `airport_fact_observations_community_not_a_profile`, a
 * CHECK that forbids a bare UUID in `observer_id` on a community row.
 *
 * A raw user id is therefore out. But so is a RANDOM handle per submission,
 * for a reason that is not obvious: `screenObservations` rate-limits per
 * (observer, factType) and `reconcile` counts CORROBORATION as distinct
 * `observerId`s. Under random handles one traveller pressing the button twice
 * IS two corroborating strangers, `MIN_COMMUNITY_CORROBORATION` is satisfied by
 * one person, and the §23 rate limit never fires. Random is not the private
 * choice here; it is the forgeable one.
 *
 * So the handle is an HMAC over (user, airport) under a server pepper. Distinct
 * travellers get distinct handles, so corroboration counts real distinct
 * people; the same traveller always gets the same handle at that airport, so
 * the rate limit binds and nobody corroborates themselves; and the handle is
 * not a profiles id, is not reversible without the pepper, and is not
 * correlatable across airports.
 *
 * ── WHY THE HANDLE DOES NOT ROTATE, STATED BECAUSE IT WAS CONSIDERED ─────────
 * `lib/sensingAnonStore.ts` rotates its contributor token on an epoch, and that
 * is right for a store whose rows live 72 hours and whose cohort counts are
 * aggregate. It is WRONG here, and adopting it by analogy would have quietly
 * removed a data-integrity check:
 *
 * A rotating handle means one traveller holds TWO handles across a rotation
 * boundary. `TRAVELER_OBSERVATION` rows live `FACT_CLASS_TTL_MIN` = 45 minutes,
 * so any boundary falling inside a 45-minute window puts both handles in the
 * same corpus — and at that moment one person satisfies a corroboration floor
 * that exists precisely so that "one stranger cannot move a deadline"
 * (LayoverAirportTruth.ts, MIN_COMMUNITY_CORROBORATION). A narrow hole is still
 * a hole in the one rule that makes community reports safe to act on.
 *
 * The cost of not rotating is that a handle is stable for as long as the pepper
 * is. What that buys an attacker who already holds the table: the ability to
 * see that the same unnamed person reported queues at one airport more than
 * once. It does not name them, does not follow them to another airport, and
 * does not survive the row TTL as anything a reader can act on. That is the
 * trade this file takes deliberately; if it is ever revisited, the corroboration
 * floor has to be re-secured FIRST, not after.
 *
 * ── FAIL-CLOSED, AND NO SWALLOWED READS ──────────────────────────────────────
 * `readObservationCorpus` returns a discriminated result and NEVER an empty
 * array standing in for a failed read. This is the defect census-layover has
 * now found four separate times on this domain (§21.4, §23.1: "an unreadable
 * block list was served as an empty city"): an outage that renders as an
 * honest-looking absence. An unreadable corpus here would publish "no live
 * reports for this airport", which is a claim, not a silence — and downstream
 * it is the input to a SAFETY buffer. It refuses instead.
 *
 * The pepper derivation throws rather than falling back to a constant, for the
 * same reason `sensingPepper` does: a guessable pepper makes every handle
 * mintable, and a mintable handle defeats both the rate limit and the
 * corroboration floor at once.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * `airport_fact_observations`, created by migration 2860 (written, NOT applied
 * as of this file — see the route's comment and docs/BUILD-BACKLOG.md), plus
 * the `submission_token` idempotency key added by migration 2982.
 *
 * Writes go through the SERVICE ROLE only. 2860 grants `authenticated` SELECT
 * and nothing else, with no INSERT policy of any kind, deliberately: a client
 * that could INSERT its own row would bypass the plausibility range, the rate
 * limit and the corroboration floor, which are the entire abuse story.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  AIRPORT_FACT_TYPES,
  FACT_CLASS_TTL_MIN,
  OBSERVATION_RATE_LIMIT,
  factClassOf,
  reconcile,
  screenObservations,
  type AirportFactType,
  type AirportObservation,
  type ObservationRejection,
  type ReconciliationOutcome,
} from "../airport/LayoverAirportTruth.js";

const logger = rootLogger.child({ service: "LayoverObservationService" });

/** The store. Created by migration 2860. */
export const OBSERVATION_TABLE = "airport_fact_observations";

/**
 * The fact types a TRAVELLER may report, and the reason the set is this small.
 *
 * These are exactly the three members of the `TRAVELER_OBSERVATION` class in
 * `AIRPORT_FACT_TYPES` — §10's own row for this class, whose Examples column
 * reads "checkpoint timing, queue report, closure".
 *
 * Everything else in the vocabulary is somebody else's fact. `security_layout`
 * and `transport_schedule` are OPERATIONAL_SEMI_LIVE and belong to an operator;
 * `security_wait_minutes` and `immigration_wait_minutes` are FAST_LIVE and
 * belong to a feed. A traveller writing into a FAST_LIVE type would be filing a
 * community reading under a class whose 20-minute TTL and whose place in
 * `liveConditionsFrom` were designed for an instrumented source — the value
 * would reach the safety buffer with a freshness it has not earned.
 *
 * Derived from the vocabulary rather than written out, so a fact type added to
 * `AIRPORT_FACT_TYPES` under this class is submittable without a second edit
 * here, and one added under another class is NOT silently admitted.
 */
export const TRAVELLER_SUBMITTABLE_FACT_TYPES: readonly AirportFactType[] =
  (Object.keys(AIRPORT_FACT_TYPES) as AirportFactType[]).filter(
    (t) => factClassOf(t) === "TRAVELER_OBSERVATION",
  );

export function isTravellerSubmittableFactType(t: string): t is AirportFactType {
  return (TRAVELLER_SUBMITTABLE_FACT_TYPES as readonly string[]).includes(t);
}

/**
 * The channel a traveller report is attributed to, and it is a CHANNEL rather
 * than a person by construction — 2860's rule. It lands in
 * `TruthValue.sourceRefs`, which is rendered, so it has to read as something a
 * person can understand rather than as an internal id.
 */
export const TRAVELLER_SOURCE_REF = "portava:layover/traveller-report";

const HANDLE_CONTEXT = "layover-observation/observer/v1";

/**
 * The server pepper. Prefers a dedicated variable and falls back to
 * SESSION_SECRET, which `lib/envValidation.ts` lists in REQUIRED_KEYS and whose
 * absence exits the process at boot — so one is always present in a valid run.
 *
 * NO CONSTANT FALLBACK. A guessable pepper lets anyone mint a handle that looks
 * like a distinct traveller, which forges corroboration and evades the rate
 * limit in the same move.
 */
function observerPepper(): string {
  const secret = process.env.LAYOVER_OBSERVER_PEPPER ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "LAYOVER_OBSERVER_PEPPER or SESSION_SECRET is required to derive a layover observer handle (integrity-critical, no fallback).",
    );
  }
  return secret;
}

/**
 * Canonicalise before hashing. Same hazard and same fix as `lib/intelGroupKey`
 * and `lib/sensingAnonStore`: two spellings of one airport ref ("bkk", "BKK ")
 * must not hash to two handles, or ONE traveller splits into two observers and
 * corroborates themselves — the exact failure the floor exists to prevent.
 */
function canon(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * The pseudonymous handle a traveller's reports at one airport are filed under.
 *
 * Shape: `tv1-` + 40 hex characters. The prefix is load-bearing twice over — it
 * versions the derivation, and it guarantees the value cannot match 2860's
 * `airport_fact_observations_community_not_a_profile` UUID pattern, so a
 * community row can never be mistaken for one carrying a profiles id.
 */
export function travellerObserverHandle(userId: string, airportRef: string): string {
  if (!userId) throw new Error("travellerObserverHandle: userId is required");
  if (!airportRef) throw new Error("travellerObserverHandle: airportRef is required");
  const mac = createHmac("sha256", observerPepper())
    .update(`${HANDLE_CONTEXT}|${canon(airportRef)}|${canon(userId)}`)
    .digest("hex");
  return `tv1-${mac.slice(0, 40)}`;
}

// ── reads ────────────────────────────────────────────────────────────────────

export type CorpusRead =
  | { ok: true; corpus: AirportObservation[] }
  | { ok: false; reason: "read_failed" };

interface ObservationRow {
  id: string;
  airport_ref: string;
  fact_type: string;
  value: number | string;
  observer_kind: string;
  observer_id: string;
  observer_trust: number | string | null;
  source_ref: string;
  observed_at: string;
}

function rowToObservation(r: ObservationRow): AirportObservation {
  const trust = r.observer_trust === null ? undefined : Number(r.observer_trust);
  return {
    observationId: r.id,
    airportRef: r.airport_ref,
    factType: r.fact_type as AirportFactType,
    // NUMERIC arrives from supabase-js as a string. Number() here rather than
    // in the reconciler, so the pure module keeps taking numbers; a value that
    // will not parse becomes NaN and `screenObservations` rejects it as
    // `not_finite` rather than being silently coerced to 0.
    value: Number(r.value),
    observerKind: r.observer_kind as AirportObservation["observerKind"],
    observerId: r.observer_id,
    ...(trust === undefined || !Number.isFinite(trust) ? {} : { observerTrust: trust }),
    observedAt: r.observed_at,
    sourceRef: r.source_ref,
  };
}

/**
 * Every observation of one fact at one airport that has not passed its stored
 * expiry, newest first. Served by 2860's `airport_fact_obs_lookup_idx`.
 *
 * The window is `expires_at > now`, which is the producer's own TTL claim, and
 * `screenObservations` applies the CLASS TTL on top — a row whose producer
 * claimed a longer life than its class allows is still aged out by the decay
 * curve. Both bounds, not either.
 *
 * A FAILED READ IS `ok: false`, NEVER AN EMPTY CORPUS. See the file header.
 */
export async function readObservationCorpus(
  db: SupabaseClient,
  airportRef: string,
  factType: AirportFactType,
  nowMs: number,
): Promise<CorpusRead> {
  const { data, error } = await db
    .from(OBSERVATION_TABLE)
    .select("id,airport_ref,fact_type,value,observer_kind,observer_id,observer_trust,source_ref,observed_at")
    .eq("airport_ref", airportRef)
    .eq("fact_type", factType)
    .gt("expires_at", new Date(nowMs).toISOString())
    .order("observed_at", { ascending: false })
    .limit(500);

  if (error) {
    logger.warn(
      { err: error.message, airportRef, factType },
      "observation corpus read failed — refusing rather than serving an empty corpus",
    );
    return { ok: false, reason: "read_failed" };
  }
  return { ok: true, corpus: (data ?? []).map((r) => rowToObservation(r as ObservationRow)) };
}

/**
 * The reconciled truth for one fact at one airport, or a refusal.
 *
 * This is the first CALLER `reconcile` has ever had — census-layover L181 has
 * scored it "W … a named service operation with no caller is W here" since it
 * was written.
 */
export type ReconcileRead =
  | { ok: true; outcome: ReconciliationOutcome }
  | { ok: false; reason: "read_failed" };

export async function reconcileAirportFact(
  db: SupabaseClient,
  airportRef: string,
  factType: AirportFactType,
  nowMs: number,
): Promise<ReconcileRead> {
  const read = await readObservationCorpus(db, airportRef, factType, nowMs);
  if (!read.ok) return read;
  return { ok: true, outcome: reconcile(read.corpus, { nowMs, factType, airportRef }) };
}

// ── the write ────────────────────────────────────────────────────────────────

export interface TravellerObservationInput {
  userId: string;
  airportRef: string;
  factType: AirportFactType;
  value: number;
  /** Client-supplied idempotency key. 8–128 chars (migration 2982's CHECK). */
  submissionToken: string;
}

export type SubmissionResult =
  /** Persisted, or already persisted under this token. */
  | { ok: true; outcome: ReconciliationOutcome; duplicate: boolean }
  /** Screened out before any write. `reason` is the screening verdict. */
  | { ok: false; kind: "rejected"; reason: ObservationRejection }
  /** The corpus could not be read, so the report could not be screened. */
  | { ok: false; kind: "unavailable" }
  /** The insert itself failed. */
  | { ok: false; kind: "write_failed"; message: string };

/**
 * Screen a traveller's report against the corpus it would join, and persist it
 * only if it survives.
 *
 * ── WHY SCREENING HAPPENS BEFORE THE WRITE AND NOT AFTER ─────────────────────
 * `screenObservations` enforces §23's rate limit by counting the candidate
 * against the accepted rows already in the bag. That is only true if the bag
 * is the STORED corpus — screening a single observation on its own can never
 * rate-limit anything, because one row is never more than three. So the corpus
 * is read first, the candidate is appended to it, and the whole set is screened
 * together; the candidate's own verdict is then read back by its id.
 *
 * The consequence worth stating: a report REJECTED here is never written. The
 * table holds screened observations only, which is what lets a reader treat a
 * row as evidence rather than as a claim someone made.
 *
 * ── AND WHY A FAILED CORPUS READ REFUSES THE WRITE ───────────────────────────
 * Writing without the corpus would mean writing WITHOUT the rate limit, since
 * the limit is a property of the corpus. An outage would become the one moment
 * the abuse control is off. `unavailable` is the honest answer, and it is
 * retryable.
 */
export async function submitTravellerObservation(
  db: SupabaseClient,
  input: TravellerObservationInput,
  nowMs: number,
): Promise<SubmissionResult> {
  const { airportRef, factType } = input;
  const factClass = factClassOf(factType);
  const observedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + FACT_CLASS_TTL_MIN[factClass] * 60_000).toISOString();
  const observerId = travellerObserverHandle(input.userId, airportRef);

  const read = await readObservationCorpus(db, airportRef, factType, nowMs);
  if (!read.ok) return { ok: false, kind: "unavailable" };

  // A local id for the candidate, used only to find its own verdict in the
  // screened output. The row's real id is assigned by the database.
  const candidateId = `candidate:${input.submissionToken}`;
  const candidate: AirportObservation = {
    observationId: candidateId,
    airportRef,
    factType,
    value: input.value,
    observerKind: "community",
    observerId,
    // observerTrust deliberately omitted: "Absent = the kind's floor, which is
    // the conservative reading — an unrated observer is not a trusted one."
    // There is no per-traveller standing score in this tree, and inventing one
    // would be exactly the fabricated certainty Appendix C1 forbids.
    observedAt,
    sourceRef: TRAVELLER_SOURCE_REF,
  };

  // Order matters: the candidate goes LAST so that the rate-limit counter has
  // already seen this observer's existing accepted rows when it reaches it.
  const screened = screenObservations([...read.corpus, candidate], {
    nowMs,
    factType,
    airportRef,
  });
  const verdict = screened.find((s) => s.observation.observationId === candidateId);
  if (!verdict) {
    // Unreachable: screenObservations drops only rows whose airportRef/factType
    // differ from opts, and the candidate is built from opts. Treated as a
    // refusal rather than an assertion so a future change to the pure module
    // cannot turn this into a silent accept.
    logger.error({ airportRef, factType }, "candidate observation vanished during screening");
    return { ok: false, kind: "unavailable" };
  }
  if (verdict.rejected !== null) {
    return { ok: false, kind: "rejected", reason: verdict.rejected };
  }

  const { data, error } = await db
    .from(OBSERVATION_TABLE)
    .insert({
      airport_ref: airportRef,
      fact_type: factType,
      fact_class: factClass,
      value: input.value,
      observer_kind: "community",
      observer_id: observerId,
      // NULL, not 0: "absent" and "rated zero" are different claims, and the
      // reconciler reads absent as the kind floor.
      observer_trust: null,
      source_ref: TRAVELLER_SOURCE_REF,
      observed_at: observedAt,
      expires_at: expiresAt,
      submission_token: input.submissionToken,
    })
    .select("id")
    .maybeSingle();

  // 23505 is a unique violation, which on this table can only be
  // airport_fact_obs_submission_token_uidx (migration 2982) — the retry case.
  // The report is already stored; reporting it as an error would push a client
  // into a retry loop against a write that has already succeeded.
  const duplicate = !!error && (error as { code?: string }).code === "23505";
  if (error && !duplicate) {
    logger.warn({ err: error.message, airportRef, factType }, "observation insert failed");
    return { ok: false, kind: "write_failed", message: error.message };
  }
  if (!duplicate && !data) {
    return { ok: false, kind: "write_failed", message: "insert returned no row" };
  }

  // Re-read so the caller sees the truth INCLUDING this report, which is what
  // makes the flow end-to-end: the traveller submits and is shown the reconciled
  // reading their report just moved (or failed to move, if it sits below the
  // corroboration floor — which is a real and honest outcome, not an error).
  const after = await reconcileAirportFact(db, airportRef, factType, nowMs);
  if (!after.ok) return { ok: false, kind: "unavailable" };
  return { ok: true, outcome: after.outcome, duplicate };
}

/** Re-exported so callers do not need a second import for the disclosure. */
export { OBSERVATION_RATE_LIMIT };
