import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { IMAGE_VARIANTS_KIND, IMAGE_VARIANTS_PIPELINE } from "../../lib/media/imageVariants/contracts.js";

export async function imageVariantsFixture() {
  const root = await mkdtemp(join(tmpdir(), "image-variants-fixture-"));
  const ownerId = "30000000-0000-4000-8000-000000000001";
  const viewerId = "30000000-0000-4000-8000-000000000002";
  const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#297" } }).png().toBuffer();
  const source = { assetId: randomUUID(), ownerUserId: ownerId, sourceVersion: 4, bucket: "post-media", path: `${ownerId}/synthetic.png`, sizeBytes: bytes.length };
  const asset: any = { id: source.assetId, owner_user_id: ownerId, version: 4, storage_bucket: source.bucket, storage_path: source.path,
    size_bytes: bytes.length, mime_type: "image/png", media_type: "image", processing_status: "ready", moderation_status: "approved", deleted_at: null, purge_status: "not_requested", visibility: "inherit" };
  const tables: Record<string, any[]> = { media_assets: [asset], stories: [], blocks: [], post_media: [], posts: [],
    profiles: [ownerId, viewerId].map(id => ({ id, account_status: "active", user_account_states: [] })),
    feature_flags: ["media_canonical_enabled", "media_derivative_jobs_enabled"].map(flag => ({ flag, enabled: true })) };
  const failures = new Set<string>();
  const signs: any[] = [];
  const fetches: any[] = [];
  const enqueued: any[] = [];
  const origin = "https://image-synthetic.supabase.co";
  const state = { ready: null as any, cancelled: false, lease: true, checks: 0,
    signedUrl: `${origin}/storage/v1/object/sign/${source.bucket}/${source.path}?token=synthetic`,
    afterSign: () => {}, afterReady: () => {}, onCheck: () => {} };
  function thenable(value: () => any) {
    const builder: any = { abortSignal: () => builder, then: (resolve: any, reject: any) => Promise.resolve().then(value).then(resolve, reject) };
    return builder;
  }
  const sc: any = {
    from(table: string) {
      const filters: Array<(row: any) => boolean> = [];
      let cap = Infinity;
      const result = () => failures.has(table) ? { data: null, error: { code: "synthetic_read_failed" } } : {
        data: structuredClone((tables[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(0, cap)), error: null };
      const builder: any = thenable(result);
      Object.assign(builder, { select: () => builder, eq(column: string, value: unknown) { filters.push(row => row[column] === value); return builder; },
        in(column: string, values: unknown[]) { filters.push(row => values.includes(row[column])); return builder; },
        limit(value: number) { cap = value; return builder; },
        async maybeSingle() { const reply = result(); return { data: reply.data?.[0] ?? null, error: reply.error }; },
        or() { return builder; } });
      return builder;
    },
    rpc(name: string) { return thenable(() => {
      if (failures.has(name)) return { data: null, error: { code: "synthetic_rpc_failed" } };
      if (name === "media_derivative_ready") { const result = structuredClone(state.ready); state.afterReady(); return { data: result, error: null }; }
      if (name === "media_derivative_cancel_asset") { state.cancelled = true; state.ready = null; state.lease = false; return { data: true, error: null }; }
      throw new Error(`unexpected RPC ${name}`);
    }); },
    storage: { from(bucket: string) { return { async createSignedUrl(path: string, ttl: number) {
      signs.push({ bucket, path, ttl }); state.afterSign();
      return failures.has("sign") ? { data: null, error: { code: "synthetic_sign_failed" } } : { data: { signedUrl: state.signedUrl }, error: null };
    } }; } },
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init });
    return new Response(Buffer.from(bytes), { headers: { "content-type": "image/png", "content-length": String(bytes.length) } });
  };
  const context = { job: { ...source, id: randomUUID(), token: randomUUID(), kind: IMAGE_VARIANTS_KIND, modelVersion: IMAGE_VARIANTS_PIPELINE },
    signal: new AbortController().signal, async isCurrent() { state.checks++; state.onCheck(); return state.lease; } };
  return { sc, source, asset, tables, failures, state, signs, fetches, bytes, context, ownerId, viewerId, root, fetch,
    config: { enabled: true, root: join(root, "private-artifacts"), storageOrigin: origin },
    queue: { async enqueue(request: unknown) { enqueued.push(structuredClone(request)); return randomUUID(); } }, enqueued,
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
