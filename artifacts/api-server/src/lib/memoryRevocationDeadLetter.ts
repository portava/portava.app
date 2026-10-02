/**
 * §21's third word: DEAD-LETTERED.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §21 (:566), last sentence: "Deletion should be observable, retryable, and
 *        dead-lettered if a downstream cleanup repeatedly fails."
 *   §21, the sentence before it: "Revocation propagation must cover public
 *        projection, search index, semantic embedding, profile Highlight, Trip
 *        story derivative, Passport reference, cached narrative, and any share
 *        link."
 *   §24 (:612) failure class; privacy_revocation_latency.
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *        empty history without structured error state."
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MEASURED BEFORE THIS FILE WAS WRITTEN
 * ══════════════════════════════════════════════════════════════════════════════
 * Census H193 reads: "TWO OF THREE. §21 asks for deletion that is observable,
 * retryable, and dead-lettered. Observable and retryable now exist per step …
 * Dead-lettering does not: there is no table, `deadLetterDurable` is a hard
 * `false` on every report."
 *
 * HALF OF THAT IS STALE AND HALF IS NOT, and the difference is the whole
 * design of this module.
 *
 *   * "There is no table" IS FALSE at this commit. `public.highlight_revocation_log`
 *     (migration 2724) is APPLIED TO PRODUCTION — version 20260915054107 in
 *     src/lib/capability/production-applied-migrations.json, and its nine
 *     columns are in src/lib/capability/snapshots/20260922-production-schema.json.
 *     2724's own header names the dead-letter question and ships the partial
 *     index built for it: `highlight_revocation_failed_idx ON (destination,
 *     attempted_at DESC) WHERE status = 'failed'`.
 *   * "Nothing writes it" IS TRUE and was re-measured here: `grep -rn
 *     highlight_revocation_log src --include=*.ts` returned exactly ONE hit,
 *     in src/test/highlightsMemoriesDeployedStorage.test.ts, which asserts the
 *     table is deployed. `services/highlights/highlightRevocation.ts` builds a
 *     RevocationReport and returns it; nothing persists one. So the table that
 *     makes revocation observable has never had a row.
 *
 * This module is the writer and the sweep. It adds NO storage: everything below
 * runs against 2724 as deployed.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THE DEAD LETTER IS DERIVED AND NOT A COLUMN
 * ══════════════════════════════════════════════════════════════════════════════
 * 2724's `status` CHECK admits exactly `revoked`, `failed`, `not_applicable`
 * and `not_implemented`. There is no `dead_letter` value and adding one is a
 * migration — which, written here, would be a file nobody has applied, and this
 * census scores unapplied storage as NOT-BUILT (H24's precedent). So the dead
 * letter is COMPUTED from the log rather than stored in it, and that is not a
 * workaround: 2724 is INSERT-ONLY by design ("a retry produces a NEW row with a
 * new attempted_at; editing the old one in place would erase the evidence that
 * the first attempt failed, which is the evidence dead-lettering depends on").
 * A log that keeps every attempt already contains the answer to "has this
 * destination failed repeatedly?" — the only thing missing was somebody asking.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * FOUR STATES, AND WHY `not_implemented` IS NOT ONE OF THE FAILING ONES
 * ══════════════════════════════════════════════════════════════════════════════
 * A destination that EXISTS and that nothing reaches is not a transient
 * failure, and retrying it forever would bury the genuinely failing ones in
 * noise. 2724 already separates `not_implemented` from `failed` for exactly
 * this reason. So:
 *
 *   RESOLVED     the latest attempt is `revoked` — nothing to do.
 *   NOT_APPLICABLE  the latest attempt says the destination does not exist here.
 *   UNREACHABLE  the latest attempt is `not_implemented`. Counted and reported,
 *                NEVER retried and NEVER dead-lettered: a retry cannot build
 *                the missing code, and calling it a dead letter would say a
 *                cleanup failed when no cleanup was ever attempted.
 *   RETRY        `failed`, fewer than `ceiling` consecutive times.
 *   DEAD_LETTER  `failed` at least `ceiling` consecutive times. Escalated.
 *
 * "Consecutive" is counted back from the newest attempt and STOPS at the first
 * non-`failed` row, so a destination that failed four times in March and
 * succeeded in April is RESOLVED, not a dead letter. Counting every failed row
 * ever written is how a healed destination stays escalated forever.
 *
 * PURE / IMPURE SPLIT. `classifyRevocationBacklog` is pure over rows.
 * `readRevocationBacklog` and `recordRevocationAttempt` do the I/O and return
 * discriminated refusals, because supabase-js RESOLVES on a database error and
 * `const { data } = await …` with `.error` unbound would render an unreadable
 * log as "nothing has ever failed" — §28.11 in its most literal form.
 */

