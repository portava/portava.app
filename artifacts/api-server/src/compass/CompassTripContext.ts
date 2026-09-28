/**
 * CompassTripContext — always-on trip grounding for /compass/ask.
 *
 * Builds a small plain-text context block describing the user's current trip
 * so chat answers are grounded in where the user actually is (or is about to
 * go) without waiting for the model to call get_current_trip:
 *
 *   - active trip (today inside start_date..end_date): headline with day N of M,
 *     today's plan items (titles UGC-wrapped), and tomorrow's item count
 *   - otherwise the next upcoming trip starting within 60 days (or a
 *     "dates not set" line for date-less drafts)
 *
 * Trip selection mirrors toolGetCurrentTrip in CompassTools.ts: trips the user
 * owns plus trips where they are an accepted member (role owner/member),
 * statuses active/upcoming/planning/draft, preferring active then earliest
 * start_date.
 *
 * Date math is intentionally simple: YYYY-MM-DD comparisons with "today"
 * resolved in the trip's timezone via Intl when set, UTC otherwise.
 *
 * Fail-soft (same contract as buildLiveChatContextLines): ANY error returns []
 * silently — trip grounding must never break chat.
 */

import { wrapUgc } from "./CompassStructuredContext.js";
import { resolveCurrentTrip, CONTEXT_TRIP_STATUSES } from "./CompassCurrentTrip.js";
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import { truthOfEnvelope } from "../lib/liveEnvelopeTruth.js";
import { readOpenSession } from "../lib/experienceSessionStore.js";
import { sessionState, type ExperienceSessionEnvelope } from "../lib/experienceSession.js";
import type { ContextKernel } from "../lib/contextKernel.js";
import type { SurfaceProjection } from "../lib/opportunityEngine.js";

const MAX_BLOCK_CHARS      = 1200;
const UPCOMING_WINDOW_DAYS = 60;
const MAX_TODAY_ITEMS      = 5;
const DAY_MS               = 86_400_000;

// Trip COLUMNS and STATUSES moved to compass/CompassCurrentTrip.ts with the
// selection they belonged to; this module now names only what it reads itself
// (the day-scoped plan items below, which no Trip projection serves yet).

/** Parse a YYYY-MM-DD(-prefixed) string to a UTC-midnight timestamp. */
function ymdToUtcMs(ymd: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Today as YYYY-MM-DD in the trip's timezone when set, else UTC. */
function todayYmd(timezone: unknown, now: Date): string {
  if (typeof timezone === "string" && timezone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year:     "numeric",
        month:    "2-digit",
        day:      "2-digit",
      }).format(now);
    } catch { /* unknown timezone — fall back to UTC */ }
  }
  return now.toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus N days (UTC arithmetic on the date string). */
function addDays(ymd: string, days: number): string | null {
  const ms = ymdToUtcMs(ymd);
  if (ms == null) return null;
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/** HH:MM for a plan item's starts_at, in the trip timezone when resolvable. */
function hhmm(startsAt: unknown, timezone: unknown): string | null {
  const s = String(startsAt ?? "");
  if (!s) return null;
  if (typeof timezone === "string" && timezone) {
    try {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          hour:     "2-digit",
          minute:   "2-digit",
          hour12:   false,
        }).format(d);
      }
    } catch { /* fall back to the raw ISO slice */ }
  }
  const sliced = s.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(sliced) ? sliced : null;
}

/**
 * Build the [Trip context] lines for /compass/ask.
 * Plain strings, no markdown, capped at ~1200 chars.
 *
 * RETURNING NOTHING IS SAFE. ASSERTING SOMETHING IS NOT.
 * =====================================================
 * These lines are GROUNDING for a language model: whatever is in them, the
 * assistant will treat as fact and repeat to the user in prose. `[] on any
 * error` covers saying nothing, and that remains the behaviour — an absent
 * trip context makes the assistant answer without trip knowledge, which is
 * merely less useful.
 *
 * What it did NOT cover is the POSITIVE sentence this function used to emit
 * when a read failed: an unreadable trip_plan_items produced zero rows, which
 * fell through to `lines.push("No plan items scheduled today.")`, and the
 * assistant then told the user their day was empty. That is not a degraded
 * answer, it is a wrong one, and the user has no way to tell it from the truth.
 *
 * So every read below binds `error`, and a failed read either omits the line
 * or says the state is unknown. Nothing here asserts an absence it did not
 * observe.
 */
