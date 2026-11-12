import type { OutboxEntry, OutboxScope, OutboxStorage } from './types.ts';
export interface OutboxResult<T> { ok: boolean; data: T | null; errorKind?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number | null }
export interface OutboxOwner extends OutboxScope { isCurrent(): boolean }
const stale = <T>(): OutboxResult<T> => ({ ok: false, data: null, errorKind: 'unauthenticated', retryable: false });
const unavailable = <T>(): OutboxResult<T> => ({ ok: false, data: null, errorKind: 'db_error', retryable: false, message: 'This device could not securely save the pending message. It was not sent. Try again.' });
/** Durable, idempotent text outbox. No timers or auth side effects: callers replay
 * only while foregrounded and for the same live session that queued the entry. */
export class MessageOutbox<T> {
  private readonly inFlight = new Map<string, Promise<OutboxResult<T>>>();
  private readonly cancellations = new Map<string, number>();
  private readonly controllers = new Map<string, { ownerId: string; controller: AbortController }>();
  private readonly generations = new Map<string, number>();
  constructor(private readonly storage: OutboxStorage, private readonly now: () => number = Date.now) {}
  private key(owner: OutboxScope, clientId: string) { return JSON.stringify([owner.ownerId, owner.sessionId, clientId]); }
  private active(owner: OutboxOwner, clientId?: string) {
    const key = clientId ? this.key(owner, clientId) : '';
    const cancellation = this.cancellations.get(key) ?? 0;
    const generation = this.generations.get(owner.ownerId) ?? 0;
    return () => owner.isCurrent() && generation === (this.generations.get(owner.ownerId) ?? 0) && cancellation === (this.cancellations.get(key) ?? 0);
  }
  private single(owner: OutboxOwner, clientId: string, action: () => Promise<OutboxResult<T>>): Promise<OutboxResult<T>> {
    const key = this.key(owner, clientId);
    const prior = this.inFlight.get(key);
    if (prior) return prior;
    const work = action(); this.inFlight.set(key, work);
    void work.finally(() => { if (this.inFlight.get(key) === work) this.inFlight.delete(key); }).catch(() => {});
    return work;
  }
  async pending(owner: OutboxOwner, threadId?: string): Promise<OutboxEntry[]> {
    const current = this.active(owner);
    if (!current()) return [];
    const entries = await this.storage.read(owner);
    return current() ? entries.filter((entry) => (!threadId || entry.threadId === threadId) && entry.state !== 'accepted').sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  }
  submit(owner: OutboxOwner, input: { clientId: string; threadId: string; display: OutboxEntry['display'] }, prepare: () => Promise<Record<string, unknown>>, send: (entry: OutboxEntry, signal: AbortSignal) => Promise<OutboxResult<T>>): Promise<OutboxResult<T>> {
    return this.single(owner, input.clientId, async () => {
      const current = this.active(owner, input.clientId);
      if (!current()) return stale();
      let entry: OutboxEntry | undefined;
      try { entry = (await this.storage.read(owner)).find((candidate) => candidate.clientId === input.clientId); }
      catch { return current() ? unavailable() : stale(); }
      if (!current()) return stale();
      if (entry && (entry.threadId !== input.threadId || JSON.stringify(entry.display) !== JSON.stringify(input.display))) return { ok: false, data: null, errorKind: 'invalid_payload', message: 'This retry does not match the original message.', retryable: false };
      if (!entry) {
        const payload = await prepare();
        if (!current()) return stale();
        entry = { ownerId: owner.ownerId, sessionId: owner.sessionId, ...input, payload, createdAt: new Date(this.now()).toISOString(), state: 'queued', attempts: 0, nextAttemptAt: 0 };
        try { await this.storage.put(entry); } catch { return current() ? unavailable() : stale(); }
      }
      return this.deliver(owner, entry, send, current);
    });
  }
  private async deliver(owner: OutboxOwner, entry: OutboxEntry, send: (entry: OutboxEntry, signal: AbortSignal) => Promise<OutboxResult<T>>, current = this.active(owner, entry.clientId)): Promise<OutboxResult<T>> {
    if (!current()) return stale();
    // Recheck durable presence before dispatch: a replay snapshot may predate
    // cancellation in this process or another browser tab.
    let persisted: OutboxEntry | undefined;
    try { persisted = (await this.storage.read(owner)).find((value) => value.clientId === entry.clientId); } catch { return unavailable(); }
    if (!current()) return stale();
    if (!persisted) return { ok: false, data: null, errorKind: 'cancelled', retryable: false };
    entry = persisted;
    if (entry.state === 'accepted') return { ok: true, data: entry.serverMessage as T };
    if (entry.nextAttemptAt > this.now()) return { ok: false, data: null, errorKind: 'rate_limited', retryable: true, retryAfterSeconds: Math.ceil((entry.nextAttemptAt - this.now()) / 1000), message: 'Waiting before retrying this message.' };
    let result: OutboxResult<T>;
    const key = this.key(owner, entry.clientId);
    const controller = new AbortController();
    this.controllers.set(key, { ownerId: owner.ownerId, controller });
    try { result = await send(entry, controller.signal); }
    catch { result = { ok: false, data: null, errorKind: 'network_unreachable', retryable: true, message: 'Connection interrupted. The message is saved on this device.' }; }
    finally { if (this.controllers.get(key)?.controller === controller) this.controllers.delete(key); }
    if (controller.signal.aborted && owner.isCurrent() && current()) return { ok: false, data: null, errorKind: 'cancelled', retryable: false };
    if (!current()) return stale();
    if (result.ok && result.data) {
      // Save the acknowledgement before cleanup. A cleanup failure must never
      // turn a server-accepted message back into an automatic resend.
      try { await this.storage.put({ ...entry, state: 'accepted', serverMessage: result.data }, true); await this.storage.remove(owner, entry.clientId); } catch { /* server idempotency still covers a lost local acknowledgement */ }
      return result;
    }
    const attempts = entry.attempts + 1;
    const retryable = result.retryable === true || result.errorKind === 'network_unreachable';
    const delay = Math.max(result.retryAfterSeconds ?? 0, Math.min(300, 2 ** Math.min(attempts, 8)));
    try { await this.storage.put({ ...entry, attempts, state: retryable ? 'retryable' : 'blocked', nextAttemptAt: retryable ? this.now() + delay * 1000 : 0, failure: result.message ?? 'Message was not sent.' }, true); } catch { /* the immutable queued payload remains recoverable */ }
    return result;
  }
  async replay(owner: OutboxOwner, send: (entry: OutboxEntry, signal: AbortSignal) => Promise<OutboxResult<T>>, threadId?: string): Promise<number> {
    let accepted = 0;
    const current = this.active(owner);
    const entries = await this.pending(owner, threadId);
    for (const entry of entries) {
      if (!current()) return accepted;
      if (entry.state === 'blocked' || entry.nextAttemptAt > this.now()) continue;
      const result = await this.single(owner, entry.clientId, () => this.deliver(owner, entry, send));
      if (result.ok) accepted += 1;
      // Preserve causal order on an outage; don't flood the server with the rest.
      if (!result.ok && (result.retryable || result.errorKind === 'network_unreachable' || result.errorKind === 'unauthenticated')) break;
    }
    return accepted;
  }
  /** Stops local retries; an already accepted server message remains canonical. */
  async cancel(owner: OutboxOwner, clientId: string): Promise<void> {
    if (!owner.isCurrent()) throw new Error('The messaging session changed.');
    const key = this.key(owner, clientId);
    this.cancellations.set(key, (this.cancellations.get(key) ?? 0) + 1);
    this.controllers.get(key)?.controller.abort();
    await this.storage.remove(owner, clientId);
  }
  async clearOwner(ownerId: string): Promise<void> {
    this.generations.set(ownerId, (this.generations.get(ownerId) ?? 0) + 1);
    for (const item of this.controllers.values()) if (item.ownerId === ownerId) item.controller.abort();
    await this.storage.clearOwner(ownerId);
  }
}