/** Migration 2724. Named once; every site below uses the string literal. */
export const REVOCATION_LOG_TABLE = "highlight_revocation_log";

/** 2724's `operation` CHECK, verbatim and in its order. */
export const REVOCATION_OPERATIONS = [
  "ARCHIVE",
  "DO_NOT_RESURFACE",
  "DO_NOT_PERSONALIZE",
  "MAKE_PRIVATE",
  "DELETE_HIGHLIGHT",
  "DELETE_MEDIA_ASSET",
] as const;
export type RevocationOperation = (typeof REVOCATION_OPERATIONS)[number];

/** 2724's `destination` CHECK — §21's eight destinations, verbatim and in order. */
export const REVOCATION_LOG_DESTINATIONS = [
  "public_projection",
  "search_index",
  "semantic_embedding",
  "profile_highlight",
  "trip_story_derivative",
  "passport_reference",
  "cached_narrative",
  "share_link",
] as const;
export type RevocationLogDestination = (typeof REVOCATION_LOG_DESTINATIONS)[number];

/** 2724's `status` CHECK. There is no `dead_letter` value; see the header. */
export const REVOCATION_LOG_STATUSES = ["revoked", "failed", "not_applicable", "not_implemented"] as const;
export type RevocationLogStatus = (typeof REVOCATION_LOG_STATUSES)[number];

export function isRevocationLogStatus(v: unknown): v is RevocationLogStatus {
  return typeof v === "string" && (REVOCATION_LOG_STATUSES as readonly string[]).includes(v);
}

/** One row of the log, as this module reads it. */
export interface RevocationLogRow {
  readonly attempt_id: string;
  readonly operation: string;
  readonly subject_id: string;
  readonly destination: string;
  readonly status: string;
  readonly detail: string | null;
  readonly attempted_at: string;
}

const LOG_COLUMNS = "attempt_id, operation, subject_id, destination, status, detail, attempted_at";

// ── the writer ───────────────────────────────────────────────────────────────

export interface RevocationAttempt {
  /** Groups the rows of ONE attempt so a report can be reassembled (2724). */
  readonly attemptId: string;
  readonly operation: RevocationOperation;
  /** The Highlight. 2724 deliberately has no FK to `highlights`. */
  readonly subjectId: string;
  /** Who performed it, or null for a sweep the server ran on its own. */
  readonly actorId: string | null;
  readonly outcomes: readonly {
    readonly destination: RevocationLogDestination;
    readonly status: RevocationLogStatus;
    readonly detail: string;
  }[];
}

export type RevocationWriteResult =
  | { ok: true; written: number }
  | { ok: false; reason: "log_unavailable" | "log_write_unconfirmed"; detail: string };

/**
 * Persist one revocation attempt: one row per destination.
 *
 * `.select()` IS BOUND, and that is not decoration. An INSERT that matched no
 * rows — an RLS refusal, which is what an end-user token gets against this
 * table by design — errors nothing and resolves cleanly, so without the select
 * this function would report a revocation record that was never written. That
 * is precisely the claim §21 asks to be observable.
 *
 * An EMPTY outcome list is refused rather than written as a successful
 * zero-row attempt: an attempt that reached no destination at all is a caller
 * bug, and recording it as a clean attempt would make the log say a revocation
 * completed when nothing was tried.
 */
