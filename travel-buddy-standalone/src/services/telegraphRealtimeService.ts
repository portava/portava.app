/**
 * Telegraph realtime service.
 *
 * Maintains a single long-lived Server-Sent Events (SSE) connection to the API
 * server (`GET /api/telegraph/stream`) and fans incoming events out to local
 * subscribers. Implemented over XMLHttpRequest because React Native's XHR can
 * set an Authorization header and exposes the incrementally-growing
 * `responseText` during the LOADING state — EventSource is not built in.
 *
 * Design guarantees:
 *   - Polling remains the source of truth. This service is an *enhancement*: if
 *     the stream cannot connect, status flips to 'polling' and consumers simply
 *     keep their existing poll loops. Nothing breaks when realtime is down.
 *   - Reconnects with exponential backoff (capped). Each consumer subscribes
 *     once; the underlying connection is reference-counted and shared.
 */

import { supabase } from '../lib/supabase';
import { freshToken as freshApiToken } from './apiToken.ts';

export type TelegraphEventType =
  | 'thread.updated'
  | 'message.created'
  | 'message.updated'
  | 'message.translated'
  | 'member.left'
  | 'typing.started'
  | 'typing.stopped'
  | 'read.updated'
  | 'request.created'
  | 'request.accepted'
  | 'request.declined'
  | 'user.blocked';

export interface TelegraphEvent {
  type: TelegraphEventType;
  threadId?: string | null;
  payload?: Record<string, unknown>;
  ts: string;
}

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'polling';

type EventListener = (event: TelegraphEvent) => void;
type StatusListener = (status: RealtimeStatus) => void;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** After this many consecutive failures we surface 'polling' to consumers. */
const POLLING_AFTER_FAILURES = 2;

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

class TelegraphRealtime {
  private xhr: XMLHttpRequest | null = null;
  private eventListeners = new Set<EventListener>();
  private statusListeners = new Set<StatusListener>();
  private status: RealtimeStatus = 'idle';
  private parseOffset = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failureCount = 0;
  private started = false;
  private stopped = false;

  /** Subscribe to realtime events. Starts the connection on first subscriber. */
  subscribe(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    this.ensureStarted();
    return () => {
      this.eventListeners.delete(listener);
      this.maybeStop();
    };
  }

  /** Subscribe to connection-status changes. */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    void this.connect();
  }

  private maybeStop() {
    // Keep the connection while any consumer is interested.
    if (this.eventListeners.size > 0) return;
    this.stopped = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.xhr) {
      try { this.xhr.abort(); } catch { /* noop */ }
      this.xhr = null;
    }
    this.setStatus('idle');
  }

  private setStatus(next: RealtimeStatus) {
    if (this.status === next) return;
    this.status = next;
    for (const l of this.statusListeners) {
      try { l(next); } catch { /* isolate */ }
    }
  }

  private async connect() {
    if (this.stopped) return;
    const base = apiBase();
    if (!base) { this.setStatus('polling'); return; }

    const token = await freshApiToken();
    if (!token) {
      // Not signed in yet; retry later without escalating to a hard failure.
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    this.setStatus('connecting');
    this.parseOffset = 0;

    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    try {
      xhr.open('GET', `${base}/api/telegraph/stream`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Accept', 'text/event-stream');

      xhr.onreadystatechange = () => {
        if (xhr.readyState >= 2 && xhr.status === 200 && this.status !== 'open') {
          this.failureCount = 0;
          this.setStatus('open');
        }
        if (xhr.readyState === 3 || xhr.readyState === 4) {
          this.consume(xhr.responseText ?? '');
        }
        if (xhr.readyState === 4) {
          this.handleDisconnect();
        }
      };
      xhr.onerror = () => this.handleDisconnect();
      xhr.ontimeout = () => this.handleDisconnect();
      xhr.send();
    } catch {
      this.handleDisconnect();
    }
  }

  /** Parse any newly-arrived bytes from the accumulating responseText. */
  private consume(text: string) {
    if (text.length <= this.parseOffset) return;
    const chunk = text.slice(this.parseOffset);
    this.parseOffset = text.length;

    // SSE frames are separated by a blank line. Keep the trailing partial frame
    // by rewinding the offset to the last complete boundary.
    const lastBoundary = chunk.lastIndexOf('\n\n');
    if (lastBoundary === -1) {
      // No complete frame yet — rewind so we re-read this chunk next time.
      this.parseOffset -= chunk.length;
      return;
    }
    const complete = chunk.slice(0, lastBoundary);
    // Push back the unparsed remainder.
    this.parseOffset -= chunk.length - (lastBoundary + 2);

    for (const frame of complete.split('\n\n')) {
      this.parseFrame(frame);
    }
  }

  private parseFrame(frame: string) {
    const trimmed = frame.trim();
    if (!trimmed || trimmed.startsWith(':')) return; // heartbeat / comment

    let dataLine = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('data:')) dataLine += line.slice(5).trim();
    }
    if (!dataLine) return;

    try {
      const evt = JSON.parse(dataLine) as TelegraphEvent;
      if (!evt || typeof evt.type !== 'string') return;
      for (const l of this.eventListeners) {
        try { l(evt); } catch { /* isolate consumer errors */ }
      }
    } catch {
      // Ignore the `connected` handshake and any malformed frame.
    }
  }

  private handleDisconnect() {
    if (this.xhr) {
      try { this.xhr.abort(); } catch { /* noop */ }
      this.xhr = null;
    }
    if (this.stopped) return;
    this.failureCount += 1;
    if (this.failureCount >= POLLING_AFTER_FAILURES) {
      this.setStatus('polling');
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(this.failureCount, 5),
      RECONNECT_MAX_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

export const telegraphRealtime = new TelegraphRealtime();
