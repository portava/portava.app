/**
 * The device's memory of stored link previews, and the batching of the reads
 * that fill it (census-telegraph T404 / T446, B58 TM-2).
 *
 * ONE READ PER RENDER PASS, PER THREAD. Every bubble that may show a preview
 * registers its message (`want`) from an effect; the registrations of one
 * commit are coalesced on a microtask into one `GET /threads/:id/link-previews`
 * per thread, at most `batchMax` ids each — so a thread page costs one read,
 * not one per bubble. The read carries message ids only.
 *
 * WHAT IS REMEMBERED, AND FOR WHOM. An entry is keyed by thread, message and
 * body version (`editedAt`): an edit is a different body and is asked about
 * afresh, and the server serves nothing for it until the sender's edit has made
 * a new preview. The store belongs to ONE viewer: a different signed-in
 * account clears it (`setViewer`), because what the server serves is decided
 * per viewer (membership, history window, blocks).
 *
 * BOUNDED RE-ASKING. A miss is final, with one exception: a body written less
 * than `RECHECK_YOUNG_MS` ago may simply not have its preview yet (the sender's
 * request is still being fetched), so it is asked once more after
 * `RECHECK_DELAY_MS`. At most two reads per message version, ever. A failed read
 * is a miss under the same rule — a failing server is never polled.
 *
 * Nothing here contacts any host but our API, and only through the injected
 * `fetchPreviews` (`linkPreviewApi.ts#fetchLinkPreviews`).
 */
import type { PreviewsRead } from './linkPreviewApi.ts';
import type { WirePreview } from './linkPreviewRules.ts';

export type PreviewEntry =
  | { readonly state: 'pending' }
  | { readonly state: 'ready'; readonly preview: WirePreview }
  | { readonly state: 'none' };

export const RECHECK_YOUNG_MS = 120_000;
export const RECHECK_DELAY_MS = 8_000;
const MAX_ENTRIES = 2_000;

export interface LinkPreviewStoreDeps {
  fetchPreviews: (threadId: string, messageIds: readonly string[]) => Promise<PreviewsRead>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  batchMax: number;
}

interface Wanted {
  key: string;
  messageId: string;
  version: string;
  writtenAt: number;
}

const PENDING: PreviewEntry = Object.freeze({ state: 'pending' });
const NONE: PreviewEntry = Object.freeze({ state: 'none' });

export class LinkPreviewStore {
  private entries = new Map<string, PreviewEntry>();
  private rechecked = new Set<string>();
  private queue = new Map<string, Map<string, Wanted>>();
  private flushQueued = false;
  private listeners = new Set<() => void>();
  private viewer: string | null = null;
  private generation = 0;

  constructor(private readonly deps: LinkPreviewStoreDeps) {}

  static key(threadId: string, messageId: string, version: string): string {
    return `${threadId}|${messageId}|${version}`;
  }

  get(threadId: string, messageId: string, version: string): PreviewEntry | undefined {
    return this.entries.get(LinkPreviewStore.key(threadId, messageId, version));
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** The signed-in viewer. A change forgets everything remembered for the previous one. */
  setViewer(viewerId: string | null): void {
    if (viewerId === this.viewer) return;
    this.viewer = viewerId;
    this.reset();
  }

  /** Ask about one message version, unless it is already known or on its way. */
  want(threadId: string, messageId: string, version: string, writtenAt: number): void {
    const key = LinkPreviewStore.key(threadId, messageId, version);
    if (this.entries.has(key)) return;
    this.entries.set(key, PENDING);
    let forThread = this.queue.get(threadId);
    if (!forThread) { forThread = new Map(); this.queue.set(threadId, forThread); }
    forThread.set(key, { key, messageId, version, writtenAt });
    if (!this.flushQueued) {
      this.flushQueued = true;
      void Promise.resolve().then(() => this.flush());
    }
  }

  /** What the sender's own request answered: remembered without a read. */
  seed(threadId: string, messageId: string, version: string, preview: WirePreview | null): void {
    const key = LinkPreviewStore.key(threadId, messageId, version);
    this.rechecked.add(key);
    this.put(key, preview ? Object.freeze({ state: 'ready', preview }) : NONE);
    this.emit();
  }

  reset(): void {
    this.generation++;
    this.entries.clear();
    this.rechecked.clear();
    this.queue.clear();
    this.flushQueued = false;
    this.emit();
  }

  private flush(): void {
    this.flushQueued = false;
    const gen = this.generation;
    const work = [...this.queue.entries()];
    this.queue.clear();
    for (const [threadId, wanted] of work) {
      const items = [...wanted.values()];
      for (let i = 0; i < items.length; i += this.deps.batchMax) {
        const chunk = items.slice(i, i + this.deps.batchMax);
        const ids = [...new Set(chunk.map((w) => w.messageId))];
        void this.deps.fetchPreviews(threadId, ids).then(
          (read) => this.settle(gen, threadId, chunk, read),
          () => this.settle(gen, threadId, chunk, { ok: false }),
        );
      }
    }
  }

  private settle(gen: number, threadId: string, chunk: Wanted[], read: PreviewsRead): void {
    if (gen !== this.generation) return; // a reset or another viewer happened meanwhile
    const byId = new Map<string, WirePreview>();
    if (read.ok) for (const p of read.previews) byId.set(p.messageId, p);
    for (const w of chunk) {
      if (this.entries.get(w.key) !== PENDING) continue; // seeded meanwhile
      const preview = byId.get(w.messageId);
      if (preview) { this.put(w.key, Object.freeze({ state: 'ready', preview })); continue; }
      this.put(w.key, NONE);
      this.maybeRecheck(threadId, w);
    }
    this.emit();
  }

  private maybeRecheck(threadId: string, w: Wanted): void {
    if (this.rechecked.has(w.key)) return;
    if (!(this.deps.now() - w.writtenAt < RECHECK_YOUNG_MS)) return;
    this.rechecked.add(w.key);
    const gen = this.generation;
    this.deps.schedule(() => {
      if (gen !== this.generation || this.entries.get(w.key) !== NONE) return;
      this.entries.delete(w.key);
      this.want(threadId, w.messageId, w.version, w.writtenAt);
    }, RECHECK_DELAY_MS);
  }

  private put(key: string, entry: PreviewEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size <= MAX_ENTRIES) return;
    for (const [k, v] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (v !== PENDING) this.entries.delete(k);
    }
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
