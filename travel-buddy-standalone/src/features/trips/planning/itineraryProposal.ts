/**
 * census G160 — §24's "Create 3 Trip stops from this text [Review]", as a
 * PROPOSAL the person reviews. Nothing here writes.
 *
 * WHAT PRODUCES THE STOPS
 * =======================
 * The paste extraction route, `POST /api/input-assistance/extract` (the §24
 * pipeline, census G154–G162): a deterministic classifier that cuts an
 * itinerary into items, keeps each item's time hint and day heading OUT of the
 * place query, and resolves each item through the shared gateway, catalog-only
 * (no model, no third-party provider). It writes nothing (`mutated: false`).
 * Under lead ruling PR-D2-7c a line that matches no place is DROPPED by the
 * server and never echoed — so "Dinner at 7", alone, comes back as nothing, and
 * this proposal can only ever offer lines that matched a place.
 *
 * WHAT A STOP BECOMES, AND WHY A COMMITMENT
 * =========================================
 * Each proposed stop is ONE `ADD_COMMITMENT` built by the trip structure
 * composer's own builder (`tripStructurePayloads.ts#commitmentCommand`) with
 * its `starts_at`: §7.1's Commitment is the Trip's timed point ("Commitment {
 * startsAt … }"), and an itinerary line with a time is exactly that. Not a
 * stage: a stage is a bounded stay anchored to a CITY (2760), three venues in
 * one evening are not three stays, and a venue's id is a `discovery_places` id,
 * not the `canonical_locations` id a stage's `city_id` holds. The place itself
 * is NOT written (the commitment's `place_id` id-space is not the venue's), and
 * neither is the line's words (`trip_commitments` has no label column) — the
 * review says both before anything is sent.
 *
 * NEVER GUESSED (itineraryTimes.ts)
 * =================================
 * A stop is READY only when its instant is unambiguous. Otherwise it is HELD
 * with exactly what is missing — morning or evening, which day, which zone,
 * which of two instants — and the person supplies it (a `StopFix`), or it is
 * BLOCKED with the reason it cannot be added here at all.
 *
 * THE ZONE RULE IS THE COMPOSER'S (TripStructureComposer.tsx, its stage form):
 * the picked place's own zone (a city row's binding, or a venue's, read through
 * `suggestionToPlace`), else the trip's, else the phone's — OFFERED, used only
 * on a tap, and labelled as the phone's.
 *
 * Pure module — no React, no network. node:test-safe.
 */
import type { PasteReviewItem } from '../../../platform/input-assistance/paste/pasteReview.ts';
import type { InputSuggestion } from '../../../platform/input-assistance/types/inputSuggestion.ts';
import { suggestionToPlace } from '../../../platform/input-assistance/geographic/geoSuggestions.ts';
import {
  readClock, readDay, todayIn, usableZone, wallTimeToInstant, dateMs,
  type ClockTime, type DayChoiceReason, type TripWindow,
} from '../../../platform/input-assistance/paste/itineraryTimes.ts';
import type { CommitmentInput } from './tripStructurePayloads.ts';

export type ZoneFrom = 'place' | 'trip' | 'device';

/** What the person supplied for one stop. Each is an explicit tap. */
export interface StopFix {
  meridiem?: 'am' | 'pm';
  /** 'YYYY-MM-DD', one of the offered days. */
  date?: string;
  /** The phone's zone, taken on a tap. */
  deviceZone?: string;
  /** For a wall time that happens twice. */
  occurrence?: 'earlier' | 'later';
}

export type BlockReason =
  | 'server'           // the extract route could not check this line (fixed copy in `detail`)
  | 'no_place'         // matched, but nothing a stop can use
  | 'no_time'          // the line carries no time
  | 'unreadable_time'  // "25:00"
  | 'skipped_time'     // the clocks skip that wall time on that day
  | 'bad_zone'         // this runtime cannot compute times in the zone
  | 'no_days';         // a day is needed and the trip has none to choose from

export type StopState =
  | { kind: 'ready'; startsAt: string; date: string; time: ClockTime; zone: string; zoneFrom: ZoneFrom }
  | { kind: 'hold'; need: 'meridiem'; am: ClockTime; pm: ClockTime }
  | { kind: 'hold'; need: 'zone'; deviceZone: string | null }
  | { kind: 'hold'; need: 'date'; why: DayChoiceReason; options: string[]; zone: string }
  | { kind: 'hold'; need: 'occurrence'; earlier: string; later: string; date: string; zone: string }
  | { kind: 'blocked'; why: BlockReason; detail: string | null };

export interface ProposedStop {
  index: number;
  /** The matched place's label — what the person recognises the line by. */
  title: string;
  subtitle: string | null;
  /** The day heading and time as pasted, shown beside what they were read as. */
  pastedDay: string | null;
  pastedTime: string | null;
  /** Some sources could not be checked: shown, never pre-ticked. */
  partial: boolean;
  state: StopState;
}

export interface ProposalContext {
  tripTimezone: string | null;
  /** The trip's first and last day; null when the trip read failed. */
  trip: TripWindow | null;
  /** True when the trip read failed — said as such, never as "this trip has no dates". */
  tripUnreadable?: boolean;
  now: Date;
  /** The phone's zone, OFFERED for a stop with none — never applied unseen. */
  deviceZone: string | null;
}

/** The candidate a stop is read from: the first one that maps to a Place. */
function usableCandidate(item: PasteReviewItem): { c: InputSuggestion; zone: string | null } | null {
  for (const c of item.candidates) {
    const place = suggestionToPlace(c);
    if (place) return { c, zone: usableZone(place.timezone) };
  }
  return null;
}

