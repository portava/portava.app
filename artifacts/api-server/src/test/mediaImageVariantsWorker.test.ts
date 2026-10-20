import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runMediaWorkerPass } from "../lib/media/jobs/worker.js";
import type { MediaJobQueue } from "../lib/media/jobs/queue.js";
import { validManifest } from "../lib/media/imageVariants/contracts.js";
import { createImageVariantsRuntime } from "../lib/media/imageVariants/runtime.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";

test("actual parent worker completes image artifacts or discards a rejected publication", async context => {
  for (const commit of [true, false]) {
    const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
    const runtime = createImageVariantsRuntime(fixture.sc, fixture.config, { fetch: fixture.fetch });
    const queue: MediaJobQueue = {
      async enqueue() { throw new Error("worker must not enqueue"); },
      async recover() { return 0; },
      async claim(kind: string, model: string) {
        assert.equal(kind, runtime.handler.kind); assert.equal(model, runtime.handler.modelVersion);
        return [{ ...fixture.context.job, bucket: "post-media", attempt: 1, leaseUntil: new Date(Date.now() + 180_000).toISOString() }];
      },
      async renew() { return fixture.state.lease; },
      async finish(_job, completion) {
        assert.equal(completion.success, true);
        assert.equal(await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"), null);
        assert.ok(completion.output);
        assert.ok(validManifest(completion.output.result));
        assert.equal(Object.keys(completion.output.result.files).length, 8);
        if (commit) fixture.state.ready = completion.output.result;
        return commit;
      },
    };
    const pass = await runMediaWorkerPass(queue, runtime.handler, { enabled: true, concurrency: 1, leaseSeconds: 180, signal: fixture.context.signal });
    assert.equal(pass.completed, commit ? 1 : 0);
    assert.equal(pass.lost, commit ? 0 : 1);
    assert.equal(pass.failed, 0); assert.equal(pass.cleanupFailed, 0);
    assert.equal((await readdir(join(fixture.config.root, "assets", fixture.source.assetId, "4"))).length, commit ? 1 : 0);
    assert.equal(!!await runtime.readFile(fixture.ownerId, fixture.source, "thumb.jpg"), commit);
  }
});
