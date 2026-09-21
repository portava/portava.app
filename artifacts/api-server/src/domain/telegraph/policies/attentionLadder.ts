/**
 * Telegraph §19 — Notifications & Attention, as an ORDER rather than a set of
 * labels.
 *
 * §19's table, verbatim:
 *   P0 Safety      SOS, safety escalation           Interruptive; bypass ordinary batching where policy requires.
 *   P1 Coordination Meetup moved, pickup, return state  Immediate/high priority.
 *   P2 Message     Normal direct/group messages     Standard notification policy.
 *   P3 Media       Large upload completion          Passive/batched.
 *   P4 Ephemeral   Typing, lightweight presence     Realtime only; no persistent push.
 *   P5 AI          Summaries/suggestions            Lowest priority; degrade first.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * census-telegraph T255 measured the exact defect: `important` "exists and is
 * used for coordination-shaped events but it carries NO DELIVERY DIFFERENCE
 * from `normal` — only `urgent` changes behaviour. It is a label, not a
 * priority." Re-read before this file was written and still true, and now worse
 * than the census recorded: `telegraph.message` — §19's P2 — is ALSO
 * `defaultPriority: 'important'`, so the one label the coordination band uses is
 * shared with the band below it and cannot distinguish them even in principle.
 *
 * A priority that changes nothing is a comment. So this file makes the bands
 * differ in the one dimension a notification system can differ in without
 * overriding a user's own settings: HOW LONG A SIMILAR NOTIFICATION SUPPRESSES
 * THE NEXT ONE.
 *
 * WHY SUPPRESSION AND NOT DELIVERY
 * ================================
 * The tempting difference is "P1 bypasses quiet hours". That would be wrong.
 * `NotificationPreferenceService` already draws that line deliberately at
 * `urgent` + `admin` and its header says so: "important priority alone does NOT
 * bypass user preferences". A meetup moving is not a reason to wake somebody at
 * 3am, and building a second override would make the first one meaningless.
 *
 * What P1 legitimately needs is not to be SWALLOWED. Two coordination events
 * twenty minutes apart say two different things about the world — "the meetup
 * moved to 8" and then "the meetup moved to the other bar" — and the general
 * 30-minute dedupe suppressed the second. A P2 message burst, by contrast,
 * SHOULD coalesce: ten messages in a thread are one thing to look at.
 *
 * So the ladder's dimension is the dedupe window, and the shape of the answer
 * is the shape of §19's table: P0 is never suppressed, P1 barely, P2 coalesces,
 * P3 batches hard, P5 is already daily-limited elsewhere.
 *
 * P4 IS NOT IN THE WINDOW TABLE, AND THAT IS THE POINT
 * ===================================================
 * §19's P4 is "realtime only; no persistent push". A dedupe window for it would
 * imply there is something to dedupe — a persisted notification. There is not,
 * and there is deliberately no template for typing anywhere in this repository
 * (census T258 is BUILT-AND-CORRECT for exactly that reason, and it was
 * re-read before this file was written).
 *
 * So P4's window is `null`, and `typing.started` / `typing.stopped` — the two
 * names the telegraph event bus actually uses — are listed in the band. That
 * turns an ABSENCE into a REFUSAL: `NotificationDeduplicationService.check()`
 * answers `ephemeral_not_persisted` for them rather than relying on nobody ever
 * calling it with one, and this file's test asserts a P4 event has NO
 * notification template, so adding one is a failing test rather than a push.
 */

/** §19's six bands, in §19's order. */
export const ATTENTION_BANDS = [
  "P0_SAFETY",
  "P1_COORDINATION",
  "P2_MESSAGE",
  "P3_MEDIA",
  "P4_EPHEMERAL",
  "P5_AI",
] as const;
export type AttentionBand = (typeof ATTENTION_BANDS)[number];

