/**
 * Trip Daily Brief Engine
 *
 * Assembles a TripDailyBrief for an accepted trip member for a given date.
 * Inputs: plan items, meetups, shared availability, Telegraph recommendations,
 * the user's preference profile. All assembled through the privacy resolver.
 *
 * Privacy: no exact GPS, no private availability of other users.
 * Degrades gracefully when optional data sources (meetups, availability) absent.
 */

import type { UserPreferenceProfile } from "./preferenceLearning.js";
import { scoreRecommendation } from "./preferenceLearning.js";

export type BriefWarningKind =
  | "time_overlap"
  | "cancelled_meetup"
  | "free_window_unplanned"
  | "late_addition";

export type BriefType = "trip_context" | "general";

export interface BriefPlanPreview {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  category: string;
  status: string;
  locationName: string | null;
  warnings: string[];
}

export interface BriefSuggestion {
  id: string;
  title: string;
  category: string;
  reason: string;
  estimatedTime: string;
  priceLevel: string;
  score: number;
  /** Gap day this suggestion is for, if any (YYYY-MM-DD) */
  forGapDay?: string;
}

export interface BriefMeetupOpportunity {
  id: string;
  title: string;
  proposedTime: string | null;
  attendeeCount: number;
}

export interface BriefQuickAction {
  id: string;
  label: string;
  kind: "add_to_plan" | "create_meetup" | "ask_telegraph" | "view_plan" | "open_poll";
  params?: Record<string, string>;
}

export interface BriefOpenWindow {
  label: string;
  startTime: string;
  endTime: string;
}

/** An upcoming meetup (within 24 h) for which the user is going or maybe. */
export interface UpcomingMeetup24h {
  id: string;
  title: string;
  proposedTime: string;
  locationName: string | null;
}

export interface TripDailyBrief {
  tripId: string;
  userId: string;
  date: string;
  briefType: BriefType;
  destination: string | null;
  summaryText: string;
  weatherSummary: string | null;
  planPreview: BriefPlanPreview[];
  openWindows: BriefOpenWindow[];
  suggestions: BriefSuggestion[];
  meetupOpportunities: BriefMeetupOpportunity[];
  /** Gap days (days within the trip window that have no plan items). */
  gapDays: string[];
  warnings: BriefWarningKind[];
  quickActions: BriefQuickAction[];
  generatedAt: string;
  isStale: boolean;
}

interface PlanRow {
  id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  category: string;
  status: string;
  location_name: string | null;
  day_date: string | null;
  warnings?: string[];
}

interface MeetupRow {
  id: string;
  title: string;
  proposed_time: string | null;
  attendee_count: number;
  status: string;
}

export interface RawRecommendation {
  id: string;
  title: string;
  category: string;
  reason: string;
  estimatedTime: string;
  priceLevel: string;
  /** If set, this suggestion is specifically for this gap day (YYYY-MM-DD). */
  forGapDay?: string;
}

