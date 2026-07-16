/**
 * Admin Reports — API service layer.
 * Thin wrappers over GET /api/admin/reports.
 * Requires an authenticated admin user.
 */
import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...((opts.headers as Record<string, string>) ?? {}),
    },
  });
}

export interface ContentReport {
  id: string;
  reporter_id: string;
  target_type: string;
  target_id: string;
  reason_code: string;
  reason_detail: string | null;
  severity: string;
  status: string;
  created_at: string;
}

export interface AdminReportsResult {
  reports: ContentReport[];
  total: number;
}

export async function fetchAdminReports(opts: {
  limit?: number;
  offset?: number;
  status?: string;
} = {}): Promise<AdminReportsResult> {
  const { limit = 50, offset = 0, status } = opts;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ...(status && status !== 'all' ? { status } : {}),
  });
  const res = await authedFetch(`${apiBase()}/api/admin/reports?${params}`);
  if (!res.ok) throw new Error(`Failed to load reports: ${res.status}`);
  return res.json() as Promise<AdminReportsResult>;
}
