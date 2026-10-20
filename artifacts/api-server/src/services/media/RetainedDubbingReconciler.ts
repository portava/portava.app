import type { SupabaseClient } from "@supabase/supabase-js";
import { validAssetId, validVersion } from "../../lib/media/adaptive/types.js";
import { derivativeSchemaStatus } from "./DerivedMediaLifecycleService.js";
import { withMediaCleanup } from "./MediaCleanupTransport.js";

const COLUMNS = "id,asset_id,owner_user_id,job_id,lease_token,storage_bucket,storage_path,write_state,write_settled_at,cleanup_requested";
interface RetainedArtifact {
  id: string;
  asset_id: string;
  owner_user_id: string;
  job_id: string;
  lease_token: string;
  storage_bucket: string;
  storage_path: string;
  write_state: "pending" | "uploaded" | "aborted";
  write_settled_at: string | null;
  cleanup_requested: boolean;
}
type Authority = { kind: "orphan" } | { kind: "account"; version: number };

function decode(value: unknown): RetainedArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid retained dubbing artifact");
  const row = value as Record<string, unknown>;
  for (const field of ["id", "asset_id", "owner_user_id", "job_id", "lease_token"]) {
    if (typeof row[field] !== "string" || !validAssetId(row[field])) throw new Error("Invalid retained dubbing identity");
  }
  if (typeof row.storage_bucket !== "string" || !/^[a-z][a-z0-9-]{2,62}$/.test(row.storage_bucket) || row.storage_bucket === "post-media"
    || row.storage_path !== `synthetic-dubbing/${row.id}.wav` || typeof row.cleanup_requested !== "boolean"
    || !["pending", "uploaded", "aborted"].includes(String(row.write_state))) throw new Error("Invalid retained dubbing storage");
  if (row.write_state === "pending" ? row.write_settled_at !== null
    : typeof row.write_settled_at !== "string" || !Number.isFinite(Date.parse(row.write_settled_at))) throw new Error("Unknown dubbing writer settlement");
  return row as unknown as RetainedArtifact;
}

function sameArtifact(left: RetainedArtifact, right: RetainedArtifact): boolean {
  return (["id", "asset_id", "owner_user_id", "job_id", "lease_token", "storage_bucket", "storage_path", "write_state", "write_settled_at"] as const)
    .every(key => left[key] === right[key]);
}

async function authority(sc: SupabaseClient, artifact: RetainedArtifact): Promise<Authority | null> {
  const { data: source, error } = await sc.from("media_assets").select("id,owner_user_id,version").eq("id", artifact.asset_id).maybeSingle();
  if (error) throw new Error("Dubbing canonical state unavailable");
  if (source === null) {
    const { data: jobs, error: jobsError } = await sc.from("media_derivative_jobs").select("id").eq("asset_id", artifact.asset_id).limit(1);
    if (jobsError || !Array.isArray(jobs)) throw new Error("Dubbing orphan job state unavailable");
    return jobs.length ? null : { kind: "orphan" };
  }
  if (!source || source.id !== artifact.asset_id || !validVersion(source.version)) throw new Error("Invalid dubbing canonical state");
  if (source.owner_user_id !== artifact.owner_user_id) return null;
  const { data: profile, error: profileError } = await sc.from("profiles").select("id,account_status").eq("id", artifact.owner_user_id).maybeSingle();
  if (profileError) throw new Error("Dubbing account tombstone unavailable");
  if (profile !== null && (!profile || profile.id !== artifact.owner_user_id)) throw new Error("Invalid dubbing account response");
  return profile?.account_status === "deleted" ? { kind: "account", version: source.version } : null;
}

async function confirmAuthority(sc: SupabaseClient, artifact: RetainedArtifact, expected: Authority): Promise<boolean> {
  const current = await authority(sc, artifact);
  if (!current || current.kind !== expected.kind || (current.kind === "account" && expected.kind === "account" && current.version !== expected.version)) return false;
  if (current.kind === "account") {
    const { data: jobs, error } = await sc.from("media_derivative_jobs").select("id")
      .eq("asset_id", artifact.asset_id).eq("kind", "dubbing").neq("state", "cancelled").limit(1);
    if (error || !Array.isArray(jobs)) throw new Error("Dubbing account job state unavailable");
    if (jobs.length) return false;
  }
  return true;
}

export class RetainedDubbingReconciler {
  private cursor: string | null = null;
  private owner: string | undefined;
  private busy = false;
  constructor(private readonly client: SupabaseClient) {}

