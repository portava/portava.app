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

const MAX_BLOCK_CHARS      = 1200;
const UPCOMING_WINDOW_DAYS = 60;
const MAX_TODAY_ITEMS      = 5;
const DAY_MS               = 86_400_000;

const TRIP_COLUMNS =
  "id, title, destination_city, destination_country, start_date, end_date, status, timezone";
const TRIP_STATUSES = ["active", "upcoming", "planning", "draft"];

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
    // ── Trip selection (mirrors toolGetCurrentTrip) ───────────────────────
    // Trip SELECTION reads: a failure here returns no context at all, which is
    // the safe outcome. It is not silent-by-omission — an incomplete union
    // would silently drop trips the user is a member of, and the assistant
    // would then reason about the wrong trip rather than about none.
    const { data: memberRows, error: memberErr } = await sc
      .from("trip_members")
      .select("trip_id, role")
      .eq("user_id", userId)
      .in("role", ["owner", "member"]);
    if (memberErr) return [];
    const memberTripIds = ((memberRows ?? []) as any[]).map((r) => r.trip_id as string);

    const { data: owned, error: ownedErr } = await sc
      .from("trips")
      .select(TRIP_COLUMNS)
      .eq("owner_id", userId)
      .in("status", TRIP_STATUSES);
    if (ownedErr) return [];

    let memberTrips: any[] = [];
    if (memberTripIds.length > 0) {
      const { data, error: mtErr } = await sc
        .from("trips")
        .select(TRIP_COLUMNS)
        .in("id", memberTripIds)
        .in("status", TRIP_STATUSES);
      if (mtErr) return [];
      memberTrips = (data ?? []) as any[];
    }

    const seen = new Set<string>();
    const all = [...((owned ?? []) as any[]), ...memberTrips].filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
    if (all.length === 0) return [];

    // Prefer active, then earliest start date.
    all.sort((a, b) => {
      const aActive = a.status === "active" ? 0 : 1;
      const bActive = b.status === "active" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return String(a.start_date ?? "9999").localeCompare(String(b.start_date ?? "9999"));
    });
    const trip = all[0] as any;

    // Trip title is UGC (user-entered, and a trip is shared with members), so wrap
    // it in <portava:ugc> — matching the plan-item titles below — before it lands
    // in the /ask prompt. A co-member could otherwise inject via the trip title.
    const title    = wrapUgc(String(trip.title ?? "Untitled trip"));
    const city     = String(trip.destination_city ?? "unknown city");
    const country  = String(trip.destination_country ?? "unknown country");
    const tz       = trip.timezone;

    const today    = todayYmd(tz, new Date());
    const todayMs  = ymdToUtcMs(today);
    const startYmd = typeof trip.start_date === "string" ? trip.start_date.slice(0, 10) : null;
    const endYmd   = typeof trip.end_date   === "string" ? trip.end_date.slice(0, 10)   : null;
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
