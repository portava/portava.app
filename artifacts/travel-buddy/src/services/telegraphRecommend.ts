/**
 * Telegraph recommend service — fetches AI place recommendations for the
 * Discovery Hub's "For You" tab.
 */
import { supabase } from '../lib/supabase';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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
        count: params.count ?? 5,
      }),
    });

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { recommendations: TelegraphRecommendation[] };
    return { ok: true, recommendations: data.recommendations ?? [] };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}
