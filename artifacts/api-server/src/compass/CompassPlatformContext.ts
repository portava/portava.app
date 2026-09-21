/**
 * CompassPlatformContext — the shared platform layer, as `/compass/ask`
 * consumes it (census-compass CCL-05, CCL-06, CX-10, CX-11).
 *
 * `docs/specs/upgrades-v2/01-COMPASS-v2.md:13` states the processing chain:
 *
 *   authorized request → EXISTING context assembly → shared world / experience
 *   / forecast / opportunity projections → EXISTING decision/ranking owner →
 *   grounded explanation → EXISTING UI/action contract.
 *
 * Every stage existed as an object and the chain did not: `/compass/ask`
 * assembled its own context from thirteen local producers and reached neither
 * the platform Context Kernel (lib/contextKernel) nor the Opportunity Engine
 * (lib/opportunityEngine), and read nothing Home had already built. This
 * module is the seam. It does not compute world truth and it does not rank:
 *
 *   - `formatHomeProjectionLines` renders the projection Compass Home builds
 *     (routes/compassHome.ts `buildCompassHomeProjection`) — ONE builder, two
 *     consumers — and keeps its honesty rule: a section whose source could
 *     not answer is said to be unavailable, never left out.
 *   - `assembleAskKernel` gathers the kernel's inputs for the subjects a turn
 *     is about through lib/contextKernelRead — the ONE world read every
 *     surface uses — and runs the pure assembler. No flag: the kernel is pure;
 *     only the live read is gated, and it degrades to `readable: false` by
 *     itself, which the kernel then REPORTS as unknown rather than hides.
 *   - `formatOpportunityLines` renders the opportunity engine's `compass`
 *     surface projection. The caller reads `opportunity_engine_enabled` (by
 *     its literal name, so check-flag-polarity resolves it) before building.
 *   - `runWithAskProjections` / `currentAskProjections` carry those same
 *     projections to the RANKING owner (CCL-05; see the block below).
 *
 * Nothing here writes, and no coordinate reaches the prompt.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleContextKernel,
  unknownContexts,
  type ContextKernel,
  type SubjectWorldContext,
} from "../lib/contextKernel.js";
import {
  DEFAULT_FORECAST_HORIZON_MINUTES,
  readAttentionContext,
  readSubjectWorld,
} from "../lib/contextKernelRead.js";
import { liveLabelsServable } from "../lib/liveClaimRead.js";
import type { OpportunityRefusal, SurfaceProjection } from "../lib/opportunityEngine.js";
import type { CompassHomeProjection } from "../routes/compassHome.js";
import { wrapUgc } from "./CompassStructuredContext.js";
import { INTENT_MODE_LABELS, INTENT_MODE_TO_DECISION_INTENT, type IntentMode } from "../lib/intentModes.js";

/** Labels the tests and the model both read; declared once. */
export const HOME_PROJECTION_HEADER = "[Current context — server projection]";
export const KERNEL_HEADER = "[Shared context kernel]";
export const OPPORTUNITY_HEADER = "[Opportunities]";

/** How many subjects a turn's kernel carries at most — the "Verified nearby places" it already names. */
export const ASK_KERNEL_SUBJECT_CAP = 5;

// ── CCL-06: Home's projection, rendered ──────────────────────────────────────

