/**
 * highlightCacheFanout — §11 KEEP_PRIVATE_FOREVER reaches OTHER PEOPLE'S
 * caches, or it does not take effect. Backlog #A9.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `PUT /highlights/resurfacing-controls` stored the control and then ran
 *
 *     await invalidateCompassCache(getServiceClient(), user.id, "…")
 *
 * — the SETTER's user id, and only the setter's. KEEP_PRIVATE_FOREVER is the
 * one control in CONTROL_EFFECTS that suppresses `public_projection`: it is a
 * statement about what EVERYONE ELSE may see. Evicting only the owner's cache
 * therefore evicted the one cache whose owner was already looking at the
 * confirmation screen, and left every other viewer served from their own
 * cached Compass feed until it aged out on its own TTL
 * (`CACHE_TTL_MS.feed` = 5 min, `city_guide` = 4 h). The route said so in a
 * comment — "CEILING, recorded rather than hidden: this evicts the SETTER's
 * cache" — and the ceiling is what this module removes.
 *
 * ── WHAT CANNOT BE DONE, AND IS THEREFORE NOT CLAIMED ───────────────────────
 * Two separate limits, both load-bearing for how the outcome is REPORTED. The
 * repo rule is absolute: a check that cannot establish its result must fail,
 * and an eviction that cannot establish its result must not be reported as
 * complete.
 *
 * 1. WE CANNOT ASK WHICH CACHE ENTRIES MENTION THIS HIGHLIGHT.
 *    `compass_feed_cache` stores `(user_id, cache_key, entry_type, payload,
 *    expires_at)`. The payload is opaque JSON with no index over its contents,
 *    and adding one is a migration — out of scope by construction here. So the
 *    fan-out is over the PERMISSION AUDIENCE (who could have been served this
 *    Highlight), not over the cache rows that actually hold it. For a bounded
 *    visibility that is a SUPERSET of the truly affected set, which is the safe
 *    direction: it evicts caches that did not need evicting, and never the
 *    reverse.
 *
 * 2. WE CANNOT CONFIRM THE PERSISTED PURGE.
 *    `CompassCacheEngine.invalidate(db, userId, reason)` evicts its in-process
 *    L1 synchronously and unconditionally, then wraps the persisted
 *    `compass_feed_cache` delete and the `compass_cache_invalidations` audit
 *    insert in `try { … } catch { /* non-fatal *\/ }` and returns `void` either
 *    way. A caller cannot tell a complete purge from an L1-only one.
 *    highlightRevocation.ts already records exactly this, at length, on its
 *    `cached_narrative` outcome.
 *
 *    Fixing (2) at the source means changing CompassCacheEngine to report its
 *    outcome. That file is NOT a scheduler, background job or migration — it
 *    is a plain request-path module — so the change would be legal in
 *    principle, but it is another surface's file and is not in this lane. So
 *    this module takes the other permitted route: it REPORTS THE REAL
 *    OUTCOME, and the strongest word it will ever say is
 *    `l1_evicted_persisted_unverifiable`. There is no `"complete"`,
 *    `"purged"` or `true` in this module's vocabulary for the persisted rows;
 *    `persistedPurgeVerified` is typed `false` so a future edit cannot quietly
 *    flip it without changing the type.
 *
 * ── WHO THE OTHER VIEWERS ARE ───────────────────────────────────────────────
 * Derived from `canViewHighlight` (lib/highlightPermissions.ts), the gate that
 * decided who could be served the Highlight in the first place — not from a
 * second, divergable guess:
 *
 *   public | travelers_nearby  any authenticated user      → UNBOUNDED
 *   circle_only                the owner's circle          → bounded
 *   trip_only                  accepted trip co-members    → bounded
 *   private                    nobody but the owner        → bounded
 *
 * plus, in every case, the viewers recorded in `highlight_views` — the people
 * who demonstrably rendered this Highlight, including under a visibility it
 * has since left.
 *
 * `public` and `travelers_nearby` are the honest problem: "any authenticated
 * user" is not a set this code can enumerate without a full scan of
 * `compass_feed_cache`, and a privacy control must not become a
 * whole-table-eviction stampede. So those two resolve the reachable part
 * (owner + recorded viewers + followers) and report `audienceBounded: false`
 * with the reason. The outcome then says `audience_incomplete`, which is the
 * truth, rather than a success over a set that was never the audience.
 */
