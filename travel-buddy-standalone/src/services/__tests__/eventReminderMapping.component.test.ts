/**
 * Event reminders are read off the server's rows as they are.
 *
 * THE DEFECT. GET /api/events/:id/reminders answers `select("*")` rows from
 * `event_reminders`, and POST answers the inserted row — both snake_case
 * (`remind_at`, `event_id`, `created_at`; artifacts/api-server/src/routes/events.ts).
 * The client typed them as `EventReminder` and passed them straight through, so
 * `app/event/[id].tsx` read `reminder.remindAt` — undefined — and told the
 * traveller "Reminder set for Invalid Date" both when they set one and when
 * they came back to an event that already had one.
 *
 * Only `fetch` is faked; the module under test is the real events service.
 *
 * RED on the tree before this change: 2 failed / 0 passed.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the events service only needs a configured flag and a session.
jest.mock('../../lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: 'tok' } } }),
    },
  },
}));

/** A row exactly as `event_reminders` stores it. */
const ROW = {
  id: 'r1', event_id: 'e1', user_id: 'u1', remind_at: '2030-06-07T19:00:00.000Z',
  note: null, sent: false, created_at: '2030-06-01T10:00:00.000Z',
};

const fetchMock = jest.fn();
let svc: typeof import('../events.ts');

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  svc = require('../events.ts');
});
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
});

describe('event reminders — the server row becomes a reminder with a real time', () => {
  it('GET: an existing reminder carries remindAt, so "Reminder set for …" is a date', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ reminders: [ROW] }) });
    const r = await svc.getEventReminders('e1');
    const reminder = r.data!.reminders[0]!;
    expect(reminder).toEqual({ id: 'r1', eventId: 'e1', userId: 'u1', remindAt: ROW.remind_at, note: null, sent: false, createdAt: ROW.created_at });
    expect(new Date(reminder.remindAt).toLocaleString()).not.toBe('Invalid Date');
  });

  it('POST: the reminder just set carries remindAt', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ROW });
    const r = await svc.createEventReminder('e1', ROW.remind_at);
    expect(r.ok).toBe(true);
    expect(r.data!.remindAt).toBe(ROW.remind_at);
    expect(Number.isNaN(new Date(r.data!.remindAt).getTime())).toBe(false);
  });
});
