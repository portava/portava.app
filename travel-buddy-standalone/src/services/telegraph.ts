/**
 * Telegraph client service.
 * Fetches AI activity recommendations from POST /api/telegraph/recommend.
 * Falls back to built-in mock recommendations when backend is unavailable.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import type { TelegraphActivityRecommendation, Interest } from '../types/models.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

export interface TelegraphRecommendContext {
  interests?: Interest[];
  travelStyle?: string;
  destination?: string;
  tripDates?: { start: string; end: string };
  conversationContext?: string;
  recipientName?: string;
  defaultLanguage?: string;
  count?: number;
}

export interface TelegraphRecommendResult {
  ok: boolean;
  recommendations: TelegraphActivityRecommendation[];
  error?: string;
}

export async function getActivityRecommendations(
  context: TelegraphRecommendContext,
): Promise<TelegraphRecommendResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: true, recommendations: buildMockRecommendations(context) };
  }

  const token = await freshToken();
  if (!token) {
    return { ok: true, recommendations: buildMockRecommendations(context) };
  }

  try {
    const res = await fetch(`${apiBase()}/api/telegraph/recommend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(context),
    });
    if (!res.ok) {
      return { ok: true, recommendations: buildMockRecommendations(context) };
    }
    const body = await res.json();
    return { ok: true, recommendations: body.recommendations ?? [] };
  } catch {
    return { ok: true, recommendations: buildMockRecommendations(context) };
  }
}

function buildMockRecommendations(
  ctx: TelegraphRecommendContext,
): TelegraphActivityRecommendation[] {
  const dest = ctx.destination ?? 'your destination';
  const interests = ctx.interests ?? [];
  const count = ctx.count ?? 3;

  const all: TelegraphActivityRecommendation[] = [
    {
      id: 'rec_mock_1',
      title: `Coastal exploration near ${dest}`,
      category: 'beach',
      reason: 'Matches your beach and adventure interests. Top-rated by solo travelers.',
      locationContext: `Near ${dest}`,
      estimatedTime: 'Full day',
      priceLevel: '$$',
    },
    {
      id: 'rec_mock_2',
      title: `Top-rated local cuisine in ${dest}`,
      category: 'food',
      reason: 'One of the best local dining experiences — a must for food lovers.',
      locationContext: `${dest} city center`,
      estimatedTime: '1–2 hours',
      priceLevel: '$',
    },
    {
      id: 'rec_mock_3',
      title: `Nightlife district in ${dest}`,
      category: 'nightlife',
      reason: 'Great bar-hopping area for solo travelers and nightlife fans.',
      locationContext: `${dest} entertainment district`,
      estimatedTime: '3–4 hours',
      priceLevel: '$$',
    },
    {
      id: 'rec_mock_4',
      title: `Adventure day trip from ${dest}`,
      category: 'activity',
      reason: 'Top adventure activity in the region. Book a guide in advance.',
      locationContext: `Day trip from ${dest}`,
      estimatedTime: 'Full day',
      priceLevel: '$$',
    },
    {
      id: 'rec_mock_5',
      title: `Heritage walk in ${dest}`,
      category: 'activity',
      reason: 'Great for culture and photography. Free to explore at your own pace.',
      locationContext: `${dest} historic district`,
      estimatedTime: '2–3 hours',
      priceLevel: 'free',
    },
  ];

  // Prioritize recs that match declared interests
  const sorted = all.sort((a, b) => {
    const aMatch = interests.some((i) => a.category.includes(i) || a.title.toLowerCase().includes(i));
    const bMatch = interests.some((i) => b.category.includes(i) || b.title.toLowerCase().includes(i));
    return (bMatch ? 1 : 0) - (aMatch ? 1 : 0);
  });

  return sorted.slice(0, count);
}
