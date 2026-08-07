/**
 * app/plan/[id].tsx — addressable alias for a trip's plan.
 *
 * A "plan" is not an entity in this codebase. There is no plans table; the
 * trip_plan_items rows are keyed on trip_id, every server route is scoped as
 * /trips/:tripId/plan/..., and the satellite tables (plan_geofences,
 * plan_checkins, plan_editors, plan_attendance_events) all hang off a trip or
 * a plan item, never off a plan of their own. The UI calls it "Trip Plan" and
 * renders it as TripPlanSection inside app/trip/[id].
 *
 * So :id here is a TRIP id, and this route redirects to the trip screen with
 * the plan section focused — the same redirect-alias pattern as
 * app/profile/[handle].tsx, which forwards to app/u/[username].
 *
 * (Meetups are a separate thing: they are a real table with their own ids and
 * they already have app/meetup/[id].tsx. A meetup is not a plan.)
 */
import { useEffect } from 'react';
import { useLocalSearchParams, router } from 'expo-router';

export default function PlanRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();

  useEffect(() => {
    if (id) {
      router.replace(`/trip/${encodeURIComponent(id)}?focus=plan`);
    } else {
      router.back();
    }
  }, [id]);

  return null;
}
