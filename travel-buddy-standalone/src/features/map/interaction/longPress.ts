/**
 * longPress — the decision layer behind the §25 long-press menu.
 *
 * WHAT THIS IS
 * ============
 * Spec §25 lists seven long-press actions:
 *
 *     Meet here · Save location · Add to Trip · Ask Compass about here ·
 *     Share permitted location · Create checkpoint · Report what is here
 *
 * This module decides which of them are legal for a given press, and why the
 * rest are not. It is pure: no React, no navigation, no I/O. `MapLongPressMenu`
 * renders exactly what this returns and makes no decision of its own.
 *
 * THE PRESS IS A POINT, NOT AN OBJECT
 * ===================================
 * This is the one structural difference from the persistent rail
 * (components/map/MapBottomActions.tsx). The rail acts on the SELECTED OBJECT,
 * so it can read `interaction.actions` as its source of truth — with nothing
 * selected there is simply nothing to act on.
 *
 * A long-press acts on the POINT UNDER THE FINGER, which always exists. Empty
 * map is not the edge case here, it is the COMMON case: "Meet here" and
 * "Create checkpoint" are mostly pressed on a spot with no object at all. So
 * `LongPressTarget` models the bare coordinate as a first-class variant rather
 * than faking a `MapObject` for it, and `interaction.actions` cannot be the
 * source of availability — a coordinate has none, and demanding one would make
 * the common case offer nothing.
 *
 * An object under the finger therefore only ever CONSTRAINS:
 *
 *   1. its `privacyClass` caps what the point may be treated as (§19 — nothing
 *      downstream of the projection may sharpen geometry);
 *   2. its kind decides whether it stands for PEOPLE rather than a place;
 *   3. `report` is gated by `contributionPromptsFor` (truth/liveTruth.ts),
 *      which is where the projection's own explicit `interaction.contributable`
 *      gate is honoured;
 *   4. its `interaction.detailRoute` is the surface `add_to_trip` hands off to.
 *
 * Three of the seven do need an object to exist at all — `save`, `add_to_trip`
 * and `report` write or open something ABOUT a thing, and a press is not one
 * (see `NO_PLACE_TO_SAVE`). That is still subtraction, not the rail's rule in
 * disguise: what is read is that an object is THERE, never its
 * `interaction.actions` list, so an object the projection forgot to annotate
 * still affords everything its rung allows.
 *
 * Every rule below is subtractive. Nothing here can make an action available
 * that the target's privacy class did not already allow — combining rules can
 * only ever TIGHTEN.
 *
 * DISABLED, NOT HIDDEN
 * ====================
 * Same convention as the rail, for the same reason: the menu always returns all
 * seven entries, in §25's order, so it cannot reflow between one press and the
 * next and move the entry the user was reaching for out from under their thumb.
 * An unavailable entry carries a `reason` instead of disappearing.
 *
 * STILL ONLY A HINT
 * =================
 * Per the `MAP_ACTIONS` contract: "every action re-authorizes on the server
 * when invoked. A client-only gate is not a gate." Nothing here is a security
 * boundary; it is what the UI is allowed to OFFER.
 */

