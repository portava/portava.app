/**
 * census-telegraph T446 (§30A.20) — the CROSS-TREE mirror of the message-tree
 * media rule.
 *
 * The server withholds a share projection's image unless it is Portava storage
 * (`services/telegraph/messageTreeImages.ts#storageImageOrNull`, §91). The
 * device applies the same rule to everything its message tree fetches
 * (travel-buddy-standalone `src/features/telegraph/media/messageTreeMedia.ts`,
 * wave 5). Two copies of one rule drift: a server that starts admitting a shape
 * the client refuses blanks images for no reason, and a client that admits a
 * shape the server refuses reopens the disclosure T446 closes. This suite runs
 * BOTH predicates over one corpus and requires the same verdict on every input,
 * with the origin configured and without it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphMessageTreeMediaMirror.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storageImageOrNull } from "../services/telegraph/messageTreeImages.js";
import {
  messageTreeMediaOrNull,
  configuredStorageOrigin as clientStorageOrigin,
} from "../../../../travel-buddy-standalone/src/features/telegraph/media/messageTreeMedia.ts";

const ORIGIN = "https://proj.supabase.co";

const CORPUS: unknown[] = [
  // kept
  "https://proj.supabase.co/storage/v1/object/public/stamp-artwork/s.png",
  "https://proj.supabase.co/storage/v1/object/public/post-media/a/b.jpg",
  "https://proj.supabase.co/storage/v1/object/sign/post-media/a.jpg?token=t",
  "https://proj.supabase.co/storage/v1/render/image/public/post-media/a.jpg?width=200",
  "https://proj.supabase.co/storage/v1/render/image/sign/post-media/a.jpg?token=t&width=300",
  "post-media/generated-visuals/a.webp",
  "profile-media/u/avatar.jpg",
  "  post-media/u/padded.jpg  ",
  // withheld
  "https://tracker.example/pixel.png?r=bob",
  "http://proj.supabase.co/storage/v1/object/public/post-media/a.jpg",
  "https://proj.supabase.co.evil.example/storage/v1/object/public/post-media/a.jpg",
  "https://proj.supabase.co:8443/storage/v1/object/public/post-media/a.jpg",
  "https://proj.supabase.co/rest/v1/profiles",
  "https://proj.supabase.co/storagex/v1/a.jpg",
  "https://user@proj.supabase.co/storage/v1/object/public/post-media/a.jpg",
  "https://user:pw@proj.supabase.co/storage/v1/object/public/post-media/a.jpg",
  "//tracker.example/a.png",
  "//proj.supabase.co/storage/v1/object/public/post-media/a.jpg",
  "data:image/png;base64,AAAA",
  "javascript:alert(1)",
  "file:///var/mobile/a.jpg",
  "blob:https://proj.supabase.co/1234",
  "tracker.example/a.png",
  "post-media/../profile-media/x.jpg",
  "post-media/a b.jpg",
  "post-media\\a.jpg",
  "-bucket/a.jpg",
  ".hidden/a.jpg",
  "_bucket/a.jpg",
  "post-media/",
  "Post-Media/A.jpg",
  "lh3.googleusercontent.com/a/photo",
  "https://cdn.example.com/post-media/user/clip.mp4",
  "", "   ", null, undefined, 42, {}, ["post-media/a.jpg"],
];

describe("T446 — the client's message-tree rule is the server's rule", () => {
  it("M1 the same verdict on every input, with the storage origin configured", () => {
    const drift: string[] = [];
    for (const v of CORPUS) {
      const server = storageImageOrNull(v, ORIGIN);
      const client = messageTreeMediaOrNull(v, ORIGIN);
      if (server !== client) drift.push(`${JSON.stringify(v)}: server=${JSON.stringify(server)} client=${JSON.stringify(client)}`);
    }
    assert.deepEqual(drift, []);
  });

  it("M2 the same verdict on every input with NO origin configured (every absolute URL withheld on both)", () => {
    const drift: string[] = [];
    for (const v of CORPUS) {
      const server = storageImageOrNull(v, null);
      const client = messageTreeMediaOrNull(v, null);
      if (server !== client) drift.push(`${JSON.stringify(v)}: server=${JSON.stringify(server)} client=${JSON.stringify(client)}`);
    }
    assert.deepEqual(drift, []);
  });

  it("M3 the corpus exercises both verdicts (not vacuous), and both trees read an origin the same way", () => {
    const kept = CORPUS.filter((v) => storageImageOrNull(v, ORIGIN) !== null).length;
    assert.ok(kept >= 7, `kept ${kept}`);
    assert.ok(CORPUS.length - kept >= 20, `withheld ${CORPUS.length - kept}`);
    assert.equal(clientStorageOrigin("https://proj.supabase.co/"), ORIGIN);
    assert.equal(clientStorageOrigin(""), null);
  });
});
