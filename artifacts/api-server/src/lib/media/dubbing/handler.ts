import type { MediaJobContext, MediaJobHandler } from "../jobs/worker.js";
import type { MediaJobOutput } from "../jobs/queue.js";
import { DubbingError, checkCancelled, validateDubbingInput, type SyntheticSpeechEngine, type TimedDubbingInput, type DubbingErrorCode } from "./contracts.js";
import { dubbingRevision, renderDubbing, type DubbingManifest } from "./render.js";

export interface DubbingHandlerDependencies {
  engine: SyntheticSpeechEngine;
  jobError(code: DubbingErrorCode, retryable: boolean): Error;
  loadInput(context: MediaJobContext): Promise<TimedDubbingInput>;
  assertCurrent(input: TimedDubbingInput): Promise<void>;
  stage(context: MediaJobContext, audio: Buffer, manifest: DubbingManifest): Promise<{ artifactId: string }>;
  remove(context: MediaJobContext, artifactId: string): Promise<void>;
}

export function createDubbingHandler(dependencies: DubbingHandlerDependencies): MediaJobHandler {
  return {
    kind: "dubbing", modelVersion: dependencies.engine.modelVersion, timeoutMs: 300_000,
    async handle(context) {
      let artifactId: string | undefined;
      let audio: Buffer | undefined;
      try {
        checkCancelled(context.signal);
        if (!await context.isCurrent()) throw new DubbingError("source_revoked");
        const input = validateDubbingInput(await dependencies.loadInput(context));
        const job = context.job;
        if (job.kind !== "dubbing" || job.assetId !== input.assetId || job.ownerUserId !== input.ownerId || job.sourceVersion !== input.sourceVersion || job.targetLanguage !== input.targetLanguage || job.modelVersion !== dependencies.engine.modelVersion || job.revisionKey !== dubbingRevision(input, dependencies.engine)) throw new DubbingError("source_revoked");
        const assertCurrent = async (snapshot: TimedDubbingInput) => {
          if (!await context.isCurrent()) throw new DubbingError("source_revoked");
          await dependencies.assertCurrent(snapshot);
        };
        const output = await renderDubbing(input, dependencies.engine, { signal: context.signal, assertCurrent });
        audio = output.audio;
        await assertCurrent(input);
        checkCancelled(context.signal);
        const staged = await dependencies.stage(context, audio, output.manifest);
        artifactId = staged.artifactId;
        if (!/^[a-f0-9-]{36}$/.test(artifactId)) throw new DubbingError("integrity_failed");
        await assertCurrent(input);
        checkCancelled(context.signal);
        return { result: { artifactId, ...output.manifest, publicationToken: job.token }, inputBytes: input.cues.reduce((sum, cue) => sum + Buffer.byteLength(cue.text), 0), outputBytes: audio.length };
      } catch (error) {
        if (artifactId) {
          try { await dependencies.remove(context, artifactId); }
          catch { throw dependencies.jobError("cleanup_failed", true); }
        }
        const code = error instanceof DubbingError ? error.code : "runtime_failed";
        throw dependencies.jobError(code, ["runtime_failed", "runtime_timeout", "runtime_busy", "storage_unavailable", "cleanup_failed"].includes(code));
      } finally { audio?.fill(0); }
    },
    async discard(context: MediaJobContext, output: MediaJobOutput) {
      const artifactId = output.result.artifactId;
      if (typeof artifactId !== "string" || !/^[a-f0-9-]{36}$/.test(artifactId)) throw new DubbingError("integrity_failed");
      await dependencies.remove(context, artifactId);
    },
  };
}
