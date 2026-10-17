/**
 * LayoverCrewLocation — §14's L4 rung, "temporary location — explicit, scoped,
 * auto-expiring", for a layover crew. PURE: no clock (`nowMs` is an argument),
 * no I/O, no Supabase client. The store is `LayoverCrewLocationStore.ts`; the
 * routes are `routes/layoverCrewLocation.ts`; the storage is migration 3996.
 *
 * census-layover rows this is the rule layer for:
 *   L132  L4 temporary location — explicit, scoped, auto-expiring
 *   L158  precise crew/live location — session scoped, expires automatically
 *   L166  precise crew sharing — separate explicit control, off by default
 *   L203  crew membership/location rows require membership and explicit permission
 *   L124  map element "Crew member" — only with explicit temporary location permission
 *   L277  Locate My Friends — crew peer-proximity after explicit opt-in (server half only)
 *
 * ── REUSED, NOT RE-INVENTED ─────────────────────────────────────────────────
 * The SHARE is Telegraph's scoped location share (§12 `location_shares`):
 *   - the expiry rule is `checkLocationShareWindow` itself — in the future, at
 *     most `MAX_LOCATION_SHARE_HOURS`, and a body with no expiry is a pin, not a
 *     share, so it is refused here;
 *   - the precision ladder is Telegraph's `LOCATION_PRECISIONS` (area / venue /
 *     exact), coarse by default;
 *   - the purpose is one of `TELEGRAPH_SHARE_PURPOSES`, paired with precision
 *     exactly as Telegraph's scope sheet pairs it (`scopedLocationPurpose`):
 *     exact → `live_session_sharing`, anything coarser → `presence_in_context`.
 * The END of a share is the §14.1 ladder `LayoverCrewService` already carries
 * (`evaluateCrewLocationShare`, `locationPrecisionFor`); this module only
 * supplies its signals. The geometry rules are Locate My Friends' (`coarsenToRing`,
 * `protectionCeiling` over the §24 protected zones), so a crew share inside a
 * protected place is coarsened or withheld by the same policy the map applies.
 *
 * ── WHAT IS STORED, BY RUNG ─────────────────────────────────────────────────
 *   area   a label. Never a coordinate, even if one was sent.
 *   venue  a label and the CENTRE of the 150 m grid cell the point fell in —
 *          never the point. Two points in one cell store the same bytes.
 *   exact  a label and the point as given. Only while the sharer's SEPARATE
 *          precise-sharing control is on (L166), and only where the §24
 *          protected-zone policy allows a precise point there. An unreadable
 *          policy is not an absent one: the coordinate is dropped.
 *
 * Nothing here reads a device position. The layover client imports no location
 * API (census L164); a coordinate reaches this module only because the sharer
 * picked a place that already has one (a plan stop, the airport).
 */
import { z } from "zod";
import { checkLocationShareWindow } from "../telegraph/threadEnvelopeWrites.js";
import {
  LOCATION_PRECISIONS as TELEGRAPH_LOCATION_PRECISIONS,
  MAX_LOCATION_SHARE_HOURS,
  type TelegraphSharePurpose,
} from "../telegraph/messageKinds.js";
import {
  evaluateCrewLocationShare,
  locationPrecisionFor,
  type CrewLocationGrant,
  type CrewShareSignals,
} from "../airport/LayoverCrewService.js";
import {
  coarsenToRing,
  isFinitePoint,
  narrowestOfPrecisions,
  protectionCeiling,
  type GeoPoint,
  type PositionRing,
} from "../../lib/locateFriendsSession.js";
import { FEATURE_PRECISION_CEILING, precisionRank, type LocationPrecision } from "../../presence/domain/types.js";
import { haversineMeters, type ProtectedZone } from "../../lib/protectedLocations.js";

/** Seeded FALSE by 3996. OFF / absent / unreadable: nothing is read or written. */
export const LAYOVER_CREW_LOCATION_FLAG = "layover_crew_location_enabled";

