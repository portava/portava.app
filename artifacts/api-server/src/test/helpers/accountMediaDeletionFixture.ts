import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeTranslationArtifact, translationArtifactPath } from '../../lib/media/captions/translationArtifactStore.js';

export const accountId = '11111111-1111-4111-8111-111111111111';
export const otherId = '22222222-2222-4222-8222-222222222222';
export const assetId = '33333333-3333-4333-8333-333333333333';
export const receiptId = '44444444-4444-4444-8444-444444444444';
export const timestamp = '2026-10-16T00:00:00.000Z';
export type Row = Record<string, any>;
export type Operation = { table: string; action: string; filters: [string, string, unknown][]; values?: Row; paths?: string[]; columns?: string };
export type Reply = { data: any; error: unknown };

export function source(owner = accountId, uploader: string | null = accountId): Row {
  return { id: assetId, owner_user_id: owner, uploader_user_id: uploader, storage_bucket: 'post-media', storage_path: `${owner}/original.mp4`,
    thumbnail_path: `${owner}/thumb.jpg`, version: 4, media_type: 'video', moderation_status: 'approved', processing_status: 'ready',
    deleted_at: null, purge_status: 'not_requested', updated_at: timestamp, size_bytes: 128, duration_ms: 2000 };
}

export function translation(state = 'dispatched', owner = accountId): Row {
  const intent = { asset_id: assetId, owner_user_id: owner, source_version: 4, kind: 'draft' as const, consent_id: receiptId,
    job_id: receiptId, lease_token: receiptId, draft_id: 'a'.repeat(64), caption_revision: 'b'.repeat(64), output_revision: 'a'.repeat(64) };
  return decodeTranslationArtifact({ id: receiptId, write_token: receiptId, ...intent, storage_bucket: 'post-media', storage_path: translationArtifactPath(intent),
    intent, write_state: state, write_settled_at: ['uploaded', 'never_dispatched'].includes(state) ? timestamp : null,
    cleanup_requested: true, source_deleted: true, retirement_token: null, created_at: timestamp });
}

export function dubbing(state = 'pending', owner = accountId): Row {
  return { id: receiptId, asset_id: assetId, owner_user_id: owner, job_id: receiptId, lease_token: receiptId, write_state: state,
    write_settled_at: state === 'pending' ? null : timestamp, storage_bucket: 'private-dubbing', storage_path: `synthetic-dubbing/${receiptId}.wav`,
    cleanup_requested: true, manifest: {}, created_at: timestamp };
}

