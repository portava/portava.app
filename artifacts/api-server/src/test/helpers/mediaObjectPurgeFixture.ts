import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;

/** Transport fixture only. Authority, locking and atomicity are proved against
 * PostgreSQL in postcardCanonicalLifecycle.db.test.ts. Keep receipts in each
 * caller's existing fixture rows so failure injection observes the same state. */
export function mediaObjectPurgeFixture(assetForId: (id: string) => Row | undefined, events: Row[], versionIncrement = () => 1) {
  return (args: Row): { data: any; error: unknown } => {
    const asset = assetForId(args.p_asset);
    const fail = (error: string) => ({ data: { ok: false, error }, error: null });
    if (!asset || asset.version !== args.p_version || !['pending', 'failed', 'completed'].includes(asset.purge_status)) return fail('purge_source_changed');
    const paths = [...new Set([asset.storage_path, asset.thumbnail_path].filter(Boolean))].sort();
    const find = (type: string, path?: string) => events.find(e => e.media_asset_id === asset.id && e.event_type === type && (path === undefined || e.details.path === path));
    const add = (type: string, details: Row) => {
      const event = { id: randomUUID(), media_asset_id: asset.id, actor_user_id: asset.owner_user_id, event_type: type, details };
      events.push(event); return event;
    };
    const output = (event: Row) => ({ data: { ok: true, receipt: { id: event.id, ...event.details } }, error: null });
    if (args.p_phase === 'manifest') return { data: { ok: true, bucket: asset.storage_bucket, generation: asset.recovery_generation ?? null, paths,
      completion: find('purge_succeeded') ? { id: find('purge_succeeded')!.id, ...find('purge_succeeded')!.details } : undefined }, error: null };
    if (asset.purge_status === 'completed') return fail('purge_source_changed');
    if (args.p_phase === 'completed') {
      if (paths.some(path => !find('purge_object_absent', path))) return fail('purge_objects_unverified');
      const receipt = add('purge_succeeded', { purgeProtocol: 'verified-objects-v1', generation: asset.recovery_generation ?? null,
        claimVersion: args.p_version, objectCount: paths.length, bucket: asset.storage_bucket, paths });
      Object.assign(asset, { purge_status: 'completed', purged_at: new Date().toISOString(), purge_error: null, version: asset.version + versionIncrement() });
      return output(receipt);
    }
    if (!paths.includes(args.p_path)) return fail('purge_path_forbidden');
    const started = find('purge_object_started', args.p_path);
    if (args.p_phase === 'started') {
      if (started) return { data: { ok: true, execute: false, token: started.details.token }, error: null };
      add('purge_object_started', { generation: asset.recovery_generation ?? null, bucket: asset.storage_bucket, path: args.p_path, token: args.p_token });
      return { data: { ok: true, execute: true, token: args.p_token }, error: null };
    }
    if (!started || started.details.token !== args.p_token) return fail('purge_authority_changed');
    return output(find('purge_object_absent', args.p_path) ?? add('purge_object_absent', { ...started.details, absent: true }));
  };
}
