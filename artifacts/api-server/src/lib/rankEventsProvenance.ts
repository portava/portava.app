/**
 * rankEventsProvenance — the two things every `rank_events` writer needs and
 * none of them had: a shared definition of the 2891 exposure token, and a way
 * for a REFUSED write to be counted rather than only mentioned.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ────────────────────────────────────────────
 * `2893_rank_events_retire_writerless_surfaces.sql`'s header records the fact
 * this file is built around, and census-discovery §41.1 repeats it:
 *
 *   EVERY `rank_events` writer in this codebase is FIRE-AND-FORGET.
 *
 * `routes/rankEvents.ts` answers a rejected insert with `200 {ok:true}` and a
 * `warn`. `lib/discoveryServeLog.ts` warns and returns. `lib/rankLog.ts` warns.
 * `routes/mediaFeed.ts` warns. That is a deliberate and correct choice — a
 * missed impression must not break a feed response — and it has one consequence
 * that is not a choice: **a constraint that starts refusing every row of a
 * surface looks exactly like a surface nobody uses.** That is not hypothetical
 * here. `0202_rank_events_live_page_watch_feed_surfaces.sql` was written because
 * `living_page` and `watch_feed` impressions had been refused by the surface
 * CHECK for an unknown period with the loss visible nowhere, and migration 2894
 * is in that state RIGHT NOW: it admits `trip_add` to the outcome CHECK, it is
 * unapplied on every database, and `travel-buddy-standalone/src/components/
 * PlanPickerController.tsx` posts that outcome today. Every one of those posts
 * is refused, and silently.
 *
 * A `warn` is not nothing, but it is not a measurement either. Nobody greps a
 * log for the absence of a line. So this module keeps a small in-process
 * COUNTER keyed by the constraint that did the refusing, and emits ONE warn
 * shape that names that constraint — so "23514 on rank_events_outcome_check,
 * 412 times, writer routes/rankEvents.ts" is a sentence somebody can be told
 * instead of one they would have to reconstruct.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────────
 * It does NOT throw, retry, or change any response. `reportRankEventsRejection`
 * returns `void` and cannot reject; a caller that awaited it and branched on the
 * result would be converting fire-and-forget into a blocking write, which is the
 * change this module exists to make UNNECESSARY. The hazard being closed is
 * invisibility, not tolerance.
 *
 * It also keeps NO row data. The counter holds a writer name, a constraint name,
 * an error code and a count. `rank_events` rows carry `user_id` and `item_id`,
 * and a telemetry ring that held them would be a second copy of behavioural data
 * outside `04` §11's retention tiers.
 *
 * ── AND THE TOKEN ────────────────────────────────────────────────────────────
 * `2891_rank_events_recommendation_id.sql` added `recommendation_id` (nullable,
 * CHECK `^[A-Za-z0-9_-]{22}$`) and the UNIQUE index `(recommendation_id,
 * outcome)`. Two writers now name that column and that arbiter — the outcome
 * route and the serve log — and before this module each carried its own copy of
 * the shape regex, the arbiter string and the "is this database missing 2891?"
 * predicate. Three constants that MUST agree with a migration, duplicated per
 * writer, is how one writer silently stops agreeing.
 *
 * The schema latch is shared for the same reason: both writers talk to ONE
 * database, so "2891 is not here" is one fact about the process, not two. The
 * WARNING is still emitted once per writer, because a reader needs to know which
 * path degraded, and a single process-wide line would credit the first caller
 * and hide the second.
 */

/** `rank_events.recommendation_id`'s shape CHECK, mirrored from migration 2891. */
export const RECOMMENDATION_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The conflict arbiter. BOTH columns, in index order.
 *
 * `recommendation_id` alone raises 42P10 against 2891's index — the migration's
 * own COMMENT says so, and says why the index is keyed on the outcome: an
 * exposure and each of its outcomes are separate rows sharing one token, so a
 * single-column unique key would silently reject every tap and save.
 */
export const RECOMMENDATION_ARBITER = "recommendation_id,outcome";

