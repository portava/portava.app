/**
 * Weather context helper — Open-Meteo (free, no API key required).
 *
 * Geocodes a destination name → lat/lng, then fetches a daily forecast for
 * the requested date range. Results are cached in-memory per
 * destination+date-range with a 6-hour TTL.
 *
 * Privacy: only the destination name (and derived lat/lng) is sent to
 * external APIs. No user identifiers or private trip data leave this server.
 *
 * Graceful degradation: any error or timeout returns null — callers must
 * treat the result as optional.
 */

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000; // 6 hours

export interface DailyWeather {
  date: string;       // YYYY-MM-DD
  weatherCode: number;
  summary: string;    // Human-readable, e.g. "Rainy"
  maxTempC: number;
  minTempC: number;
  precipMm: number;
}

export interface WeatherContext {
  destination: string;
  forecasts: DailyWeather[];
  briefSummary: string; // 1–2 sentence narrative for AI prompt injection
}

interface CacheEntry {
  context: WeatherContext;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(destination: string, startDate: string, endDate: string): string {
  return `${destination.toLowerCase()}:${startDate}:${endDate}`;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

function wmoSummary(code: number): string {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  return "Thunderstorms";
}

function buildBriefSummary(forecasts: DailyWeather[]): string {
  if (forecasts.length === 0) return "";
  const rainy = forecasts.filter((f) => f.precipMm > 2 || f.weatherCode >= 51);
  const sunny = forecasts.filter((f) => f.weatherCode <= 3);
  if (rainy.length > 0 && rainy.length < forecasts.length) {
    const labels = rainy.slice(0, 2).map((f) =>
      new Date(f.date + "T12:00:00").toLocaleDateString("en", {
        weekday: "short", month: "short", day: "numeric",
      }),
    );
    return `Rain forecast on ${labels.join(" and ")} — indoor alternatives recommended those days.`;
  }
  if (rainy.length === forecasts.length) {
    return "Rainy weather expected throughout — pack rain gear and plan indoor activities.";
  }
  if (sunny.length === forecasts.length) {
    const avg = Math.round(forecasts.reduce((s, f) => s + f.maxTempC, 0) / forecasts.length);
    return `Sunny skies throughout with highs around ${avg}°C — great conditions for outdoor activities.`;
  }
  const f = forecasts[0];
  return `${f.summary} expected, with temperatures ${f.minTempC}–${f.maxTempC}°C.`;
}

async function fetchWithTimeout(url: string, options?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocode(destination: string): Promise<{ lat: number; lng: number } | null> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(destination)}&count=1&language=en&format=json`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const data = await res.json() as any;
  const r = data?.results?.[0];
  if (!r) return null;
  return { lat: r.latitude as number, lng: r.longitude as number };
}

export async function getWeatherContext(
  destination: string,
  startDate?: string,
  endDate?: string,
): Promise<WeatherContext | null> {
  const today = new Date().toISOString().slice(0, 10);
  const start = startDate ?? today;
  const end = endDate && endDate >= start ? endDate : start;

  const key = cacheKey(destination, start, end);
  const cached = cache.get(key);
  if (cached && isFresh(cached)) return cached.context;

  try {
    const coords = await geocode(destination);
    if (!coords) return null;

    const url =
      `${FORECAST_URL}?latitude=${coords.lat}&longitude=${coords.lng}` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum` +
      `&timezone=auto&start_date=${start}&end_date=${end}`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;

    const data = await res.json() as any;
    const daily = data?.daily;
    if (!daily?.time?.length) return null;

    const forecasts: DailyWeather[] = (daily.time as string[]).map((date: string, i: number) => ({
      date,
      weatherCode: daily.weathercode?.[i] ?? 0,
      summary: wmoSummary(daily.weathercode?.[i] ?? 0),
      maxTempC: Math.round(daily.temperature_2m_max?.[i] ?? 0),
      minTempC: Math.round(daily.temperature_2m_min?.[i] ?? 0),
      precipMm: Math.round((daily.precipitation_sum?.[i] ?? 0) * 10) / 10,
    }));

    const context: WeatherContext = {
      destination,
      forecasts,
      briefSummary: buildBriefSummary(forecasts),
    };
    cache.set(key, { context, cachedAt: Date.now() });
    return context;
  } catch {
    return null;
  }
}