export interface BandPolicy {
  band: AttentionBand;
  /** §19's own description, so the table and the code cannot drift apart. */
  behaviour: string;
  /**
   * How long an equivalent notification suppresses the next one, in ms.
   * `0` means never suppressed. `null` means the band is not persisted at all.
   */
  dedupeWindowMs: number | null;
  /** May a notification in this band ever be delivered only in a daily digest? */
  digestible: boolean;
  /** Is a notification in this band written to `notifications` at all? */
  persisted: boolean;
}

export const BAND_POLICY: Readonly<Record<AttentionBand, BandPolicy>> = {
  P0_SAFETY: {
    band: "P0_SAFETY",
    behaviour: "Interruptive; bypass ordinary batching where policy requires.",
    // NEVER suppressed. A second SOS is not a duplicate of the first, and the
    // cost of being wrong in the other direction is unbounded.
    dedupeWindowMs: 0,
    digestible: false,
    persisted: true,
  },
  P1_COORDINATION: {
    band: "P1_COORDINATION",
    behaviour: "Immediate/high priority.",
    // Sixty seconds: long enough to swallow a double-tap on Save, short enough
    // that two real changes to a plan both arrive.
    dedupeWindowMs: 60 * 1000,
    digestible: false,
    persisted: true,
  },
  P2_MESSAGE: {
    band: "P2_MESSAGE",
    behaviour: "Standard notification policy.",
    // Five minutes — the existing message coalescing window, unchanged. A burst
    // of messages in one thread is one thing to look at.
    dedupeWindowMs: 5 * 60 * 1000,
    digestible: false,
    persisted: true,
  },
  P3_MEDIA: {
    band: "P3_MEDIA",
    behaviour: "Passive/batched.",
    // Fifteen minutes. "Batched" in §19 means a person who uploads eight photos
    // is told once, and a longer window is what "batched" is.
    dedupeWindowMs: 15 * 60 * 1000,
    digestible: true,
    persisted: true,
  },
  P4_EPHEMERAL: {
    band: "P4_EPHEMERAL",
    behaviour: "Realtime only; no persistent push.",
    dedupeWindowMs: null,
    digestible: false,
    persisted: false,
  },
  P5_AI: {
    band: "P5_AI",
    behaviour: "Lowest priority; degrade first.",
    // Deliberately the longest persisted window. §17.4 puts AI first on the
    // degradation ladder and §19 says it degrades first; a long suppression
    // window is what "lowest priority" means when nothing else may change.
    dedupeWindowMs: 60 * 60 * 1000,
    digestible: true,
    persisted: true,
  },
};

/**
 * Which notification event type belongs to which band.
 *
 * EVERY NAME HERE WAS READ OFF `NotificationTemplateService.TEMPLATES`, not
 * recalled. The first draft of this map named `meetup.time_changed`,
 * `meetup.location_changed` and `trip.plan_changed` — none of which exist in
 * this repository; the real "a meetup moved" event is
 * `circle.meeting_point_updated`. A band keyed on an event type nothing can
 * ever emit is a policy that silently does nothing, so
 * `telegraphAttentionLadder.test.ts` asserts every key here either HAS a
 * template or is named in `DECLARED_NOT_EMITTED` below.
 *
 * An event type not listed here is NOT in the ladder and keeps exactly the
 * behaviour it had: this policy narrows nothing by accident, and a band it does
 * not claim is a band it does not affect. That is why `admin.*` and
 * `rent_buddy.*` are absent though they carry `urgent`, why `compass.sense.*`
 * is absent though a circle plan change is coordination-shaped (it belongs to
 * the Sensing surface, whose own cadence rules govern it), and why the many
 * `low`-priority events are absent: unclaimed is the safe answer.
 */