export type CrewSharePrecision = (typeof TELEGRAPH_LOCATION_PRECISIONS)[number];
export type CrewSharePurpose = Extract<TelegraphSharePurpose, "presence_in_context" | "live_session_sharing">;

/** Telegraph's ladder, the same array — a test pins it. */
export const CREW_SHARE_PRECISIONS: readonly CrewSharePrecision[] = TELEGRAPH_LOCATION_PRECISIONS;

/** Telegraph's ceiling, in minutes. 3996's CHECK carries the same 4 hours. */
export const CREW_SHARE_MAX_MINUTES = MAX_LOCATION_SHARE_HOURS * 60;

/** The registry purpose a share declares, paired with its precision as Telegraph's scope sheet pairs it. */
export function crewSharePurposeFor(precision: CrewSharePrecision): CrewSharePurpose {
  return precision === "exact" ? "live_session_sharing" : "presence_in_context";
}

/** The Locate My Friends rung each share precision may at most be drawn at. */
const RUNG_FOR: Record<CrewSharePrecision, LocationPrecision> = {
  area: "presence_only",
  venue: "nearby",
  exact: "precise",
};

/** The ring a venue share is drawn as (`RING_RADIUS_METERS.nearby`). */
export const VENUE_RING_METERS = 150;

/** One field more than this and the body is refused, not trimmed. */
export const crewLocationShareSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    precision: z.enum(TELEGRAPH_LOCATION_PRECISIONS).optional(),
    purpose: z.enum(["presence_in_context", "live_session_sharing"]).optional(),
    expiresAt: z.string().min(1).max(64).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict();

export interface CrewShareContext {
  nowMs: number;
  /** The crew's own end. A share never outlives its crew. */
  crewExpiresAt: string;
  /** The sharer's boarding time, when known. */
  sharerBoardingAt: string | null;
  /** The sharer's departure; the bound when boarding is not known. */
  sharerDepartureAt: string;
  /** L166: the sharer's separate precise-sharing control. */
  preciseControlEnabled: boolean;
  /** §24 policy rows; `null` = unreadable, which drops every coordinate. */
  zones: readonly ProtectedZone[] | null;
}

export type CrewShareRefusal =
  | "invalid_body"
  | "expiry_required"
  | "expiry_invalid"
  | "purpose_mismatch"
  | "coordinates_incomplete"
  | "precise_control_off"
  | "layover_ending";

export interface PlannedCrewGrant {
  precision: CrewSharePrecision;
  purpose: CrewSharePurpose;
  label: string;
  lat: number | null;
  lng: number | null;
  grantedAt: string;
  expiresAt: string;
}

export type CrewSharePlan =
  | {
      ok: true;
      grant: PlannedCrewGrant;
      /** Why the share ends when it does. */
      endsBecause: "requested" | "crew_ends" | "boarding";
      /** Set when less was stored than was asked for, and why. */
      downgraded: null | "protected_zone" | "zones_unreadable";
    }
  | { ok: false; status: 400 | 409; reason: CrewShareRefusal; message: string };

function refuse(status: 400 | 409, reason: CrewShareRefusal, message: string): CrewSharePlan {
  return { ok: false, status, reason, message };
}

/**
 * Validate one share request into the row 3996 will hold, or refuse it.
 *
 * Order matters and is the order a person would want to be told things in:
 * the body, then the expiry (Telegraph's rule), then the precision pairing,
 * then the separate control, then the layover's own end. Clamping to the
 * layover's end is not a refusal — a share asked for an hour that meets a
 * boarding call in 30 minutes ends at the boarding call, and the answer says so.
 */