import {
  centroidOf,
  mayRenderIdentity,
  narrowestPrivacyClass,
  precisionRank,
  type MapAction,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';
import { contributionPromptsFor } from '../truth/liveTruth.ts';
import {
  ceilingForPurpose,
  type PrecisionGrant,
  type PresencePurpose,
} from '../presence/presenceLadder.ts';

// ── The target (§25) ──────────────────────────────────────────────────────────

/** A press that landed on a projected object. */
export interface LongPressObjectTarget {
  kind: 'object';
  object: MapObject;
}

/**
 * A press that landed on bare map. Carries the raw press coordinate because
 * that IS the subject — there is no object to borrow geometry from.
 *
 * Note that this coordinate is the USER'S OWN CHOICE of a point on the base
 * map. It is not anybody's presence, so it carries no `privacyClass`: there is
 * no §23 rung to record, because no one's location was reduced to produce it.
 * That is why a coordinate can be PINNED — met at, checkpointed — while an
 * `aggregate_only` object cannot: the object stands for people, the pressed
 * point does not. It still cannot be SAVED, but for an unrelated reason that
 * has nothing to do with privacy — see `NO_PLACE_TO_SAVE` below.
 */
export interface LongPressCoordinateTarget {
  kind: 'coordinate';
  lat: number;
  lng: number;
}

export type LongPressTarget = LongPressObjectTarget | LongPressCoordinateTarget;

export function objectTarget(object: MapObject): LongPressObjectTarget {
  return { kind: 'object', object };
}

export function coordinateTarget(lat: number, lng: number): LongPressCoordinateTarget {
  return { kind: 'coordinate', lat, lng };
}

export function isObjectTarget(
  target: LongPressTarget | null | undefined,
): target is LongPressObjectTarget {
  return target?.kind === 'object';
}

export function isCoordinateTarget(
  target: LongPressTarget | null | undefined,
): target is LongPressCoordinateTarget {
  return target?.kind === 'coordinate';
}

// ── Order (§25) ───────────────────────────────────────────────────────────────

/**
 * The seven slugs, in §25's order. Order is part of the contract.
 *
 * The LABELS deliberately live nowhere in this file: they already exist as
 * `LONG_PRESS_ACTIONS` in components/map/MapBottomActions.tsx, and copying them
 * would create a second place for the spec's own words to drift. This module
 * returns slugs; the menu looks their labels up.
 *
 * The two lists are pinned together by a guard test that reads
 * MapBottomActions.tsx as text (`__tests__/longPress.test.ts`). It has to read
 * it as text rather than import it: that module pulls in react-native, which
 * the node:test runner cannot transform.
 */
export const LONG_PRESS_ACTION_ORDER: readonly MapAction[] = [
  'meet_here',
  'save',
  'add_to_trip',
  'ask_compass',
  'share',
  'create_checkpoint',
  'report',
];

// ── Privacy rungs (§23) ───────────────────────────────────────────────────────

/**
 * Actions that PIN a rendezvous to one spot — a meeting point, a checkpoint.
 * They need geometry at least as precise as `place_level`, which is the same
 * floor `MapBottomActions` applies to Navigate / Meet Here. Routing two people
 * to a deliberately coarsened point asserts a precision the object was never
 * given.
 */
export const MIN_PRECISION_FOR_PINNING: PrivacyClass = 'place_level';

/**
 * Actions that treat the target as A PLACE — save it, add it to a trip, share
 * it. §23's identity line is `approximate`: at `aggregate_only` and below the
 * geometry is an AREA STANDING IN FOR PEOPLE ("18 travelers active around this
 * area"), not a location, and `mayRenderIdentity` returns false for exactly
 * that reason. Treating it as a place would hand a user a pin that points at
 * whoever is inside it.
 */
export const MIN_PRECISION_FOR_PLACE_USE: PrivacyClass = 'approximate';

/**
 * ...AND THEY ALSO NEED A PLACE. The rung above is necessary, not sufficient.
 *
 * "Save location" and "Add to Trip" do not publish a point, they write a PLACE
 * RECORD: `AddToTripPayload.id` is documented as "Stable unique identifier for
 * the place (OSM ID, DB UUID, or stable slug)", and `getSavedListIds(id)` uses
 * that id to decide whether the thing is already saved. A bare coordinate has
 * neither an id nor a name, and the only ones available would be minted from
 * the gesture itself — a key derived from the press point makes two presses on
 * the same cafe two different "places", so "Already saved" never matches and
 * the second press silently duplicates the row.
 *
 * This is NOT a §23 refusal. The pressed point carries no privacy bar at all
 * (see `LongPressCoordinateTarget`) — it is the user's own choice of a spot.
 * The refusal is that there is nothing here to save AS. "Meet here" and
 * "Create checkpoint" stay available on empty map for exactly the reason these
 * two do not: they publish a POINT, which a press is, rather than a record of
 * a place that exists.
 *
 * The wording says "no place HERE" rather than "long-press a place", because
 * the user may well have long-pressed something that looks exactly like one:
 * the map draws legacy Discovery place pins alongside §18 objects, and
 * app/map/index.tsx says so itself — "discovery places, passport stamps and raw
 * Compass results, none of which have a MapObject here at all". Telling
 * somebody to do the thing they just did would be the menu blaming them for the
 * shell's own missing projection.
 */
const NO_PLACE_TO_SAVE = 'No place here to save — just a spot on the map';
const NO_PLACE_FOR_TRIP = 'No place here to put on a trip — just a spot on the map';

/**
 * "Add to Trip" carries one bar `save` does not: a detail surface to hand off
 * to.
 *
 * The itinerary is §20's, not the map's, and the map screen says so — its
 * `add_to_trip` pushes `interaction.detailRoute` and lets the plan picker there
 * own the add, because "a fake confirmation here would be worse than the
 * handoff". An object with no detail route has nothing to hand off TO, so the
 * entry states that instead of pushing nowhere.
 *
 * `save` needs no such route: it writes a self-contained wishlist row built
 * from the object itself — id, title, kind, centroid — and never navigates.
 */
const NO_TRIP_HANDOFF = 'There is no page to add this to a trip from';

function hasDetailRoute(obj: MapObject): boolean {
  const route = obj.interaction?.detailRoute;
  return typeof route === 'string' && route.trim() !== '';
}

/**
 * Kinds whose geometry stands for PEOPLE rather than for a place: a crew
 * member is a person; a social zone is an aggregate of strangers; a buddy zone
 * is where somebody is offering their time.
 *
 * These never offer "Share permitted location" at any rung — see below.
 */
export const PERSON_BEARING_KINDS: readonly MapObjectKind[] = [
  'crew_member',
  'social_zone',
  'buddy_zone',
];

export function standsForPeople(kind: MapObjectKind): boolean {
  return PERSON_BEARING_KINDS.includes(kind);
}

function meetsPrecision(cls: PrivacyClass, floor: PrivacyClass): boolean {
  return precisionRank(cls) >= precisionRank(floor);
}

// ── "Share permitted location" — the bounded one (§23, §37) ───────────────────

/**
 * §37 non-goal: "Do not create permanent exact-location sharing."
 *
 * So this entry is NOT an open-ended share, and the menu is not allowed to
 * offer one. What it opens is a share bounded three ways at once, and every
 * bound is expressed here rather than left to the caller:
 *
 *   PRECISION — never above `place_level`. That is §23's Shared Moment rung
 *               ("Shared Moment: place-level or delayed"), which is the row a
 *               pin dropped from a public map belongs to. `precise_temporary`
 *               is reachable in §23 only for Trip Crew, Locate My Friends and
 *               Safe Return — all of which are group-scoped flows entered
 *               deliberately, never side-effects of pressing the map.
 *   PURPOSE   — §24 "purpose-bound". The share is opened under a named
 *               presence purpose and is not transferable to another one.
 *   TIME      — a mandatory TTL. This is the sentence §37 is made of: a share
 *               with no expiry IS permanent sharing.
 *
 * The rung is computed as the NARROWEST of the ceiling, the §23 purpose row
 * (presence/presenceLadder.ts, so the table is not restated here) and — when
 * the press landed on an object — that object's own class. A grant can lower
 * the result and can never raise it above `SHARE_PRECISION_CEILING`; a purpose
 * the ladder does not recognise yields `none` and the entry goes dark.
 */
export const SHARE_PRECISION_CEILING: PrivacyClass = 'place_level';

/** The §23 row a map long-press share is opened under, when the caller says nothing. */
export const DEFAULT_SHARE_PURPOSE: PresencePurpose = 'shared_moment';

/**
 * §25 "Share permitted location", deliberately left CLOSED.
 *
 * The BOUNDS are computable and are computed: `resolveShareBound` below is the
 * §23/§37 answer, it is exported, and it is what the caller must open a share
 * with on the day one exists. What does not exist is that caller — nothing in
 * this app or on the server opens a location share that EXPIRES:
 *
 *   • `/api/trips/:id/crew/live-share/*` (services/tripCrewLocation.ts) streams
 *     the viewer's OWN MOVING POSITION to named trip crew. That is §23's
 *     `trip_crew` row, a different purpose and a different subject; it cannot
 *     carry the point under the finger.
 *   • "Shared moments" (services/sharedMoments.ts) is a photo album — invites,
 *     contributions, a feed. It shares no location at all.
 *   • The platform share sheet is the only other thing in reach, and a
 *     coordinate pasted into a message never expires. That is the exact
 *     sentence §37 forbids: "Do not create permanent exact-location sharing."
 *
 * So the row would state a TTL the app has no way to honour. Offering it is a
 * promise that cannot be kept, and quietly resolving it to §8's `share` — "send
 * a link to this place", which app/map/index.tsx does have — would be a
 * different action wearing this one's label and this one's bound.
 *
 * It therefore stays disabled WITH ITS REASON (§25 disables, never hides) until
 * an expiring, purpose-bound share exists, at which point this becomes a real
 * check on that channel instead of a constant.
 *
 * Annotated `boolean` rather than left as the literal `false` so the branch
 * below reads as a check and not as dead code.
 */
export const BOUNDED_SHARE_CHANNEL_EXISTS: boolean = false;

/** Said on the row when §23 would permit the share but nothing can open it. */
export const NO_SHARE_CHANNEL_REASON = 'A location share that expires is not available yet';

/** The §37 hard stop. A caller may ask for less; it may never ask for more. */
export const SHARE_MAX_TTL_MS = 60 * 60 * 1000;

export interface LongPressShareBound {
  /** The rung the share may not exceed. Always ≤ `SHARE_PRECISION_CEILING`. */
  privacyClass: PrivacyClass;
  /** The §23 purpose it is scoped to. */
  purpose: PresencePurpose;
  /** Lifetime in ms. Always ≤ `SHARE_MAX_TTL_MS`, always > 0. */
  ttlMs: number;
}

/** Everything the resolver reads besides the target itself. */
export interface LongPressContext {
  /**
   * The group / event map a §12 checkpoint would be dropped into. A checkpoint
   * is a message to a group ("Checkpoint: Food Court"); with no group there is
   * nobody it could reach, so this is required and fails closed when absent.
   */
  checkpointScopeId?: string | null;
  /** §23 purpose for the share. Defaults to `shared_moment`. */
  sharePurpose?: PresencePurpose;
  /** A live precision grant, if the viewer holds one. May only narrow the rung. */
  shareGrant?: PrecisionGrant | null;
  /** A shorter TTL than the ceiling. Clamped DOWN; never up. */
  shareTtlMs?: number;
  /**
   * Clock, epoch ms. Required for grant expiry to mean anything — omitting it
   * makes every grant read as not-live, which is the safe direction.
   */
  now?: number;
}

function shareTtlOf(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return SHARE_MAX_TTL_MS;
  }
  return Math.min(SHARE_MAX_TTL_MS, requested);
}

