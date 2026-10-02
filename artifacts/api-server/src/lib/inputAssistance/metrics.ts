/**
 * §57 Product Success Metrics — the computation, over the §44 serve log.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ANSWERS AND WHAT IT DOES NOT
 * ══════════════════════════════════════════════════════════════════════════════
 * `census-input-intelligence.md` §57 opens: "None of the nine is instrumented.
 * There is no metric emitter, no analytics transport (G306), and no store any of
 * these could be computed from." Two of those three are now false — the events
 * have call sites, and `POST /api/input-assistance/telemetry` plus migration
 * 2950 are the store. This file is the third: the definition of each metric, as
 * code, over the rows that store holds.
 *
 * It does NOT produce a production number. Migration 2950 is unapplied to
 * production and to portava-ci (`checkProductionDrift.ts:615`), so the table is
 * empty everywhere and `reportInputMetrics.ts` run today reports zero rows. A
 * definition that can be computed is not a measurement that has been taken, and
 * nothing here should be read as claiming otherwise.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * FOUR OF THE NINE ARE REFUSED, NOT ESTIMATED
 * ══════════════════════════════════════════════════════════════════════════════
 * The temptation in a metrics module is to produce a plausible number for every
 * line of the spec, because a dashboard with a hole in it looks unfinished. That
 * is how a metric that measures nothing ends up being trusted. Four of §57's
 * nine have NO PRODUCER in the taxonomy, and each is returned as an explicit
 * refusal naming what is missing rather than as a rate over an empty numerator:
 *
 *   - wrong-selection reversal (G368): no event records that a resolved field
 *     was later un-resolved. Adding one means a new name in
 *     INPUT_TELEMETRY_EVENT_NAMES *and* in migration 2950's
 *     `iate_event_name_known` CHECK, i.e. a follow-on migration.
 *   - downstream task completion (G370): `downstream_task_completed` has an
 *     exported emitter and no caller. The screens that complete a task —
 *     app/trip/new.tsx, app/events/create/index.tsx, app/telegraph/new.tsx —
 *     are the only places that can know, and none of them calls it.
 *   - offline completion (G373): nothing marks a serve as degraded. The hook
 *     sets `unavailable` state and emits no event for it.
 *   - privacy incident count (G371): this table is deliberately incapable of
 *     recording one. It stores no account id, so "an incident happened to
 *     someone" is not a fact it could hold. That metric is a production
 *     security/audit-log question and this module must not pretend otherwise.
 *
 * A rate of 0/0 reported as 0 would be a lie in all four cases, and a rate over
 * an event that no code emits is the worst kind: it looks green forever.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE EPISODE — why the three funnel rates share one construction
 * ══════════════════════════════════════════════════════════════════════════════
 * "Time to valid selection", "valid entity resolution rate" and "manual fallback
 * rate" are all statements about ONE INTERACTION with ONE FIELD, and the rows
 * are a flat event stream. An episode is the run of events for a given
 * (session_id, field_id) starting at an `input_opened` and ending at the next
 * `input_opened` for the same pair (or at the end of the stream). Building it
 * once means the three rates cannot disagree about what an interaction was,
 * which is the defect that makes funnel dashboards contradict each other.
 *
 * `session_id` is the per-app-run correlator the client mints
 * (`telemetryBatcher.ts#newTelemetrySessionId`) and the ingest stores. It is not
 * derived from and not resolvable to an account — see migration 2950's header.
 *
 * Pure module. No database, no clock, no I/O: it takes rows and returns numbers,
 * which is what lets `test/inputAssistanceMetrics.test.ts` assert exact values.
 */

/** One row as migration 2950 stores it, narrowed to what a metric reads. */
export interface MetricRow {
  session_id: string;
  event_name: string;
  context: string;
  field_id: string;
  /** ISO-8601, as `timestamptz` comes back over PostgREST. */
  occurred_at: string;
  props: Record<string, unknown>;
}

/**
 * A metric that was computed, or a metric that was REFUSED with the reason.
 * `value` is never a stand-in: a refused metric carries null and a blocker, and
 * a metric with no observations carries null and `n: 0`.
 */
export interface Metric {
  value: number | null;
  /** Observations the value is over. Zero means "no data", not "zero percent". */
  n: number;
  /** Present only when the metric CANNOT be computed from this table at all. */
  blocked?: string;
}

export interface LatencyMetric {
  p50: number | null;
  p95: number | null;
  n: number;
  blocked?: string;
}

