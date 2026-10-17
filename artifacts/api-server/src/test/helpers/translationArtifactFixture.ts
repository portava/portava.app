import { randomUUID } from 'node:crypto';
import { translationArtifactPath, type TranslationArtifact, type TranslationArtifactIntent } from '../../lib/media/captions/translationArtifactStore.js';

export function translationArtifactFixture(options: { canRetire?: (artifact: TranslationArtifact) => boolean; canDispatch?: () => boolean } = {}) {
  const rows: TranslationArtifact[] = [];
  const calls: string[] = [];
  const state = { failRpc: '', malformed: false };
  const copy = <Value>(value: Value): Value => structuredClone(value);
  return {
    rows, calls, state,
    query() {
      const filters: Array<(row: TranslationArtifact) => boolean> = [];
      let maximum = 1000;
      const query = {
        select() { return query; },
        eq(key: keyof TranslationArtifact, value: unknown) { filters.push(row => row[key] === value); return query; },
        gt(key: keyof TranslationArtifact, value: string) { filters.push(row => String(row[key]) > value); return query; },
        in(key: keyof TranslationArtifact, values: unknown[]) { filters.push(row => values.includes(row[key])); return query; },
        order() { return query; }, limit(value: number) { maximum = value; return query; }, abortSignal() { return query; },
        async maybeSingle() { return { data: copy(rows.filter(row => filters.every(filter => filter(row)))[0] ?? null), error: null }; },
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) {
          return Promise.resolve({ data: state.malformed ? null : copy(rows.filter(row => filters.every(filter => filter(row))).sort((left, right) => left.id.localeCompare(right.id)).slice(0, maximum)), error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (state.failRpc === name) return { data: null, error: new Error('Synthetic retained RPC failure') };
      let data: unknown = null;
      if (name === 'media_caption_translation_artifact_reserve') {
        const intent = copy(args.p_intent as TranslationArtifactIntent);
        const path = translationArtifactPath(intent);
        const existing = rows.find(row => row.storage_path === path || row.id === args.p_id);
        if (existing) data = existing.id === args.p_id && existing.write_token === args.p_token && JSON.stringify(existing.intent) === JSON.stringify(intent) ? existing : null;
        else {
          const artifact: TranslationArtifact = { id: String(args.p_id), write_token: String(args.p_token), asset_id: intent.asset_id, owner_user_id: intent.owner_user_id,
            source_version: intent.source_version, kind: intent.kind, storage_bucket: 'post-media', storage_path: path, intent,
            write_state: 'reserved', write_settled_at: null, cleanup_requested: false, source_deleted: false, retirement_token: null, created_at: new Date().toISOString() };
          rows.push(artifact); data = artifact;
        }
      } else if (name === 'media_caption_translation_artifact_dispatch' || name === 'media_caption_translation_artifact_settle') {
        const artifact = rows.find(row => row.id === args.p_id && row.write_token === args.p_token);
        if (artifact && !artifact.retirement_token) {
          if (name.endsWith('_dispatch')) {
            if (artifact.write_state === 'reserved' && !artifact.cleanup_requested && (options.canDispatch?.() ?? true)) { artifact.write_state = 'dispatched'; data = artifact; }
          } else if (args.p_state === artifact.write_state) data = artifact;
          else if (args.p_state === 'uploaded' && artifact.write_state === 'dispatched' || args.p_state === 'never_dispatched' && artifact.write_state === 'reserved') {
            artifact.write_state = args.p_state as 'uploaded' | 'never_dispatched'; artifact.write_settled_at = new Date().toISOString(); data = artifact;
          }
        }
      } else if (name === 'media_caption_translation_artifact_retire') {
        const expected = args.p_expected as TranslationArtifact;
        const artifact = rows.find(row => row.id === expected.id);
        if (artifact && JSON.stringify(artifact) === JSON.stringify(expected) && ['uploaded','never_dispatched'].includes(artifact.write_state)
          && (artifact.retirement_token || options.canRetire?.(artifact))) {
          artifact.cleanup_requested = true; artifact.retirement_token ??= randomUUID(); data = artifact;
        }
      } else if (name === 'media_caption_translation_artifact_forget') {
        const expected = args.p_receipt as TranslationArtifact;
        const index = rows.findIndex(row => row.id === expected.id && row.retirement_token && JSON.stringify(row) === JSON.stringify(expected));
        data = index >= 0; if (index >= 0) rows.splice(index, 1);
      } else throw new Error(`Unexpected retained fixture RPC: ${name}`);
      return { data: copy(data), error: null };
    },
  };
}
