/**
 * The daily brief's last-known-weather fallback reads where the server writes.
 *
 * THE DEFECT. GET /api/trips/:tripId/daily-brief answers
 * `{ access: "full", brief: { …, weatherSummary } }` (artifacts/api-server/src/
 * routes/dailyBrief.ts). `fetchDailyBrief` looked for `data.weatherSummary` —
 * a key the response never has — so it never saved a summary, and on a day
 * Open-Meteo was down it "restored" one onto the top level, where
 * DailyBriefCard (which reads `brief.weatherSummary`) never looks. The
 * traveller lost the weather line exactly when the fallback existed to keep it.
 *
 * Only `fetch` is faked; AsyncStorage is the official jest mock (jest.config
 * moduleNameMapper).
 *
 * RED on the tree before this change: 2 failed / 0 passed.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

// NOTE: intentionally exhaustive — the service lazy-requires AsyncStorage's `.default`
// (the ESM shape the app bundle gives it); the official jest mock is CommonJS with
// no `.default`, so that same mock object is exposed as the ESM default here.
jest.mock('@react-native-async-storage/async-storage', () => {
  const m = jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock');
  return { __esModule: true, default: m };
});
// NOTE: intentionally exhaustive — the real module builds a Supabase client at
// import time; the service reads only the configured flag.
jest.mock('../../lib/supabase', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: intentionally exhaustive — the token helper is the only export used.
jest.mock('../apiToken', () => ({ freshToken: async () => 'tok' }));

const fetchMock = jest.fn();
let fetchDailyBrief: typeof import('../intelligence.ts').fetchDailyBrief;

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  fetchDailyBrief = require('../intelligence.ts').fetchDailyBrief;
});
beforeEach(async () => {
  fetchMock.mockReset();
  (globalThis as any).fetch = fetchMock;
  await AsyncStorage.clear();
});

const answer = (brief: Record<string, unknown> | null) =>
  ({ ok: true, status: 200, json: async () => ({ access: 'full', brief }) });

describe('fetchDailyBrief — weather fallback', () => {
  it("saves the brief's weather summary as the last known one", async () => {
    fetchMock.mockResolvedValue(answer({ destination: 'Tokyo', weatherSummary: 'Sunny, 24°C' }));
    const r = await fetchDailyBrief('trip-1');
    expect(r.ok).toBe(true);
    await Promise.resolve();
    expect(await AsyncStorage.getItem('weather_summary:trip-1')).toBe('Sunny, 24°C');
  });

  it('restores the last known summary INTO the brief when today has none', async () => {
    await AsyncStorage.setItem('weather_summary:trip-1', 'Light rain, 18°C');
    fetchMock.mockResolvedValue(answer({ destination: 'Tokyo', weatherSummary: null }));
    const r = await fetchDailyBrief('trip-1');
    expect(r.data.brief.weatherSummary).toBe('Light rain, 18°C');
  });
});
