/**
 * VideoSegmentNativeSession must not report a psql refusal before psql's stderr
 * has been read.
 *
 * With ON_ERROR_STOP=1, psql prints the refusal (for example PT409) on stderr and
 * exits 3. Node can emit the child's "exit" before that stderr arrives ("exit"
 * fires while stdio may still be open; "close" fires after the streams end). A
 * session that rejected on "exit" produced `psql exited 3: ` with no SQLSTATE, and
 * reportedReviewRemoval.native.test.ts's `assert.rejects(…, /PT409/)` failed on CI
 * (PR #766, run 39657158644) although the database refused correctly.
 *
 * The stand-in psql below makes that ordering certain rather than likely: it exits
 * 3 at once while a background writer still holds stderr and emits the refusal
 * 200 ms later. A session that rejects on "exit" loses the refusal every time.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoSegmentNativeSession } from "./memoryVideoSegmentsPostgresFixture.js";

const LATE_REFUSAL = `#!/bin/sh
read -r line
( sleep 0.2; printf 'ERROR:  P0001: PT409: the review changed after preview\\n' >&2 ) &
exit 3
`;

describe("VideoSegmentNativeSession drains stderr before it reports a refusal", () => {
  it("a refusal written after psql's exit still reaches the rejection, SQLSTATE included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-session-drain-"));
    try {
      const fake = join(dir, "psql");
      await writeFile(fake, LATE_REFUSAL);
      await chmod(fake, 0o755);
      const session = new VideoSegmentNativeSession(fake, dir, { PATH: "/usr/bin:/bin" });
      await assert.rejects(session.query("SELECT 1;"), (error: Error) => {
        assert.match(error.message, /^psql exited 3: /);
        assert.match(error.message, /PT409: the review changed after preview/);
        return true;
      });
      await session.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
