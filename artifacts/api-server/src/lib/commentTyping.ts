import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getServiceClient } from './supabase.js';
import { logger } from './logger.js';

export const COMMENT_TYPING_TTL_MS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface CommentTypingSignal { postId: string; userId: string; typing: boolean; at: number }
/** Ephemeral hints, never drafts or durable viewing history. Tombstones reject reordered starts. */
export class CommentTypingStore {
  private entries = new Map<string, CommentTypingSignal>();
  constructor(private now: () => number = Date.now, private capacity = 2000) {}
  accept(signal: CommentTypingSignal): boolean {
    if (!signal || !UUID.test(signal.postId) || !UUID.test(signal.userId) || typeof signal.typing !== 'boolean'
      || !Number.isFinite(signal.at) || signal.at > this.now() + 1000 || signal.at < this.now() - COMMENT_TYPING_TTL_MS) return false;
    this.prune();
    const key = `${signal.postId}:${signal.userId}`;
    const previous = this.entries.get(key);
    if (previous && (previous.at > signal.at || previous.at === signal.at && !previous.typing)) return false;
    this.entries.delete(key); this.entries.set(key, signal);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }
  actors(postId: string): string[] {
    this.prune();
    return [...this.entries.values()].filter(row => row.postId === postId && row.typing).map(row => row.userId).slice(0, 16);
  }
  private prune() { for (const [key, row] of this.entries) if (row.at + COMMENT_TYPING_TTL_MS <= this.now()) this.entries.delete(key); }
}
export function signCommentTyping(signal: CommentTypingSignal, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify([signal.postId, signal.userId, signal.typing, signal.at])).digest('hex');
}
export function verifyCommentTyping(signal: CommentTypingSignal, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signCommentTyping(signal, secret), 'hex'));
}
export const commentTypingStore = new CommentTypingStore();
let channel: RealtimeChannel | null = null;
let signingSecret: string | null = null;
let initialized = false;
/** Private server-only broadcast mirrors short-lived hints across autoscale instances. */
export function initCommentTypingBroadcast(): void {
  if (initialized) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  initialized = true;
  signingSecret = createHmac('sha256', key).update('portava-comment-typing-v1').digest('hex');
  const client = getServiceClient();
  if (!client) { initialized = false; return; }
  channel = client.channel('portava:comment-typing:v1', { config: { private: true, broadcast: { self: false } } });
  channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
    const signal = payload?.signal as CommentTypingSignal | undefined;
    if (signal && signingSecret && verifyCommentTyping(signal, payload?.signature, signingSecret)) commentTypingStore.accept(signal);
  }).subscribe(status => { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') logger.warn({ status }, 'Comment typing relay unavailable; transient indicators may be delayed'); });
}
export function publishCommentTyping(postId: string, userId: string, typing: boolean, at = Date.now()): void {
  const signal = { postId, userId, typing, at };
  if (!commentTypingStore.accept(signal)) return;
  if (channel && signingSecret) void channel.send({ type: 'broadcast', event: 'typing', payload: { signal, signature: signCommentTyping(signal, signingSecret) } })
    .catch(() => logger.warn('Comment typing relay failed'));
}
