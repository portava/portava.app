import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

export type ReasonCode =
  | 'blocked'
  | 'muted'
  | 'restricted'
  | 'private_account'
  | 'not_following'
  | 'circle_only';

export interface SharedContext {
  sharedTrip: boolean;
  sharedCircle: boolean;
  areMutualFollowers: boolean;
  isFriend: boolean;
}

export interface InteractionContext {
  targetUserId: string;
  canViewProfile: boolean;
  canFollow: boolean;
  canMessage: boolean;
  canAddFriend: boolean;
  canBlock: boolean;
  canMute: boolean;
  canReport: boolean;
  canRestrict: boolean;
  iBlocked: boolean;
  theyBlockedMe: boolean;
  iMuted: boolean;
  iRestricted: boolean;
  reasonCodes: ReasonCode[];
  context: SharedContext;
}

export interface InteractionContextResult {
  ok: boolean;
  data?: InteractionContext;
  error?: string;
}

export async function fetchInteractionContext(
  userId: string,
): Promise<InteractionContextResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, error: 'Not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  try {
    const res = await fetch(`${apiBase()}/api/users/${encodeURIComponent(userId)}/interaction-context`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? 'Failed to fetch context' };
    }
    const body = await res.json();
    return { ok: true, data: body as InteractionContext };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
