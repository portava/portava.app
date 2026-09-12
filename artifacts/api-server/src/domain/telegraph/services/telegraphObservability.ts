/**
 * Telegraph observability — the SLO registry and the recorder.
 *
 * Two things live here and they are deliberately in one file: the DECLARATIONS
 * (what must be measured, against what target) and the RECORDER (what is
 * actually counted). Splitting them is how a target ends up with no emitter and
 * an emitter ends up with no target, which is exactly the state the census
 * found — "Sentry is wired app-wide but there is no Telegraph SLO, dashboard or
 * alert."
 *
 * PRIVACY IS A PROPERTY OF THIS MODULE, NOT A CONVENTION
 * -----------------------------------------------------
 * §30A.17: "Do not indiscriminately copy private message text into analytics."
 * The recorder's signature makes that structural rather than aspirational: it
 * takes a metric key and an outcome, and there is NO parameter that can carry a
 * message body, a display name, a handle or a location. The only free-form value
 * it accepts is a latency in milliseconds. A caller who wanted to log a body
 * would have to change this type first, which is a reviewable act.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a telemetry sink. The counters are in-process, per-instance, and reset on
 * restart. They make a regression VISIBLE to an operator who looks; they do not
 * page anyone and they do not survive a deploy. Saying so here rather than
 * letting a reader infer a pipeline that does not exist.
 */

import type {
  MetricState,
  SloSeverity,
  TelegraphSlo,
} from "../contracts/observability.js";

// ── The registry ──────────────────────────────────────────────────────────────

/**
 * §28's nine metrics and §30A.17's eight SLOs.
 *
 * The §28 rows keep the spec's own target words. The §30A.17 SLOs are the eight
 * operations that clause names, and their severities encode its final sentence —
 * "Safety/privacy operations receive the strictest requirements" — which
 * `src/scripts/checkTelegraphSlos.ts` enforces as an ORDERING rather than
 * trusting the labels: no `delivery` or `product` SLO may carry a target
 * stricter than the strictest `safety`/`privacy` one.
 */