/** The migration a `recommendation_id` failure points at. Named in every warn. */
export const RECOMMENDATION_ID_MIGRATION = "2891_rank_events_recommendation_id.sql";

// ── Is this database missing 2891? ───────────────────────────────────────────

/**
 * Does this PostgREST/Postgres error mean "migration 2891 is not applied here"?
 *
 * Three codes, each of which a writer naming `recommendation_id` can only
 * produce for that one reason:
 *   42703    undefined_column — a SELECT list, a filter or a payload named it;
 *   PGRST204 PostgREST's schema cache has no such column for a write;
 *   42P10    the column exists but the unique index that arbitrates it does not.
 *
 * Anything else — a timeout, an RLS denial, a CHECK violation — is NOT this and
 * must keep whatever treatment it had. A predicate that absorbed those would
 * turn a real outage into a permanent quiet degradation, which is the defect
 * class one layer out from the one this file addresses.
 */
export function isMissingRecommendationIdSchema(err: unknown): boolean {
  const e    = err as { code?: unknown; message?: unknown } | null | undefined;
  const code = String(e?.code ?? "");
  if (code === "42703" || code === "PGRST204" || code === "42P10") return true;
  const msg = String(e?.message ?? "").toLowerCase();
  if (msg.includes("on conflict specification")) return true;
  if (!msg.includes("recommendation_id")) return false;
  return msg.includes("does not exist")
      || msg.includes("could not find")
      || msg.includes("schema cache");
}

/** Where the process currently believes 2891 stands. `unknown` = not disproved. */
let _recommendationIdColumn: "unknown" | "absent" = "unknown";

/** Writers that have already said out loud that 2891 is missing. */
let _announced = new Set<string>();

/** Has a writer established that `recommendation_id` is unavailable here? */
export function recommendationIdSchemaAbsent(): boolean {
  return _recommendationIdColumn === "absent";
}

/**
 * Record that 2891 is not applied on this database.
 *
 * Returns `true` when THIS writer has not said so before, so the caller emits
 * exactly one line per writer per process rather than one per request.
 */
export function noteRecommendationIdAbsent(writer: string): boolean {
  _recommendationIdColumn = "absent";
  if (_announced.has(writer)) return false;
  _announced.add(writer);
  return true;
}

/**
 * Test seam. The latch is process-wide, so a suite that simulates a 2891-less
 * database would otherwise poison every suite that runs after it.
 */
export function _resetRecommendationIdSchemaLatch(): void {
  _recommendationIdColumn = "unknown";
  _announced = new Set<string>();
}

// ── The constraint that did the refusing ─────────────────────────────────────

/**
 * Postgres names the constraint in the message of every integrity violation:
 *
 *   new row for relation "rank_events" violates check constraint "rank_events_outcome_check"
 *   duplicate key value violates unique constraint "rank_events_pkey"
 *   insert or update on table "rank_events" violates foreign key constraint "..."
 *
 * PostgREST passes that message through verbatim and additionally puts the name
 * in `details` for some builds, so both are read. Returning the NAME rather than
 * the whole message is the point: a name is a stable key a counter can group by
 * and a reader can grep a migration for, while the message carries the offending
 * row's values and must not be counted (or, below, logged) as an identity.
 *
 * Pure and total. `null` means "this error did not name a constraint" — a
 * timeout, a network failure, an RLS denial — which is a real and different
 * state from "refused by a constraint" and is kept distinguishable.
 */
export function constraintNameFrom(err: unknown): string | null {
  const e = err as { message?: unknown; details?: unknown; constraint?: unknown } | null | undefined;
  const direct = e?.constraint;
  if (typeof direct === "string" && direct.length > 0) return direct;
  for (const field of [e?.message, e?.details]) {
    if (typeof field !== "string") continue;
    const m = /constraint "([^"]+)"/.exec(field);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ── The counter ──────────────────────────────────────────────────────────────

/** One refusal class: a writer, and what refused it. */
export interface RankEventsRejection {
  /** The module or route that attempted the write, e.g. `routes/rankEvents.ts`. */
  writer:     string;
  /** The constraint that refused it, or `null` when the error named none. */
  constraint: string | null;
  /** The SQLSTATE / PostgREST code, or `""` when the error carried none. */
  code:       string;
  /** Attempts refused this way since process start (or the last reset). */
  count:      number;
  /** Rows lost across those attempts, when the caller knew how many. */
  rows:       number;
}

