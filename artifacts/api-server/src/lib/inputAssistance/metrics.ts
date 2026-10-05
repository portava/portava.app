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
 * It does NOT produce a production number. Migration 2950 IS applied in hosted
 * (object-probed 2026-09-21 and 2026-10-03, census §31/§35) and the table held
 * ZERO rows both times, so `reportInputMetrics.ts` run today reports zero rows. A
 * definition that can be computed is not a measurement that has been taken, and
 * nothing here should be read as claiming otherwise.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * A METRIC WITH NO PRODUCER IS REFUSED, NOT ESTIMATED (three were; one still is)
 * ══════════════════════════════════════════════════════════════════════════════
 * The temptation in a metrics module is to produce a plausible number for every
 * line of the spec, because a dashboard with a hole in it looks unfinished. That
 * is how a metric that measures nothing ends up being trusted. Three of §57's
 * nine HAD NO PRODUCER in the taxonomy and were returned as explicit refusals
 * naming what was missing, rather than as a rate over an empty numerator. Two
 * now have producers; the refusal that remains is the one that must:
 *
 *   - wrong-selection reversal (G368) WAS refused here: no event recorded that
 *     a resolved field was later un-resolved. It is now computed below, over
 *     `selection_reversed` (the fifteenth §44 name; migration 3781 widens 2950's
 *     `iate_event_name_known` CHECK to admit it). Until 3781 is applied to a
 *     database, an insert carrying that name fails there — the number is
 *     computable from the tree and measurable nowhere yet.
 *   - downstream task completion (G370) WAS refused: `downstream_task_completed`
 *     had an emitter and no caller. It now has one (the §24 paste-to-Trip
 *     write) and a consent gate (OD-INPUT-1): the ingest admits the event only
 *     for a caller who opted in to outcome learning. So it is computed below,
 *     and its POPULATION IS CONSENTING USERS ONLY — a rate over the people who
 *     opted in, which is the honest scope of an opt-in measurement and must be
 *     reported as such, never as "all users". The screens that complete most
 *     tasks (app/trip/new.tsx, app/events/create, the Telegraph composer) still
 *     do not call it; they are other lanes' files.
 *   - privacy incident count (G371): this table is deliberately incapable of
 *     recording one. It stores no account id, so "an incident happened to
 *     someone" is not a fact it could hold. That metric is a production
 *     security/audit-log question and this module must not pretend otherwise.
 *
 * (A fourth, offline completion (G373), was refused here until the ingest
 * admitted the client's `degraded` flag; it is computed below, over episodes
 * that were served degraded, and a degraded row is kept out of G372's latency
 * — a round trip that never reached the network is not a serve's latency.)
 *
 * A rate of 0/0 reported as 0 would be a lie in every case, and a rate over an
 * event that no code emits is the worst kind: it looks green forever. So an
 * empty denominator is `value: null, n: 0` — no blocker, and no zero.
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
  /** G368 — entity-resolving selections later edited away from, over entity-resolving selections. */
  wrongSelectionReversalRate: Metric;
  /** G369 — `disambiguation_selected` rows that resolved to an EXISTING entity. */
  duplicateCreationPrevented: Metric;
  /** G370 — successful downstream tasks over reported downstream tasks (consenting users only). */
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

  // ── G368 wrong-selection reversal rate ──────────────────────────────────────
  // PER SELECTION, over each (session, field) stream — NOT per episode. A user
  // who picks "Paris", leaves the field, comes back and edits it has started a
  // new episode (a new `input_opened`), and an episode-scoped count would file
  // that reversal under an episode with no selection in it and lose it. So each
  // entity-resolving `suggestion_selected` opens a pending resolution; the next
  // `selection_reversed` on the same stream reverses it; the next
  // `suggestion_selected` closes it as kept. A reversal with nothing pending —
  // the selection fell outside the window, or was not entity-resolving — is
  // counted nowhere: it cannot be attributed to a selection in this sample.
  let resolvingSelections = 0;
  let reversedSelections = 0;
  const streams = new Map<string, MetricRow[]>();
  for (const ep of episodes) {
    const key = `${ep.sessionId}\u0000${ep.fieldId}`;
    const list = streams.get(key);
    if (list) list.push(...ep.events);
    else streams.set(key, [...ep.events]);
  }
  for (const stream of streams.values()) {
    let pending = false;
    for (const e of stream) {
      if (e.event_name === 'suggestion_selected') {
        const t = e.props.suggestionType;
        pending = typeof t === 'string' && ENTITY_RESOLVING.has(t);
        if (pending) resolvingSelections += 1;
      } else if (e.event_name === 'selection_reversed' && pending) {
        reversedSelections += 1;
        pending = false;
      }
    }
  }

  // ── G369 duplicate creation prevented ───────────────────────────────────────
  const duplicatesPrevented = scoped.filter(
    (r) => r.event_name === 'disambiguation_selected' && r.props.resolvedExisting === true,
  ).length;

  // ── G373 offline completion rate ────────────────────────────────────────────
  // Over episodes in which the field was served DEGRADED — the gateway was
  // unavailable and the device's own tier answered (`degraded: true`, a literal
  // bool; the ingest admits nothing else). Completed = a `suggestion_selected`
  // AFTER the first degraded serve in the same episode: a pick made before the
  // outage began did not complete anything offline. The population is what the
  // log can see — an app run that ends offline sends nothing (census §33.4).
  let degradedEpisodes = 0;
  let completedDegraded = 0;
  for (const ep of episodes) {
    const firstDegraded = ep.events.findIndex(
      (e) => e.event_name === 'suggestion_request_completed' && e.props.degraded === true,
    );
    if (firstDegraded < 0) continue;
    degradedEpisodes += 1;
    if (ep.events.slice(firstDegraded + 1).some((e) => e.event_name === 'suggestion_selected')) completedDegraded += 1;
  }

  // ── G370 downstream task completion ─────────────────────────────────────────
  // Of the tasks a suggestion-served field reported, how many SUCCEEDED. Only a
  // literal bool counts either way — the ingest admits nothing else, and a row
  // without one is not a report of anything. The population is consenting users
  // (the ingest refuses the event for anyone else), so this is an opt-in rate.
  let tasksReported = 0;
  let tasksSucceeded = 0;
  for (const r of scoped) {
    if (r.event_name !== 'downstream_task_completed') continue;
    if (r.props.ok === true) {
      tasksReported += 1;
      tasksSucceeded += 1;
    } else if (r.props.ok === false) {
      tasksReported += 1;
    }
  }

  // ── G372 suggest latency ────────────────────────────────────────────────────
  const serverMs: number[] = [];
  const clientMs: number[] = [];
  for (const r of scoped) {
    if (r.event_name !== 'suggestion_request_completed') continue;
    // A degraded serve never touched the network it would be timing (§33.3).
    if (r.props.degraded === true) continue;
    const s = num(r.props.serverMs);
    const c = num(r.props.clientMs);
    if (s !== null) serverMs.push(s);
    if (c !== null) clientMs.push(c);
  }

  return {
    timeToValidSelectionMs: latency(ttvs),
    validEntityResolutionRate: rate(entityResolutions, impressions),
    manualFallbackRate: rate(manualEpisodes, manualEpisodes + resolvedEpisodes),
    wrongSelectionReversalRate: rate(reversedSelections, resolvingSelections),
    // A COUNT, not a rate: §57 asks "duplicate creation prevented", and there is
    // no honest denominator (the duplicates the user never saw are unobservable).
    duplicateCreationPrevented: { value: duplicatesPrevented, n: duplicatesPrevented },
    downstreamTaskCompletionRate: rate(tasksSucceeded, tasksReported),
    privacyIncidents: { value: null, n: 0, blocked: BLOCKED_PRIVACY },
    suggestLatencyServerMs: latency(serverMs),
    suggestLatencyClientMs: latency(clientMs),
    offlineCompletionRate: rate(completedDegraded, degradedEpisodes),
    rowsRead: scoped.length,
  };
}