/**
 * The bounds a share from this press may be opened with, or `null` when no
 * legal share exists (which is what disables the entry).
 *
 * Exported because the caller that actually opens the share needs the same
 * numbers the menu was gated on — recomputing them at the call site is how the
 * two drift apart.
 */
export function resolveShareBound(
  target: LongPressTarget | null | undefined,
  ctx: LongPressContext = {},
): LongPressShareBound | null {
  if (!isUsableTarget(target)) return null;

  // Sharing someone ELSE's position is not what this entry is. It shares the
  // pressed point. An object that stands for people has no shareable point.
  if (isObjectTarget(target) && standsForPeople(target.object.kind)) return null;

  const purpose = ctx.sharePurpose ?? DEFAULT_SHARE_PURPOSE;
  const now = typeof ctx.now === 'number' && Number.isFinite(ctx.now) ? ctx.now : Number.NaN;

  let cls = narrowestPrivacyClass(
    SHARE_PRECISION_CEILING,
    ceilingForPurpose(purpose, ctx.shareGrant ?? null, now),
  );
  if (isObjectTarget(target)) {
    cls = narrowestPrivacyClass(cls, target.object.privacyClass);
  }

  // Below the identity line there is no place to share, only people.
  if (!meetsPrecision(cls, MIN_PRECISION_FOR_PLACE_USE)) return null;

  return { privacyClass: cls, purpose, ttlMs: shareTtlOf(ctx.shareTtlMs) };
}

