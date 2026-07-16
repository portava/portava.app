/**
 * Telegraph recommend service — fetches AI place recommendations for the
 * Discovery Hub's "For You" tab.
 */
import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

/** Minimal hashtag span returned by the Telegraph recommend endpoint. */
export interface TelegraphHashtagSpan {
  slug: string;
  hashtagId?: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
}

/** Minimal @mention span returned by the Telegraph recommend endpoint (permission-filtered). */
export interface TelegraphTagSpan {
  type: 'user';
  id: string;
  matchToken: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
}

export interface TelegraphRecommendation {
  id: string;
  title: string;
  category: string;
  reason: string;
  locationContext: string;
  estimatedTime: string;
  priceLevel: string;
  imageUrl: string | null;
  /** Server-resolved positioned #hashtag spans for the `reason` field. */
  hashtagSpans?: TelegraphHashtagSpan[];
  /** Server-resolved, permission-filtered @mention spans for the `reason` field. */
  tagSpans?: TelegraphTagSpan[];
}

export interface ForYouParams {
  destination: string;
  interests?: string[];
  travelStyle?: string;
  count?: number;
}

export async function getForYouRecommendations(
  params: ForYouParams,
): Promise<{ ok: true; recommendations: TelegraphRecommendation[] } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10 s hard cap

  try {
    const res = await fetch(`${base}/api/telegraph/recommend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        destination: params.destination,
        interests: params.interests ?? ['food', 'culture', 'adventure'],
        travelStyle: params.travelStyle ?? 'explorer',
        count: params.count ?? 8,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { recommendations: TelegraphRecommendation[] };
    return { ok: true, recommendations: data.recommendations ?? [] };
  } catch (e) {
    clearTimeout(timeoutId);
    const isTimeout = e instanceof Error && e.name === 'AbortError';
    return { ok: false, error: isTimeout ? 'Request timed out' : 'Network error' };
  }
}