export function buildDailyBrief(opts: {
  tripId: string;
  userId: string;
  date: string;
  briefType: BriefType;
  destination: string | null;
  tripStartDate: string | null;
  tripEndDate: string | null;
  planItems: PlanRow[];
  meetups: MeetupRow[];
  upcomingMeetups24h?: UpcomingMeetup24h[];
  recommendations: RawRecommendation[];
  preferenceProfile: UserPreferenceProfile | null;
  weatherSummary?: string | null;
}): TripDailyBrief {
  const {
    tripId,
    userId,
    date,
    briefType,
    destination,
    tripStartDate,
    tripEndDate,
    planItems,
    meetups,
    recommendations,
    preferenceProfile,
    weatherSummary = null,
  } = opts;
  const upcomingMeetups24h: UpcomingMeetup24h[] = opts.upcomingMeetups24h ?? [];

  // Filter plan items for the target date
  const dayItems = planItems.filter((i) => i.day_date === date);

  const planPreview: BriefPlanPreview[] = dayItems.map((i) => ({
    id: i.id,
    title: i.title,
    startsAt: i.starts_at,
    endsAt: i.ends_at,
    category: i.category,
    status: i.status,
    locationName: i.location_name,
    warnings: i.warnings ?? [],
  }));

  // Detect warnings
  const warnings: BriefWarningKind[] = [];
  const hasOverlap = dayItems.some((i) => i.warnings?.includes("time_overlap"));
  if (hasOverlap) warnings.push("time_overlap");

  const cancelledMeetups = meetups.filter((m) => m.status === "cancelled");
  if (cancelledMeetups.length > 0) warnings.push("cancelled_meetup");

  // Compute open windows (simplified: before first item, between items, after last item)
  const openWindows = computeOpenWindows(dayItems, date);
  if (openWindows.length > 0 && dayItems.length === 0) warnings.push("free_window_unplanned");

  // Compute gap days — trip days with no plan items at all
  const gapDays = computeGapDays(planItems, tripStartDate, tripEndDate, date);

  // Score and sort suggestions against preference profile
  const scoredSuggestions: BriefSuggestion[] = recommendations.map((r) => {
    const score = preferenceProfile
      ? scoreRecommendation(r.category, preferenceProfile.explicit, preferenceProfile.inferred)
      : 0;
    return {
      id: r.id,
      title: r.title,
      category: r.category,
      reason: r.reason,
      estimatedTime: r.estimatedTime,
      priceLevel: r.priceLevel,
      score,
      ...(r.forGapDay ? { forGapDay: r.forGapDay } : {}),
    };
  });
  scoredSuggestions.sort((a, b) => b.score - a.score);

  // Meetup opportunities (active meetups only)
  const meetupOpportunities: BriefMeetupOpportunity[] = meetups
    .filter((m) => m.status !== "cancelled")
    .map((m) => ({
      id: m.id,
      title: m.title,
      proposedTime: m.proposed_time,
      attendeeCount: m.attendee_count,
    }));

  // Quick actions
  const quickActions: BriefQuickAction[] = [
    { id: "qa_plan", label: "View plan", kind: "view_plan" },
    { id: "qa_telegraph", label: "Ask Telegraph", kind: "ask_telegraph" },
  ];
  if (openWindows.length > 0) {
    const dest = destination ? ` in ${destination}` : "";
    quickActions.push({
      id: "qa_fill",
      label: "Fill free time",
      kind: "ask_telegraph",
      params: { prompt: `What should I do during my free time${dest}?` },
    });
  }
  if (dayItems.length === 0) {
    const dest = destination ? ` in ${destination}` : "";
    quickActions.push({
      id: "qa_plan_day",
      label: "Plan today",
      kind: "ask_telegraph",
      params: { prompt: `Help me plan today${dest}` },
    });
  }
  // Upcoming meetup action: suggest nearby food if meetup is at lunch (11–13) or dinner (17+) time
  for (const m of upcomingMeetups24h.slice(0, 1)) {
    const meetupHour = new Date(m.proposedTime).getHours();
    const isLunch  = meetupHour >= 11 && meetupHour < 14;
    const isDinner = meetupHour >= 17;
    if (isLunch || isDinner) {
      const meal = isLunch ? "lunch" : "dinner";
      const dest = destination ? ` in ${destination}` : "";
      const locationHint = m.locationName ?? null;
      // Structured params let Telegraph generate location/time-aware food suggestions.
      // prompt is kept as a human-readable fallback for clients that ignore the structured fields.
      const params: Record<string, string> = {
        prompt: locationHint
          ? `Find ${meal} options near ${locationHint} before my ${m.title} meetup`
          : `Find ${meal} options before my ${m.title} meetup${dest}`,
        meetupId: m.id,
        meetupTime: m.proposedTime,
      };
      if (locationHint) params.meetupLocation = locationHint;
      quickActions.push({
        id: `qa_premeetup_${m.id}`,
        label: `Find ${meal} nearby`,
        kind: "ask_telegraph",
        params,
      });
    }
  }

  // Summary text
  const summaryText = buildSummaryText({
    planCount: dayItems.length,
    openWindowCount: openWindows.length,
    suggestionCount: scoredSuggestions.length,
    destination,
    briefType,
    gapDays,
    upcomingMeetups24h,
  });

  return {
    tripId,
    userId,
    date,
    briefType,
    destination,
    summaryText,
    weatherSummary,
    planPreview,
    openWindows,
    suggestions: scoredSuggestions.slice(0, 4),
    meetupOpportunities: meetupOpportunities.slice(0, 2),
    gapDays,
    warnings,
    quickActions,
    generatedAt: new Date().toISOString(),
    isStale: false,
  };
}

/**
 * Compute gap days — calendar days within the trip date range that have no
 * plan items assigned to them. Excludes today (the date being briefed) since
 * the "today" section covers that. Returns at most 5 gap days.
 */
