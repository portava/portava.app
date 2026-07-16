/**
 * Mock trip detail for the Trip Page (Pass 1). Mock seam — swap to backend later.
 * Marked as mock; do not present as live trip data.
 */
import type { TripDetail } from '../types/models';
import { users } from './cebu';

export const mockTripDetail: TripDetail = {
  id: 't1',
  title: 'Cebu Trip',
  destinationCity: 'Lapu-Lapu City + Cebu City',
  destinationCountry: 'Philippines',
  neighborhoods: ['Lapu-Lapu City', 'Cebu City', 'IT Park', 'Mactan'],
  startDate: '2025-06-20',
  endDate: '2025-06-27',
  nights: 7,
  status: 'active',
  visibility: 'buddies',
  travelStyle: 'Solo Traveler',
  openToMeet: true,
  availabilityLabel: 'Evenings + Weekends',
  coverUrl: '',
  progress: 70,
  progressSteps: [
    { label: 'Add your availability', done: true },
    { label: 'Add 3+ plans', done: true },
    { label: 'Invite a buddy', done: true },
    { label: 'Check-in to first plan', done: false },
  ],
  nextUpPlanId: 'p1',
  timeline: [
    {
      dateLabel: 'TODAY', dateSub: 'Jun 20', iso: '2025-06-20',
      items: [
        { id: 'tl1', kind: 'plan', time: '7:00 PM', title: 'Dinner & Drinks at Sugbo Mercado', place: 'IT Park, Cebu City', attendeeCount: 5 },
        { id: 'tl2', kind: 'plan', time: '10:00 PM', title: 'Rooftop Night at 7100', place: 'Lahug, Cebu City', attendeeCount: 3 },
      ],
    },
    {
      dateLabel: 'SAT', dateSub: 'Jun 21', iso: '2025-06-21',
      items: [
        { id: 'tl3', kind: 'plan', time: '9:00 AM', title: 'Island Hopping in Mactan', place: 'Mactan Island', attendeeCount: 4 },
        { id: 'tl4', kind: 'free', time: '7:00 PM', title: 'Open Evening', place: 'Add a plan or ask Compass for ideas' },
      ],
    },
    { dateLabel: 'SUN', dateSub: 'Jun 22', iso: '2025-06-22', items: [] },
    { dateLabel: 'MON', dateSub: 'Jun 23', iso: '2025-06-23', items: [] },
    { dateLabel: 'TUE', dateSub: 'Jun 24', iso: '2025-06-24', items: [] },
  ],
  savedIdeas: [
    { id: 's1', name: 'Lechon Crawl', category: 'Food', neighborhood: 'Cebu City', source: 'discovery' },
    { id: 's2', name: 'Rooftop Bars', category: 'Nightlife', neighborhood: 'Lahug', source: 'discovery' },
    { id: 's3', name: 'Tumalog Falls', category: 'Nature', neighborhood: 'Oslob, Cebu', source: 'gem' },
  ],
  safetyStatus: 'ok',
};

/** Next-up plan card data (mock). */
export const mockNextUp = {
  id: 'p1',
  badge: 'TONIGHT',
  time: '7:00 PM',
  title: 'Dinner & Drinks at Sugbo Mercado',
  place: 'IT Park, Cebu City',
  host: users[0],
  attendees: users.slice(0, 4),
  attendeeCount: 5,
};

/* ── Trip Pass 2 mock data (plans, circle, stamps) — clearly mock, replaceable ── */
import type { PassportStamp } from '../types/models';

export type TripPlanStatus = 'joined' | 'hosting' | 'requested' | 'saved' | 'past';
export interface TripPlan {
  id: string;
  title: string;
  time: string;
  neighborhood: string;
  status: TripPlanStatus;
  attendeeCount: number;
  hasGroup: boolean;
}

export const tripPlans: TripPlan[] = [
  { id: 'tp1', title: 'Dinner & Drinks at Sugbo Mercado', time: 'Tonight · 7:00 PM', neighborhood: 'IT Park, Cebu City', status: 'joined', attendeeCount: 5, hasGroup: true },
  { id: 'tp2', title: 'Rooftop Night at 7100', time: 'Tonight · 10:00 PM', neighborhood: 'Lahug, Cebu City', status: 'joined', attendeeCount: 3, hasGroup: true },
  { id: 'tp3', title: 'Island Hopping in Mactan', time: 'Tomorrow · 9:00 AM', neighborhood: 'Mactan Island', status: 'hosting', attendeeCount: 4, hasGroup: true },
  { id: 'tp4', title: 'Sunset Beach Hang', time: 'Sat · 5:30 PM', neighborhood: 'Mactan Island', status: 'requested', attendeeCount: 8, hasGroup: false },
];

export const tripCircle = {
  cityCount: 3,
  inCity: users.slice(0, 3),
  suggested: [...users].slice(1, 6),
};

export const tripStamps: PassportStamp[] = [
  { id: 'ts1', kind: 'city', label: 'CEBU', sublabel: 'ARRIVAL', earnedAt: '2025-06-20T00:00:00Z' },
  { id: 'ts2', kind: 'plan', label: 'FIRST PLAN', sublabel: 'JOINED', earnedAt: '2025-06-20T00:00:00Z' },
  { id: 'ts3', kind: 'gem', label: 'HIDDEN GEM', sublabel: 'FOUND', earnedAt: '', locked: true },
  { id: 'ts4', kind: 'safe', label: 'SAFE RETURN', sublabel: 'CHECKED', earnedAt: '', locked: true },
  { id: 'ts5', kind: 'host', label: 'HOST', sublabel: 'EXPERIENCE', earnedAt: '', locked: true },
];

export const tripPosts: { id: string; city: string; caption: string; mediaUrl?: string }[] = [
  // empty by default to show the empty state; backend fills later
];