// ── Target sanity ─────────────────────────────────────────────────────────────

function isFinitePosition(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Whether there is anything here to act on at all.
 *
 * `privacyClass: 'none'` is the "not visible to this viewer" rung — an object
 * at `none` should never have been rendered (`isRenderable` drops it), and if
 * one reaches us anyway the honest answer is that there is no "here": not even
 * Ask Compass, because Compass would be asked about an object the viewer was
 * never authorized to see.
 */
export function isUsableTarget(target: LongPressTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.kind === 'coordinate') return isFinitePosition(target.lat, target.lng);
  const obj = target.object;
  if (!obj || obj.privacyClass === 'none') return false;
  return centroidOf(obj.geometry) != null;
}

/** The representative point for a press — the object's centroid, or the coordinate. */
export function coordinateOf(
  target: LongPressTarget | null | undefined,
): { lat: number; lng: number } | null {
  if (!target) return null;
  if (target.kind === 'coordinate') {
    return isFinitePosition(target.lat, target.lng) ? { lat: target.lat, lng: target.lng } : null;
  }
  return centroidOf(target.object.geometry);
}

// ── describeTarget — the menu's title line ────────────────────────────────────

export const UNKNOWN_TARGET_LABEL = 'This spot';
export const AGGREGATE_AREA_LABEL = 'Around this area';

