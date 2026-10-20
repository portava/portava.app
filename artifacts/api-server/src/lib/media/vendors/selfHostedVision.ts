import type { MediaVisionProvider } from "./mediaVisionProvider.js";
import { refused } from "./vendorCommon.js";

export function composeSelfHostedVision(understanding: MediaVisionProvider, index: MediaVisionProvider): MediaVisionProvider {
  return {
    name: "self_hosted_media",
    capabilities: { sceneSignals: understanding.capabilities.sceneSignals, similarMedia: index.capabilities.similarMedia,
      ingest: understanding.capabilities.ingest || index.capabilities.ingest },
    sceneSignals: input => understanding.sceneSignals(input),
    similarMedia: input => index.similarMedia(input),
    async ingest(subject) {
      const answers = await Promise.allSettled([understanding.ingest(subject), index.ingest(subject)]);
      if (answers.some(answer => answer.status === "fulfilled" && answer.value.ok && answer.value.value.accepted)) {
        return { ok: true, value: { accepted: true } };
      }
      return refused("unsupported", "no authorized visual processing was enqueued");
    },
  };
}