export async function buildTripContextLines(sc: any, userId: string): Promise<string[]> {
  try {
    // ── Trip selection ────────────────────────────────────────────────────
    // This used to be a second copy of toolGetCurrentTrip's union, differing
    // from it by one status (`draft`). One seam now decides it for every
    // Compass surface — compass/CompassCurrentTrip.ts — and the status set is
    // passed explicitly so THIS surface's long-standing rule is preserved
    // rather than quietly unified with the tool's (CT-02; the divergence is an
    // owner decision, named in that module's header).
    //
    // `unread` keeps this function's existing contract: it returns no lines, so
    // the assistant answers without trip knowledge rather than asserting a trip
    // state it did not observe.
    const resolved = await resolveCurrentTrip(sc, userId, CONTEXT_TRIP_STATUSES);
    if (resolved.status !== "ok") return [];
    const trip = resolved.trip;

    // Trip title is UGC (user-entered, and a trip is shared with members), so wrap
    // it in <portava:ugc> — matching the plan-item titles below — before it lands
    // in the /ask prompt. A co-member could otherwise inject via the trip title.
    const title    = wrapUgc(String(trip.title ?? "Untitled trip"));
    const city     = String(trip.destinationCity ?? "unknown city");
    const country  = String(trip.destinationCountry ?? "unknown country");
    const tz       = trip.timezone;

    const today    = todayYmd(tz, new Date());
    const todayMs  = ymdToUtcMs(today);
    const startYmd = trip.startDate;
    const endYmd   = trip.endDate;
    const startMs  = startYmd ? ymdToUtcMs(startYmd) : null;
    const endMs    = endYmd   ? ymdToUtcMs(endYmd)   : null;
    if (todayMs == null) return [];

    const lines: string[] = [];
    const isActiveToday =
      startMs != null && endMs != null && todayMs >= startMs && todayMs <= endMs;

    if (isActiveToday) {
      const dayN = Math.floor((todayMs - startMs!) / DAY_MS) + 1;
      const dayM = Math.floor((endMs! - startMs!) / DAY_MS) + 1;
      lines.push(
        `Active trip: "${title}" in ${city}, ${country} — day ${dayN} of ${dayM} (${startYmd} to ${endYmd}).`,
      );

      // Today's plan items (≤5, not cancelled, not removed).
      const { data: todayItems, error: todayErr } = await sc
        .from("trip_plan_items")
        .select("title, starts_at, sort_order, status")
        .eq("trip_id", trip.id)
        .eq("day_date", today)
        .neq("status", "cancelled")
        .is("removed_at", null)
        .order("starts_at", { ascending: true })
        .order("sort_order", { ascending: true })
        .limit(MAX_TODAY_ITEMS);
      const items = (todayErr ? [] : (todayItems ?? [])) as any[];
      if (items.length > 0) {
        const parts = items.map((i) => {
          const itemTitle = wrapUgc(String(i.title ?? ""));
          const at = hhmm(i.starts_at, tz);
          return at ? `${itemTitle} (${at})` : itemTitle;
        });
        lines.push(`Today's plan: ${parts.join("; ")}`);
      } else if (todayErr) {
        // NOT "no plan items scheduled today". The assistant repeats these
        // lines as fact; telling someone their day is empty because a query
        // failed is the worst answer available here.
        lines.push("Today's plan could not be read — do not state whether anything is scheduled today.");
      } else {
        lines.push("No plan items scheduled today.");
      }

      // Tomorrow's count (only mentioned when > 0).
      const tomorrow = addDays(today, 1);
      if (tomorrow) {
        const { data: tomorrowItems, error: tomorrowErr } = await sc
          .from("trip_plan_items")
          .select("id")
          .eq("trip_id", trip.id)
          .eq("day_date", tomorrow)
          .neq("status", "cancelled")
          .is("removed_at", null)
          .limit(50);
        // Omitted on failure rather than reported as 0. This line is only ever
        // emitted when n > 0, so an unreadable table already said nothing —
        // binding the error keeps it that way deliberately rather than by
        // accident, and stops a future edit from adding an `else` branch that
        // asserts tomorrow is clear.
        const n = tomorrowErr ? 0 : ((tomorrowItems ?? []) as any[]).length;
        if (n > 0) lines.push(`Tomorrow: ${n} planned item(s).`);
      }
    } else if (startMs != null) {
      // Upcoming trip — only surfaced within the 60-day window.
      const daysUntil = Math.ceil((startMs - todayMs) / DAY_MS);
      if (daysUntil < 0 || daysUntil > UPCOMING_WINDOW_DAYS) return [];
      lines.push(
        `Upcoming trip: "${title}" to ${city}, ${country} — starts in ${daysUntil} days (${startYmd}..${endYmd ?? "?"}).`,
      );
    } else {
      // Selected trip has no dates (e.g. a draft): still worth grounding.
      lines.push(`Upcoming trip: "${title}" to ${city}, ${country} — dates not set.`);
    }

    // ── Cap the whole block at ~1200 chars ────────────────────────────────
    const out: string[] = [];
    let total = 0;
    for (const line of lines) {
      if (total + line.length + 1 > MAX_BLOCK_CHARS) break;
      out.push(line);
      total += line.length + 1;
    }
    return out;
  } catch {
    // Fail-soft: trip grounding must never break chat.
    return [];
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// S83 — TripWorldContext
// ═════════════════════════════════════════════════════════════════════════════
/**
 * census-sensing S83: *"`TripWorldContext` projection: current world state,
 * nearby opportunities, disruptions, ExperienceSessions, crew context"*, scored
 * BUILT-BUT-WRONG because *"`compass/CompassTripContext.ts` still exports
 * exactly one function, `buildTripContextLines`, and it is trip grounding — no
 * world state, no opportunities, no disruptions, no sessions"*. Its RED WHEN is
 * *"S54 (`ExperienceSession`) exists and a `TripWorldContext` projection
 * carries the five named parts"*. S54 exists, so here are the five.
 *
 * ── IT PROJECTS, IT DOES NOT COMPUTE ─────────────────────────────────────────
 * Every part comes from the owner that already exists, and this module composes
 * them onto the trip. Nothing here grades a claim, ranks an opportunity or
 * decides what is live:
 *
 *   1. world state    the platform Context Kernel's own per-subject world
 *                     (`lib/contextKernel` → `ContextKernel.world.subjects`),
 *                     passed in by the caller that assembled it. Not re-read,
 *                     so the prompt and the ranker cannot see two worlds.
 *   2. opportunities  `lib/opportunityEngine`'s `compass` surface projection,
 *                     passed in by the caller BECAUSE it is flag-gated
 *                     (`opportunity_engine_enabled`, seeded FALSE). Undefined
 *                     means the flag-gated half never ran; an empty array means
 *                     it ran and promoted nothing. The two are not conflated.
 *   3. disruptions    live claims of the types that say A PLANNED THING MAY NOT
 *                     HAPPEN — transit condition, closure, event status — read
 *                     for the places on today's plan through the one live read
 *                     (`lib/liveClaimRead`), with their §5.1 band attached.
 *   4. sessions       the viewer's OPEN `ExperienceSession`
 *                     (`lib/experienceSessionStore.readOpenSession`). That seam
 *                     offers one open session and no history, and this takes
 *                     exactly what it offers: a trip context is not the place a
 *                     session list gets reinvented (S54).
 *   5. crew           accepted members of the resolved trip, by handle, from
 *                     the membership table — never a location, never a status.
 *
 * ── THE HONESTY RULE, BORROWED DELIBERATELY ──────────────────────────────────
 * `CompassPlatformContext.formatHomeProjectionLines` keeps the rule that *"a
 * section whose source could not answer is said to be unavailable, never left
 * out"*, and this keeps it too. A part whose read failed lands in `unavailable`
 * and gets a line saying so. The failure mode it prevents is the one
 * `buildTripContextLines` documents at length above: an unreadable table
 * becoming a confident "nothing is happening", which the model then tells the
 * user as fact.
 *
 * NO COORDINATE IS EVER SELECTED. `trip_plan_items` carries `lat`/`lng`; the
 * reads below name their columns and those two are not among them.
 */

/** The five parts, as data a test can walk. */
export const TRIP_WORLD_PARTS = ["world_state", "opportunities", "disruptions", "sessions", "crew"] as const;
export type TripWorldPart = (typeof TRIP_WORLD_PARTS)[number];

export const TRIP_WORLD_CONTEXT_HEADER = "[Trip world context]";

/**
 * The claim types that constitute a DISRUPTION to a plan. Deliberately narrow:
 * a busy bar is not a disruption, a cancelled event is. `transit.condition` is
 * `lib/freshnessPolicy`'s own `transit_disruption` family; `closure.state` and
 * `event.status` are the two other types whose value can say a planned thing is
 * not going to happen.
 */
export const TRIP_DISRUPTION_CLAIM_TYPES: readonly string[] = Object.freeze([
  "transit.condition",
  "closure.state",
  "event.status",
]) as readonly string[];

/** How many of today's plan places are checked for disruption. Bounded like every other block here. */
export const TRIP_DISRUPTION_SUBJECT_CAP = 5;
export const TRIP_CREW_CAP = 8;

export interface TripWorldSubjectState {
  subjectId: string;
  /** The kernel's own crowd density word, or null when it could not look. */
  density: string | null;
  forecast: string | null;
  truthClass: string;
  /** False ⇒ the live gates refused the read; "unknown" here is not "quiet". */
  readable: boolean;
}

export interface TripDisruption {
  subjectId: string;
  /** The plan item this affects, UGC-wrapped. */
  planTitle: string;
  claimType: string;
  value: unknown;
  truthClass: string;
  confidence: string;
  band: string;
}

export interface TripSessionState {
  sessionId: string;
  subjectId: string;
  opportunityKind: string;
  openedAt: string;
  expiresAt: string;
  state: string;
}

export interface TripWorldContext {
  tripId: string | null;
  /** UGC-wrapped trip title, or null when no trip resolved. */
  tripTitle: string | null;
  city: string | null;
  worldState: TripWorldSubjectState[];
  /** Undefined ⇒ the flag-gated engine never ran. Empty ⇒ it ran, nothing promoted. */
  opportunities: SurfaceProjection[] | undefined;
  disruptions: TripDisruption[];
  sessions: TripSessionState[];
  crew: string[];
  /** Parts whose source could not answer. Said out loud, never dropped. */
  unavailable: TripWorldPart[];
}

const EMPTY_TRIP_WORLD: TripWorldContext = {
  tripId: null, tripTitle: null, city: null,
  worldState: [], opportunities: undefined, disruptions: [], sessions: [], crew: [],
  unavailable: [],
};

function bandOf(envelope: LiveClaimEnvelope, nowMs: number): { truthClass: string; confidence: string } {
  const truth = truthOfEnvelope(envelope, nowMs);
  return { truthClass: truth.truthClass, confidence: String(truth.confidence) };
}

function sessionStateOf(envelope: ExperienceSessionEnvelope, nowMs: number): TripSessionState {
  return {
    sessionId: envelope.session_id,
    subjectId: envelope.subject_id,
    opportunityKind: envelope.opportunity_kind,
    openedAt: envelope.opened_at,
    expiresAt: envelope.expires_at,
    state: sessionState(envelope, nowMs),
  };
}

/**
 * Build the five-part projection for this user's current trip.
 *
 * Fail-soft per PART rather than per call: one unreadable source costs that
 * part and marks it unavailable, and the other four still answer. A total
 * failure returns the empty projection, which formats to nothing.
 */
export async function buildTripWorldContext(
  sc: any,
  userId: string,
  opts: {
    now?: Date;
    /** The kernel this turn already assembled. Not re-read here on purpose. */
    kernel?: ContextKernel | null;
    /** The opportunity engine's compass projection, when its flag let it run. */
    opportunities?: readonly SurfaceProjection[] | null;
  } = {},
): Promise<TripWorldContext> {
  try {
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();
    const unavailable: TripWorldPart[] = [];

    // ── 1. current world state ───────────────────────────────────────────────
    // Taken from the kernel the turn already built. A caller that assembled no
    // kernel has no world to report, and that is UNAVAILABLE rather than empty:
    // "we did not look" must not render as "nothing is happening".
    let worldState: TripWorldSubjectState[] = [];
    if (opts.kernel) {
      worldState = (opts.kernel.world?.subjects ?? []).map((s: any) => ({
        subjectId: String(s.subjectId),
        density: s.readable ? (s.crowd?.density ?? null) : null,
        forecast: s.forecast?.expectedDensity ?? null,
        truthClass: String(s.truth?.truthClass ?? "unknown"),
        readable: s.readable === true,
      }));
    } else {
      unavailable.push("world_state");
    }

    // ── 2. nearby opportunities ──────────────────────────────────────────────
    // `undefined` is preserved: it means the flag-gated engine never ran, which
    // is a different fact from "it ran and promoted nothing".
    const opportunities = opts.opportunities === null || opts.opportunities === undefined
      ? undefined
      : [...opts.opportunities];

    // ── the trip everything else hangs on ────────────────────────────────────
    const resolved = await resolveCurrentTrip(sc, userId, CONTEXT_TRIP_STATUSES);
    if (resolved.status !== "ok") {
      // No trip (or an unreadable trips table) means no crew and no plan to be
      // disrupted. The world and the opportunities above still stand.
      return {
        ...EMPTY_TRIP_WORLD,
        worldState,
        opportunities,
        unavailable: [...unavailable, "disruptions", "crew"],
      };
    }
    const trip = resolved.trip;
    const today = todayYmd(trip.timezone, now);

    // ── 3. disruptions ───────────────────────────────────────────────────────
    // Today's plan items that name a place, checked for the three claim types
    // that can say a planned thing will not happen. NO COORDINATE IS SELECTED.
    const disruptions: TripDisruption[] = [];
    const { data: planRows, error: planErr } = await sc
      .from("trip_plan_items")
      .select("id, title, place_id, status")
      .eq("trip_id", trip.id)
      .eq("day_date", today)
      .neq("status", "cancelled")
      .is("removed_at", null)
      .limit(TRIP_DISRUPTION_SUBJECT_CAP);
    if (planErr) {
      unavailable.push("disruptions");
    } else {
      for (const item of ((planRows ?? []) as any[])) {
        const placeId = typeof item.place_id === "string" ? item.place_id : null;
        if (!placeId) continue;
        const envelopes = await readLiveClaimEnvelopes(sc, placeId, {
          claimTypes: TRIP_DISRUPTION_CLAIM_TYPES,
          now,
        });
        for (const e of envelopes) {
          const band = bandOf(e, nowMs);
          disruptions.push({
            subjectId: placeId,
            planTitle: wrapUgc(String(item.title ?? "").slice(0, 120)),
            claimType: e.claimType,
            value: e.value,
            truthClass: band.truthClass,
            confidence: band.confidence,
            band: String(e.band),
          });
        }
      }
    }

    // ── 4. ExperienceSessions ────────────────────────────────────────────────
    // Exactly what the S54 seam offers: the viewer's ONE open session. A
    // refusal is unavailable, not "no session" — the difference between "you
    // have nothing on" and "we could not look" is the whole point.
    const sessions: TripSessionState[] = [];
    const read = await readOpenSession(sc, userId, nowMs);
    if (read.refusal !== null) unavailable.push("sessions");
    else if (read.open) sessions.push(sessionStateOf(read.open.envelope, nowMs));

    // ── 5. crew context ──────────────────────────────────────────────────────
    // Handles only. No location, no status, no last-seen: who is on the trip,
    // which is what "crew context" means here and all it may mean.
    let crew: string[] = [];
    const { data: crewRows, error: crewErr } = await sc
      .from("trip_members")
      .select("profiles(handle), role, status")
      .eq("trip_id", trip.id)
      .eq("status", "accepted")
      .limit(TRIP_CREW_CAP);
    if (crewErr) unavailable.push("crew");
    else {
      crew = ((crewRows ?? []) as any[])
        .map((r) => (r.profiles as any)?.handle)
        .filter((h): h is string => typeof h === "string" && h.length > 0)
        .map((h) => `@${h}`);
    }

    return {
      tripId: String(trip.id),
      tripTitle: wrapUgc(String(trip.title ?? "Untitled trip")),
      city: trip.destinationCity ? String(trip.destinationCity) : null,
      worldState,
      opportunities,
      disruptions,
      sessions,
      crew,
      unavailable,
    };
  } catch {
    // Total failure: say nothing rather than assert anything.
    return EMPTY_TRIP_WORLD;
  }
}

/**
 * Render the projection as prompt lines.
 *
 * Every part gets a line even when it is empty, because "no disruption
 * reported" and "we could not check for disruptions" are different sentences
 * and the model must be able to tell the user which one is true.
 */
export function formatTripWorldContextLines(ctx: TripWorldContext): string[] {
  if (!ctx || (ctx.tripId === null && ctx.worldState.length === 0 && ctx.opportunities === undefined)) return [];
  const unavailable = new Set(ctx.unavailable ?? []);
  const lines: string[] = [TRIP_WORLD_CONTEXT_HEADER];

  if (ctx.tripTitle) lines.push(`Trip: ${ctx.tripTitle}${ctx.city ? ` — ${ctx.city}` : ""}`);

  if (unavailable.has("world_state")) lines.push("World state: could not be read");
  else if (ctx.worldState.length === 0) lines.push("World state: no subject carried one this turn");
  else {
    for (const s of ctx.worldState) {
      lines.push(
        `World ${s.subjectId}: ${s.readable ? `crowd ${s.density ?? "unknown"}` : "crowd: could not look"}; ` +
          `forecast ${s.forecast ?? "unknown"}; truth ${s.truthClass}`,
      );
    }
  }

  if (ctx.opportunities === undefined) lines.push("Opportunities: not evaluated this turn");
  else if (ctx.opportunities.length === 0) lines.push("Opportunities: none promoted");
  else {
    for (const o of ctx.opportunities) {
      lines.push(`Opportunity ${o.kind ?? "unknown"} — subject ${o.subjectId}; truth ${o.truth?.truthClass ?? "unknown"}`);
    }
  }

  if (unavailable.has("disruptions")) lines.push("Disruptions: could not be checked — do not say the day is clear");
  else if (ctx.disruptions.length === 0) lines.push("Disruptions: none reported for today's plan");
  else {
    for (const d of ctx.disruptions) {
      lines.push(
        `Disruption affecting ${d.planTitle}: ${d.claimType}=${JSON.stringify(d.value)} ` +
          `(truth ${d.truthClass}; confidence ${d.confidence}; band ${d.band})`,
      );
    }
  }

  if (unavailable.has("sessions")) lines.push("Experience sessions: could not be read");
  else if (ctx.sessions.length === 0) lines.push("Experience sessions: none open");
  else {
    for (const s of ctx.sessions) {
      lines.push(
        `Experience session ${s.sessionId}: ${s.opportunityKind} at subject ${s.subjectId}; ` +
          `${s.state}, opened ${s.openedAt}, expires ${s.expiresAt}`,
      );
    }
  }

  if (unavailable.has("crew")) lines.push("Crew: could not be read");
  else if (ctx.crew.length === 0) lines.push("Crew: travelling solo, or no accepted members");
  else lines.push(`Crew: ${ctx.crew.join(", ")}`);

  return lines;
}