  async runPass(options: { signal?: AbortSignal; limit?: number; operationTimeoutMs?: number; ownerUserId?: string } = {}) {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (options.ownerUserId !== undefined && !validAssetId(options.ownerUserId))) throw new Error("Invalid retained dubbing cleanup bound");
    if (this.busy) throw new Error("Retained dubbing cleanup already running");
    this.busy = true;
    try {
      return await withMediaCleanup(this.client, async (sc, signal) => {
        const result = { schemaInstalled: false, scanned: 0, removed: 0, preserved: 0, unsettled: 0, failed: 0,
          pageExhausted: false, ownerLedgerEmpty: null as boolean | null };
        const schema = await derivativeSchemaStatus(sc);
        if (!schema?.media_dubbing_artifacts) return result;
        result.schemaInstalled = true;
        if (this.owner !== options.ownerUserId) { this.cursor = null; this.owner = options.ownerUserId; }
        let query = sc.from("media_dubbing_artifacts").select(COLUMNS).order("id", { ascending: true }).limit(limit);
        if (options.ownerUserId) query = query.eq("owner_user_id", options.ownerUserId);
        if (this.cursor) query = query.gt("id", this.cursor);
        const { data: rows, error } = await query;
        if (error || !Array.isArray(rows) || rows.length > limit) throw new Error("Retained dubbing inventory unavailable");
        for (const row of rows) {
          signal.throwIfAborted();
          result.scanned++;
          if (typeof row.id !== "string" || !validAssetId(row.id) || (this.cursor && row.id <= this.cursor)) throw new Error("Invalid retained dubbing cursor");
          this.cursor = row.id;
          try {
            const artifact = decode(row);
            if (options.ownerUserId && artifact.owner_user_id !== options.ownerUserId) throw new Error("Retained dubbing owner changed");
            if (artifact.write_state === "pending") { result.unsettled++; continue; }
            const allowed = await authority(sc, artifact);
            if (!allowed) { result.preserved++; continue; }
            const barrier = allowed.kind === "account"
              ? await sc.rpc("media_dubbing_revoke", { p_asset: artifact.asset_id, p_owner: artifact.owner_user_id })
              : await sc.rpc("media_derivative_cancel_asset", { p_asset_id: artifact.asset_id });
            if (barrier.error || barrier.data !== true) throw new Error("Dubbing reconciliation barrier unconfirmed");
            if (!await confirmAuthority(sc, artifact, allowed)) { result.preserved++; continue; }
            const parameters = { p_id: artifact.id, p_owner: artifact.owner_user_id, p_job: null, p_token: null };
            const retired = await sc.rpc("media_dubbing_retire", parameters);
            if (retired.error) throw new Error("Dubbing retirement unconfirmed");
            if (retired.data === null) { result.preserved++; continue; }
            const receipt = decode(retired.data);
            if (!sameArtifact(artifact, receipt) || !receipt.cleanup_requested || receipt.write_state === "pending") throw new Error("Dubbing retirement identity changed");
            const bucket = await sc.storage.getBucket(receipt.storage_bucket);
            if (bucket.error || !bucket.data || bucket.data.id !== receipt.storage_bucket || bucket.data.public !== false) throw new Error("Retained dubbing private bucket unavailable");
            if (!await confirmAuthority(sc, artifact, allowed)) { result.preserved++; continue; }
            signal.throwIfAborted();
            const removal = await sc.storage.from(receipt.storage_bucket).remove([receipt.storage_path]);
            if (removal.error) throw new Error("Retained dubbing bytes removal unconfirmed");
            const forgotten = await sc.rpc("media_dubbing_forget", parameters);
            if (forgotten.error || forgotten.data !== true) throw new Error("Retained dubbing ledger removal unconfirmed");
            const remaining = await sc.from("media_dubbing_artifacts").select("id").eq("id", artifact.id).maybeSingle();
            if (remaining.error || remaining.data !== null) throw new Error("Retained dubbing erasure unconfirmed");
            result.removed++;
          } catch { signal.throwIfAborted(); result.failed++; }
        }
        result.pageExhausted = rows.length < limit;
        if (result.pageExhausted) this.cursor = null;
        if (options.ownerUserId) {
          const remaining = await sc.from("media_dubbing_artifacts").select("id").eq("owner_user_id", options.ownerUserId).limit(1);
          if (remaining.error || !Array.isArray(remaining.data)) throw new Error("Retained owner dubbing ledger unavailable");
          result.ownerLedgerEmpty = remaining.data.length === 0;
        }
        return result;
      }, { ...options, timeoutMs: 60000 });
    } finally { this.busy = false; }
  }
}
