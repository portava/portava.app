/**
 * MOCK Passport data — TEMPORARY local fallback. Replace with usePassport()
 * backed by the API. Shapes match src/types/models.ts exactly.
 */
import type { PassportData, PassportStamp, Plan, Perk } from '../types/models';
import { me, users, cebu, trips } from './cebu';

const dRef = { id: cebu.id, city: cebu.city, country: cebu.country, slug: cebu.slug };

const stamps: PassportStamp[] = [
  { id: 's1', kind: 'city', label: 'CEBU', sublabel: 'PH · 2026', earnedAt: '2026-06-10T00:00:00Z' },
  { id: 's2', kind: 'city', label: 'MANILA', sublabel: 'PH · 2026', earnedAt: '2026-06-08T00:00:00Z' },
  { id: 's3', kind: 'city', label: 'TOKYO', sublabel: 'JP · 2025', earnedAt: '2025-11-02T00:00:00Z' },
  { id: 's4', kind: 'safe', label: 'SAFE MEETUP', sublabel: 'x3', earnedAt: '2026-06-12T00:00:00Z' },
  { id: 's5', kind: 'gem', label: 'HIDDEN GEM', sublabel: 'Carbon Mkt', earnedAt: '2026-06-13T00:00:00Z' },
  { id: 's6', kind: 'plan', label: 'FIRST PLAN', sublabel: 'joined', earnedAt: '2026-06-13T00:00:00Z' },
  { id: 's7', kind: 'host', label: 'FIRST HOST', sublabel: 'locked', earnedAt: '', locked: true },
  { id: 's8', kind: 'perk', label: 'PERK', sublabel: 'locked', earnedAt: '', locked: true },
];

const plans: Plan[] = [
  {
    id: 'pl1', title: 'Sunset dive @ Mactan', destination: dRef, host: users[0],
    status: 'joined', startAt: '2026-06-20T09:00:00Z', attendeeCount: 4, capacity: 6, category: 'adventure',
  },
  {
    id: 'pl2', title: 'IT Park food crawl', destination: dRef, host: users[2],
    status: 'open', startAt: '2026-06-21T19:00:00Z', attendeeCount: 7, capacity: 10, category: 'food',
  },
];

const perks: Perk[] = [
  { id: 'pk1', title: 'Welcome perk', detail: 'Free city guide PDF', unlocked: true },
  { id: 'pk2', title: 'Trusted traveler', detail: 'Priority plan invites', unlocked: false, requirement: 'Reach Trusted tier' },
  { id: 'pk3', title: 'Host rewards', detail: 'Featured host badge', unlocked: false, requirement: 'Host 1 plan' },
];

export const mockPassport: PassportData = {
  user: me,
  stats: { citiesVisited: 12, plansJoined: 8, buddies: 34, stamps: stamps.filter((s) => !s.locked).length, hostedPlans: 0 },
  trust: { score: 72, tier: 'trusted', verifiedId: true, completedPlans: 6, positiveReviews: 19, safeMeetups: 3 },
  stamps,
  travelStyle: me.interests,
  plans,
  buddies: users,
  perks,
};