export const EVENT_BAND: Readonly<Record<string, AttentionBand>> = {
  // P0 — safety. Every one of these already carries `urgent` and already
  // overrides quiet hours in NotificationPreferenceService; what the ladder
  // adds is that they are never SUPPRESSED as duplicates of each other.
  "safe_return.reminder": "P0_SAFETY",              // NotificationTemplateService.ts:246
  "safe_return.missed": "P0_SAFETY",                // :255
  "safe_return.trusted_circle_alert": "P0_SAFETY",  // :264
  "safe_return.check_in_prompt": "P0_SAFETY",       // :682
  "circle.need_help_host_alert": "P0_SAFETY",       // :986

  // P1 — §19's own three examples, each matched to the event that IS it:
  //   "meetup moved"  -> circle.meeting_point_updated  (the host moved it)
  //   "pickup"        -> trip.departure_reminder       (be somewhere, at a time)
  //   "return state"  -> safe_return.cleared           (they are back)
  // Nothing else is claimed for P1. An invite is not a plan changing under
  // someone who already made arrangements around it, which is the specific harm
  // a 30-minute swallow does here.
  "circle.meeting_point_updated": "P1_COORDINATION", // :974
  "trip.departure_reminder": "P1_COORDINATION",      // :640
  "safe_return.cleared": "P1_COORDINATION",          // :271

  // P2 — ordinary conversation. The window is 5 minutes, which is the window
  // telegraph.message already had; the point is that P1 above is now SHORTER
  // than this rather than four times longer.
  "telegraph.message": "P2_MESSAGE",         // :215
  "telegraph.message_request": "P2_MESSAGE", // :224
  "telegraph.mention": "P2_MESSAGE",         // :651
  "telegraph.reaction": "P2_MESSAGE",        // :660
  "trip.crew_message": "P2_MESSAGE",         // :631

  // P3 — §19's "large upload completion". DECLARED, NOT EMITTED: there is no
  // template for it and nothing sends it, because the server does not observe
  // how long an upload took or whether the app was backgrounded, and inventing
  // the signal would be worse than not having it. The band is here so the
  // batching behaviour already exists on the day something does emit it.
  "telegraph.media_ready": "P3_MEDIA",

  // P4 — realtime only. These two are NOT notification templates and must
  // never become them: they are the telegraph event bus's typing relay
  // (lib/telegraphEvents.ts) and §19 says ephemeral presence gets no persistent
  // push. Listing them here turns "there happens to be no typing template" into
  // an enforced refusal — NotificationDeduplicationService.check() answers
  // `ephemeral_not_persisted` for them — and the ladder's test asserts a P4
  // event has NO template, so adding one is a failing test rather than a push.
  "typing.started": "P4_EPHEMERAL",
  "typing.stopped": "P4_EPHEMERAL",

  // P5 — AI. §17.4 degrades AI first and §19 calls it lowest priority; the
  // longest persisted window is what that means when delivery may not change.
  "telegraph.ai_suggestion": "P5_AI",  // :233
  "compass.recommendation": "P5_AI",   // :363
};

/** The band an event type belongs to, or null when the ladder does not claim it. */
export function bandFor(eventType: string | null | undefined): AttentionBand | null {
  if (!eventType) return null;
  return EVENT_BAND[eventType] ?? null;
}

/**
 * The dedupe window for an event type, or `undefined` when the ladder does not
 * claim it — in which case the caller keeps its own default.
 *
 * `undefined` and `0` are different answers and the distinction is load-bearing:
 * `0` is "P0, never suppress"; `undefined` is "not my event, do what you did
 * before". Collapsing them would silently make every unclaimed event
 * unsuppressable.
 */
export function dedupeWindowFor(eventType: string | null | undefined): number | null | undefined {
  const band = bandFor(eventType);
  if (band === null) return undefined;
  return BAND_POLICY[band].dedupeWindowMs;
}

/** May this event type ever be delivered only inside a daily digest? */
export function isDigestible(eventType: string | null | undefined): boolean | undefined {
  const band = bandFor(eventType);
  if (band === null) return undefined;
  return BAND_POLICY[band].digestible;
}

/**
 * Event types declared in the ladder that nothing emits.
 *
 * Named rather than left to be discovered, so the census can score them as
 * declared-not-emitted instead of as built.
 */
export const DECLARED_NOT_EMITTED: readonly string[] = ["telegraph.media_ready"];