export function accountMediaFixture(initial: Record<string, Row[]> = {}) {
  const rows: Record<string, Row[]> = {
    profiles: [{ id: accountId, account_status: 'active' }], user_deletion_requests: [{ user_id: accountId, status: 'pending' }],
    media_assets: [], media_caption_translation_artifacts: [], media_dubbing_artifacts: [],
    feature_flags: ['media_derivative_jobs_enabled', 'media_caption_translation_enabled', 'media_dubbing_enabled'].map(flag => ({ flag, enabled: false })),
    ...structuredClone(initial),
  };
  const operations: Operation[] = [];
  const state = {
    rows, operations, authDeleted: [] as string[], signals: [] as AbortSignal[], versionIncrement: 3,
    schema: { media_derivative_jobs: true, media_caption_manifests: true, media_visual_embeddings: false, media_image_understanding_artifacts: false, media_dubbing_artifacts: true },
    before: (_operation: Operation): Reply | undefined | Promise<Reply | undefined> => undefined,
    after: (_operation: Operation, reply: Reply): Reply | Promise<Reply> => reply,
  };
  function query(table: string) {
    const operation: Operation = { table, action: 'select', filters: [] };
    const predicates: ((row: Row) => boolean)[] = [];
    let single = false, limit = Infinity, offset = 0;
    const ordering: string[] = [];
    const builder = {
      select(columns?: string) { operation.columns = columns; return builder; },
      delete() { operation.action = 'delete'; return builder; },
      update(values: Row) { operation.action = 'update'; operation.values = values; return builder; },
      insert(values: Row) { operation.action = 'insert'; operation.values = values; return builder; },
      upsert(values: Row) { operation.action = 'upsert'; operation.values = values; return builder; },
      eq(column: string, value: unknown) { operation.filters.push(['eq', column, value]); predicates.push(row => row[column] === value); return builder; },
      neq(column: string, value: unknown) { predicates.push(row => row[column] !== value); return builder; },
      is(column: string, value: unknown) { operation.filters.push(['is', column, value]); predicates.push(row => row[column] === value); return builder; },
      not(column: string, _operator: string, value: unknown) { predicates.push(row => row[column] !== value); return builder; },
      in(column: string, values: unknown[]) { operation.filters.push(['in', column, values]); predicates.push(row => values.includes(row[column])); return builder; },
      gt(column: string, value: unknown) { operation.filters.push(['gt', column, value]); predicates.push(row => row[column] > value!); return builder; },
      lte(column: string, value: unknown) { predicates.push(row => row[column] <= value!); return builder; },
      or(expression: string) {
        operation.filters.push(['or', '', expression]);
        const alternatives = expression.split(',').map(part => part.split('.'));
        predicates.push(row => alternatives.some(([column, operator, value]) => operator === 'eq' && row[column!] === value));
        return builder;
      },
      order(column: string) { ordering.push(column); return builder; },
      limit(value: number) { limit = value; return builder; },
      range(start: number, end: number) { offset = start; limit = end - start + 1; return builder; },
      maybeSingle() { single = true; return builder; },
      abortSignal(signal: AbortSignal) { state.signals.push(signal); return builder; },
      then(resolve: (reply: Reply) => unknown, reject?: (error: unknown) => unknown) { return run().then(resolve, reject); },
    };
    async function run(): Promise<Reply> {
      operations.push(structuredClone(operation));
      const intercepted = await state.before(operation);
      if (intercepted) return intercepted;
      const collection = rows[table] ??= [];
      const matches = collection.filter(row => predicates.every(predicate => predicate(row)))
        .sort((left, right) => { for (const column of ordering) { const order = String(left[column]).localeCompare(String(right[column])); if (order) return order; } return 0; }).slice(offset, offset + limit);
      if (operation.action === 'update') for (const row of matches) {
        Object.assign(row, operation.values);
        if (table === 'media_assets') row.version += state.versionIncrement;
      }
      if (operation.action === 'delete') for (const row of matches) collection.splice(collection.indexOf(row), 1);
      if (operation.action === 'insert' || operation.action === 'upsert') collection.push({ ...operation.values });
      const data = single ? (matches.length === 1 ? matches[0] : null) : matches;
      return state.after(operation, { data: structuredClone(data), error: single && matches.length > 1 ? new Error('Multiple rows') : null });
    }
    return builder;
  }
  const client = {
    from: query,
    async rpc(name: string, values: Row = {}) {
      const operation: Operation = { table: name, action: 'rpc', filters: [], values };
      operations.push(operation);
      const intercepted = await state.before(operation);
      if (intercepted) return intercepted;
      let data: unknown = true;
      if (name === 'media_derivative_schema_status') data = state.schema;
      if (name === 'media_dubbing_retire') data = rows.media_dubbing_artifacts!.find(row => row.id === values.p_id) ?? null;
      if (name === 'media_dubbing_forget') rows.media_dubbing_artifacts = rows.media_dubbing_artifacts!.filter(row => row.id !== values.p_id);
      if (name === 'media_caption_translation_artifact_retire') {
        const row = rows.media_caption_translation_artifacts!.find(item => item.id === values.p_expected?.id);
        if (row) row.retirement_token = receiptId;
        data = row ?? null;
      }
      if (name === 'media_caption_translation_artifact_forget') rows.media_caption_translation_artifacts = rows.media_caption_translation_artifacts!.filter(row => row.id !== values.p_receipt?.id);
      return state.after(operation, { data: structuredClone(data), error: null });
    },
    storage: {
      async getBucket(id: string) { return { data: { id, public: false }, error: null }; },
      from(bucket: string) { return {
        async remove(paths: string[]) {
          const operation: Operation = { table: `storage:${bucket}`, action: 'remove', filters: [], paths };
          operations.push(operation);
          return await state.before(operation) ?? { data: paths.map(name => ({ name })), error: null };
        },
        async list() { return { data: [], error: null }; },
      }; },
    },
    auth: { admin: { async deleteUser(id: string) {
      const operation: Operation = { table: 'auth.users', action: 'delete', filters: [] };
      operations.push(operation); state.authDeleted.push(id);
      return await state.before(operation) ?? { data: {}, error: null };
    } } },
  };
  return { ...state, state, client: client as unknown as SupabaseClient };
}