import {
  CONTROL_EFFECTS,
  isResurfacingControl,
  type ResurfacingControl,
} from "./highlightResurfacing.js";

/* ── which controls reach other people at all ──────────────────────────────*/

/**
 * A control needs a fan-out exactly when it suppresses `public_projection` —
 * the only surface in CONTROL_EFFECTS that is somebody ELSE's view. DERIVED
 * from CONTROL_EFFECTS rather than listed beside it, for the reason
 * FEED_ENFORCEABLE_CONTROLS gives: the list it would replace was wrong once
 * already, having been retyped next to the table instead of read off it.
 */
export const CACHE_FANOUT_CONTROLS: readonly ResurfacingControl[] = Object.freeze(
  (Object.keys(CONTROL_EFFECTS) as ResurfacingControl[]).filter((c) =>
    (CONTROL_EFFECTS[c].suppresses as readonly string[]).includes("public_projection"),
  ),
) as readonly ResurfacingControl[];

export function controlNeedsCacheFanout(control: unknown): boolean {
  return isResurfacingControl(control) && CACHE_FANOUT_CONTROLS.includes(control);
}

/* ── audience resolution ───────────────────────────────────────────────────*/

export type AudienceSourceName =
  | "highlights"
  | "highlight_views"
  | "user_follows"
  | "circle_memberships"
  | "trip_membership"
  | "service_client";

export interface AudienceSourceResult {
  readonly source: AudienceSourceName;
  readonly resolved: boolean;
  readonly detail: string;
}

export interface CacheAudience {
  readonly userIds: readonly string[];
  /** True only when every source that DEFINES the audience was read AND the rule bounds it. */
  readonly bounded: boolean;
  readonly visibility: string | null;
  readonly sources: readonly AudienceSourceResult[];
}

const ACCEPTED_TRIP_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

/**
 * Same predicate as routes/highlights.ts `isAcceptedMembershipRow` and
 * services/memory/memoryReadPolicy.ts — trip_members encodes "pending" in TWO
 * columns (legacy `role='invited'`, current `status='invited'`), so a predicate
 * reading one of them is defective in both directions.
 */
function isAcceptedMembershipRow(r: { role?: string | null; status?: string | null }): boolean {
  if (!r.role || !ACCEPTED_TRIP_ROLES.has(r.role)) return false;
  return r.status == null || r.status === "accepted";
}

function errText(e: unknown): string {
  return String((e as any)?.message ?? e);
}

/** Accepted trip co-members of `ownerId`, by the definition of record. */
async function tripCoMembersOf(
  sc: any,
  ownerId: string,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; detail: string }> {
  const [ownRows, ownedTrips] = await Promise.all([
    sc.from("trip_members").select("trip_id, role, status").eq("user_id", ownerId),
    sc.from("trips").select("id").eq("owner_id", ownerId),
  ]);
  if (ownRows.error) return { ok: false, detail: `trip_members read failed: ${errText(ownRows.error)}` };
  if (ownedTrips.error) return { ok: false, detail: `trips read failed: ${errText(ownedTrips.error)}` };

  const rowTrips = new Set<string>();
  const trips = new Set<string>();
  for (const r of (ownRows.data ?? []) as any[]) {
    rowTrips.add(r.trip_id as string);
    if (isAcceptedMembershipRow(r)) trips.add(r.trip_id as string);
  }
  for (const t of (ownedTrips.data ?? []) as any[]) {
    if (!rowTrips.has(t.id as string)) trips.add(t.id as string);
  }
  if (trips.size === 0) return { ok: true, ids: new Set() };

  const tripIds = [...trips];
  const [crew, owners] = await Promise.all([
    sc.from("trip_members").select("trip_id, user_id, role, status").in("trip_id", tripIds),
    sc.from("trips").select("id, owner_id").in("id", tripIds),
  ]);
  if (crew.error) return { ok: false, detail: `trip_members crew read failed: ${errText(crew.error)}` };
  if (owners.error) return { ok: false, detail: `trips owner read failed: ${errText(owners.error)}` };

  const ids = new Set<string>();
  const rowKeys = new Set<string>();
  for (const r of (crew.data ?? []) as any[]) {
    rowKeys.add(`${r.trip_id}:${r.user_id}`);
    if (isAcceptedMembershipRow(r)) ids.add(r.user_id as string);
  }
  for (const t of (owners.data ?? []) as any[]) {
    if (t.owner_id && !rowKeys.has(`${t.id}:${t.owner_id}`)) ids.add(t.owner_id as string);
  }
  return { ok: true, ids };
}