export const TELEGRAPH_SLOS: readonly TelegraphSlo[] = [
  // ── §28 ─────────────────────────────────────────────────────────────────────
  {
    id: "SLO-01",
    censusRow: "T346",
    specSection: "28",
    metric: "message_command_success",
    requirement: "message command success — high availability; safety/coordination prioritized",
    target: { kind: "ratio", min: 0.99 },
    severity: "delivery",
    status: "measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "Every Telegraph command surface — send, edit, media, read receipt, request, " +
      "accept/decline, leave, save, report, thread creation — is classified by the " +
      "middleware and its HTTP outcome recorded. A 2xx is ok; a 5xx or a " +
      "degraded_unavailable is a violation; a 4xx that is a REFUSAL (403, 404, " +
      "422) is neither, because a guard doing its job is not an availability " +
      "failure and counting it as one would make a hardening change look like an " +
      "outage. The 'safety/coordination prioritized' half is the severity ladder " +
      "below, enforced as an ordering by the guard.",
  },
  {
    id: "SLO-02",
    censusRow: "T347",
    specSection: "28",
    metric: "duplicate_canonical_messages",
    requirement: "duplicate canonical messages = 0 under the idempotency contract",
    target: { kind: "count", max: 0 },
    severity: "delivery",
    status: "partially_measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "The middleware remembers the (threadId, clientId) pairs it has seen accepted " +
      "and counts a second acceptance as a violation. That is a REAL detector for " +
      "the case that actually happens — an offline client retrying a send that did " +
      "in fact land — and it is bounded by this process's memory: a duplicate " +
      "across two instances, or across a restart, is not seen. The exact version " +
      "needs the idempotency key the send path does not have (T231); until then " +
      "this is a floor on the true number, never a ceiling, and it is labelled " +
      "as one.",
  },
  {
    id: "SLO-03",
    censusRow: "T348",
    specSection: "28",
    metric: "unsend_after_seen_violations",
    requirement: "unsend-after-seen violations = 0",
    target: { kind: "count", max: 0 },
    severity: "privacy",
    status: "unmeasurable",
    emitters: [],
    note:
      "Vacuously zero: there is no unsend operation in this tree, so there is " +
      "nothing that could violate it. Declared with its target anyway, and that " +
      "is the point of declaring it — when unsend lands (PR #472, unmerged, " +
      "CI-only) the target already exists and the person building it does not " +
      "also have to remember to define one. A zero produced by absence is not a " +
      "measurement and is not counted as one.",
  },
  {
    id: "SLO-04",
    censusRow: "T349",
    specSection: "28",
    metric: "expired_precise_location_leakage",
    requirement: "expired precise-location leakage = 0",
    target: { kind: "count", max: 0 },
    severity: "privacy",
    status: "unmeasurable",
    emitters: [],
    note:
      "The guarantee is genuinely enforced — two independent artifacts, an expiry " +
      "gate before the handler and a coordinate strip on the way out, both proved " +
      "by RLS-05 — and NOTHING COUNTS IT, so a regression would be silent. The " +
      "emitter belongs in services/safeReturn/SafeReturnPrivacyGuard.ts, which " +
      "this lane does not hold. Recorded as unmeasurable rather than credited to " +
      "the enforcement, because 'it cannot happen' and 'we would notice if it " +
      "did' are different claims and only the first is true today.",
  },
  {
    id: "SLO-05",
    censusRow: "T350",
    specSection: "28",
    metric: "blocked_direct_deliveries",
    requirement: "blocked direct deliveries = 0",
    target: { kind: "count", max: 0 },
    severity: "safety",
    status: "partially_measured",
    emitters: ["src/lib/blockGuard.ts"],
    note:
      "What is counted is the guard's own activity: every evaluation, and separately " +
      "every occasion the blocks table was unreadable and the guard denied without " +
      "knowing. The second counter is the one worth having — it is the rate at " +
      "which this system is failing closed, which is invisible in any success " +
      "metric and is what a blocked-user leak would look like in its early stage. " +
      "The zero itself is established by P-04, which quantifies over the failure " +
      "states as well as the healthy ones; a counter cannot prove a negative and " +
      "is not asked to.",
  },
  {
    id: "SLO-06",
    censusRow: "T351",
    specSection: "28",
    metric: "projection_lag_ms",
    requirement: "projection lag — bounded; alert on material stale shared context",
    target: { kind: "latency", percentile: 95, maxMs: 1500 },
    severity: "delivery",
    status: "partially_measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "Four of the six §24 projections do not exist, and the two that do are " +
      "computed per request from canonical tables and cache nothing — so their " +
      "STALENESS is zero by construction and there is no lag to measure. What is " +
      "measured instead is their BUILD latency, which is the quantity that would " +
      "start to matter the moment either is cached. 'Alert on material stale " +
      "shared context' has no referent at all: there is no shared context (T21).",
  },
  {
    id: "SLO-07",
    censusRow: "T352",
    specSection: "28",
    metric: "realtime_delivery_loss",
    requirement: "realtime reconnect recovery — no lost confirmed messages",
    target: { kind: "count", max: 0 },
    severity: "delivery",
    status: "measured",
    emitters: ["src/domain/telegraph/services/telegraphObservability.ts"],
    note:
      "Folded from the event bus's own counters rather than re-counted: " +
      "telegraphEmitterStats already records subscriber failures, cross-instance " +
      "broadcast failures and — the important one — events dropped because a " +
      "thread's audience could not be resolved, which loses the event for every " +
      "member at once. The guarantee itself is architectural: the canonical row " +
      "is committed and the 201 returned before any publish, so a lost event " +
      "cannot lose a message. These counters measure how much realtime is being " +
      "lost, which is the operable question.",
  },
  {
    id: "SLO-08",
    censusRow: "T353",
    specSection: "28",
    metric: "share_revocation_latency_ms",
    requirement: "share-revocation latency — fast enough to prevent stale authorization bypass",
    target: { kind: "unbounded", intent: "fast enough to prevent stale authorization bypass" },
    severity: "privacy",
    status: "unmeasurable",
    emitters: [],
    note:
      "Revocation does not exist, so the latency is not large — it is undefined, " +
      "and a shared card's authorization never ends. The target carries the spec's " +
      "own words rather than a number, because inventing one would produce " +
      "confident alerts about a line nobody drew. F-12 is the fixture that holds " +
      "the divergence.",
  },
  {
    id: "SLO-09",
    censusRow: "T354",
    specSection: "28",
    metric: "coordinated_actions_confirmed",
    requirement: "successful coordinated real-world actions — the primary product outcome metric",
    target: { kind: "unbounded", intent: "the primary product outcome metric" },
    severity: "product",
    status: "partially_measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "A CONFIRMED TYPED COMMAND IS NOT A REAL-WORLD OUTCOME, and the gap is the " +
      "whole of what §1's north star asks for. What is counted is the closest thing " +
      "the tree can observe: a human confirming a proposed action through " +
      "/telegraph/commands/:id/confirm-action, which is the one place a " +
      "conversation becomes a canonical write. Whether anybody then met is not in " +
      "this system. Labelled a proxy so it cannot be quoted as the outcome metric.",
  },

  // ── §30A.17's eight SLOs ────────────────────────────────────────────────────
  {
    id: "SLO-10",
    censusRow: null,
    specSection: "30A.17",
    metric: "message_acceptance_latency_ms",
    requirement: "SLO: message acceptance",
    target: { kind: "latency", percentile: 95, maxMs: 1000 },
    severity: "delivery",
    status: "measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "Wall-clock from request to response on the send surfaces, measured at the " +
      "middleware so it includes everything the user waits for — including the " +
      "kill-switch read, the membership check, the block guard and the insert, " +
      "and excluding the fire-and-forget translation, tagging, notification and " +
      "realtime work that §29 keeps off the delivery path.",
  },
  {
    id: "SLO-11",
    censusRow: null,
    specSection: "30A.17",
    metric: "realtime_delivery_latency_ms",
    requirement: "SLO: realtime delivery",
    target: { kind: "latency", percentile: 95, maxMs: 2000 },
    severity: "delivery",
    status: "unmeasurable",
    emitters: [],
    note:
      "The server can time a publish; it cannot time an ARRIVAL, and the arrival " +
      "is the SLO. Measuring it needs a client acknowledgement the SSE protocol " +
      "does not carry. Declared so the number exists when that does.",
  },
  {
    id: "SLO-12",
    censusRow: null,
    specSection: "30A.17",
    metric: "offline_recovery_success",
    requirement: "SLO: offline recovery",
    target: { kind: "ratio", min: 0.99 },
    severity: "delivery",
    status: "unmeasurable",
    emitters: [],
    note:
      "There is no resume cursor and no outbox (T154, T233), so there is no " +
      "recovery operation whose success could be a ratio. The client's polling " +
      "fallback is what makes a dropped connection survivable, and a poll is " +
      "indistinguishable from an ordinary read at this layer.",
  },
  {
    id: "SLO-13",
    censusRow: null,
    specSection: "30A.17",
    metric: "seen_convergence_latency_ms",
    requirement: "SLO: seen convergence",
    target: { kind: "latency", percentile: 95, maxMs: 5000 },
    severity: "delivery",
    status: "measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "The read-receipt surface's own latency. Seen here is thread-level " +
      "(last_read_at) rather than per-message, so what converges is a thread " +
      "pointer — which is what this system has, and the SLO is stated against it " +
      "rather than against a per-message receipt that does not exist.",
  },
  {
    id: "SLO-14",
    censusRow: null,
    specSection: "30A.17",
    metric: "block_enforcement_failures",
    requirement: "SLO: block enforcement (safety — strictest)",
    target: { kind: "count", max: 0 },
    severity: "safety",
    status: "measured",
    emitters: ["src/lib/blockGuard.ts"],
    note:
      "Shares the block guard's emitter with SLO-05 and states the stricter half: " +
      "a block-guard evaluation that could not complete is an enforcement FAILURE " +
      "even though it denied, because the denial was made without knowledge. " +
      "Target zero.",
  },
  {
    id: "SLO-15",
    censusRow: null,
    specSection: "30A.17",
    metric: "location_revocation_latency_ms",
    requirement: "SLO: location revocation (privacy — strictest)",
    target: { kind: "latency", percentile: 99, maxMs: 1000 },
    severity: "privacy",
    status: "unmeasurable",
    emitters: [],
    note:
      "Revocation is a read-time property here — an expired window is recomputed " +
      "as expired on the next read, with no sweep — so the latency is bounded by " +
      "the reader, not by a job. That makes the SLO nearly trivially satisfied and " +
      "completely unmeasured, and the second half is what is recorded.",
  },
  {
    id: "SLO-16",
    censusRow: null,
    specSection: "30A.17",
    metric: "media_availability",
    requirement: "SLO: media availability",
    target: { kind: "ratio", min: 0.999 },
    severity: "delivery",
    status: "unmeasurable",
    emitters: [],
    note:
      "Media availability is reconciled by check:media-objects against Storage, " +
      "which is the right instrument and is a CI lane rather than a runtime metric. " +
      "A runtime emitter belongs with the media pipeline, which this lane does not " +
      "hold.",
  },
  {
    id: "SLO-17",
    censusRow: null,
    specSection: "30A.17",
    metric: "projection_freshness_ms",
    requirement: "SLO: projection freshness",
    target: { kind: "latency", percentile: 95, maxMs: 1500 },
    severity: "delivery",
    status: "partially_measured",
    emitters: ["src/middlewares/telegraphObservability.ts"],
    note:
      "Same instrument as SLO-06 and the same caveat: nothing is cached, so " +
      "freshness is build latency. Stated separately because §30A.17 asks for it " +
      "separately, and because the two would diverge the moment a projection is " +
      "materialised.",
  },
];

