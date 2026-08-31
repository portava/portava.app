/**
 * intentModel — Intent Mode's temporary context (Map spec §13).
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ==========================================
 * Spec §13, first sentence:
 *
 *     "Intent Mode represents temporary context, not a permanent preference
 *      rewrite."
 *
 * and, four lines later:
 *
 *     "Intent should carry a TTL or be cleared explicitly."
 *
 * Everything here follows from that. A `TemporaryIntent` is a dated, expiring
 * object. It is a SEPARATE input to ranking, alongside the user's stored
 * preferences — never merged into them, never used to mutate them. The §13
 * pipeline is:
 *
 *     UserPreferences + TemporaryIntent + CurrentContext + TripContext
 *       + LiveWorld  →  Discovery Candidates  →  Compass Ranking
 *       →  Map Projection
 *
 * Note the `+`. `UserPreferences` and `TemporaryIntent` are two addends, not
 * one merged blob. If "I want to party tonight" quietly became "this user
 * likes nightlife", a single Friday would rewrite the map they see for months.
 * That failure is silent — nothing errors, the recommendations simply drift —
 * which is exactly why the TTL and the non-merging are treated here as the
 * primary requirement rather than as a detail.
 *
 * The second half of the rule is expiry HYGIENE. It is not enough to store an
 * `expiresAt`; every read path must honour it. `activeIntent()` is the only
 * blessed accessor and returns `null` past expiry, and
 * `intentToRankingContext()` routes through it, so a stale intent cannot leak
 * into ranking even if a caller forgot to check.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure data + pure functions. No storage, no network, no React, no clock of
 * its own — every time-dependent function takes `now` explicitly so behaviour
 * at the expiry boundary is testable rather than flaky. Persisting the intent
 * (and, more importantly, NOT persisting it into the preference record) is the
 * caller's job.
 */

// ── Intent kinds (spec §13) ────────────────────────────────────────────────────

/**
 * The nine primary intents, in the spec's own order:
 * "I'm Bored, Eat, Party, Explore, Meet People, Date Night, Chill, Local,
 *  Surprise Me."
 */
export const MAP_INTENT_KINDS = [
  'bored',
  'eat',
  'party',
  'explore',
  'meet_people',
  'date_night',
  'chill',
  'local',
  'surprise_me',
] as const;

export type MapIntentKind = (typeof MAP_INTENT_KINDS)[number];

/** Display labels, verbatim from §13. */
export const MAP_INTENT_LABELS: Record<MapIntentKind, string> = {
  bored: "I'm Bored",
  eat: 'Eat',
  party: 'Party',
  explore: 'Explore',
  meet_people: 'Meet People',
  date_night: 'Date Night',
  chill: 'Chill',
  local: 'Local',
  surprise_me: 'Surprise Me',
};

/** One-line hint shown under each tile so the nine choices read distinctly. */
export const MAP_INTENT_HINTS: Record<MapIntentKind, string> = {
  bored: 'Anything happening right now',
  eat: 'Food, close and open now',
  party: 'Nightlife and high energy',
  explore: 'Walkable discovery nearby',
  meet_people: 'Places people gather',
  date_night: 'Somewhere worth the evening',
  chill: 'Quiet, low-key spots',
  local: 'Where locals actually go',
  surprise_me: 'One unexpected pick',
};

export function isMapIntentKind(value: unknown): value is MapIntentKind {
  return typeof value === 'string' && (MAP_INTENT_KINDS as readonly string[]).includes(value);
}

// ── The two continuous controls (spec §13) ─────────────────────────────────────

/**
 * §13 gives two axes: "Energy control: Low ↔ High" and "Future novelty
 * control: Familiar ↔ Adventurous".
 *
 * Both are a bounded 0…1 scale. 0…1 rather than 0…100 because these are
 * WEIGHTS handed to a ranker, not scores shown to a user — a ranker that
 * multiplies by 0.8 is obviously reading a weight, whereas one that multiplies
 * by 80 invites a stray factor of 100. The bounds are closed and enforced:
 * anything outside is clamped, so a bad caller can bias ranking but can never
 * blow past the ends of the scale.
 *
 * 0.5 is the neutral midpoint and the default for both axes — "I picked an
 * intent but did not touch the sliders" must not silently read as "low energy".
 */
export const INTENT_SCALE_MIN = 0;
export const INTENT_SCALE_MAX = 1;
export const INTENT_SCALE_DEFAULT = 0.5;