export function formatHomeProjectionLines(home: CompassHomeProjection): string[] {
  const lines: string[] = [HOME_PROJECTION_HEADER];
  lines.push(`Time of day: ${home.timeOfDay}; context: ${home.contextState}${home.city ? `; city: ${home.city}` : ""}`);

  const unavailable = (k: keyof CompassHomeProjection["sources"]) => home.sources[k] === "unavailable";

  if (unavailable("bestNextMove")) lines.push("Best next move: could not be read");
  else if (home.bestNextMove) {
    const m = home.bestNextMove;
    const name = wrapUgc(String(m.title ?? m.type).slice(0, 200));
    lines.push(`Best next move: ${name}${m.category ? ` (${m.category})` : ""}${m.city ? ` — ${m.city}` : ""}`);
  }

  if (unavailable("circleActivity")) lines.push("Who's around: could not be read");
  else if (home.circleActivity && home.circleActivity.people.length > 0) {
    const people = home.circleActivity.people
      .slice(0, 5)
      .map((p) => `${wrapUgc(String(p.label).slice(0, 80))}${p.statusLabel ? ` (${p.statusLabel})` : ""}`)
      .join(", ");
    lines.push(`Who's around: ${people}`);
  }

  if (unavailable("startingSoon")) lines.push("Starting soon: could not be read");
  else if (home.startingSoon && home.startingSoon.length > 0) {
    const events = home.startingSoon
      .slice(0, 5)
      .map((e) => `${wrapUgc(String(e.title).slice(0, 120))}${e.startsAt ? ` at ${e.startsAt}` : ""}`)
      .join("; ");
    lines.push(`Starting soon: ${events}`);
  }

  if (unavailable("tonightVibe")) lines.push("Tonight: could not be read");
  else if (home.tonightVibe) lines.push(`Tonight: ${wrapUgc(String(home.tonightVibe.headline).slice(0, 200))}`);

  if (unavailable("weatherWindow")) lines.push("Weather window: could not be read");
  else if (home.weatherWindow) lines.push(`Weather window: ${home.weatherWindow.headline}`);

  return lines;
}

// ── CX-10: the Context Kernel, assembled for a turn ──────────────────────────

export interface AskKernel {
  kernel: ContextKernel;
  /** Whether the Live gates allowed the world read at all. */
  readable: boolean;
  /** The §8 intent mode the request declared, or null. */
  intentMode: IntentMode | null;
}

export async function assembleAskKernel(
  sc: SupabaseClient | any,
  userId: string,
  subjectIds: readonly string[],
  opts: { utcOffsetMinutes: number | null; now: Date; intentMode?: IntentMode | null },
): Promise<AskKernel> {
  const ids = Array.from(new Set(subjectIds)).slice(0, ASK_KERNEL_SUBJECT_CAP);
  const readable = await liveLabelsServable(sc);
  const subjects: SubjectWorldContext[] = [];
  for (const id of ids) {
    subjects.push(await readSubjectWorld(sc, id, { now: opts.now, readable, horizonMinutes: DEFAULT_FORECAST_HORIZON_MINUTES }));
  }
  const attention = await readAttentionContext(sc, userId, opts.now, []);
  const etaMinutesBySubject: Record<string, number | null> = {};
  for (const id of ids) etaMinutesBySubject[id] = null;
  const kernel = assembleContextKernel(
    {
      // A chat turn's crowd preference is the §8 intent mode the client
      // DECLARED (lib/intentModes → the shared decision intent), never a guess
      // from prose. Queue tolerance and relation stay the decision surface's
      // inputs (get_decision).
      user: { intent: opts.intentMode ? INTENT_MODE_TO_DECISION_INTENT[opts.intentMode] : null, queueToleranceMinutes: null, relevance: "none" },
      utcOffsetMinutes: opts.utcOffsetMinutes,
      spatial: { viewerPositionKnown: false, etaMinutesBySubject },
      trip: null,
      social: null,
      experience: null,
      subjects,
      attention,
    },
    opts.now.getTime(),
  );
  return { kernel, readable, intentMode: opts.intentMode ?? null };
}

export function formatKernelLines(k: AskKernel): string[] {
  const { kernel, readable } = k;
  const unknown = unknownContexts(kernel);
  const lines: string[] = [KERNEL_HEADER];
  lines.push(
    `Day part: ${kernel.temporal.dayPart ?? "unknown"}; live intelligence readable: ${readable ? "yes" : "no"}; ` +
      `unknown contexts: ${unknown.length ? unknown.join(", ") : "none"}`,
  );
  if (k.intentMode) {
    lines.push(`Intent mode: ${INTENT_MODE_LABELS[k.intentMode]} (crowd preference: ${kernel.user.intent ?? "none"})`);
  }
  for (const s of kernel.world.subjects) {
    const crowd = s.readable ? `crowd ${s.crowd.density ?? "unknown"}` : "crowd: could not look";
    const forecast = s.forecast
      ? `forecast ${s.forecast.expectedDensity ?? "unknown"} by ${s.forecast.predictedFor}`
      : s.forecastRefused
        ? `forecast refused (${s.forecastRefused.refusal})`
        : "forecast unknown";
    lines.push(`Subject ${s.subjectId}: ${crowd}; ${forecast}; truth ${s.truth.truthClass}`);
  }
  if (kernel.safety.suppressedSubjectIds.length > 0) {
    lines.push(`Safety-suppressed subjects: ${kernel.safety.suppressedSubjectIds.join(", ")}`);
  }
  return lines;
}