const _rejections = new Map<string, RankEventsRejection>();

function keyOf(writer: string, constraint: string | null, code: string): string {
  return `${writer} ${constraint ?? ""} ${code}`;
}

/**
 * Count one refused `rank_events` write. Never throws — an instrument that can
 * break the thing it instruments is worse than no instrument.
 */
export function recordRankEventsRejection(a: {
  writer: string;
  err:    unknown;
  /** Rows the refused statement would have written. Defaults to 1. */
  rows?:  number;
}): RankEventsRejection {
  const e          = a.err as { code?: unknown } | null | undefined;
  const code       = String(e?.code ?? "");
  const constraint = constraintNameFrom(a.err);
  const rows       = Number.isFinite(a.rows) ? Math.max(0, Math.trunc(a.rows as number)) : 1;
  const key        = keyOf(a.writer, constraint, code);
  const existing   = _rejections.get(key);
  if (existing) {
    existing.count += 1;
    existing.rows  += rows;
    return existing;
  }
  const fresh: RankEventsRejection = { writer: a.writer, constraint, code, count: 1, rows };
  _rejections.set(key, fresh);
  return fresh;
}

/** Every refusal class seen so far, newest class last. Copies, not the store. */
export function rankEventsRejectionSnapshot(): readonly RankEventsRejection[] {
  return [..._rejections.values()].map((r) => ({ ...r }));
}

/** Rows lost to refused writes since process start. The one number to alert on. */
export function rankEventsRejectedRows(): number {
  let total = 0;
  for (const r of _rejections.values()) total += r.rows;
  return total;
}

/** Test seam — the counter is process-wide. */
export function _resetRankEventsRejections(): void {
  _rejections.clear();
}

// ── The warn shape ───────────────────────────────────────────────────────────

/**
 * The ONE message a refused `rank_events` write produces.
 *
 * A fixed prefix, because the whole point is that this line is findable: the
 * existing warns say "insert rejected", "direct insert failed (non-fatal)" and
 * "analytics insert failed (non-fatal)" — three spellings of one event, none of
 * which a log query would find from the other two.
 */
export const RANK_EVENTS_REJECTED_MSG =
  "rank_events REFUSED: a fire-and-forget write was rejected and the signal is lost";

/** The logger shape these helpers accept. `req.log` is absent in unit tests. */
export interface RejectionLog {
  warn?: (ctx: unknown, msg?: string) => void;
}

/**
 * Count a refused write AND say so, once per call, in the one findable shape.
 *
 * Returns the updated class so a caller can assert on it. Never throws and never
 * awaits: this is called from paths whose contract is that they do not block a
 * response, and it must not quietly become one.
 *
 * The context deliberately carries NO row: `writer`, `constraint`, `code`,
 * `rows` and the running totals, and nothing that identifies a user or an item.
 */
export function reportRankEventsRejection(
  log: RejectionLog | undefined,
  a: { writer: string; err: unknown; rows?: number; extra?: Record<string, unknown> },
): RankEventsRejection {
  let rejection: RankEventsRejection = {
    writer: a.writer, constraint: null, code: "", count: 0, rows: 0,
  };
  try {
    rejection = recordRankEventsRejection({ writer: a.writer, err: a.err, rows: a.rows });
    const emit = log?.warn ?? console.warn;
    emit.call(log ?? console, {
      err:            a.err,
      writer:         rejection.writer,
      // `null` is written out rather than omitted: an absent key would read as
      // "not looked for", and "this error named no constraint" is a finding.
      constraint:     rejection.constraint,
      code:           rejection.code,
      rowsLost:       a.rows ?? 1,
      rejectedCount:  rejection.count,
      rejectedRows:   rejection.rows,
      ...(a.extra ?? {}),
    }, RANK_EVENTS_REJECTED_MSG);
  } catch {
    /* an instrument must never break the thing it instruments */
  }
  return rejection;
}