/**
 * Everyone whose Compass cache could hold `highlightId`.
 *
 * Every read binds `.error`. An unread source does NOT silently shrink the
 * audience to the part that happened to load: it is recorded in `sources` and
 * clears `bounded`, which is what makes the caller's outcome say
 * `audience_incomplete` instead of claiming a fan-out it did not perform.
 */
export async function resolveCacheEvictionAudience(
  sc: any,
  highlightId: string,
  ownerId: string,
): Promise<CacheAudience> {
  const sources: AudienceSourceResult[] = [];
  const ids = new Set<string>([ownerId]);
  let bounded = true;

  if (!sc) {
    return {
      userIds: [ownerId],
      bounded: false,
      visibility: null,
      sources: [{
        source: "service_client",
        resolved: false,
        detail: "no service client: another viewer's follows, circle and trip rows are not readable with the caller's own credentials",
      }],
    };
  }

  const h = await sc.from("highlights").select("id, owner_id, visibility").eq("id", highlightId).maybeSingle();
  if (h.error) {
    sources.push({ source: "highlights", resolved: false, detail: `highlights read failed: ${errText(h.error)}` });
    bounded = false;
  } else if (h.data && (h.data as any).owner_id !== ownerId) {
    // NOT this caller's Highlight. `highlight_views` would enumerate SOMEBODY
    // ELSE'S viewers, and the report carries `audience` on the wire — so a
    // fan-out over an unowned subject is an audience-disclosure oracle, not a
    // privacy control. Resolve nothing, evict nobody but the caller, and say
    // why. The PUT route checks ownership before the write (ownsHighlight in
    // highlightControlWrites); this is the second lock, here rather than only
    // at the caller.
    sources.push({ source: "highlights", resolved: false, detail: "subject is not owned by the caller — no audience resolved and no other viewer's cache touched" });
    return { userIds: [ownerId], bounded: false, visibility: null, sources };
  } else if (!h.data) {
    // The route verified ownership before the control was written, so a row
    // that is now unreadable-as-absent is a fact about this read, not about
    // the Highlight. Either way the audience rule cannot be selected.
    sources.push({ source: "highlights", resolved: false, detail: "highlight row not returned — the visibility rule that defines the audience could not be selected" });
    bounded = false;
  } else {
    sources.push({ source: "highlights", resolved: true, detail: "visibility read" });
  }
  const visibility = (h.data as any)?.visibility ?? null;

  // Recorded viewers, in EVERY case: these people demonstrably rendered the
  // Highlight, possibly under a wider visibility than it has now.
  const views = await sc.from("highlight_views").select("viewer_id").eq("highlight_id", highlightId);
  if (views.error) {
    sources.push({ source: "highlight_views", resolved: false, detail: `highlight_views read failed: ${errText(views.error)}` });
    bounded = false;
  } else {
    for (const r of (views.data ?? []) as any[]) if (r.viewer_id) ids.add(r.viewer_id as string);
    sources.push({ source: "highlight_views", resolved: true, detail: `${(views.data ?? []).length} recorded viewer row(s)` });
  }

  if (visibility === "public" || visibility === "travelers_nearby") {
    // Reachable part only. `canViewHighlight` admits ANY authenticated user to
    // these two rungs, so the audience is the user table; enumerating it, or
    // scanning compass_feed_cache, is not something a privacy control should
    // trigger. Followers are the set a proactive feed actually assembles from
    // (GET /highlights/following-feed), so they are the part worth evicting.
    const follows = await sc.from("user_follows").select("follower_id").eq("following_id", ownerId);
    if (follows.error) {
      sources.push({ source: "user_follows", resolved: false, detail: `user_follows read failed: ${errText(follows.error)}` });
    } else {
      for (const r of (follows.data ?? []) as any[]) if (r.follower_id) ids.add(r.follower_id as string);
      sources.push({ source: "user_follows", resolved: true, detail: `${(follows.data ?? []).length} follower row(s)` });
    }
    bounded = false;
  } else if (visibility === "circle_only") {
    // circle_memberships is keyed (user_id = the owner, other_id = the member),
    // the same direction routes/highlights.ts reads it.
    const circle = await sc.from("circle_memberships").select("other_id").eq("user_id", ownerId);
    if (circle.error) {
      sources.push({ source: "circle_memberships", resolved: false, detail: `circle_memberships read failed: ${errText(circle.error)}` });
      bounded = false;
    } else {
      for (const r of (circle.data ?? []) as any[]) if (r.other_id) ids.add(r.other_id as string);
      sources.push({ source: "circle_memberships", resolved: true, detail: `${(circle.data ?? []).length} circle row(s)` });
    }
  } else if (visibility === "trip_only") {
    const crew = await tripCoMembersOf(sc, ownerId);
    if (!crew.ok) {
      sources.push({ source: "trip_membership", resolved: false, detail: crew.detail });
      bounded = false;
    } else {
      for (const id of crew.ids) ids.add(id);
      sources.push({ source: "trip_membership", resolved: true, detail: `${crew.ids.size} accepted co-member(s)` });
    }
  } else if (visibility === "private") {
    // Nobody but the owner was ever served it. The recorded viewers above are
    // still evicted: a Highlight can have been public yesterday.
  } else if (visibility !== null) {
    sources.push({ source: "highlights", resolved: false, detail: `unrecognised visibility ${JSON.stringify(visibility)} — no audience rule matches it` });
    bounded = false;
  }

  return { userIds: [...ids], bounded, visibility, sources };
}