// ── CX-11: the Opportunity Engine's compass projection, rendered ─────────────

export function formatOpportunityLines(wire: readonly SurfaceProjection[], refusals: readonly OpportunityRefusal[]): string[] {
  const lines: string[] = [OPPORTUNITY_HEADER];
  if (wire.length === 0) lines.push("No opportunity was promoted for the subjects above.");
  for (const o of wire) {
    lines.push(
      `${o.kind ?? "unknown"} — subject ${o.subjectId}; relevance ${typeof o.relevance === "number" ? o.relevance.toFixed(2) : "unknown"}; ` +
        `decision ${o.decision ?? "unknown"} (${(o.decisionReasons ?? []).join(", ") || "no reasons"}); ` +
        `reachable ${o.reachable === null || o.reachable === undefined ? "unknown" : o.reachable ? "yes" : "no"}; truth ${o.truth?.truthClass ?? "unknown"}`,
    );
  }
  // A refusal is a fact the model must carry: "live intelligence unavailable"
  // is never rendered as "nothing is happening".
  for (const r of refusals) lines.push(`Refused ${r.subjectId}: ${r.reason}${r.decision ? ` (${r.decision})` : ""}`);
  return lines;
}

// ── CCL-05: the same projections, carried to the RANKING owner ───────────────
//
// §26.3 closed CCL-05's first half and named the second verbatim: "The ranking
// owner, `CompassPipeline`, still ranks without them." The spec's chain is
//
//   … → shared world/experience/forecast/opportunity projections → EXISTING
//   decision/ranking owner → …
//
// so the projections have to reach `runPipeline`, not only the prompt. The
// ranker is reached from `/compass/ask` through the model's tool calls
// (routes/compass.ts → runToolCallingLoop → CompassTools → runPipeline): a
// stack of callers that have no business knowing about a context kernel and
// must not grow a parameter for one. An AsyncLocalStorage is the request-scoped
// seam for exactly that — one store per turn, established by the route around
// the tool loop, read by the pipeline at the bottom. It is NOT global mutable
// state: two concurrent turns each see their own store, and a caller that never
// established one (the feed, a job, a test) reads `null` and ranks exactly as it
// did before CCL-05.

/** The shared projections as the ranking owner consumes them. */
export interface AskRankingProjections {
  /** The nine-context kernel this turn assembled. */
  kernel: ContextKernel;
  /** Whether the Live gates allowed the world read at all (`AskKernel.readable`). */
  readable: boolean;
  /**
   * The opportunity engine's `compass` projections. Present ONLY when the
   * caller read `opportunity_engine_enabled` TRUE — an empty array then means
   * "the flag is on and nothing was promoted", while `undefined` means the
   * flag-gated half never ran. The ranker must not conflate the two, so the
   * field is optional rather than defaulted to `[]`.
   */
  opportunities?: readonly SurfaceProjection[];
}

const askProjectionStore = new AsyncLocalStorage<AskRankingProjections>();

/** Run `fn` with these projections ambient for everything it awaits. */
export function runWithAskProjections<T>(projections: AskRankingProjections, fn: () => Promise<T>): Promise<T> {
  return askProjectionStore.run(projections, fn);
}

/** The projections for the turn in flight, or null outside one. Never throws, never guesses. */
export function currentAskProjections(): AskRankingProjections | null {
  return askProjectionStore.getStore() ?? null;
}