function blocked(why: BlockReason, detail: string | null = null): StopState {
  return { kind: 'blocked', why, detail };
}

/** One item → one stop's state, applying the person's fixes. Pure. */
export function stopState(item: PasteReviewItem, ctx: ProposalContext, fix: StopFix = {}): StopState {
  if (item.status === 'failed' || item.status === 'unsupported') return blocked('server', item.reason);
  const pick = item.status === 'resolved' ? usableCandidate(item) : null;
  if (!pick) return blocked('no_place');
  if (!item.timeHint) return blocked('no_time');

  const clock = readClock(item.timeHint);
  if (clock.kind === 'unreadable') return blocked('unreadable_time');
  let time: ClockTime;
  if (clock.kind === 'exact') time = clock.time;
  else if (fix.meridiem) time = fix.meridiem === 'am' ? clock.am : clock.pm;
  else return { kind: 'hold', need: 'meridiem', am: clock.am, pm: clock.pm };

  const tripZone = usableZone(ctx.tripTimezone);
  const phoneZone = usableZone(fix.deviceZone);
  const zone = pick.zone ?? tripZone ?? phoneZone;
  const zoneFrom: ZoneFrom = pick.zone ? 'place' : tripZone ? 'trip' : 'device';
  if (!zone) return { kind: 'hold', need: 'zone', deviceZone: usableZone(ctx.deviceZone) };

  let date: string;
  if (fix.date && dateMs(fix.date) !== null) {
    date = fix.date;
  } else {
    const day = readDay(item.dayLabel, ctx.trip, todayIn(zone, ctx.now));
    if (day.kind === 'choose') {
      if (day.options.length === 0) return blocked('no_days', ctx.tripUnreadable ? 'unreadable' : null);
      return { kind: 'hold', need: 'date', why: day.why, options: day.options, zone };
    }
    date = day.date;
  }

  const instant = wallTimeToInstant(date, time, zone);
  switch (instant.kind) {
    case 'exact':
      return { kind: 'ready', startsAt: instant.iso, date, time, zone, zoneFrom };
    case 'twice':
      if (fix.occurrence) return { kind: 'ready', startsAt: fix.occurrence === 'earlier' ? instant.earlier : instant.later, date, time, zone, zoneFrom };
      return { kind: 'hold', need: 'occurrence', earlier: instant.earlier, later: instant.later, date, zone };
    case 'skipped':
      return blocked('skipped_time');
    default:
      return blocked('bad_zone');
  }
}

/** Every item of the extraction as a proposed stop, in paste order. */
export function proposeStops(items: readonly PasteReviewItem[], ctx: ProposalContext, fixes: Readonly<Record<number, StopFix>> = {}): ProposedStop[] {
  return items.map((item) => {
    const pick = item.status === 'resolved' ? usableCandidate(item) : null;
    return {
      index: item.index,
      title: pick?.c.label ?? item.query ?? item.raw,
      subtitle: pick?.c.subtitle ?? null,
      pastedDay: item.dayLabel,
      pastedTime: item.timeHint,
      partial: item.partial,
      state: stopState(item, ctx, fixes[item.index]),
    };
  });
}

/** What is ticked before the person touches anything: ready, complete answers only. */
export function initiallyTicked(stops: readonly ProposedStop[]): Record<number, boolean> {
  const out: Record<number, boolean> = {};
  for (const s of stops) if (s.state.kind === 'ready' && !s.partial) out[s.index] = true;
  return out;
}

export interface BatchChoice {
  /** One of COMMITMENT_TYPES; null until the person picks — the composer pre-selects no type either. */
  type: string | null;
  flexibility: string;
  stageId: string | null;
}

/**
 * The composer's commitment input for one READY stop — the only shape this
 * proposal sends. Null for a stop that is not ready or a batch with no type.
 */
export function commitmentInputFor(stop: ProposedStop, batch: BatchChoice): CommitmentInput | null {
  if (stop.state.kind !== 'ready' || !batch.type) return null;
  return { type: batch.type, flexibility: batch.flexibility, stageId: batch.stageId, startsAt: stop.state.startsAt };
}

/** Plain words for a stop that cannot be added here. */
export function blockWords(state: Extract<StopState, { kind: 'blocked' }>, zoneHint?: string): string {
  switch (state.why) {
    case 'server': return state.detail ?? 'We couldn’t check this line.';
    case 'no_place': return 'Matched, but not to a place a stop can use.';
    case 'no_time': return 'No time in this line. This adds timed stops only.';
    case 'unreadable_time': return 'That time couldn’t be read.';
    case 'skipped_time': return `The clocks skip that time on that day${zoneHint ? ` in ${zoneHint}` : ''}.`;
    case 'bad_zone': return 'This phone can’t work out times in that place’s time zone.';
    case 'no_days': return state.detail === 'unreadable' ? 'Which day? This trip’s dates couldn’t be read.' : 'Which day? This trip has no dates to choose from.';
  }
}

/** Plain words for why a day is needed. */
export function dayChoiceWords(why: DayChoiceReason, pasted: string | null): string {
  switch (why) {
    case 'no_label': return 'Which day?';
    case 'unrecognised': return `Which day is “${pasted ?? ''}”?`;
    case 'weekday_none': return `No ${pasted ?? 'such day'} falls in this trip’s dates. Which day?`;
    case 'weekday_many': return `This trip has more than one ${pasted ?? 'such day'}. Which one?`;
    case 'day_outside': return `${pasted ?? 'That day'} is outside this trip’s dates. Which day?`;
    case 'weekend': return 'Which day of the weekend?';
    case 'no_trip_dates': return 'Which day? This trip has no dates to choose from.';
  }
}