// ── The recorder ──────────────────────────────────────────────────────────────

const metricById = new Map<string, TelegraphSlo>();
for (const s of TELEGRAPH_SLOS) metricById.set(s.metric, s);

const state = new Map<string, MetricState>();

function slot(metric: string): MetricState {
  let m = state.get(metric);
  if (!m) {
    m = { metric, ok: 0, violations: 0, unknown: 0, latenciesMs: [] };
    state.set(metric, m);
  }
  return m;
}

/** Latency samples kept per metric. Bounded so a long-lived process cannot grow without limit. */
const LATENCY_WINDOW = 500;

export type MetricOutcome = "ok" | "violation" | "unknown";

/**
 * Record one observation.
 *
 * There is no parameter here that can carry content. That is the §30A.17
 * privacy rule expressed as a type: a caller who wanted to attach a message
 * body would have to widen this signature first.
 *
 * Unknown metric keys are IGNORED rather than counted under a catch-all. A
 * typo'd key that silently accumulated into "other" would make a dashboard that
 * is wrong in the one way nobody checks; `src/scripts/checkTelegraphSlos.ts`
 * fails on an emitter recording a key no SLO declares, so the typo is caught
 * where it is cheap.
 */
export function recordTelegraphMetric(
  metric: string,
  outcome: MetricOutcome,
  latencyMs?: number,
): void {
  if (!metricById.has(metric)) return;
  const m = slot(metric);
  if (outcome === "ok") m.ok++;
  else if (outcome === "violation") m.violations++;
  else m.unknown++;
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    m.latenciesMs.push(latencyMs);
    if (m.latenciesMs.length > LATENCY_WINDOW) m.latenciesMs.shift();
  }
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface SloReading {
  readonly id: string;
  readonly metric: string;
  readonly specSection: string;
  readonly severity: SloSeverity;
  readonly status: string;
  readonly target: string;
  readonly ok: number;
  readonly violations: number;
  readonly unknown: number;
  readonly p95Ms: number | null;
  /**
   * true / false / null. NULL when there is no observation to judge — which is
   * different from meeting the target, and a surface that collapsed the two
   * would report a system nobody is using as healthy.
   */
  readonly meetsTarget: boolean | null;
}

