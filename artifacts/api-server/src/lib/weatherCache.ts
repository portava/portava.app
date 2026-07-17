/**
 * Weather context helper — Open-Meteo (free, no API key required).
 *
 * Geocodes a destination name → lat/lng, then fetches a daily forecast for
 * the requested date range. Results are cached at two layers:
 *   1. In-memory Map (fast, lost on restart)     — 6-hour TTL
 *   2. Supabase weather_cache table (durable)    — 6-hour TTL
 *
 * Read order on cache miss: memory → DB → Open-Meteo.
 * Write order on fresh fetch: memory + DB (best-effort, upsert).
 *
 * Privacy: only the destination name (and derived lat/lng) is sent to
 * external APIs. No user identifiers or private trip data leave this server.
 *
 * Graceful degradation: any error or timeout returns null — callers must
 * treat the result as optional.
 */

import { getServiceClient } from './supabase';

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
  cachedAt: number; // Unix ms
}

const cache = new Map<string, CacheEntry>();

function memKey(destination: string, startDate: string, endDate: string): string {
  return `${destination.toLowerCase()}:${startDate}:${endDate}`;
}

function dbDateKey(startDate: string, endDate: string): string {
  return `${startDate}:${endDate}`;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

/* ── DB helpers ───────────────────────────────────────────────────────────── */

async function dbGet(destination: string, dateKey: string): Promise<CacheEntry | null> {
  const client = getServiceClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('weather_cache')
      .select('brief_summary, forecasts_json, fetched_at')
      .eq('destination', destination.toLowerCase())
      .eq('date_key', dateKey)
      .single();
    if (error || !data) return null;
    const cachedAt = new Date(data.fetched_at as string).getTime();
    if (Date.now() - cachedAt >= CACHE_TTL_MS) return null;
    const context: WeatherContext = {
      destination,
      forecasts: data.forecasts_json as DailyWeather[],
      briefSummary: data.brief_summary as string,
    };
    return { context, cachedAt };
  } catch {
    return null;
  }
}

async function dbSet(destination: string, dateKey: string, entry: CacheEntry): Promise<void> {
  const client = getServiceClient();
  if (!client) return;
  try {
    await client.from('weather_cache').upsert(
      {
        destination: destination.toLowerCase(),
        date_key: dateKey,
        brief_summary: entry.context.briefSummary,
        forecasts_json: entry.context.forecasts,
        fetched_at: new Date(entry.cachedAt).toISOString(),
      },
      { onConflict: 'destination,date_key' },
    );
  } catch {
    // best-effort — never block the response
  }
}

/* ── Utility ──────────────────────────────────────────────────────────────── */

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

/* ── Public API ───────────────────────────────────────────────────────────── */

export async function getWeatherContext(
  destination: string,
  startDate?: string,
  endDate?: string,
): Promise<WeatherContext | null> {
  // Single clock read for this call — `today` and the cache timestamp both
  // derive from nowMs so they can never disagree (split-clock risk).
  const nowMs = Date.now();
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const start = startDate ?? today;
  const end = endDate && endDate >= start ? endDate : start;

  const key = memKey(destination, start, end);
  const dateKey = dbDateKey(start, end);

  // 1. In-memory cache (fastest)
  const memEntry = cache.get(key);
  if (memEntry && isFresh(memEntry)) return memEntry.context;

  // 2. DB cache (survives server restart)
  const dbEntry = await dbGet(destination, dateKey);
  if (dbEntry) {
    cache.set(key, dbEntry);
    return dbEntry.context;
  }

  // 3. Live fetch from Open-Meteo
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
    const entry: CacheEntry = { context, cachedAt: nowMs };

    // Write to both layers (DB is best-effort — don't await to block response)
    cache.set(key, entry);
    dbSet(destination, dateKey, entry).catch(() => {});

    return context;
  } catch {
    return null;
  }
}
