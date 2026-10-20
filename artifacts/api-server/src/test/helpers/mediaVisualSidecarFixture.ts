import { randomUUID } from "node:crypto";

export const visualOwner = "30000000-0000-4000-8000-000000000001";
export const visualOther = "30000000-0000-4000-8000-000000000002";
export const visualAsset = "10000000-0000-4000-8000-000000000001";
export const visualOrigin = "https://synthetic-fixture.supabase.co";

export function visualSidecarFixture(bytes = Buffer.from("synthetic-pixels")) {
  const asset = { id: visualAsset, owner_user_id: visualOwner, version: 4, media_type: "image", storage_bucket: "post-media",
    storage_path: `${visualOwner}/${visualAsset}.png`, size_bytes: bytes.length, mime_type: "image/png", public_url: "https://untrusted.invalid/ignore-me",
    visibility: "private", deleted_at: null, purge_status: "not_requested", processing_status: "ready", moderation_status: "active" };
  const tables: Record<string, any[]> = {
    media_assets: [asset], media_visual_index_consents: [], media_visual_embeddings: [],
    profiles: [visualOwner, visualOther].map(id => ({ id, account_status: "active", user_account_states: [] })),
    feature_flags: ["media_vision_provider_enabled", "media_derivative_jobs_enabled"].map(flag => ({ flag, enabled: true })),
  };
  const jobs = new Map<string, any>();
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const signs: Array<{ bucket: string; path: string; ttl: number }> = [];
  const failures = new Set<string>();
  let afterSign = () => {};
  let signedUrl = `${visualOrigin}/storage/v1/object/sign/post-media/${asset.storage_path}?token=synthetic`;
  const sc: any = {
    auth: { getUser: async (token: string) => ({ data: { user: token === "owner" ? { id: visualOwner } : token === "other" ? { id: visualOther } : null }, error: null }) },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let limit = Infinity;
      const result = () => failures.has(table) ? { data: null, error: { code: "fixture_read_failure" } } : {
        data: (tables[table] ?? []).filter(row => filters.every(([column, value]) => row[column] === value)).slice(0, limit), error: null,
      };
      const builder: any = {
        select() { return builder; }, eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
        limit(value: number) { limit = value; return builder; }, abortSignal() { return builder; },
        async maybeSingle() { const reply = result(); return reply.error || (reply.data?.length ?? 0) > 1 ? { data: null, error: reply.error ?? { code: "duplicate" } } : { data: reply.data?.[0] ? structuredClone(reply.data[0]) : null, error: null }; },
        then(resolve: any, reject: any) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return builder;
    },
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args: structuredClone(args) });
      if (failures.has(name)) return { data: null, error: { code: "fixture_rpc_failure" } };
      if (name === "media_visual_index_consent") {
        if (args.p_actor_id !== asset.owner_user_id || args.p_source_version !== asset.version) return { data: null, error: { code: "source_mismatch" } };
        tables.media_visual_embeddings = [];
        if (!args.p_allowed) {
          for (const grant of tables.media_visual_index_consents!) grant.revoked_at = new Date().toISOString();
          return { data: null, error: null };
        }
        const revision = randomUUID();
        tables.media_visual_index_consents = [{ asset_id: asset.id, owner_id: asset.owner_user_id, source_version: asset.version,
          revision, expires_at: args.p_expires_at, revoked_at: null }];
        return { data: revision, error: null };
      }
      if (name === "media_derivative_enqueue") {
        if (args.p_owner_user_id !== asset.owner_user_id || args.p_source_version !== asset.version) return { data: null, error: { code: "source_mismatch" } };
        if (!jobs.has(args.p_revision_key)) jobs.set(args.p_revision_key, { id: randomUUID(), ...args });
        return { data: jobs.get(args.p_revision_key).id, error: null };
      }
      throw new Error(`unexpected fixture RPC: ${name}`);
    },
    storage: { from(bucket: string) { return { async createSignedUrl(path: string, ttl: number) {
      signs.push({ bucket, path, ttl }); afterSign();
      return failures.has("sign") ? { data: null, error: { code: "sign_failed" } } : { data: { signedUrl }, error: null };
    } }; } },
  };
  return { sc, asset, tables, jobs, rpcCalls, signs, failures, bytes,
    env: { MEDIA_VISUAL_INDEX_ENABLED: "1", SUPABASE_URL: visualOrigin },
    grant() { tables.media_visual_index_consents = [{ asset_id: asset.id, owner_id: visualOwner, source_version: asset.version,
      revision: visualOther, expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null }]; },
    signed(value: string) { signedUrl = value; }, onSign(callback: () => void) { afterSign = callback; },
  };
}