export function planCrewLocationShare(body: unknown, ctx: CrewShareContext): CrewSharePlan {
  const parsed = crewLocationShareSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return refuse(400, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid location share");
  }
  const b = parsed.data;
  const precision: CrewSharePrecision = b.precision ?? "area";
  const purpose = crewSharePurposeFor(precision);

  const window = checkLocationShareWindow("LOCATION", { expiresAt: b.expiresAt ?? null, precision, purpose }, ctx.nowMs);
  if (!window.ok) return refuse(400, "expiry_invalid", window.message);
  if (!window.share) {
    return refuse(400, "expiry_required", "A crew location share needs an end time. A location with no end is a pin, not a share.");
  }
  if (b.purpose !== undefined && b.purpose !== purpose) {
    return refuse(400, "purpose_mismatch", `A ${precision} share is shared for ${purpose}, not ${b.purpose}.`);
  }
  if ((b.lat === undefined) !== (b.lng === undefined)) {
    return refuse(400, "coordinates_incomplete", "Send both lat and lng, or neither.");
  }
  if (precision === "exact" && !ctx.preciseControlEnabled) {
    return refuse(409, "precise_control_off", "Exact location is off for this crew. Turn on exact sharing first — it is a separate switch, off by default.");
  }

  // ── the layover's own end ──────────────────────────────────────────────
  const requestedMs = Date.parse(window.share.expiresAt);
  const crewEndMs = Date.parse(ctx.crewExpiresAt);
  const boardingMs = Date.parse(ctx.sharerBoardingAt ?? ctx.sharerDepartureAt);
  let endMs = requestedMs;
  let endsBecause: "requested" | "crew_ends" | "boarding" = "requested";
  if (!Number.isFinite(crewEndMs) || !Number.isFinite(boardingMs)) {
    return refuse(409, "layover_ending", "Your layover's end could not be read, so nothing is shared.");
  }
  if (boardingMs < endMs) { endMs = boardingMs; endsBecause = "boarding"; }
  if (crewEndMs < endMs) { endMs = crewEndMs; endsBecause = "crew_ends"; }
  if (endMs <= ctx.nowMs) {
    return refuse(409, "layover_ending", "Your flight is boarding or your crew has ended, so there is nothing left to share for.");
  }

  // ── what is stored ─────────────────────────────────────────────────────
  let stored: CrewSharePrecision = precision;
  let lat: number | null = null;
  let lng: number | null = null;
  let downgraded: null | "protected_zone" | "zones_unreadable" = null;
  const point: GeoPoint | null = b.lat !== undefined && b.lng !== undefined ? { lat: b.lat, lng: b.lng } : null;
  if (precision !== "area" && point && isFinitePoint(point)) {
    const allowed = narrowestOfPrecisions(RUNG_FOR[precision], FEATURE_PRECISION_CEILING.crew, protectionCeiling(point, ctx.zones));
    if (allowed === "precise") {
      lat = point.lat; lng = point.lng;
    } else if (precisionRank(allowed) >= precisionRank("nearby")) {
      const ring = coarsenToRing(point, "nearby");
      if (ring) { lat = ring.center.lat; lng = ring.center.lng; stored = "venue"; }
    }
    if (lat === null) stored = "area";
    if (precisionRank(allowed) < precisionRank(RUNG_FOR[precision])) {
      downgraded = ctx.zones === null ? "zones_unreadable" : "protected_zone";
    }
  }

  return {
    ok: true,
    grant: {
      precision: stored,
      purpose: crewSharePurposeFor(stored),
      label: b.label,
      lat,
      lng,
      grantedAt: new Date(ctx.nowMs).toISOString(),
      expiresAt: new Date(endMs).toISOString(),
    },
    endsBecause,
    downgraded,
  };
}

/** A `layover_crew_location_grants` row (3996), as the store returns it. */
export interface CrewGrantRow {
  crewId: string;
  userId: string;
  sessionId: string;
  purpose: string;
  precision: string;
  label: string;
  lat: number | null;
  lng: number | null;
  grantedAt: string;
  expiresAt: string;
}

export interface SharerSessionFacts {
  id: string;
  status: string;
  departureTime: string;
  boardingTime: string | null;
  updatedAt: string | null;
}

const LIVE_SESSION_STATUSES = new Set(["active", "returning"]);

function instantOr(iso: string | null | undefined, fallbackMs: number): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : fallbackMs;
}