/** The nine of §57, in the spec's own order. */
export interface InputSuccessMetrics {
  /** G365 — `input_opened` → first `suggestion_selected`, per episode. */
  timeToValidSelectionMs: LatencyMetric;
  /** G366 — entity-resolving selections over impressions. */
  validEntityResolutionRate: Metric;
  /** G367 — episodes that ended in the user's own text, over episodes that resolved either way. */
  manualFallbackRate: Metric;
  /** G368 — no producer. */
  wrongSelectionReversalRate: Metric;
  /** G369 — `disambiguation_selected` rows that resolved to an EXISTING entity. */
  duplicateCreationPrevented: Metric;
  /** G370 — no producer. */
  downstreamTaskCompletionRate: Metric;
  /** G371 — not answerable from this table by construction. */
  privacyIncidents: Metric;
  /** G372 — the serve's own cost and the device's round trip. */
  suggestLatencyServerMs: LatencyMetric;
  suggestLatencyClientMs: LatencyMetric;
  /** G373 — no producer. */
  offlineCompletionRate: Metric;
  /** Rows the computation actually read. */
  rowsRead: number;
}

/**
 * Suggestion types whose acceptance BINDS THE FIELD TO A CANONICAL ENTITY.
 *
 * `completion` and `action` are deliberately absent: a completion puts text in
 * the field and an action opens something else, and counting either as an
 * entity resolution is how a "resolution rate" stops meaning resolution.
 * `validation` and `ai_suggestion` are absent for the same reason.
 */
const ENTITY_RESOLVING: ReadonlySet<string> = new Set([
  'entity',
  'personalized',
  'recent',
  'structured_value',
  'disambiguation',
]);

const BLOCKED_REVERSAL =
  'no event records that a resolved field was later un-resolved; a reversal signal ' +
  'needs a new name in INPUT_TELEMETRY_EVENT_NAMES and in migration 2950\'s ' +
  'iate_event_name_known CHECK (census G368)';
const BLOCKED_DOWNSTREAM =
  'downstream_task_completed has an exported emitter and no caller; only the screens ' +
  'that complete a task (app/trip/new.tsx, app/events/create/index.tsx, ' +
  'app/telegraph/new.tsx) can emit it (census G320/G370)';
const BLOCKED_OFFLINE =
  'nothing marks a serve as degraded — useInputAssistance sets `unavailable` state and ' +
  'emits no event for it, so there is no offline denominator (census G373)';
const BLOCKED_PRIVACY =
  'this table stores no account id by construction (migration 2950), so it cannot hold ' +
  'the fact that an incident happened to anyone; the answer lives in production ' +
  'security/audit logs (census G371)';

/** Nearest-rank percentile over a numeric sample. Empty sample → null. */
export function percentile(sample: readonly number[], p: number): number | null {
  if (sample.length === 0) return null;
  const sorted = [...sample].sort((a, b) => a - b);
  // Nearest-rank: ceil(p/100 * N), 1-indexed, clamped. Chosen over interpolation
  // because a P95 latency should be a value the system ACTUALLY produced.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function latency(sample: readonly number[]): LatencyMetric {
  return { p50: percentile(sample, 50), p95: percentile(sample, 95), n: sample.length };
}

