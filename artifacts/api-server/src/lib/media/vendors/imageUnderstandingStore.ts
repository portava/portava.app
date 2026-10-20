import { createHash } from "node:crypto";
import { imageUnderstandingJobSchema, imageUnderstandingRecognitionSchema, sameImageUnderstandingSource, IMAGE_UNDERSTANDING_MODEL, IMAGE_UNDERSTANDING_REVISION, IMAGE_UNDERSTANDING_TAXONOMY, type ImageUnderstandingConsent, type ImageUnderstandingJobs, type ImageUnderstandingJob, type ImageUnderstandingResult } from "./imageUnderstandingContract.js";

export const IMAGE_UNDERSTANDING_QUEUE_MODEL = `${IMAGE_UNDERSTANDING_MODEL}@${IMAGE_UNDERSTANDING_REVISION}/${IMAGE_UNDERSTANDING_TAXONOMY}`;

export function imageUnderstandingRevisionKey(job: ImageUnderstandingJob): string {
  return createHash("sha256").update(job.key).digest("hex");
}

export function createImageUnderstandingStore(sc: any): ImageUnderstandingJobs & {
  consentStillGranted: ImageUnderstandingConsent;
  load(jobId: string): Promise<ImageUnderstandingJob | null>;
  publish(jobId: string, leaseToken: string, result: ImageUnderstandingResult): Promise<boolean>;
  discard(jobId: string, leaseToken: string): Promise<void>;
} {
  return {
    async consentStillGranted({ source, policyVersion, signal }) {
      signal.throwIfAborted();
      const read = await sc.from("media_image_understanding_consents").select("id,revoked_at")
        .eq("asset_id", source.assetId).eq("source_version", source.sourceVersion).eq("post_media_id", source.postMediaId)
        .eq("owner_user_id", source.ownerId).eq("policy_version", policyVersion).maybeSingle();
      signal.throwIfAborted();
      if (read.error) throw new Error("vision_consent_unavailable");
      return Boolean(read.data?.id) && read.data.revoked_at === null;
    },
    async enqueue(input) {
      const job = imageUnderstandingJobSchema.parse(input);
      const reply = await sc.rpc("media_image_understanding_enqueue", { p_job: job });
      if (reply.error || typeof reply.data !== "string") throw new Error("vision_queue_unavailable");
      return { key: job.key, state: "queued" };
    },
    async read(key) {
      const reply = await sc.rpc("media_image_understanding_read", { p_artifact_key: key });
      if (reply.error) throw new Error("vision_artifact_unavailable");
      return reply.data;
    },
    async load(jobId) {
      const reply = await sc.from("media_image_understanding_artifacts").select("request").eq("job_id", jobId).maybeSingle();
      if (reply.error) throw new Error("vision_artifact_unavailable");
      if (!reply.data) return null;
      return imageUnderstandingJobSchema.parse(reply.data.request);
    },
    async publish(jobId, leaseToken, result) {
      const job = await this.load(jobId);
      if (!job || !sameImageUnderstandingSource(job.source, result.source) || job.consentVersion !== result.consentVersion) return false;
      imageUnderstandingRecognitionSchema.parse(result.recognition);
      const reply = await sc.rpc("media_image_understanding_publish", { p_job_id: jobId, p_lease_token: leaseToken, p_result: result });
      if (reply.error) throw new Error("vision_publication_unavailable");
      return reply.data === true;
    },
    async discard(jobId, leaseToken) {
      const reply = await sc.rpc("media_image_understanding_discard", { p_job_id: jobId, p_lease_token: leaseToken });
      if (reply.error) throw new Error("vision_cleanup_unavailable");
    },
  };
}
