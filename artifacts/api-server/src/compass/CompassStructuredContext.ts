/**
 * CompassStructuredContext — Phase 3 structured context expansion.
 *
 * Gathers circle memberships, active bookings, and Passport/stamp history for
 * a user and formats them as a privacy-guarded prompt context block for the
 * Compass AI assistant.
 *
 * Privacy guarantees (see docs/compass/master-roadmap.md — global rules):
 *   - NO coordinates ever reach the model: coordinate columns are never
 *     selected, and `stripCoordinateFields()` removes any lat/lng-shaped key
 *     from every row as defense-in-depth.
 *   - Blocked, blocker, and muted user IDs (from CompassProfile) are filtered
 *     out of circle members and bookings before formatting.
 *   - User-generated text (circle names, stamp title overrides) is wrapped in
 *     <portava:ugc>…</portava:ugc> data-not-instructions delimiters; nested
 *     delimiters inside user text are neutralized.
 *   - Free-text fields that could carry private info (booking notes) are
 *     never included.
 *
 * Mode weighting: `buildModeWeightingLines()` makes the derived UI modes
 * (arrival/night/budget, etc.) explicit, inspectable inputs to the prompt.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile, CompassContextState, CompassIntentMode } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StructuredCircle {
  /** UGC-wrapped circle name (already delimiter-safe). */
  name: string;
  /** @handles of visible (non-blocked, non-muted) members. */
  memberHandles: string[];
  /** True when the caller owns this circle. */
  isOwner: boolean;
}

export interface StructuredBooking {
  city: string;
  /**
   * The booking day (`rent_buddy_bookings.booking_date`). A Rent-a-Buddy
   * booking is single-day by construction — the schema carries
   * `booking_date` + `start_time` + `duration_h`, and there is no
   * `date_from` / `date_to` pair anywhere on the table. This field used to be
   * `dateFrom`/`dateTo` read from those two non-existent columns, which made
   * the whole select fail 42703 and the booking context permanently empty.
   */
  date: string;
  /** Local start time (`start_time`), or null when the booking has none. */
  startTime: string | null;
  /** Booked duration in hours (`duration_h`), or null. */
  durationHours: number | null;
  status: string;
  /** @handle of the buddy, or null if unavailable/filtered. */
  buddyHandle: string | null;
}

export interface StructuredStamp {
  /** Display title (UGC-wrapped when a user override is present). */
  title: string;
  city: string | null;
  country: string | null;
  earnedAt: string;
}

export interface StructuredCompassContext {
  circles: StructuredCircle[];
  activeBookings: StructuredBooking[];
  recentStamps: StructuredStamp[];
}

// ── UGC delimiters ────────────────────────────────────────────────────────────

/**
 * Wrap user-generated text in explicit data-not-instructions delimiters.
 * Any attempt to close/open the delimiter from inside the text is neutralized.
 */
export function wrapUgc(text: string): string {
  const neutralized = String(text).replace(/<\/?portava:ugc>/gi, "");
  return `<portava:ugc>${neutralized}</portava:ugc>`;
}

// ── Coordinate scrub (defense-in-depth) ───────────────────────────────────────

const COORD_KEY_RE = /^(lat|lng|lon|long|latitude|longitude)$|(_|^)(lat|lng|lon|latitude|longitude)(_|$)|Lat$|Lng$|Latitude$|Longitude$/i;