export function accountMediaSqlFixture(executeSql: (statement: string) => Promise<string>) {
  const fallback = accountMediaFixture();
  const operations: Operation[] = [];
  const objects = new Set<string>();
  const quote = (value: unknown): string => value === null ? 'NULL' : typeof value === 'number' || typeof value === 'boolean' ? String(value)
    : `'${(typeof value === 'object' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'`;
  const name = (value: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid fixture identifier'); return `"${value}"`; };
  const state = { before: async (_operation: Operation): Promise<void> => {}, failRemove: false };
  const client = {
    ...fallback.client,
    from(table: string) {
      if (!table.startsWith('media_') && table !== 'feature_flags') return fallback.client.from(table);
      const operation: Operation = { table, action: 'select', filters: [] };
      const predicates: string[] = [];
      const ordering: string[] = [];
      let columns = '*', limit = 10000, single = false;
      const builder = {
        select(value = '*') { columns = value === '*' ? '*' : value.split(',').map(column => name(column.trim())).join(','); return builder; },
        update(values: Row) { operation.action = 'update'; operation.values = values; return builder; },
        delete() { operation.action = 'delete'; return builder; },
        insert(values: Row) { operation.action = 'insert'; operation.values = values; return builder; },
        eq(column: string, value: unknown) { operation.filters.push(['eq', column, value]); predicates.push(`${name(column)}=${quote(value)}`); return builder; },
        is(column: string, value: unknown) { predicates.push(`${name(column)} IS ${quote(value)}`); return builder; },
        in(column: string, values: unknown[]) { predicates.push(`${name(column)} IN (${values.map(quote).join(',')})`); return builder; },
        gt(column: string, value: unknown) { predicates.push(`${name(column)}>${quote(value)}`); return builder; },
        or(expression: string) {
          predicates.push(`(${expression.split(',').map(part => { const [column, operator, value] = part.split('.'); if (operator !== 'eq') throw new Error('Invalid fixture predicate'); return `${name(column!)}=${quote(value)}`; }).join(' OR ')})`);
          return builder;
        },
        order(column: string) { ordering.push(name(column)); return builder; },
        limit(value: number) { assertBound(value); limit = value; return builder; },
        maybeSingle() { single = true; return builder; },
        abortSignal(_signal: AbortSignal) { return builder; },
        then(resolve: (reply: Reply) => unknown, reject?: (error: unknown) => unknown) { return run().then(resolve, reject); },
      };
      async function run(): Promise<Reply> {
        operations.push(structuredClone(operation));
        await state.before(operation);
        const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
        const relation = `public.${name(table)}`;
        let statement = `SELECT ${columns} FROM ${relation}${where}${ordering.length ? ` ORDER BY ${ordering.join(',')}` : ''} LIMIT ${limit}`;
        if (operation.action === 'update') statement = `UPDATE ${relation} SET ${Object.entries(operation.values!).map(([column, value]) => `${name(column)}=${quote(value)}`).join(',')}${where} RETURNING ${columns}`;
        if (operation.action === 'delete') statement = `DELETE FROM ${relation}${where} RETURNING ${columns}`;
        if (operation.action === 'insert') statement = `INSERT INTO ${relation}(${Object.keys(operation.values!).map(name).join(',')}) VALUES(${Object.values(operation.values!).map(quote).join(',')}) RETURNING *`;
        try {
          const rows = JSON.parse(await executeSql(`SET ROLE service_role; WITH result AS (${statement}) SELECT COALESCE(jsonb_agg(to_jsonb(result)),'[]'::jsonb) FROM result;`));
          return { data: single ? rows[0] ?? null : rows, error: single && rows.length > 1 ? new Error('Multiple rows') : null };
        } catch (error) { return { data: null, error }; }
      }
      return builder;
    },
    async rpc(functionName: string, parameters: Row = {}) {
      if (!functionName.startsWith('media_') && !functionName.startsWith('cas_media_')) return { data: true, error: null };
      const operation: Operation = { table: functionName, action: 'rpc', values: parameters, filters: [] };
      operations.push(operation); await state.before(operation);
      try {
        const data = JSON.parse(await executeSql(`SET ROLE service_role; SELECT to_jsonb(public.${name(functionName)}(${Object.entries(parameters).map(([key, value]) => `${name(key)} => ${quote(value)}`).join(',')}));`) || 'null');
        return { data, error: null };
      } catch (error) { return { data: null, error }; }
    },
    storage: {
      async getBucket(id: string) { return { data: { id, public: false }, error: null }; },
      from(bucket: string) { return {
        async remove(paths: string[]) {
          const operation: Operation = { table: `storage:${bucket}`, action: 'remove', paths, filters: [] };
          operations.push(operation); await state.before(operation);
          if (state.failRemove) return { data: null, error: new Error('Synthetic storage outage') };
          paths.forEach(path => objects.delete(`${bucket}/${path}`));
          return { data: paths.map(name => ({ name })), error: null };
        },
        async list(prefix: string, options: { limit: number }) {
          return { data: [...objects].filter(path => path.startsWith(`${bucket}/${prefix}/`)).slice(0, options.limit)
            .map(path => ({ name: path.slice(`${bucket}/${prefix}/`.length) })), error: null };
        },
      }; },
    },
  };
  return { client: client as unknown as SupabaseClient, state, operations, objects, fallback };
}

function assertBound(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('Invalid fixture bound'); }