function computeGapDays(
  planItems: PlanRow[],
  tripStartDate: string | null,
  tripEndDate: string | null,
  today: string,
): string[] {
  if (!tripStartDate || !tripEndDate) return [];

  const start = new Date(tripStartDate + "T00:00:00Z");
  const end   = new Date(tripEndDate   + "T00:00:00Z");

  // Build set of days that have at least one plan item
  const daysWithItems = new Set<string>();
  for (const item of planItems) {
    if (item.day_date) daysWithItems.add(item.day_date);
  }

  const gaps: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end && gaps.length < 5) {
    const isoDate = cursor.toISOString().slice(0, 10);
    if (isoDate !== today && !daysWithItems.has(isoDate)) {
      gaps.push(isoDate);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return gaps;
}

function computeOpenWindows(items: PlanRow[], date: string): BriefOpenWindow[] {
  const windows: BriefOpenWindow[] = [];
  const timed = items
    .filter((i) => i.starts_at)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());

  if (timed.length === 0) {
    windows.push({ label: "All day open", startTime: "09:00", endTime: "22:00" });
    return windows;
  }

  const dayStart = new Date(`${date}T09:00:00`);
  const firstStart = new Date(timed[0].starts_at!);
  if (firstStart.getTime() - dayStart.getTime() >= 90 * 60 * 1000) {
    windows.push({
      label: "Free before first activity",
      startTime: "09:00",
      endTime: formatTime(timed[0].starts_at!),
    });
  }

  for (let i = 0; i < timed.length - 1; i++) {
    const current = timed[i];
    const next = timed[i + 1];
    const currentEnd = current.ends_at
      ? new Date(current.ends_at)
      : new Date(new Date(current.starts_at!).getTime() + 60 * 60 * 1000);
    const nextStart = new Date(next.starts_at!);
    const gap = nextStart.getTime() - currentEnd.getTime();
    if (gap >= 90 * 60 * 1000) {
      windows.push({
        label: "Free window",
        startTime: formatTime(currentEnd.toISOString()),
        endTime: formatTime(next.starts_at!),
      });
    }
  }

  const lastItem = timed[timed.length - 1];
  const lastEnd = lastItem.ends_at
    ? new Date(lastItem.ends_at)
    : new Date(new Date(lastItem.starts_at!).getTime() + 60 * 60 * 1000);
  const dayEnd = new Date(`${date}T22:00:00`);
  if (dayEnd.getTime() - lastEnd.getTime() >= 90 * 60 * 1000) {
    windows.push({
      label: "Free evening",
      startTime: formatTime(lastEnd.toISOString()),
      endTime: "22:00",
    });
  }

  return windows;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function buildSummaryText(opts: {
  planCount: number;
  openWindowCount: number;
  suggestionCount: number;
  destination: string | null;
  briefType: BriefType;
  gapDays: string[];
  upcomingMeetups24h: UpcomingMeetup24h[];
}): string {
  const { planCount, openWindowCount, suggestionCount, destination, briefType, gapDays, upcomingMeetups24h } = opts;
  const dest = destination ? ` in ${destination}` : "";

  // General brief (no active trip) — travel inspiration
  if (briefType === "general") {
    return suggestionCount > 0
      ? "No active trip right now — here's some travel inspiration to spark your next adventure."
      : "No active trip right now. Start planning your next trip to get personalised suggestions.";
  }

  // Trip-context brief
  // Upcoming meetup nudge (within 24 h)
  const nextMeetup = upcomingMeetups24h[0] ?? null;
  const meetupNudge = nextMeetup
    ? ` You have ${nextMeetup.title} at ${formatTime(nextMeetup.proposedTime)}${nextMeetup.locationName ? ` at ${nextMeetup.locationName}` : ""} — plan around it.`
    : "";

  if (planCount === 0 && openWindowCount > 0) {
    const gapHint = gapDays.length > 0
      ? ` You also have ${gapDays.length} unplanned day${gapDays.length > 1 ? "s" : ""} ahead.`
      : "";
    return `Your day${dest} is open — ${suggestionCount > 0 ? "Telegraph has suggestions ready" : "add something to your plan"}.${gapHint}${meetupNudge}`;
  }
  if (planCount > 0 && openWindowCount > 0) {
    return `${planCount} plan item${planCount > 1 ? "s" : ""} today${dest} with ${openWindowCount} free window${openWindowCount > 1 ? "s" : ""}.${meetupNudge}`;
  }
  if (planCount > 0) {
    return `${planCount} plan item${planCount > 1 ? "s" : ""} today${dest} — looking full.${meetupNudge}`;
  }
  return `Today${dest} is unplanned — let Telegraph help.${meetupNudge}`;
}