/**
 * Decimal places used when a bare coordinate has to be shown to a human.
 *
 * Two places is ~1.1 km at the equator — deliberately COARSER than the
 * `place_level` rung the share is capped at, so the menu's own title line can
 * never be the leak. §23's whole point is that the UI must not imply precision
 * it was not given, and a full-precision "16.047079, 108.220520" implies a GPS
 * fix. The action still operates on the real press coordinate; only the words
 * are coarsened.
 */
export const COORDINATE_LABEL_DECIMALS = 2;

function coarseCoordinateLabel(lat: number, lng: number): string {
  if (!isFinitePosition(lat, lng)) return UNKNOWN_TARGET_LABEL;
  const ns = lat < 0 ? 'S' : 'N';
  const ew = lng < 0 ? 'W' : 'E';
  const la = Math.abs(lat).toFixed(COORDINATE_LABEL_DECIMALS);
  const lo = Math.abs(lng).toFixed(COORDINATE_LABEL_DECIMALS);
  return `Near ${la}°${ns}, ${lo}°${ew}`;
}

/**
 * The menu's title line.
 *
 * For an object that stands for people below the `approximate` rung this
 * returns the generic area phrase, NEVER the object's title — an aggregate
 * cluster's title can carry a name, and `mayRenderIdentity` is false at that
 * rung precisely because naming someone there is not permitted (§23: "show
 * '18 travelers active around this area' rather than a field of identifiable
 * stranger avatars").
 */
export function describeTarget(target: LongPressTarget | null | undefined): string {
  if (!target) return UNKNOWN_TARGET_LABEL;
  if (target.kind === 'coordinate') return coarseCoordinateLabel(target.lat, target.lng);

  const obj = target.object;
  if (!obj) return UNKNOWN_TARGET_LABEL;
  if (obj.privacyClass === 'none') return UNKNOWN_TARGET_LABEL;
  if (standsForPeople(obj.kind) && !mayRenderIdentity(obj.privacyClass)) {
    return AGGREGATE_AREA_LABEL;
  }
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  return title === '' ? UNKNOWN_TARGET_LABEL : title;
}

// ── Resolution ────────────────────────────────────────────────────────────────

export interface LongPressItem {
  action: MapAction;
  enabled: boolean;
  /** Present exactly when `enabled` is false. Shown on tap, and as an a11y hint. */
  reason?: string;
  /** Present exactly on an ENABLED `share` entry — the §37 bounds it opens with. */
  shareBound?: LongPressShareBound;
}

const NOTHING_HERE = 'Nothing here to act on';

function enabledItem(action: MapAction): LongPressItem {
  return { action, enabled: true };
}

function disabledItem(action: MapAction, reason: string): LongPressItem {
  return { action, enabled: false, reason };
}

