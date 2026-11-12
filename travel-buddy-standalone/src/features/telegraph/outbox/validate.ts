import type { OutboxEntry, OutboxScope } from './types.ts';
export function validate(value: unknown, scope: OutboxScope, clientId?: string): OutboxEntry {
  const e = value as OutboxEntry;
  if (!e || e.ownerId !== scope.ownerId || e.sessionId !== scope.sessionId || (clientId && e.clientId !== clientId) || typeof e.clientId !== 'string' || typeof e.threadId !== 'string' || !e.payload || typeof e.display?.body !== 'string' || !['queued', 'retryable', 'blocked', 'accepted'].includes(e.state)) throw new Error('A pending message failed its account check.');
  if (e.display.isE2ee && ('body' in e.payload || typeof e.payload.ciphertext !== 'string')) throw new Error('Encrypted pending message has an invalid payload.');
  return e;
}
