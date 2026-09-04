/**
 * meetHereModel — the §25 "Meet Here" action, as data (spec §11, §23, §25).
 *
 * "Meet Here" is on the persistent action rail and in the long-press menu, but
 * nothing in the app created a meeting point, so the action had nowhere to go
 * and §35's `meet_here_created` had nothing honest to report.
 *
 * WHAT A MEETING POINT MAY PUBLISH
 * ================================
 * A meeting point is a location one person publishes to several others, which
 * makes it a §23 disclosure and not merely a UI affordance. The rung it
 * publishes at is therefore decided here, from what the subject already was —
 * never requested by the caller:
 *
 *   - An object the viewer already sees at `place_level` (a venue, an event)
 *     publishes at `place_level`: naming a bar everyone can already see on the
 *     map discloses nothing new.
 *   - An object at `approximate` publishes at `approximate`. The meeting point
 *     cannot be more precise than the thing it refers to.
 *   - Anything at `aggregate_only` or `none` CANNOT be a meeting point at all.
 *     "Meet me where those 18 travellers are" is not a place, and resolving it
 *     to a point would sharpen an aggregate — the one thing §19 forbids
 *     downstream of the projection.
 *   - A bare coordinate the user picked themselves publishes at `place_level`:
 *     it is the user's own choice about their own plan, and no one else's
 *     position was reduced to produce it.
 *
 * This module decides and shapes. It performs no I/O and creates nothing.
 */
import {
  centroidOf,
  mayRenderIdentity,
  narrowestPrivacyClass,
  precisionRank,
  type MapObject,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';

/** Who a meeting point is published to. Mirrors §35's audience vocabulary. */
export const MEET_AUDIENCES = ['crew', 'friends', 'group', 'buddy'] as const;
export type MeetAudience = (typeof MEET_AUDIENCES)[number];

/**
 * The ceiling a meeting point may ever publish at. `precise_temporary` is
 * deliberately unreachable: that rung exists for Safe Return and for a live
 * group session the user deliberately entered, not for a pin dropped on a map.
 */
export const MEET_POINT_CEILING: PrivacyClass = 'place_level';

/** Below this rung a subject is not a place, so it cannot anchor a meeting. */
export const MIN_SUBJECT_RUNG: PrivacyClass = 'approximate';

/** What the user chose to meet at: a map object, or a point they picked. */
export type MeetTarget =
  | { kind: 'object'; object: MapObject }
  | { kind: 'coordinate'; lat: number; lng: number; label?: string };

export interface MeetHereProposal {
  /** Human label for the meeting point. Never a raw coordinate pair. */
  title: string;
  /** The §23 rung this will publish at. */
  sharedAs: PrivacyClass;
  /** Anchor, for callers that need one. Null when the subject has no point. */
  anchor: { lat: number; lng: number } | null;
  /** The subject's id, when it was an object. */
  subjectId: string | null;
}

export type MeetHereDecision =
  | { ok: true; proposal: MeetHereProposal }
  | { ok: false; reason: MeetRefusalReason };

export type MeetRefusalReason =
  | 'aggregate_subject'
  | 'no_geometry'
  | 'not_visible';

export const MEET_REFUSAL_TEXT: Record<MeetRefusalReason, string> = {
  aggregate_subject:
    'This is an aggregate area, not a place — pick a specific spot to meet at.',
  no_geometry: 'This has no location to meet at.',
  not_visible: 'You can’t share this location.',
};

/**
 * Decide whether a target can anchor a meeting point, and at which rung.
 *
 * Fail-closed at every step: an unrecognised or missing privacy class is
 * treated as the aggregate case, not the permissive one.
 */
export function proposeMeetHere(target: MeetTarget): MeetHereDecision {
  if (target.kind === 'coordinate') {
    if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) {
      return { ok: false, reason: 'no_geometry' };
    }
    return {
      ok: true,
      proposal: {
        // A label, never "16.0500, 108.2000" — a meeting point people read.
        title: target.label?.trim() || 'Dropped pin',
        sharedAs: MEET_POINT_CEILING,
        anchor: { lat: target.lat, lng: target.lng },
        subjectId: null,
      },
    };
  }

  const obj = target.object;
  const cls: PrivacyClass = obj.privacyClass;

  if (cls === 'none') return { ok: false, reason: 'not_visible' };
  if (precisionRank(cls) < precisionRank(MIN_SUBJECT_RUNG)) {
    // aggregate_only: "meet where those 18 travellers are" is not a place, and
    // resolving it to a point would sharpen an aggregate.
    return { ok: false, reason: 'aggregate_subject' };
  }

  const anchor = centroidOf(obj.geometry);
  if (!anchor) return { ok: false, reason: 'no_geometry' };

  return {
    ok: true,
    proposal: {
      title: obj.title,
      // Narrowest of the subject's own rung and the meeting-point ceiling, so
      // this can only ever tighten.
      sharedAs: narrowestPrivacyClass(cls, MEET_POINT_CEILING),
      anchor,
      subjectId: obj.id,
    },
  };
}

/**
 * Whether a meeting point may name the people it is shared with in its title.
 * At `approximate` and below the subject is a ring rather than a venue, so a
 * title naming someone would attach a person to a place they only vaguely are.
 */
export function mayNameSubject(sharedAs: PrivacyClass): boolean {
  return mayRenderIdentity(sharedAs) && precisionRank(sharedAs) >= precisionRank('place_level');
}

/** The default audience for a target, when the caller has no better context. */
export function defaultAudienceFor(target: MeetTarget): MeetAudience {
  if (target.kind === 'coordinate') return 'friends';
  switch (target.object.kind) {
    case 'crew_member':
    case 'trip_stop':
    case 'meeting_point':
      return 'crew';
    case 'buddy_zone':
      return 'buddy';
    case 'event':
      return 'group';
    default:
      return 'friends';
  }
}