/**
 * Clamp a slider value into [0, 1].
 *
 * THROWS on non-finite input rather than substituting a default. NaN here means
 * a caller did arithmetic on `undefined` somewhere upstream; silently healing
 * it to 0.5 would hide that bug behind subtly wrong recommendations forever.
 * Boundaries that legitimately receive junk (storage rehydration, a wire
 * payload) should call `parseIntent`, which rejects instead of throwing.
 */
export function clampScale(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`intent scale must be a finite number, received ${String(value)}`);
  }
  if (value < INTENT_SCALE_MIN) return INTENT_SCALE_MIN;
  if (value > INTENT_SCALE_MAX) return INTENT_SCALE_MAX;
  return value;
}

/** Non-throwing predicate for validation at untrusted boundaries. */
export function isValidScale(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= INTENT_SCALE_MIN &&
    value <= INTENT_SCALE_MAX
  );
}

// ── TTL policy (spec §13: "Intent should carry a TTL or be cleared explicitly") ─

/**
 * The baseline lifetime of an intent, in minutes.
 *
 * 120 minutes. Rationale: an intent answers "what do I want RIGHT NOW", and the
 * honest half-life of that answer is roughly one outing — long enough to walk
 * somewhere, look around, change your mind and look again; short enough that an
 * intent nobody cleared has aged out before the next meal, let alone the next
 * day. The failure mode we are pricing is asymmetric: an intent that expires
 * slightly too early costs one extra tap, while one that expires too late
 * quietly mis-ranks the map with yesterday's mood.
 */
export const DEFAULT_INTENT_TTL_MINUTES = 120;

/**
 * Per-intent overrides. Only where §13's own semantics demand a different
 * lifetime — every entry carries its reason, because an unexplained TTL is how
 * "temporary" turns into "permanent" one commit at a time.
 */
export const INTENT_TTL_MINUTES: Record<MapIntentKind, number> = {
  /**
   * 60. Boredom is self-resolving: the moment the user acts on anything, the
   * intent is spent. A long-lived "I'm bored" would keep injecting novelty
   * bias after the user has plainly stopped being bored.
   */
  bored: 60,

  /**
   * 90. A meal decision resolves fast and then is FLATLY wrong — nobody wants
   * the map still optimising for lunch while they eat it. Slightly longer than
   * the decision itself to cover the walk and a change of mind.
   */
  eat: 90,

  /**
   * 300 (5h), and additionally evening-bounded (see EVENING_BOUND_INTENTS).
   * §13 lists Party as a primary intent and nightlife genuinely runs five
   * hours; the hard stop that matters is not elapsed time but daybreak, which
   * the evening bound supplies. Without that bound, an intent set at 23:00
   * would still be shaping the breakfast map.
   */
  party: 300,

  /** 180. Exploring is an afternoon-shaped activity; three hours is one. */
  explore: 180,

  /**
   * 180. Wanting to meet people persists across several venues, but it is
   * still an outing, not a personality trait — which is precisely the
   * confusion §13 forbids.
   */
  meet_people: 180,

  /**
   * 240 (4h), and evening-bounded. A date night spans dinner plus what
   * follows. Evening-bounded for the same reason as Party: "date night" that
   * survives into the next morning is no longer a date night, and it is the
   * intent most likely to distort long-run recommendations if it leaked into
   * stored preferences.
   */
  date_night: 240,

  /** 120. No reason to differ from the baseline; a chill mood is outing-shaped. */
  chill: DEFAULT_INTENT_TTL_MINUTES,

  /**
   * 240 (4h). "Local" is a lens on the whole day's wandering rather than a
   * single decision, so it earns a longer — but still bounded — life.
   */
  local: 240,

  /**
   * 30. Surprise Me is ONE roll of the dice. It is the intent most at odds
   * with §13's warning, because a persistent "surprise me" would permanently
   * bias the ranker toward novelty and look exactly like a preference change.
   * Short enough to be a gesture, not a setting.
   */
  surprise_me: 30,
};

/**
 * Intents whose meaning is tied to an evening rather than to elapsed time.
 * For these, expiry is additionally capped at the next local
 * EVENING_END_HOUR — whichever comes first, the TTL or daybreak.
 */
export const EVENING_BOUND_INTENTS: readonly MapIntentKind[] = ['party', 'date_night'];