/**
 * The §14.1 terminators for one share, as `evaluateCrewLocationShare` reads them.
 *
 *   crew dissolution  the crew disbanded, or reached its own end
 *   airport re-entry  a re-entry reported AFTER the share began (one before it
 *                     is the place the share was made from, not its end)
 *   boarding          the sharer's boarding time, else their departure
 *   session expiry    the sharer's layover is no longer live — and a session
 *                     that could not be read is not a live one
 *   user revocation   the sharer left the crew (an explicit stop deletes the
 *                     row, so it never reaches this function)
 */
export function crewShareSignalsFor(input: {
  grant: CrewGrantRow;
  crew: { status: string; expiresAt: string; updatedAt?: string | null };
  sharerSession: SharerSessionFacts | null;
  membershipLive: boolean;
  reentryAtMs: number | null;
  nowMs: number;
}): CrewShareSignals {
  const { crew, sharerSession: s, nowMs } = input;
  const grantedMs = Date.parse(input.grant.grantedAt);
  // Disbanded: at the moment it was (never later than now — a skewed
  // `updated_at` must not keep a dissolved crew's shares live). Otherwise the
  // crew ends at its own `expires_at`, and an unreadable one has ended.
  const signals: CrewShareSignals = {
    crewDissolvedAtMs: crew.status === "disbanded"
      ? Math.min(instantOr(crew.updatedAt, nowMs), nowMs)
      : instantOr(crew.expiresAt, nowMs),
  };
  if (input.reentryAtMs !== null && Number.isFinite(grantedMs) && input.reentryAtMs >= grantedMs) {
    signals.airportReentryAtMs = input.reentryAtMs;
  }
  if (!s) {
    signals.sessionExpiredAtMs = nowMs;
  } else {
    signals.boardingAtMs = instantOr(s.boardingTime ?? s.departureTime, nowMs);
    if (!LIVE_SESSION_STATUSES.has(s.status)) signals.sessionExpiredAtMs = Math.min(instantOr(s.updatedAt, nowMs), nowMs);
  }
  if (!input.membershipLive) signals.revokedAtMs = nowMs;
  return signals;
}

export interface CrewShareGeometry {
  /** Present only for an exact share with a stored point. */
  position: GeoPoint | null;
  /** Present only for a venue share: the stored cell centre and its radius. */
  ring: PositionRing | null;
}

const NO_GEOMETRY: CrewShareGeometry = Object.freeze({ position: null, ring: null }) as CrewShareGeometry;

/** The only path a stored coordinate leaves through. */
export function shareGeometry(grant: Pick<CrewGrantRow, "precision" | "lat" | "lng">): CrewShareGeometry {
  if (grant.lat === null || grant.lng === null) return NO_GEOMETRY;
  const p = { lat: grant.lat, lng: grant.lng };
  if (!isFinitePoint(p)) return NO_GEOMETRY;
  if (grant.precision === "exact") return { position: p, ring: null };
  if (grant.precision === "venue") return { position: null, ring: { center: p, radiusMeters: VENUE_RING_METERS } };
  return NO_GEOMETRY;
}

export type CrewProximityBucket = "together" | "close" | "same_area" | "far";

/** Upper bounds of each bucket, metres. Coarser than a venue cell's error on purpose. */
export const CREW_PROXIMITY_BUCKETS: ReadonlyArray<[CrewProximityBucket, number]> = [
  ["together", 300],
  ["close", 1_500],
  ["same_area", 5_000],
];

function anchorOf(g: Pick<CrewGrantRow, "precision" | "lat" | "lng">): GeoPoint | null {
  const geo = shareGeometry(g);
  return geo.position ?? geo.ring?.center ?? null;
}

/**
 * L277 — how close two crewmates are, as a BUCKET. Never a distance: a number
 * of metres between two people is a finer fact than either of their shares
 * publishes. Null unless BOTH sides share a point — the viewer's own share is
 * what opts them in.
 */
export function crewProximity(
  mine: Pick<CrewGrantRow, "precision" | "lat" | "lng"> | null,
  theirs: Pick<CrewGrantRow, "precision" | "lat" | "lng">,
): CrewProximityBucket | null {
  if (!mine) return null;
  const a = anchorOf(mine);
  const b = anchorOf(theirs);
  if (!a || !b) return null;
  const d = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  for (const [bucket, max] of CREW_PROXIMITY_BUCKETS) if (d <= max) return bucket;
  return "far";
}

