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

export interface TripDailyBrief {
  tripId: string;
  userId: string;
  date: string;
  summaryText: string;
  planPreview: BriefPlanPreview[];
  openWindows: BriefOpenWindow[];
  suggestions: BriefSuggestion[];
  meetupOpportunities: BriefMeetupOpportunity[];
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
}

export function buildDailyBrief(opts: {
  tripId: string;
  userId: string;
  date: string;
  planItems: PlanRow[];
  meetups: MeetupRow[];
  recommendations: RawRecommendation[];
  preferenceProfile: UserPreferenceProfile | null;
}): TripDailyBrief {
  const { tripId, userId, date, planItems, meetups, recommendations, preferenceProfile } = opts;

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
    quickActions.push({ id: "qa_fill", label: "Fill free time", kind: "ask_telegraph", params: { prompt: "Fill free time" } });
  }
  if (dayItems.length === 0) {
    quickActions.push({ id: "qa_plan_day", label: "Plan today", kind: "ask_telegraph", params: { prompt: "Plan tonight" } });
  }

  // Summary text
  const summaryText = buildSummaryText(dayItems.length, openWindows.length, scoredSuggestions.length);

  return {
    tripId,
    userId,
    date,
    summaryText,
    planPreview,
    openWindows,
    suggestions: scoredSuggestions.slice(0, 3),
    meetupOpportunities: meetupOpportunities.slice(0, 2),
    warnings,
    quickActions,
    generatedAt: new Date().toISOString(),
    isStale: false,
  };
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

function buildSummaryText(planCount: number, openWindowCount: number, suggestionCount: number): string {
  if (planCount === 0 && openWindowCount > 0) {
    return `Your day is open — ${suggestionCount > 0 ? "Telegraph has suggestions ready" : "add something to your plan"}.`;
  }
  if (planCount > 0 && openWindowCount > 0) {
    return `${planCount} plan item${planCount > 1 ? "s" : ""} today with ${openWindowCount} free window${openWindowCount > 1 ? "s" : ""}.`;
  }
  if (planCount > 0) {
    return `${planCount} plan item${planCount > 1 ? "s" : ""} today — looking full.`;
  }
  return "Today is unplanned — let Telegraph help.";
}
