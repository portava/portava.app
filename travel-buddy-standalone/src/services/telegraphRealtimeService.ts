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

import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import { cursorHeaderValue } from '../features/telegraph/connection/sequenceCursorStore.ts';

export type TelegraphEventType =
  | 'thread.updated'
  | 'message.created'
  | 'message.updated'
  | 'message.translated'
  | 'member.left'
  | 'typing.started'
  | 'typing.stopped'
  | 'read.updated'
  /** §13.2: which of the caller's messages a reader's seen-advance crossed (POST /threads/:id/seen). */
  | 'message.seen'
  /** §13.2: a recipient's open connection took one of the caller's messages — sent to the SENDER only. */
  | 'message.delivered'
  | 'request.created'
  | 'request.accepted'
  | 'request.declined'
  | 'user.blocked'
  | 'call.incoming'
  | 'call.accepted'
  | 'call.declined'
  | 'call.canceled'
  | 'call.ended'
  | 'call.missed'
  | 'call.group_started'
  | 'call.group_ended'
  | 'call.room_updated'
  | 'call.role_changed'
  | 'call.removed_from_room'
  /** Server closed this connection because access was revoked (e.g. after a block). Client should reconnect with a fresh token. */
  | 'access.revoked'
  /** Server closed this connection to force re-authentication (max lifetime reached). Client should reconnect immediately. */
  | 'reconnect'
  /** Sent by the server on EVERY (re)connection (§17.3): a consumer catches up from its sequence cursor (T233). */
  | 'stream.resumed';

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
  private generation = 0;

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
    const generation = this.retireConnection();
    if (this.generation === generation) this.setStatus('idle');
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && this.generation === generation;
  }

  private retireConnection(): number {
    const generation = ++this.generation;
    const xhr = this.xhr;
    this.xhr = null;
    if (xhr) {
      xhr.onreadystatechange = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      try { xhr.abort(); } catch {}
    }
    return generation;
  }

  private setStatus(next: RealtimeStatus) {
    if (this.status === next) return;
    this.status = next;
    const generation = this.generation;
    for (const l of this.statusListeners) {
      if (this.generation !== generation || this.status !== next) return;
      try { l(next); } catch { /* isolate */ }
    }
  }

  private async connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    const base = apiBase();
    if (!base) { this.setStatus('polling'); return; }

    const token = await freshApiToken();
    if (!this.isCurrent(generation)) return;
    if (!token) {
      // Not signed in yet; retry later without escalating to a hard failure.
      this.scheduleReconnect(generation);
      return;
    }

    this.setStatus('connecting');
    if (!this.isCurrent(generation)) return;
    this.parseOffset = 0;

    const xhr = new XMLHttpRequest();
    this.xhr = xhr;
    try {
      xhr.open('GET', `${base}/api/telegraph/stream`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Accept', 'text/event-stream');
      // §71 (T233): the per-thread sequences this device acknowledged — the server replays exactly what came after each.
      const seqCursors = cursorHeaderValue(); if (seqCursors) xhr.setRequestHeader('X-Telegraph-Sequence-Cursors', seqCursors);

      xhr.onreadystatechange = () => {
        if (!this.isCurrent(generation) || this.xhr !== xhr) return;
        if (xhr.readyState >= 2 && xhr.status === 200 && this.status !== 'open') {
          this.failureCount = 0;
          this.setStatus('open');
        }
        if (!this.isCurrent(generation) || this.xhr !== xhr) return;
        if (xhr.readyState === 3 || xhr.readyState === 4) {
          this.consume(xhr.responseText ?? '', generation);
        }
        if (xhr.readyState === 4) {
          this.handleDisconnect(generation);
        }
      };
      xhr.onerror = () => this.handleDisconnect(generation);
      xhr.ontimeout = () => this.handleDisconnect(generation);
      xhr.send();
    } catch {
      this.handleDisconnect(generation);
    }
  }

  /** Parse any newly-arrived bytes from the accumulating responseText. */
  private consume(text: string, generation: number) {
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
      if (!this.isCurrent(generation)) return;
      this.parseFrame(frame, generation);
    }
  }

  private parseFrame(frame: string, generation: number) {
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

      // Control events: dispatch to listeners first so consumers can react
      // (e.g. clear cached user data after access.revoked), then reconnect
      // immediately with a fresh token rather than entering the normal failure
      // backoff path.
      if (evt.type === 'access.revoked' || evt.type === 'reconnect') {
        for (const l of this.eventListeners) {
          if (!this.isCurrent(generation)) return;
          try { l(evt); } catch { /* isolate consumer errors */ }
        }
        this.immediateReconnect(generation);
        return;
      }

      for (const l of this.eventListeners) {
        if (!this.isCurrent(generation)) return;
        try { l(evt); } catch { /* isolate consumer errors */ }
      }
    } catch {
      // Ignore the `connected` handshake and any malformed frame.
    }
  }

  /**
   * Reconnect immediately after a server-initiated close (access.revoked or
   * max-age reconnect signal).  Resets the failure counter so the connection
   * is not mis-classified as a persistent failure, and bypasses the backoff
   * timer so the fresh auth token is sent without delay.
   */
  private immediateReconnect(generation: number) {
    if (!this.isCurrent(generation)) return;
    const retiredGeneration = this.retireConnection();
    if (!this.isCurrent(retiredGeneration)) return;
    // Reset failure tracking — this was a clean server-side close, not a fault.
    this.failureCount = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Small delay to let the server fully flush before we reconnect.
    this.scheduleReconnect(retiredGeneration, 100);
  }

  private handleDisconnect(generation: number) {
    if (!this.isCurrent(generation)) return;
    const retiredGeneration = this.retireConnection();
    if (!this.isCurrent(retiredGeneration)) return;
    this.failureCount += 1;
    if (this.failureCount >= POLLING_AFTER_FAILURES) {
      this.setStatus('polling');
    }
    this.scheduleReconnect(retiredGeneration);
  }

  private scheduleReconnect(generation: number, immediateDelay?: number) {
    if (!this.isCurrent(generation) || this.reconnectTimer) return;
    const delay = immediateDelay ?? Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(this.failureCount, 5),
      RECONNECT_MAX_MS,
    );
    const timer = setTimeout(() => {
      if (!this.isCurrent(generation) || this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer = timer;
  }
}

export const telegraphRealtime = new TelegraphRealtime();