export async function recordRevocationAttempt(
  sc: any,
  attempt: RevocationAttempt,
): Promise<RevocationWriteResult> {
  if (attempt.outcomes.length === 0) {
    return {
      ok: false,
      reason: "log_write_unconfirmed",
      detail: "an attempt with no destination outcomes is not a revocation record",
    };
  }

  const rows = attempt.outcomes.map((o) => ({
    attempt_id: attempt.attemptId,
    operation: attempt.operation,
    subject_id: attempt.subjectId,
    actor_id: attempt.actorId,
    destination: o.destination,
    status: o.status,
    // 2724 defaults `detail` to '' and declares it NOT NULL. An undefined here
    // would be sent as SQL NULL by PostgREST and violate the constraint, so the
    // empty string is written explicitly rather than left to a default.
    detail: o.detail ?? "",
  }));

  const { data, error } = await sc
    .from("highlight_revocation_log")
    .insert(rows)
    .select("id");

  if (error) {
    return { ok: false, reason: "log_unavailable", detail: error.message ?? String(error) };
  }
  const written = Array.isArray(data) ? data.length : 0;
  if (written !== rows.length) {
    return {
      ok: false,
      reason: "log_write_unconfirmed",
      detail: `wrote ${written} of ${rows.length} destination rows`,
    };
  }
  return { ok: true, written };
}

// ── the reader ───────────────────────────────────────────────────────────────

export type RevocationReadResult =
  | { ok: true; rows: RevocationLogRow[] }
  | { ok: false; reason: "log_unavailable"; detail: string };

/**
 * Read the log for the subjects that have ever had a non-`revoked` outcome.
 *
 * Reads NEWEST FIRST and bounded, because the classifier only ever needs the
 * tail of each group: "consecutive failures counted back from the newest
 * attempt" cannot be changed by a row older than the last success. The bound is
 * therefore a real limit and is reported, never silently applied — a truncated
 * read is `truncated: true` at the call site below rather than a smaller
 * backlog that looks like progress.
 */
export async function readRevocationBacklog(
  sc: any,
  opts: { limit?: number } = {},
): Promise<RevocationReadResult> {
  const { data, error } = await sc
    .from("highlight_revocation_log")
    .select(LOG_COLUMNS)
    .order("attempted_at", { ascending: false })
    .limit(opts.limit ?? 1000);

  if (error) {
    return { ok: false, reason: "log_unavailable", detail: error.message ?? String(error) };
  }
  if (!Array.isArray(data)) {
    // Neither an error nor rows. NOT "nothing has failed" — a non-array body
    // means the shape changed under us (§28.11).
    return { ok: false, reason: "log_unavailable", detail: "revocation log read returned a non-array body" };
  }
  return { ok: true, rows: data as RevocationLogRow[] };
}

// ── the classifier ───────────────────────────────────────────────────────────

export type BacklogState = "RESOLVED" | "NOT_APPLICABLE" | "UNREACHABLE" | "RETRY" | "DEAD_LETTER";

export interface BacklogEntry {
  readonly operation: string;
  readonly subjectId: string;
  readonly destination: string;
  readonly state: BacklogState;
  /** Consecutive `failed` attempts counted back from the newest. */
  readonly consecutiveFailures: number;
  readonly latestStatus: string;
  readonly latestAttemptAt: string;
  readonly latestDetail: string;
}

export interface BacklogClassification {
  readonly entries: readonly BacklogEntry[];
  readonly retry: readonly BacklogEntry[];
  readonly deadLettered: readonly BacklogEntry[];
  readonly unreachable: readonly BacklogEntry[];
}

/** How many consecutive failures make a destination a dead letter. */
export const DEFAULT_DEAD_LETTER_CEILING = 5;

/**
 * Group the log by (operation, subject, destination) and say what each group is.
 *
 * PURE. The caller supplies the rows and the ceiling, so the same classification
 * runs in a test, in the sweep, and in an operator script without any of them
 * reading a clock or a database.
 *
 * A row whose `status` is not one of 2724's four is counted as UNREACHABLE with
 * its raw status preserved, NOT dropped: a value the CHECK constraint should
 * have refused is evidence of something wrong, and discarding it would make the
 * classifier quieter than the database.
 */
