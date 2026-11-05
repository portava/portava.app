export interface OutboxScope { ownerId: string; sessionId: string }
export interface OutboxEntry extends OutboxScope {
  clientId: string;
  threadId: string;
  createdAt: string;
  /** Exact prepared wire request. Encrypted threads have ciphertext, never body. */
  payload: Record<string, unknown>;
  /** Local display is encrypted at rest, including for E2EE messages. */
  display: { body: string; msgType: string; subtype: string | null; replyToId: string | null; isE2ee: boolean };
  attempts: number;
  nextAttemptAt: number;
  state: 'queued' | 'retryable' | 'blocked' | 'accepted';
  failure?: string;
  serverMessage?: unknown;
}
export interface OutboxStorage {
  read(scope: OutboxScope): Promise<OutboxEntry[]>;
  /** Updates after dispatch may not recreate a cancelled/erased entry. */
  put(entry: OutboxEntry, onlyIfPresent?: boolean): Promise<void>;
  remove(scope: OutboxScope, clientId: string): Promise<void>;
  clearOwner(ownerId: string): Promise<void>;
}