/* ── the fan-out, and its honest report ────────────────────────────────────*/

export type CacheEvictionOutcome =
  /** The control changes nothing about what other viewers see. */
  | "not_applicable"
  /** Every audience source read, the rule bounds the audience, every eviction call returned. */
  | "l1_evicted_persisted_unverifiable"
  /** A source failed, the visibility rule is unbounded, or the cap was hit. */
  | "audience_incomplete"
  /** An eviction call itself failed for at least one user. */
  | "eviction_failed";

export interface CacheEvictionReport {
  readonly control: string;
  readonly subjectId: string;
  readonly reachesOtherViewers: boolean;
  readonly visibility: string | null;
  readonly audience: readonly string[];
  readonly audienceBounded: boolean;
  readonly sources: readonly AudienceSourceResult[];
  readonly evicted: readonly string[];
  readonly failed: readonly { readonly userId: string; readonly detail: string }[];
  /**
   * Typed `false`, not `boolean`. CompassCacheEngine.invalidate returns void
   * and swallows the persisted delete; nothing this module can observe would
   * justify `true`, so the type refuses it.
   */
  readonly persistedPurgeVerified: false;
  readonly outcome: CacheEvictionOutcome;
  readonly detail: string;
}

/**
 * A privacy control must not be able to trigger an unbounded eviction storm.
 * Hitting the cap is reported as `audience_incomplete` — the fan-out really
 * was partial, and saying otherwise is the lie this module exists to avoid.
 */
export const CACHE_FANOUT_AUDIENCE_CAP = 500;

const UNVERIFIABLE =
  "Each eviction called CompassCacheEngine.invalidate, which evicts its in-process L1 synchronously " +
  "and unconditionally but wraps the persisted compass_feed_cache delete and the audit insert in a " +
  "swallowing try/catch and returns void. L1 eviction is therefore established; the PERSISTED PURGE IS " +
  "BEST-EFFORT AND UNVERIFIABLE from here, and this report never claims otherwise. The audience is the " +
  "permission audience, not the set of cache rows that hold this Highlight: compass_feed_cache.payload " +
  "is unindexed JSON and querying it would need a migration.";

