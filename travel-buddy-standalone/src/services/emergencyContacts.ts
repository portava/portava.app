/**
 * Emergency Contacts mobile service.
 * Profile-level contacts managed from Settings → Emergency Contacts.
 */
import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authHeader(): Promise<string | null> {
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

async function apiFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const token = await authHeader();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> ?? {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    return res.json();
  } catch {
    return { error: 'network_error' };
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmergencyContact {
  id: string;
  label: string;
  name: string;
  phone: string | null;
  email: string | null;
  notifyMethod: 'in_app' | 'sms' | 'email';
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmergencyContactInput {
  name: string;
  label?: string;
  phone?: string | null;
  email?: string | null;
  notifyMethod?: 'in_app' | 'sms' | 'email';
  sortOrder?: number;
}

// ── API calls ─────────────────────────────────────────────────────────────────

export async function listEmergencyContacts(): Promise<{ contacts: EmergencyContact[]; error?: string }> {
  const data = await apiFetch('/api/me/emergency-contacts');
  if (data?.error) return { contacts: [], error: data.error };
  return { contacts: data?.contacts ?? [] };
}

export async function addEmergencyContact(
  input: EmergencyContactInput,
): Promise<{ ok: boolean; contact?: EmergencyContact; error?: string }> {
  return apiFetch('/api/me/emergency-contacts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateEmergencyContact(
  id: string,
  input: Partial<EmergencyContactInput>,
): Promise<{ ok: boolean; contact?: EmergencyContact; error?: string }> {
  return apiFetch(`/api/me/emergency-contacts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteEmergencyContact(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  return apiFetch(`/api/me/emergency-contacts/${id}`, { method: 'DELETE' });
}