export function classifyRevocationBacklog(
  rows: readonly RevocationLogRow[],
  opts: { ceiling?: number } = {},
): BacklogClassification {
  const ceiling = opts.ceiling ?? DEFAULT_DEAD_LETTER_CEILING;
  const groups = new Map<string, RevocationLogRow[]>();

  for (const r of rows) {
    const key = `${r.operation}\u0000${r.subject_id}\u0000${r.destination}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const entries: BacklogEntry[] = [];
  for (const list of groups.values()) {
    // Newest first. `attempted_at` is enough HERE and is not enough in general:
    // two attempts inside one transaction share `now()`. The tiebreak on
    // attempt_id keeps the ordering TOTAL and deterministic so the same rows
    // always classify the same way, which is what makes this replayable.
    const ordered = [...list].sort(
      (a, b) => b.attempted_at.localeCompare(a.attempted_at) || b.attempt_id.localeCompare(a.attempt_id),
    );
    const latest = ordered[0]!;

    let consecutiveFailures = 0;
    for (const r of ordered) {
      if (r.status === "failed") consecutiveFailures += 1;
      else break;
    }

    const state: BacklogState =
      latest.status === "revoked"
        ? "RESOLVED"
        : latest.status === "not_applicable"
          ? "NOT_APPLICABLE"
          : latest.status === "failed"
            ? (consecutiveFailures >= ceiling ? "DEAD_LETTER" : "RETRY")
            : "UNREACHABLE";

    entries.push({
      operation: latest.operation,
      subjectId: latest.subject_id,
      destination: latest.destination,
      state,
      consecutiveFailures,
      latestStatus: latest.status,
      latestAttemptAt: latest.attempted_at,
      latestDetail: latest.detail ?? "",
    });
  }

  // Deterministic order so two runs over the same log report the same list.
  entries.sort(
    (a, b) =>
      a.subjectId.localeCompare(b.subjectId) ||
      a.operation.localeCompare(b.operation) ||
      a.destination.localeCompare(b.destination),
  );

  return {
    entries,
    retry: entries.filter((e) => e.state === "RETRY"),
    deadLettered: entries.filter((e) => e.state === "DEAD_LETTER"),
    unreachable: entries.filter((e) => e.state === "UNREACHABLE"),
  };
}

// ── the sweep ────────────────────────────────────────────────────────────────

export interface RevocationSweepResult {
  readonly ok: boolean;
  /** A class when the PASS failed, as distinct from an individual destination. */
  readonly failureClass: string | null;
  readonly detail: string | null;
  readonly inspected: number;
  readonly retried: number;
  readonly retrySucceeded: number;
  readonly retryFailed: number;
  readonly deadLettered: number;
  readonly unreachable: number;
  /** True when the read hit its bound, so the numbers are a floor, not a total. */
  readonly truncated: boolean;
  readonly deadLetters: readonly BacklogEntry[];
}

export interface RevocationRetryDeps {
  /**
   * Re-attempt ONE destination for one subject. Injected rather than imported:
   * the destinations live in services/highlights/, this module must not depend
   * on that surface to be testable, and a sweep that cannot be driven without a
   * network is a sweep nobody exercises.
   *
   * Returns the new outcome, which is written to the log as a NEW attempt —
   * 2724 is insert-only and the previous failure stays on the record.
   */
  readonly retryDestination?: (entry: BacklogEntry) => Promise<{
    status: RevocationLogStatus;
    detail: string;
  }>;
  /** Supplies the attempt_id for each retry. Injected so a test is deterministic. */
  readonly newAttemptId?: () => string;
  readonly log?: { info?: (o: unknown, m: string) => void; warn?: (o: unknown, m: string) => void };
}

/**
 * One sweep: read the log, classify it, retry what is retryable, escalate what
 * is not.
 *
 * AN UNREADABLE LOG IS NEVER AN EMPTY BACKLOG. The pass returns `ok: false`
 * with a failure class rather than zeros, for the reason the header gives: a
 * sweep that reported "nothing has failed" every time the table was
 * unreachable would be indistinguishable from a healthy system.
 *
 * A DEAD LETTER IS REPORTED, NOT RETRIED AND NOT DELETED. §21 asks for
 * escalation, and escalation is somebody being told. The entries are returned
 * and logged with their destination, subject and failure count; nothing here
 * decides what an operator does about them, because that is a decision and not
 * a sweep.
 */
export async function sweepRevocationDeadLetters(
  sc: any,
  deps: RevocationRetryDeps = {},
  opts: { ceiling?: number; limit?: number } = {},
): Promise<RevocationSweepResult> {
  const limit = opts.limit ?? 1000;
  const empty: RevocationSweepResult = {
    ok: true, failureClass: null, detail: null,
    inspected: 0, retried: 0, retrySucceeded: 0, retryFailed: 0,
    deadLettered: 0, unreachable: 0, truncated: false, deadLetters: [],
  };

  const read = await readRevocationBacklog(sc, { limit });
  if (!read.ok) {
    return { ...empty, ok: false, failureClass: read.reason, detail: read.detail };
  }
  if (read.rows.length === 0) return empty;

  const truncated = read.rows.length >= limit;
  const classified = classifyRevocationBacklog(read.rows, { ceiling: opts.ceiling });

  let retried = 0;
  let retrySucceeded = 0;
  let retryFailed = 0;

  if (typeof deps.retryDestination === "function") {
    for (const entry of classified.retry) {
      retried += 1;
      let outcome: { status: RevocationLogStatus; detail: string };
      try {
        outcome = await deps.retryDestination(entry);
      } catch (err) {
        // Our own injected code threw. Recorded as a failed attempt, which is
        // what it is, rather than dropped — the failure count is the dead-letter
        // signal and losing one makes escalation late.
        outcome = { status: "failed", detail: `retry threw: ${String((err as any)?.message ?? err)}` };
      }

      const write = await recordRevocationAttempt(sc, {
        attemptId: deps.newAttemptId ? deps.newAttemptId() : cryptoRandomId(),
        operation: entry.operation as RevocationOperation,
        subjectId: entry.subjectId,
        // A sweep is the server acting on its own; there is no human actor and
        // inventing one would put a false name on an audit row.
        actorId: null,
        outcomes: [{
          destination: entry.destination as RevocationLogDestination,
          status: outcome.status,
          detail: outcome.detail,
        }],
      });

      if (!write.ok) {
        // The retry may well have reached the destination; what failed is the
        // RECORD of it. Counted as failed, because an unrecorded revocation is
        // not an observable one and §21 asks for observable.
        retryFailed += 1;
        deps.log?.warn?.(
          { subjectId: entry.subjectId, destination: entry.destination, reason: write.reason, detail: write.detail },
          "revocation sweep: retry outcome could not be recorded",
        );
        continue;
      }
      if (outcome.status === "revoked") retrySucceeded += 1;
      else retryFailed += 1;
    }
  }

  if (classified.deadLettered.length > 0) {
    deps.log?.warn?.(
      {
        count: classified.deadLettered.length,
        ceiling: opts.ceiling ?? DEFAULT_DEAD_LETTER_CEILING,
        entries: classified.deadLettered.map((e) => ({
          subjectId: e.subjectId, operation: e.operation,
          destination: e.destination, failures: e.consecutiveFailures,
        })),
      },
      "revocation dead letter: a §21 destination has failed repeatedly and is escalated",
    );
  }

  return {
    ok: true,
    failureClass: null,
    detail: null,
    inspected: classified.entries.length,
    retried,
    retrySucceeded,
    retryFailed,
    deadLettered: classified.deadLettered.length,
    unreachable: classified.unreachable.length,
    truncated,
    deadLetters: classified.deadLettered,
  };
}

/** Local so this module has no import that a pure test has to stub. */
function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
