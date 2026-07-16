/**
 * Available attach targets (trips + plans) for the selector. Derived from
 * existing mock data. Replace with real user trips/plans from backend later.
 */
import type { AttachTarget } from '../types/models';
import { tripPlans, mockTripDetail } from './tripDetail';

/** Trips the user can add to. Active trip first, then upcoming/planning. */
export const attachTripTargets: AttachTarget[] = [
  {
    id: mockTripDetail.id, type: 'trip', title: mockTripDetail.title,
    subtitle: `${mockTripDetail.destinationCity} · ${mockTripDetail.status}`,
    group: 'active',
  },
  { id: 'trip_tokyo', type: 'trip', title: 'Tokyo Spring', subtitle: 'Japan · upcoming', group: 'upcoming' },
  { id: 'trip_bali', type: 'trip', title: 'Bali Escape', subtitle: 'Indonesia · planning', group: 'planning' },
];

/** Plans the user can add to. Trip-linked plans first. */
export const attachPlanTargets: AttachTarget[] = [
  ...tripPlans
    .filter((p) => p.status === 'joined' || p.status === 'hosting')
    .map((p): AttachTarget => ({ id: p.id, type: 'plan', title: p.title, subtitle: p.time, group: 'trip_plans' })),
  { id: 'plan_draft1', type: 'plan', title: 'Weekend in Moalboal', subtitle: 'Draft', group: 'draft' },
];

export const TRIP_GROUP_LABEL: Record<string, string> = {
  active: 'Active trip', upcoming: 'Upcoming', planning: 'Planning',
};
export const PLAN_GROUP_LABEL: Record<string, string> = {
  trip_plans: 'Plans on this trip', open: 'Your plans', draft: 'Drafts',
};
