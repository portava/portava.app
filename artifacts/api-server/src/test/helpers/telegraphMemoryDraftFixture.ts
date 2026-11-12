import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readLiveMessageSource } from '../../services/telegraph/memorySource.js';

type Row = Record<string, any>;
/** The HTTP fixtures replace only the transactional kernel receipt, retaining
 * the production source authorization/projector. The real wrapper's locks,
 * atomic reference write and rollback are exercised by
 * telegraphMemorySources.pglite.test.ts. No card/location snapshot is projected here. */
export function attachTelegraphMemoryDraftFixture(client: { rpc: (...args: any[]) => any }, rows: Record<string, Row[]>) {
  const original = client.rpc.bind(client);
  client.rpc = async (name: string, args: { p_command?: Row }) => {
    if (name !== 'telegraph_memory_draft_execute') return original(name, args);
    const command = args.p_command;
    const sourceId = command?.payload?.telegraph_source_message_id;
    const write = command?.payload?.write;
    if (command?.type !== 'CREATE_MEMORY' || !sourceId || write?.state !== 'draft' || write?.visibility !== 'only_me') {
      return { data: null, error: { message: 'invalid_telegraph_memory_command' } };
    }
    try {
      if (!await readLiveMessageSource(client as unknown as SupabaseClient, command.actor_user_id, sourceId)) {
        return { data: null, error: { message: 'message_unavailable' } };
      }
    } catch {
      return { data: null, error: { message: 'message_source_unreadable' } };
    }
    const row = { id: randomUUID(), ...write };
    (rows.memories ??= []).push(row);
    (rows.telegraph_memory_sources ??= []).push({ memory_id: row.id, message_id: sourceId });
    return { data: { ok: true, memory_id: row.id, event_id: randomUUID(), event_type: 'memory.created', result: row, contract_version: 1 }, error: null };
  };
}