/** Remove any coordinate-shaped key from a row. Returns a new object. */
export function stripCoordinateFields<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (COORD_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

// ── Builders ──────────────────────────────────────────────────────────────────

function hiddenUserIds(profile: CompassProfile): Set<string> {
  return new Set([
    ...(profile.blockedUserIds ?? []),
    ...(profile.blockerUserIds ?? []),
    ...(profile.mutedUserIds ?? []),
  ]);
}

/**
 * Build the structured Compass context for a user. Never throws — any data
 * source failure degrades to an empty section.
 */
export async function buildStructuredCompassContext(
  sc: SupabaseClient,
  profile: CompassProfile,
): Promise<StructuredCompassContext> {
  const userId = profile.userId;
  const hidden = hiddenUserIds(profile);

  const empty: StructuredCompassContext = { circles: [], activeBookings: [], recentStamps: [] };
  const result: StructuredCompassContext = { ...empty };

  // ── Circles ────────────────────────────────────────────────────────────────
  try {
    const [{ data: owned }, { data: memberships }] = await Promise.all([
      sc.from("circles").select("id, name, owner_id").eq("owner_id", userId).limit(10),
      sc.from("circle_memberships").select("user_id, other_id, status").eq("other_id", userId).limit(10),
    ]);

    const ownedRows = ((owned ?? []) as any[]).map((r) => stripCoordinateFields(r));

    // Circles the user belongs to via membership (user_id = circle owner)
    const joinedOwnerIds = ((memberships ?? []) as any[])
      .filter((m) => (m.status ?? "accepted") === "accepted")
      .map((m) => m.user_id as string)
      .filter((id) => !hidden.has(id));

    let joinedRows: any[] = [];
    if (joinedOwnerIds.length > 0) {
      const { data: joined } = await sc
        .from("circles")
        .select("id, name, owner_id")
        .in("owner_id", joinedOwnerIds)
        .limit(10);
      joinedRows = ((joined ?? []) as any[]).map((r) => stripCoordinateFields(r));
    }

    const allCircles = [
      ...ownedRows.map((r) => ({ ...r, __isOwner: true })),
      ...joinedRows.map((r) => ({ ...r, __isOwner: false })),
    ];

    // Members of each circle: circle_memberships rows where user_id = circle owner
    const ownerIds = allCircles.map((c: any) => c.owner_id as string);
    let memberRows: any[] = [];
    if (ownerIds.length > 0) {
      const { data: members } = await sc
        .from("circle_memberships")
        .select("user_id, other_id, status")
        .in("user_id", ownerIds)
        .limit(200);
      memberRows = ((members ?? []) as any[]).filter(
        (m) => (m.status ?? "accepted") === "accepted",
      );
    }

    // Resolve visible member handles (block/mute filtered BEFORE the lookup)
    const visibleMemberIds = [
      ...new Set(
        memberRows
          .map((m) => m.other_id as string)
          .filter((id) => id !== userId && !hidden.has(id)),
      ),
    ];
    const handleById = new Map<string, string>();
    if (visibleMemberIds.length > 0) {
      const { data: profs } = await sc
        .from("profiles")
        .select("id, handle")
        .in("id", visibleMemberIds)
        .limit(200);
      for (const p of (profs ?? []) as any[]) {
        if (p.handle) handleById.set(p.id as string, `@${p.handle}`);
      }
    }

    result.circles = allCircles.slice(0, 5).map((c: any) => {
      const members = memberRows
        .filter((m) => m.user_id === c.owner_id)
        .map((m) => m.other_id as string)
        .filter((id) => id !== userId && !hidden.has(id))
        .map((id) => handleById.get(id))
        .filter(Boolean) as string[];
      return {
        name: wrapUgc(String(c.name ?? "Circle")),
        memberHandles: [...new Set(members)].slice(0, 8),
        isOwner: Boolean(c.__isOwner),
      };
    });
  } catch { /* non-fatal — no circle context */ }

  // ── Active bookings ────────────────────────────────────────────────────────
  try {
    const { data: bookings } = await sc
      .from("rent_buddy_bookings")
      // `date_from` / `date_to` are NOT columns of rent_buddy_bookings — the
      // table has `booking_date` (date) + `start_time` + `duration_h`, and
      // routes/rentABuddy.ts:4625 already proves the mapping by translating its
      // own ?dateFrom/?dateTo query params onto `booking_date`. PostgREST
      // rejects an unknown column with 42703 and fails the WHOLE select, so
      // `bookings` was always undefined here and `result.activeBookings` was
      // always []. Compass's Ask/chat prompt has therefore never known that the
      // caller has a buddy booking, and `social_mode` ("user has an active
      // buddy booking") could never be evidenced from this context.
      .select("buddy_id, city, booking_date, start_time, duration_h, status")
      .eq("traveler_id", userId)
      .in("status", ["confirmed", "in_progress"])
      .limit(5);

    const rows = ((bookings ?? []) as any[])
      .map((r) => stripCoordinateFields(r))
      .filter((r: any) => !hidden.has(r.buddy_id as string));

    const buddyIds = [...new Set(rows.map((r: any) => r.buddy_id as string).filter(Boolean))];
    const buddyHandleById = new Map<string, string>();
    if (buddyIds.length > 0) {
      const { data: profs } = await sc
        .from("profiles")
        .select("id, handle")
        .in("id", buddyIds)
        .limit(20);
      for (const p of (profs ?? []) as any[]) {
        if (p.handle) buddyHandleById.set(p.id as string, `@${p.handle}`);
      }
    }

    result.activeBookings = rows.slice(0, 3).map((r: any) => ({
      city:        String(r.city ?? ""),
      date:        String(r.booking_date ?? ""),
      startTime:   r.start_time != null ? String(r.start_time) : null,
      durationHours:
        r.duration_h != null && Number.isFinite(Number(r.duration_h))
          ? Number(r.duration_h)
          : null,
      status:      String(r.status ?? ""),
      buddyHandle: buddyHandleById.get(r.buddy_id as string) ?? null,
      // rent_buddy_bookings.notes (the traveller's free text — hotel, room
      // number, meeting point) is intentionally NEVER selected or included.
    }));
  } catch { /* non-fatal — no booking context */ }

  // ── Passport / stamp history ───────────────────────────────────────────────
  try {
    // lat/lng columns intentionally NOT selected
    const { data: stamps } = await sc
      .from("user_stamps")
      .select("title_override, city, country, earned_at, is_revoked, stamp_definitions(name)")
      .eq("user_id", userId)
      .eq("is_revoked", false)
      .order("earned_at", { ascending: false })
      .limit(10);

    result.recentStamps = ((stamps ?? []) as any[])
      .map((r) => stripCoordinateFields(r))
      .map((r: any) => {
        const defName = r.stamp_definitions?.name ?? null;
        const title = r.title_override
          ? wrapUgc(String(r.title_override))
          : String(defName ?? "Stamp");
        return {
          title,
          city:     r.city ?? null,
          country:  r.country ?? null,
          earnedAt: String(r.earned_at ?? ""),
        };
      });
  } catch { /* non-fatal — no stamp context */ }

  return result;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Render the structured context as prompt lines. Empty sections are omitted.
 * The output never contains coordinates and never contains hidden users —
 * both are filtered upstream in buildStructuredCompassContext().
 */
export function formatStructuredContextLines(ctx: StructuredCompassContext): string[] {
  const lines: string[] = [];

  if (ctx.circles.length > 0) {
    lines.push("Circles (trusted groups):");
    for (const c of ctx.circles) {
      const members = c.memberHandles.length > 0 ? ` — members: ${c.memberHandles.join(", ")}` : "";
      lines.push(`• ${c.name}${c.isOwner ? " (owner)" : ""}${members}`);
    }
  }

  if (ctx.activeBookings.length > 0) {
    lines.push("Active buddy bookings (city-level only):");
    for (const bkg of ctx.activeBookings) {
      const buddy = bkg.buddyHandle ? ` with ${bkg.buddyHandle}` : "";
      const when = [
        bkg.startTime ? String(bkg.startTime).slice(0, 5) : null,
        bkg.durationHours != null ? `${bkg.durationHours}h` : null,
      ].filter(Boolean).join(", ");
      lines.push(`• ${bkg.city}${buddy} — ${bkg.date}${when ? ` (${when})` : ""} (${bkg.status})`);
    }
  }

  if (ctx.recentStamps.length > 0) {
    lines.push("Passport history (recent stamps):");
    for (const s of ctx.recentStamps) {
      const where = [s.city, s.country].filter(Boolean).join(", ");
      const date = s.earnedAt ? s.earnedAt.slice(0, 10) : "";
      lines.push(`• ${s.title}${where ? ` — ${where}` : ""}${date ? ` (${date})` : ""}`);
    }
  }

  return lines;
}

// ── Mode weighting ────────────────────────────────────────────────────────────

const MODE_WEIGHTING_HINTS: Record<string, string> = {
  arrival_mode: "user is arriving within 48h — weight orientation, logistics, first-day essentials",
  night_mode:   "it is night-time for the user — weight open-late options and safety-conscious suggestions",
  budget_mode:  "user travels on a backpacker budget — weight free and low-cost options first",
  safety_mode:  "a safety session is active — prioritize safety and check-in guidance over discovery",
  social_mode:  "user has an active buddy booking — weight meetup-friendly suggestions",
  explore_now:  "user is exploring their current city — weight nearby, do-today options",
  plan_ahead:   "user is planning a future trip — weight planning and itinerary suggestions",
  private_mode: "user prefers privacy — avoid social/visibility-increasing suggestions",
  creator_mode: "user has pending posts — content-creation-friendly suggestions are welcome",
};

/**
 * Make derived UI modes explicit, inspectable prompt-weighting inputs.
 * Returns lines like: "Mode weighting: primary=arrival_mode (…hint…); secondary=night_mode".
 */
export function buildModeWeightingLines(
  contextState: CompassContextState,
  intentMode: CompassIntentMode,
): string[] {
  const parts: string[] = [];
  const primaryHint = MODE_WEIGHTING_HINTS[intentMode.primary];
  parts.push(`primary=${intentMode.primary}${primaryHint ? ` (${primaryHint})` : ""}`);
  for (const m of intentMode.secondary) {
    const hint = MODE_WEIGHTING_HINTS[m];
    parts.push(`secondary=${m}${hint ? ` (${hint})` : ""}`);
  }
  return [
    `Context state: ${contextState}`,
    `Mode weighting: ${parts.join("; ")}`,
  ];
}