function resolveOne(
  action: MapAction,
  target: LongPressTarget,
  ctx: LongPressContext,
): LongPressItem {
  const obj = isObjectTarget(target) ? target.object : null;
  const cls = obj ? obj.privacyClass : null;

  switch (action) {
    // "Ask Compass about here" is about the LOCATION, not about any object, so
    // it is available for every usable press — including bare map, which is
    // the case it was written for.
    case 'ask_compass':
      return enabledItem(action);

    case 'meet_here':
      if (cls && !meetsPrecision(cls, MIN_PRECISION_FOR_PINNING)) {
        return disabledItem(
          action,
          'This area is approximate — long-press an exact spot to meet',
        );
      }
      return enabledItem(action);

    case 'create_checkpoint': {
      // §12: a checkpoint is a manual position report INTO a group or event
      // map. No group, nobody to tell.
      const scope = ctx.checkpointScopeId;
      if (typeof scope !== 'string' || scope.trim() === '') {
        return disabledItem(action, 'Join a group or event map to drop a checkpoint');
      }
      if (cls && !meetsPrecision(cls, MIN_PRECISION_FOR_PINNING)) {
        return disabledItem(
          action,
          'This area is approximate — long-press an exact spot for a checkpoint',
        );
      }
      return enabledItem(action);
    }

    case 'save':
      if (!obj) return disabledItem(action, NO_PLACE_TO_SAVE);
      if (cls && !meetsPrecision(cls, MIN_PRECISION_FOR_PLACE_USE)) {
        return disabledItem(action, 'This shows people, not a place — there is nothing to save');
      }
      return enabledItem(action);

    case 'add_to_trip':
      if (!obj) return disabledItem(action, NO_PLACE_FOR_TRIP);
      if (cls && !meetsPrecision(cls, MIN_PRECISION_FOR_PLACE_USE)) {
        return disabledItem(action, 'This shows people, not a place — it cannot go on a trip');
      }
      // The privacy floor first, then the handoff: an aggregate WITH a page is
      // still refused for the §23 reason, which is the more permanent of the two.
      if (!hasDetailRoute(obj)) return disabledItem(action, NO_TRIP_HANDOFF);
      return enabledItem(action);

    case 'share': {
      const bound = resolveShareBound(target, ctx);
      // A bound means §23 and §37 permit this share. Whether anything can OPEN
      // one is a separate question, and today the answer is no — so the row is
      // refused here rather than at the call site, because a menu that renders
      // the bound and then does nothing has promised the bound.
      if (bound && !BOUNDED_SHARE_CHANNEL_EXISTS) {
        return disabledItem(action, NO_SHARE_CHANNEL_REASON);
      }
      if (bound) return { action, enabled: true, shareBound: bound };
      if (obj && standsForPeople(obj.kind)) {
        return disabledItem(action, 'You can only share your own location, never someone else’s');
      }
      if (cls && !meetsPrecision(cls, MIN_PRECISION_FOR_PLACE_USE)) {
        return disabledItem(action, 'This area is aggregated — sharing it would point at people');
      }
      return disabledItem(action, 'Location sharing is not permitted here');
    }

    case 'report': {
      // §22 decides this, not the menu: an object only takes the prompts that
      // can describe it (an `activity_zone` has no door, so it cannot be
      // reported closed), and `interaction.contributable: false` shuts it off
      // outright. A bare coordinate has no object to observe, so it yields none.
      if (!obj) {
        return disabledItem(action, 'Long-press a place or event to report what is there');
      }
      if (contributionPromptsFor(obj).length === 0) {
        return disabledItem(action, 'There is nothing here you can report on');
      }
      return enabledItem(action);
    }

    default:
      return disabledItem(action, 'Not available here');
  }
}

/**
 * The seven §25 entries for this press, in §25's order, every one carrying an
 * explicit `enabled`.
 *
 * ALWAYS returns `LONG_PRESS_ACTION_ORDER.length` items in
 * `LONG_PRESS_ACTION_ORDER` order — that invariant is what lets the menu keep a
 * fixed height and fixed row positions across targets.
 */
export function resolveLongPressActions(
  target: LongPressTarget | null | undefined,
  ctx: LongPressContext = {},
): LongPressItem[] {
  if (!isUsableTarget(target)) {
    return LONG_PRESS_ACTION_ORDER.map((action) => disabledItem(action, NOTHING_HERE));
  }
  const usable = target as LongPressTarget;
  return LONG_PRESS_ACTION_ORDER.map((action) => resolveOne(action, usable, ctx));
}

/** Convenience for callers that hold a slug and want its resolved entry. */
export function longPressItemFor(
  items: readonly LongPressItem[],
  action: MapAction,
): LongPressItem | null {
  return items.find((item) => item.action === action) ?? null;
}