export interface CrewLocationView {
  userId: string;
  label: string;
  precision: string;
  purpose: string;
  sharedAt: string;
  endsAt: string;
  position: GeoPoint | null;
  ring: PositionRing | null;
  proximity: CrewProximityBucket | null;
}

/** One share as a crew member may read it. */
export function crewLocationViewOf(g: CrewGrantRow, proximity: CrewProximityBucket | null = null): CrewLocationView {
  const geo = shareGeometry(g);
  return {
    userId: g.userId,
    label: g.label,
    precision: g.precision,
    purpose: g.purpose,
    sharedAt: g.grantedAt,
    endsAt: g.expiresAt,
    position: geo.position,
    ring: geo.ring,
    proximity,
  };
}

function grantOf(g: CrewGrantRow): CrewLocationGrant {
  return { grantedByUserId: g.userId, crewId: g.crewId, grantedAtMs: Date.parse(g.grantedAt), expiresAtMs: Date.parse(g.expiresAt) };
}

/**
 * What one crew member may see of the crew's live shares.
 *
 * A crewmate's share is shown only when ALL hold: the share is this crew's,
 * its author is a LIVE member, the §14.1 ladder (`locationPrecisionFor`) says
 * the viewer may see it — a crewmate, not blocked, a live grant from the
 * target to this crew — and the author's sharing preferences still allow
 * publishing them. Two unreadable inputs withhold every crewmate rather than
 * clearing anyone: an unreadable block list (`blocked: null`) and unreadable
 * preferences (`publishable: null`). The viewer's own share is never withheld
 * from the viewer.
 *
 * `ended` lists every row that is no longer live (or never belonged here), so
 * the caller can delete it — a share past its scope is not kept (Appendix C.8).
 */
export function projectCrewLocations(input: {
  viewerId: string;
  crewId: string;
  grants: readonly CrewGrantRow[];
  liveMemberIds: ReadonlySet<string>;
  blocked: ReadonlySet<string> | null;
  publishable: ReadonlySet<string> | null;
  signalsFor: (grant: CrewGrantRow) => CrewShareSignals;
  nowMs: number;
}): {
  mine: CrewLocationView | null;
  crewmates: CrewLocationView[];
  ended: CrewGrantRow[];
  crewmatesWithheld: null | "blocks_unreadable" | "sharing_preferences_unreadable";
} {
  const ended: CrewGrantRow[] = [];
  const live: CrewGrantRow[] = [];
  for (const g of input.grants) {
    if (g.crewId !== input.crewId || !input.liveMemberIds.has(g.userId)) { ended.push(g); continue; }
    const state = evaluateCrewLocationShare(grantOf(g), input.signalsFor(g), input.nowMs);
    if (!state.active) { ended.push(g); continue; }
    live.push(g);
  }
  const mineRow = live.find((g) => g.userId === input.viewerId) ?? null;
  const crewmatesWithheld = input.blocked === null
    ? "blocks_unreadable" as const
    : input.publishable === null
      ? "sharing_preferences_unreadable" as const
      : null;
  const crewmates: CrewLocationView[] = [];
  if (crewmatesWithheld === null) {
    for (const g of live) {
      if (g.userId === input.viewerId) continue;
      const gate = locationPrecisionFor({
        viewerUserId: input.viewerId,
        targetUserId: g.userId,
        sameCrewId: input.liveMemberIds.has(input.viewerId) ? input.crewId : null,
        blocked: input.blocked!.has(g.userId),
        grant: grantOf(g),
        signals: input.signalsFor(g),
        nowMs: input.nowMs,
      });
      if (gate.precision !== "precise") continue;
      if (!input.publishable!.has(g.userId)) continue;
      crewmates.push(crewLocationViewOf(g, crewProximity(mineRow, g)));
    }
  }
  return { mine: mineRow ? crewLocationViewOf(mineRow, null) : null, crewmates, ended, crewmatesWithheld };
}