function rate(numerator: number, denominator: number): Metric {
  if (denominator === 0) return { value: null, n: 0 };
  return { value: numerator / denominator, n: denominator };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** One interaction with one field, in occurrence order. */
export interface Episode {
  sessionId: string;
  fieldId: string;
  context: string;
  events: MetricRow[];
}

/**
 * Split a flat row stream into episodes.
 *
 * Rows are sorted by `occurred_at` per (session, field) first — the stream
 * arrives in batches and a batch boundary is not an ordering guarantee. Events
 * that arrive before any `input_opened` for their pair are their own leading
 * episode rather than being dropped: a `suggestion_request_completed` with no
 * preceding open is still a latency observation, and silently discarding rows
 * is how a denominator quietly shrinks.
 */
export function toEpisodes(rows: readonly MetricRow[]): Episode[] {
  const byKey = new Map<string, MetricRow[]>();
  for (const r of rows) {
    const key = `${r.session_id}\u0000${r.field_id}`;
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  const episodes: Episode[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    let current: Episode | null = null;
    for (const r of list) {
      if (r.event_name === 'input_opened' || current === null) {
        current = {
          sessionId: r.session_id,
          fieldId: r.field_id,
          context: r.context,
          events: [],
        };
        episodes.push(current);
      }
      current.events.push(r);
    }
  }
  return episodes;
}

function first(ep: Episode, name: string): MetricRow | undefined {
  return ep.events.find((e) => e.event_name === name);
}

function has(ep: Episode, name: string): boolean {
  return ep.events.some((e) => e.event_name === name);
}

/**
 * Compute all nine §57 metrics.
 *
 * `contexts`, when given, restricts every metric to those InputContexts — a
 * fallback rate over "every field in the product" averages a recipient picker
 * with a trip title, and §57's numbers are only meaningful per surface.
 */
export function computeInputSuccessMetrics(
  rows: readonly MetricRow[],
  opts: { contexts?: readonly string[] } = {},
): InputSuccessMetrics {
  const allowed = opts.contexts ? new Set(opts.contexts) : null;
  const scoped = allowed ? rows.filter((r) => allowed.has(r.context)) : rows;
  const episodes = toEpisodes(scoped);

  // ── G365 time to valid selection ────────────────────────────────────────────
  const ttvs: number[] = [];
  for (const ep of episodes) {
    const opened = first(ep, 'input_opened');
    const selected = first(ep, 'suggestion_selected');
    if (!opened || !selected) continue;
    const ms = Date.parse(selected.occurred_at) - Date.parse(opened.occurred_at);
    // A negative delta is a clock that moved, not a selection before the open.
    if (Number.isFinite(ms) && ms >= 0) ttvs.push(ms);
  }

  // ── G366 valid entity resolution rate ───────────────────────────────────────
  // Denominator is IMPRESSIONS — the number of times a list was put in front of
  // the user — because that is the opportunity a resolution had. An impression
  // of an empty list is never emitted (SmartInput does not emit for count 0), so
  // the denominator cannot be inflated by lists nobody could choose from.
  let impressions = 0;
  let entityResolutions = 0;
  for (const r of scoped) {
    if (r.event_name === 'suggestion_rendered') impressions += 1;
    else if (
      r.event_name === 'suggestion_selected' &&
      typeof r.props.suggestionType === 'string' &&
      ENTITY_RESOLVING.has(r.props.suggestionType)
    ) {
      entityResolutions += 1;
    }
  }

  // ── G367 manual fallback rate ───────────────────────────────────────────────
  // Only over episodes where assistance was actually SHOWN. A field the user
  // typed into while the list was empty is not a "fallback" — there was nothing
  // to fall back from, and counting it would make the rate a function of how
  // often the backend returns nothing.
  let manualEpisodes = 0;
  let resolvedEpisodes = 0;
  for (const ep of episodes) {
    if (!has(ep, 'suggestion_rendered')) continue;
    const rawUnassisted = ep.events.some(
      (e) => e.event_name === 'raw_search_submitted' && e.props.viaSuggestion === false,
    );
    const manual = has(ep, 'manual_value_kept') || rawUnassisted;
    const assisted = has(ep, 'suggestion_selected');
    // An episode that did both (kept text, then came back and chose) counts as
    // assisted: the field ended resolved, which is the outcome §57 asks about.
    if (assisted) resolvedEpisodes += 1;
    else if (manual) manualEpisodes += 1;
  }

  // ── G369 duplicate creation prevented ───────────────────────────────────────
  const duplicatesPrevented = scoped.filter(
    (r) => r.event_name === 'disambiguation_selected' && r.props.resolvedExisting === true,
  ).length;

  // ── G372 suggest latency ────────────────────────────────────────────────────
  const serverMs: number[] = [];
  const clientMs: number[] = [];
  for (const r of scoped) {
    if (r.event_name !== 'suggestion_request_completed') continue;
    const s = num(r.props.serverMs);
    const c = num(r.props.clientMs);
    if (s !== null) serverMs.push(s);
    if (c !== null) clientMs.push(c);
  }

  return {
    timeToValidSelectionMs: latency(ttvs),
    validEntityResolutionRate: rate(entityResolutions, impressions),
    manualFallbackRate: rate(manualEpisodes, manualEpisodes + resolvedEpisodes),
    wrongSelectionReversalRate: { value: null, n: 0, blocked: BLOCKED_REVERSAL },
    // A COUNT, not a rate: §57 asks "duplicate creation prevented", and there is
    // no honest denominator (the duplicates the user never saw are unobservable).
    duplicateCreationPrevented: { value: duplicatesPrevented, n: duplicatesPrevented },
    downstreamTaskCompletionRate: { value: null, n: 0, blocked: BLOCKED_DOWNSTREAM },
    privacyIncidents: { value: null, n: 0, blocked: BLOCKED_PRIVACY },
    suggestLatencyServerMs: latency(serverMs),
    suggestLatencyClientMs: latency(clientMs),
    offlineCompletionRate: { value: null, n: 0, blocked: BLOCKED_OFFLINE },
    rowsRead: scoped.length,
  };
}