export async function fanOutCacheEviction(params: {
  readonly sc: any;
  readonly control: unknown;
  readonly subjectId: string;
  readonly ownerId: string;
  readonly reason: string;
  readonly invalidate: (userId: string, reason: string) => Promise<void> | void;
  readonly log?: { error: (obj: unknown, msg: string) => void } | undefined;
  readonly cap?: number;
  /**
   * `false` suppresses the fan-out even for a control that would otherwise get
   * one. The DELETE route passes `false` when the clear removed no row: the
   * selector there is unchecked user input, and resolving an audience for a
   * subject the caller never set would turn `audience` into a disclosure
   * oracle for somebody else's viewer set.
   */
  readonly fanOut?: boolean;
}): Promise<CacheEvictionReport> {
  const { sc, control, subjectId, ownerId, reason, invalidate, log } = params;
  const cap = params.cap ?? CACHE_FANOUT_AUDIENCE_CAP;
  const fanOut = params.fanOut !== false;

  if (!fanOut || !controlNeedsCacheFanout(control)) {
    // Still evict the setter: their own proactive surfaces changed. But say
    // plainly that no other viewer needed reaching, rather than reporting a
    // fan-out that was never due.
    const failed: Array<{ userId: string; detail: string }> = [];
    try {
      await invalidate(ownerId, reason);
    } catch (err) {
      failed.push({ userId: ownerId, detail: errText(err) });
    }
    return {
      control: String(control),
      subjectId,
      reachesOtherViewers: false,
      visibility: null,
      audience: [ownerId],
      audienceBounded: true,
      sources: [],
      evicted: failed.length === 0 ? [ownerId] : [],
      failed,
      persistedPurgeVerified: false,
      outcome: failed.length > 0 ? "eviction_failed" : "l1_evicted_persisted_unverifiable",
      detail:
        (fanOut
          ? `${String(control)} suppresses ${JSON.stringify(CONTROL_EFFECTS[control as ResurfacingControl]?.suppresses ?? [])}, ` +
            "none of which is another viewer's view, so only the setter's cache is due for eviction. "
          : "the caller's request changed no stored control of theirs, so no other viewer's projection changed and no audience was resolved. ") +
        UNVERIFIABLE,
    };
  }

  const audience = await resolveCacheEvictionAudience(sc, subjectId, ownerId);
  let targets = audience.userIds;
  let capped = false;
  if (targets.length > cap) {
    capped = true;
    targets = targets.slice(0, cap);
  }

  const evicted: string[] = [];
  const failed: Array<{ userId: string; detail: string }> = [];
  const results = await Promise.allSettled(
    targets.map(async (userId) => {
      await invalidate(userId, reason);
      return userId;
    }),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") evicted.push(targets[i]!);
    else failed.push({ userId: targets[i]!, detail: errText((r as PromiseRejectedResult).reason) });
  });

  const unresolved = audience.sources.filter((s) => !s.resolved);
  const outcome: CacheEvictionOutcome =
    failed.length > 0
      ? "eviction_failed"
      : audience.bounded && !capped
        ? "l1_evicted_persisted_unverifiable"
        : "audience_incomplete";

  const why: string[] = [];
  if (!audience.bounded) {
    if (unresolved.length > 0) why.push(`unresolved audience source(s): ${unresolved.map((u) => `${u.source} (${u.detail})`).join("; ")}`);
    if (audience.visibility === "public" || audience.visibility === "travelers_nearby") {
      why.push(`visibility ${audience.visibility} admits any authenticated user, which is not an enumerable audience — the owner, recorded viewers and followers were evicted and nobody else`);
    }
  }
  if (capped) why.push(`audience exceeded the ${cap}-user cap and was truncated`);

  const detail = `${evicted.length} cache(s) evicted for control ${String(control)} on ${subjectId}` +
    (why.length > 0 ? `. INCOMPLETE: ${why.join(". ")}` : "") +
    `. ${UNVERIFIABLE}`;

  if (outcome !== "l1_evicted_persisted_unverifiable") {
    log?.error(
      { control: String(control), subjectId, outcome, unresolved, capped, visibility: audience.visibility, evicted: evicted.length },
      "highlights: §11 cache fan-out did not reach the whole audience — the control IS stored; the eviction is reported partial rather than complete",
    );
  }

  return {
    control: String(control),
    subjectId,
    reachesOtherViewers: true,
    visibility: audience.visibility,
    audience: targets,
    audienceBounded: audience.bounded && !capped,
    sources: audience.sources,
    evicted,
    failed,
    persistedPurgeVerified: false,
    outcome,
    detail,
  };
}
