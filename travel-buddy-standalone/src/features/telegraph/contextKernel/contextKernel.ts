/**
 * Telegraph §30A.19 — the conversation screen READS the Context Kernel (census T439).
 *
 *   GET /api/threads/:threadId/context-kernel
 *     -> { inputs: { relationship, time, proximity, intent, sharedObjects }, offeredActions, degraded, … }
 *        each input { revealed, reason, detail, value }
 *
 * The kernel is the server's one decision about what this conversation may reveal: Relationship gates
 * Proximity in a direct conversation, a block withholds everything, a non-member is shown nothing.
 * The client draws ONE line from it, under the header, and only what the kernel REVEALED:
 *   Time        "Happening now" while a shared plan is on, else "Next: <its start>" when one is coming;
 *   Proximity   the other person's coarse bucket, only where revealed ("Nearby", "Same city", …);
 *   Relationship the in-force origin that explains why the two of you are here ("Trip crew", …).
 * Nothing is inferred from an input the kernel withheld, and an unreadable kernel draws nothing — the
 * header then says exactly what it said before. The client never re-derives a reveal decision.
 */
import { useEffect, useState } from 'react';
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

interface KernelInput<T> {
  revealed: boolean;
  value: T | null;
}

export interface ContextKernelWire {
  conversationId: string;
  conversationType: string;
  inputs: {
    relationship: KernelInput<{ state: string; origins: string[] }>;
    time: KernelInput<{ now: string; band: string | null; nextStartsAt: string | null }>;
    proximity: KernelInput<{ people: Array<{ userId: string; bucket: string }> }>;
  };
  degraded: boolean;
}

const BUCKET_LABEL: Readonly<Record<string, string>> = {
  same_area: 'Same area',
  nearby: 'Nearby',
  same_city: 'Same city',
  same_region: 'Same region',
};

/** The origin that best explains a relationship, most specific first. Unknown origins say nothing. */
const ORIGIN_LABEL: ReadonlyArray<[string, string]> = [
  ['CREW', 'Trip crew'],
  ['TRIP', 'Same trip'],
  ['EVENT', 'Same event'],
  ['PLAN', 'Shared plan'],
  ['BUDDY', 'Buddy'],
  ['MUTUAL_FOLLOW', 'You follow each other'],
];

function input<T>(v: unknown): KernelInput<T> | null {
  const x = v as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || typeof x.revealed !== 'boolean') return null;
  return { revealed: x.revealed, value: (x.value ?? null) as T | null };
}

/** The wire, or null when it is not a kernel answer (never guessed). Pure. */
export function parseContextKernel(v: unknown): ContextKernelWire | null {
  const x = v as Record<string, any> | null;
  if (!x || typeof x !== 'object' || !x.inputs || typeof x.inputs !== 'object') return null;
  const relationship = input<{ state: string; origins: string[] }>(x.inputs.relationship);
  const time = input<{ now: string; band: string | null; nextStartsAt: string | null }>(x.inputs.time);
  const proximity = input<{ people: Array<{ userId: string; bucket: string }> }>(x.inputs.proximity);
  if (!relationship || !time || !proximity) return null;
  return {
    conversationId: String(x.conversationId ?? ''),
    conversationType: String(x.conversationType ?? ''),
    inputs: { relationship, time, proximity },
    degraded: x.degraded === true,
  };
}

function startsLabel(iso: string, nowMs: number): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= nowMs) return null;
  const mins = Math.round((at - nowMs) / 60_000);
  if (mins < 60) return `Next: in ${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Next: in ${hours} h`;
  return `Next: ${new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

/**
 * The one line the screen draws from the kernel, or null when the kernel revealed nothing to say.
 * Only revealed inputs are read; a withheld one contributes nothing, whatever its value field holds. Pure.
 */
export function kernelContextLine(k: ContextKernelWire | null, nowMs: number): string | null {
  if (!k) return null;
  const parts: string[] = [];
  const time = k.inputs.time.revealed ? k.inputs.time.value : null;
  if (time?.band === 'HAPPENING_NOW') parts.push('Happening now');
  else if (time?.nextStartsAt) { const s = startsLabel(time.nextStartsAt, nowMs); if (s) parts.push(s); }
  if (k.conversationType === 'direct') {
    const p = k.inputs.proximity.revealed ? k.inputs.proximity.value?.people?.[0] : null;
    const b = p ? BUCKET_LABEL[p.bucket] : undefined;
    if (b) parts.push(b);
  }
  const rel = k.inputs.relationship.revealed ? k.inputs.relationship.value : null;
  if (rel && Array.isArray(rel.origins)) {
    const o = ORIGIN_LABEL.find(([origin]) => rel.origins.includes(origin));
    if (o) parts.push(o[1]);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function fetchContextKernel(threadId: string): Promise<ContextKernelWire | null> {
  if (!threadId || !isSupabaseConfigured || !apiBase()) return null;
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/context-kernel`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return parseContextKernel(await res.json());
  } catch {
    return null;
  }
}

/** The screen's read: fetched when the conversation opens, and the line re-derived each minute (time bands move). */
export function useContextKernelLine(threadId: string | null | undefined): string | null {
  const [kernel, setKernel] = useState<ContextKernelWire | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    setKernel(null);
    if (threadId) void fetchContextKernel(threadId).then((k) => { if (live) setKernel(k); });
    return () => { live = false; };
  }, [threadId]);
  useEffect(() => {
    if (!kernel) return;
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [kernel]);
  return kernelContextLine(kernel, nowMs);
}
