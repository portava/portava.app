/**
 * Telegraph client service.
 * Fetches AI activity recommendations from POST /api/telegraph/recommend.
 * Falls back to built-in mock recommendations when backend is unavailable.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { TelegraphActivityRecommendation, Interest } from '../types/models';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return session?.access_token ?? null;
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
  const dest = ctx.destination ?? 'Cebu';
  const interests = ctx.interests ?? [];
  const count = ctx.count ?? 3;

  const all: TelegraphActivityRecommendation[] = [
    {
      id: 'rec_mock_1',
      title: `Island Hopping near ${dest}`,
      category: 'beach',
      reason: 'Matches your beach and adventure interests. Top-rated by solo travelers.',
      locationContext: '45 min from Mactan Pier',
      estimatedTime: 'Full day',
      priceLevel: '$$',
    },
    {
      id: 'rec_mock_2',
      title: 'Lechón at CNT Lechon',
      category: 'food',
      reason: 'Best-rated lechón in the Visayas — a must for food lovers.',
      locationContext: '1.4 km from downtown Cebu City',
      estimatedTime: '1–2 hours',
      priceLevel: '$',
    },
    {
      id: 'rec_mock_3',
      title: 'IT Park Night Crawl',
      category: 'nightlife',
      reason: 'Great bar-hopping area for solo travelers and nightlife fans.',
      locationContext: 'IT Park, Cebu City',
      estimatedTime: '3–4 hours',
      priceLevel: '$$',
    },
    {
      id: 'rec_mock_4',
      title: 'Kawasan Falls Canyoneering',
      category: 'activity',
      reason: 'Top adventure activity in the region. Book a guide in advance.',
      locationContext: 'Badian, 3 hrs from Cebu City',
      estimatedTime: 'Full day',
      priceLevel: '$$',
    },
    {
      id: 'rec_mock_5',
      title: 'Heritage Walk: Colon Street',
      category: 'activity',
      reason: 'Oldest street in the Philippines — great for culture and photography.',
      locationContext: 'Downtown Cebu City',
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
