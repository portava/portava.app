/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW17): every events list the client reads marks the counts
 * the server could not recount live, so the cards can say them as last known.
 *
 * The server names a failed or cut live count read in `failedSources` (`event_rsvps`, `event_waitlist`) and serves the
 * cached count (B20, SW18). The list services passed the body through, and no screen read the name.
 *
 *   SM1  listEvents, listMyEvents, listFollowingEvents, listCircleEvents, getSavedEvents: `failedSources` names both reads
 *        → every event is marked `goingCountUnread` and `waitlistCountUnread`
 *   SM0  CONTROL: a body that names neither → the events as served, unmarked
 */
jest.mock('../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

// NOTE: intentionally exhaustive — apiToken exposes a single async helper; a stable token reaches fetch.
jest.mock('../apiToken.ts', () => ({
  freshToken: jest.fn(async () => 'tok'),
}));

import { listEvents, listMyEvents, listFollowingEvents, listCircleEvents, getSavedEvents } from '../events.ts';

const event = { id: 'ev-1', title: 'Rooftop quiz', goingCount: 5, waitlistCount: 3, coverUrl: null };
const CALLS: Array<[string, () => Promise<any>]> = [
  ['listEvents', () => listEvents({ limit: 10 })],
  ['listMyEvents', () => listMyEvents(10)],
  ['listFollowingEvents', () => listFollowingEvents({ limit: 10 })],
  ['listCircleEvents', () => listCircleEvents({ limit: 10 })],
  ['getSavedEvents', () => getSavedEvents(1)],
];

function answer(body: Record<string, unknown>) {
  (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

describe('census-discovery §117 (SW17): the list services mark the counts the server could not recount', () => {
  afterEach(() => { delete (global as any).fetch; });

  for (const [name, call] of CALLS) {
    it(`SM1 ${name}: failedSources names both reads → every event is marked`, async () => {
      answer({ events: [event], failedSources: ['event_rsvps', 'event_waitlist'] });
      const r = await call();
      expect(r.ok).toBe(true);
      expect(r.data.events[0]).toMatchObject({ id: 'ev-1', goingCount: 5, goingCountUnread: true, waitlistCountUnread: true });
    });
    it(`SM0 ${name}: CONTROL, a whole body → unmarked`, async () => {
      answer({ events: [event] });
      const r = await call();
      expect(r.ok).toBe(true);
      expect(r.data.events[0].goingCountUnread).toBeUndefined();
      expect(r.data.events[0].waitlistCountUnread).toBeUndefined();
    });
  }
});