function describeTarget(s: TelegraphSlo): string {
  switch (s.target.kind) {
    case "ratio":
      return `success ratio ≥ ${s.target.min}`;
    case "count":
      return `violations ≤ ${s.target.max}`;
    case "latency":
      return `p${s.target.percentile} ≤ ${s.target.maxMs}ms`;
    case "unbounded":
      return `intent: ${s.target.intent}`;
  }
}

function judge(s: TelegraphSlo, m: MetricState | undefined): boolean | null {
  if (s.target.kind === "unbounded") return null;
  if (!m) return null;
  const observations = m.ok + m.violations + m.unknown;
  if (observations === 0 && m.latenciesMs.length === 0) return null;
  switch (s.target.kind) {
    case "ratio": {
      const denom = m.ok + m.violations;
      if (denom === 0) return null;
      return m.ok / denom >= s.target.min;
    }
    case "count":
      return m.violations <= s.target.max;
    case "latency": {
      const p = percentile(m.latenciesMs, s.target.percentile);
      return p === null ? null : p <= s.target.maxMs;
    }
  }
}

/**
 * Every declared SLO with its current reading.
 *
 * Includes the SLOs nothing records, with `meetsTarget: null` and their declared
 * status, because a list that showed only what is measured would read as a
 * complete picture of a system that is mostly unmeasured.
 */
export function telegraphSloSnapshot(
  emitterStats?: Record<string, number>,
): readonly SloReading[] {
  // The realtime loss metric is FOLDED from the event bus's own counters rather
  // than double-counted: the bus already counts what it swallows, and a second
  // counter beside it would drift.
  if (emitterStats) {
    const lost =
      (emitterStats.eventsDroppedUnresolvedAudience ?? 0) +
      (emitterStats.broadcastErrors ?? 0) +
      (emitterStats.terminateBroadcastErrors ?? 0) +
      (emitterStats.subscriberErrors ?? 0);
    const delivered = emitterStats.delivered ?? 0;
    const m = slot("realtime_delivery_loss");
    m.ok = delivered;
    m.violations = lost;
  }

  return TELEGRAPH_SLOS.map((s) => {
    const m = state.get(s.metric);
    return {
      id: s.id,
      metric: s.metric,
      specSection: s.specSection,
      severity: s.severity,
      status: s.status,
      target: describeTarget(s),
      ok: m?.ok ?? 0,
      violations: m?.violations ?? 0,
      unknown: m?.unknown ?? 0,
      p95Ms: m ? percentile(m.latenciesMs, 95) : null,
      meetsTarget: judge(s, m),
    };
  });
}

/** Test hook: zero every counter. Not called by production code. */
export function _resetTelegraphMetrics(): void {
  state.clear();
}