/**
 * 04:00 LOCAL time is treated as the end of "tonight" — late enough that a
 * genuine night out is not cut short, early enough that no morning is served
 * last night's intent. Local, not UTC: "the evening" is a wall-clock idea, and
 * a traveller crossing time zones should get the evening they are standing in.
 */
export const EVENING_END_HOUR = 4;

/**
 * Absolute ceiling on any intent lifetime, including explicit `ttlMinutes`
 * overrides. 360 minutes (6h). Nothing may opt out of §13 by requesting a
 * week-long "temporary" intent — that is a preference rewrite wearing a TTL.
 */
export const MAX_INTENT_TTL_MINUTES = 360;

/**
 * Floor on any intent lifetime. 15 minutes. Guards the evening bound: an
 * intent set at 03:58 must not expire two minutes later and leave the user
 * tapping the same tile over and over.
 */
export const MIN_INTENT_TTL_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

/** The TTL that applies to a kind before the evening bound and clamps. */
export function ttlMinutesFor(kind: MapIntentKind): number {
  return INTENT_TTL_MINUTES[kind] ?? DEFAULT_INTENT_TTL_MINUTES;
}

/** The next local wall-clock occurrence of `hour`, strictly after `from`. */
function nextLocalHour(from: Date, hour: number): Date {
  const d = new Date(from.getTime());
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Resolve the absolute expiry instant for a new intent.
 *
 * Order of operations, and each step's job:
 *   1. requested TTL (explicit override, else the per-kind policy)
 *   2. clamp to [MIN, MAX]                  — nothing escapes §13's bound
 *   3. evening bound for evening intents    — cap at the next local 04:00
 *   4. re-apply the MIN floor               — so step 3 can't produce a stub
 */
export function resolveExpiry(kind: MapIntentKind, setAt: Date, requestedTtlMinutes?: number): Date {
  let minutes = ttlMinutesFor(kind);
  if (requestedTtlMinutes !== undefined) {
    if (typeof requestedTtlMinutes !== 'number' || !Number.isFinite(requestedTtlMinutes)) {
      throw new RangeError(
        `ttlMinutes must be a finite number, received ${String(requestedTtlMinutes)}`,
      );
    }
    minutes = requestedTtlMinutes;
  }
  if (minutes > MAX_INTENT_TTL_MINUTES) minutes = MAX_INTENT_TTL_MINUTES;
  if (minutes < MIN_INTENT_TTL_MINUTES) minutes = MIN_INTENT_TTL_MINUTES;

  let expiry = new Date(setAt.getTime() + minutes * MS_PER_MINUTE);

  if (EVENING_BOUND_INTENTS.includes(kind)) {
    const eveningEnd = nextLocalHour(setAt, EVENING_END_HOUR);
    if (eveningEnd.getTime() < expiry.getTime()) expiry = eveningEnd;
  }

  const floor = setAt.getTime() + MIN_INTENT_TTL_MINUTES * MS_PER_MINUTE;
  if (expiry.getTime() < floor) expiry = new Date(floor);

  return expiry;
}

// ── The intent ─────────────────────────────────────────────────────────────────

/**
 * A single, expiring statement of what the user wants right now.
 *
 * `setAt` / `expiresAt` are ISO-8601 strings rather than Date objects so the
 * whole record is JSON-serializable without a custom reviver — it crosses the
 * store boundary, the cache boundary and (as a ranking context) the wire.
 *
 * There is deliberately NO `sticky`, `remember` or `persist` flag. §13 admits
 * exactly two ways an intent ends: it expires, or the user clears it.
 */
export interface TemporaryIntent {
  kind: MapIntentKind;
  /** Low ↔ High, 0…1. */
  energy: number;
  /** Familiar ↔ Adventurous, 0…1. */
  novelty: number;
  /** ISO-8601 instant the intent was set. */
  setAt: string;
  /** ISO-8601 instant the intent stops counting. Never absent. */
  expiresAt: string;
}

export interface CreateIntentOptions {
  energy?: number;
  novelty?: number;
  /**
   * Override the per-kind TTL. Still clamped to
   * [MIN_INTENT_TTL_MINUTES, MAX_INTENT_TTL_MINUTES] and still subject to the
   * evening bound — an override tunes the lifetime, it does not remove it.
   */
  ttlMinutes?: number;
}

/**
 * Build a fresh intent. Pure: no storage, no side effects, and `now` is passed
 * in rather than read from the ambient clock.
 */
export function createIntent(
  kind: MapIntentKind,
  opts: CreateIntentOptions = {},
  now: Date = new Date(),
): TemporaryIntent {
  if (!isMapIntentKind(kind)) {
    throw new RangeError(`unknown intent kind: ${String(kind)}`);
  }
  const setAt = new Date(now.getTime());
  const energy = clampScale(opts.energy ?? INTENT_SCALE_DEFAULT);
  const novelty = clampScale(opts.novelty ?? INTENT_SCALE_DEFAULT);
  const expiresAt = resolveExpiry(kind, setAt, opts.ttlMinutes);

  return {
    kind,
    energy,
    novelty,
    setAt: setAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Adjust the two sliders WITHOUT restarting the clock.
 *
 * Nudging Energy is a refinement of the intent already running, not a new
 * intent — renewing the TTL on every slider drag would let a user hold an
 * intent alive indefinitely by fidgeting, which is the slow version of the
 * permanence §13 forbids.
 */
export function withScales(
  intent: TemporaryIntent,
  scales: { energy?: number; novelty?: number },
): TemporaryIntent {
  return {
    ...intent,
    energy: scales.energy === undefined ? intent.energy : clampScale(scales.energy),
    novelty: scales.novelty === undefined ? intent.novelty : clampScale(scales.novelty),
  };
}

// ── Expiry ─────────────────────────────────────────────────────────────────────

/**
 * Has this intent aged out?
 *
 * The boundary is INCLUSIVE: at exactly `expiresAt` the intent is already
 * expired. Fail-closed — when the two readings are indistinguishable, the
 * choice that cannot corrupt ranking is "gone".
 *
 * A malformed or missing `expiresAt` also reads as expired, for the same
 * reason: an intent whose lifetime cannot be established has no business
 * influencing the map.
 */
export function isExpired(intent: TemporaryIntent | null | undefined, now: Date = new Date()): boolean {
  if (!intent) return true;
  const expiry = Date.parse(intent.expiresAt);
  if (!Number.isFinite(expiry)) return true;
  return now.getTime() >= expiry;
}

/**
 * THE blessed accessor. Returns the intent only while it is still live, and
 * `null` the instant it is not.
 *
 * Every read path — ranking, the "why this option" line, the sheet's own
 * display — goes through here, so a stale intent cannot leak into the map
 * because one call site forgot to check a timestamp.
 */
export function activeIntent(
  intent: TemporaryIntent | null | undefined,
  now: Date = new Date(),
): TemporaryIntent | null {
  if (!intent) return null;
  return isExpired(intent, now) ? null : intent;
}

/**
 * The explicit-clear half of §13's "carry a TTL OR be cleared explicitly".
 *
 * A named function rather than a bare `null` at every call site: clearing is a
 * meaningful product action (the Clear button in IntentSheet, a mode exit, a
 * trip change) and it should read as one. It also gives the lead exactly one
 * symbol to search for when wiring the store.
 */
export function clearIntent(): null {
  return null;
}

/** Milliseconds left before expiry; 0 once expired (never negative). */
export function remainingMs(
  intent: TemporaryIntent | null | undefined,
  now: Date = new Date(),
): number {
  if (!intent) return 0;
  const expiry = Date.parse(intent.expiresAt);
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, expiry - now.getTime());
}

/**
 * Human-readable countdown for the sheet's "clears in …" affordance.
 * The TTL must be VISIBLE — an invisible expiry is indistinguishable from a
 * preference change from the user's side of the screen.
 */
export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

// ── Describing an intent (spec §14) ────────────────────────────────────────────

/** Band labels for the Energy axis, low → high. */
export function energyLabel(energy: number): string {
  const v = clampScale(energy);
  if (v < 0.2) return 'Very low energy';
  if (v < 0.4) return 'Low energy';
  if (v <= 0.6) return 'Balanced energy';
  if (v <= 0.8) return 'High energy';
  return 'Very high energy';
}

/** Band labels for the Novelty axis, familiar → adventurous. */
export function noveltyLabel(novelty: number): string {
  const v = clampScale(novelty);
  if (v < 0.2) return 'Very familiar';
  if (v < 0.4) return 'Familiar';
  if (v <= 0.6) return 'Balanced novelty';
  if (v <= 0.8) return 'Adventurous';
  return 'Very adventurous';
}

/**
 * The §14 "WHY THIS OPTION" line — the spec's own example is
 * "Matches current Party intent".
 *
 * Returns `null` for a missing OR expired intent, so the explanation panel can
 * never claim a recommendation matches an intent that is no longer in force.
 * A "why" that cites a dead reason is worse than no "why" at all.
 */
export function describeIntent(
  intent: TemporaryIntent | null | undefined,
  now: Date = new Date(),
): string | null {
  const live = activeIntent(intent, now);
  if (!live) return null;
  return [
    `Matches current ${MAP_INTENT_LABELS[live.kind]} intent`,
    energyLabel(live.energy),
    noveltyLabel(live.novelty),
  ].join(' · ');
}

// ── The ranking context (spec §13 pipeline) ────────────────────────────────────

/**
 * The plain, serializable object the Discovery/Compass pipeline receives as its
 * `TemporaryIntent` addend.
 *
 * `source` and `ephemeral` are carried on the wire on purpose: whatever
 * consumes this can see, without reading this file, that the payload is a
 * temporary signal and not a preference record.
 */
export interface IntentRankingContext {
  source: 'temporary_intent';
  /** null when there is no live intent — an explicit "no intent", not absence. */
  kind: MapIntentKind | null;
  energy: number | null;
  novelty: number | null;
  setAt: string | null;
  expiresAt: string | null;
  /** Time left at the moment the context was built; 0 when there is no intent. */
  ttlRemainingMs: number;
  /** Always true. A constant, not a flag — there is no non-ephemeral variant. */
  ephemeral: true;
}

/**
 * Project an intent into the ranking pipeline's input.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS FUNCTION MUST NOT MERGE INTO, READ, OR MUTATE STORED PREFERENCES.   │
 * │                                                                          │
 * │ It takes an intent and returns a NEW object. It does not accept a        │
 * │ preference record, so it cannot write to one; it shares no reference     │
 * │ with its input, so a downstream mutation of the returned context cannot  │
 * │ reach back into the stored intent. §13's whole point is that             │
 * │ UserPreferences and TemporaryIntent are two separate addends to the      │
 * │ ranker — merging them here would silently convert one evening's mood     │
 * │ into a permanent taste, and nothing would ever report the error.         │
 * │                                                                          │
 * │ If a future caller needs "preferences plus intent", it composes the two  │
 * │ at the ranker, per-request. It does not fold one into the other here.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Expiry is enforced on this path too: an expired intent projects to the empty
 * context, so no stale kind can reach Compass ranking even if the store still
 * holds the record.
 */
export function intentToRankingContext(
  intent: TemporaryIntent | null | undefined,
  now: Date = new Date(),
): IntentRankingContext {
  const live = activeIntent(intent, now);
  if (!live) {
    return {
      source: 'temporary_intent',
      kind: null,
      energy: null,
      novelty: null,
      setAt: null,
      expiresAt: null,
      ttlRemainingMs: 0,
      ephemeral: true,
    };
  }
  // Every field is copied by value; the returned object shares no reference
  // with `intent` (strings and numbers are immutable primitives in JS).
  return {
    source: 'temporary_intent',
    kind: live.kind,
    energy: live.energy,
    novelty: live.novelty,
    setAt: live.setAt,
    expiresAt: live.expiresAt,
    ttlRemainingMs: remainingMs(live, now),
    ephemeral: true,
  };
}

// ── Untrusted-boundary parsing ─────────────────────────────────────────────────

/**
 * Rehydrate an intent from storage or a wire payload.
 *
 * Returns `null` for anything malformed instead of throwing, because the
 * caller at these boundaries has exactly one sensible recovery — treat it as
 * "no intent" — and because a corrupt cache entry must not crash the map.
 * Note this does NOT check expiry: parsing and expiry are separate concerns,
 * and `activeIntent` is still the accessor that decides whether it counts.
 */
export function parseIntent(raw: unknown): TemporaryIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isMapIntentKind(r.kind)) return null;
  if (!isValidScale(r.energy) || !isValidScale(r.novelty)) return null;
  if (typeof r.setAt !== 'string' || !Number.isFinite(Date.parse(r.setAt))) return null;
  if (typeof r.expiresAt !== 'string' || !Number.isFinite(Date.parse(r.expiresAt))) return null;
  return {
    kind: r.kind,
    energy: r.energy,
    novelty: r.novelty,
    setAt: r.setAt,
    expiresAt: r.expiresAt,
  };
}
