import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeLadder, runMediaTool } from "../lib/media/adaptive/encoder.js";
import type { AdaptiveConfig } from "../lib/media/adaptive/types.js";

const encodingOptions = { timeout: 180_000, skip: process.env.FFMPEG_PATH && process.env.FFPROBE_PATH || process.env.MEDIA_REQUIRE_ENCODING_TESTS === "true"
  ? false : "Isolated FFmpeg/ffprobe paths are required; set MEDIA_REQUIRE_ENCODING_TESTS=true for activation validation." };

test("real CPU FFmpeg: synthetic source becomes two measured decodable renditions and a bounded preview", encodingOptions, async () => {
  assert.ok(process.env.FFMPEG_PATH && process.env.FFPROBE_PATH, "explicit real tools required; this proof must not silently skip");
  const directory = await mkdtemp(join(tmpdir(), "adaptive-real-"));
  const config: AdaptiveConfig = { enabled: false, root: directory, apiBaseUrl: "https://api.example.test/api",
    storageOrigin: "https://storage.example.test", ffmpeg: resolve(process.env.FFMPEG_PATH!), ffprobe: resolve(process.env.FFPROBE_PATH!) };
  try {
    const source = join(directory, "synthetic.mp4");
    const output = join(directory, "out");
    await mkdir(output);
    await runMediaTool(config.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast",
      "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", source], directory);
    const started = Date.now();
    const result = await encodeLadder(config, source, output);
    assert.deepEqual(result.renditions.map(({ width, height }) => [width, height]), [[640, 360], [1280, 720]]);
    for (const rendition of result.renditions) {
      assert.ok(rendition.bitrateKbps > 100 && rendition.bitrateKbps < 2200);
      assert.ok(rendition.peakBitrateKbps >= rendition.bitrateKbps);
      assert.equal(rendition.durationSeconds, 8);
      const decoded = await runMediaTool(config.ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe",
        "-i", rendition.playlist, "-map", "0:v:0", "-map", "0:a:0", "-c:a", "aac", "-f", "null", "-progress", "pipe:1", "-"], output);
      assert.match(decoded, /frame=240/);
      assert.match(decoded, /progress=end/);
    }
    assert.ok(result.files["preview.jpg"], "pipeline must create the actual preview, not a metadata-only claim");
    const preview = JSON.parse(await runMediaTool(config.ffprobe, ["-v", "error", "-show_streams", "-of", "json", "preview.jpg"], output));
    assert.equal(preview.streams[0].codec_name, "mjpeg");
    assert.equal(preview.streams[0].width, 320);
    assert.equal(preview.streams[0].height, 180);
    const master = await readFile(join(output, "master.m3u8"), "utf8");
    for (const rendition of result.renditions) {
      assert.ok(master.includes(`AVERAGE-BANDWIDTH=${Math.ceil(rendition.bitrateKbps * 1000)}`));
      assert.ok(master.includes(`RESOLUTION=${rendition.width}x${rendition.height}`));
    }
    assert.doesNotMatch(master, /https?:|\.\./);
    const evidence = { elapsedMs: Date.now() - started, ...result };
    console.log(JSON.stringify(evidence));
    if (process.env.ADAPTIVE_EVIDENCE_DIR) {
      await mkdir(process.env.ADAPTIVE_EVIDENCE_DIR, { recursive: true });
      await writeFile(join(process.env.ADAPTIVE_EVIDENCE_DIR, "encoding-proof.json"), JSON.stringify(evidence, null, 2));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real silent 360p source remains silent, creates 180p/360p, and unsupported bytes preserve the original", encodingOptions, async () => {
  assert.ok(process.env.FFMPEG_PATH && process.env.FFPROBE_PATH);
  const directory = await mkdtemp(join(tmpdir(), "adaptive-silent-"));
  const config: AdaptiveConfig = { enabled: false, root: directory, apiBaseUrl: "https://api.example.test/api",
    storageOrigin: "https://storage.example.test", ffmpeg: resolve(process.env.FFMPEG_PATH!), ffprobe: resolve(process.env.FFPROBE_PATH!) };
  try {
    const source = join(directory, "silent.mp4");
    const output = join(directory, "out");
    await mkdir(output);
    await runMediaTool(config.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", source], directory);
    const original = await readFile(source);
    const result = await encodeLadder(config, source, output);
    assert.deepEqual(result.renditions.map(({ width, height }) => [width, height]), [[320, 180], [640, 360]]);
    for (const rendition of result.renditions) {
      const probe = JSON.parse(await runMediaTool(config.ffprobe, ["-v", "error", "-show_streams", "-of", "json", rendition.playlist], output));
      assert.equal(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "audio"), false);
      const decoded = await runMediaTool(config.ffmpeg, ["-nostdin", "-v", "error", "-xerror", "-i", rendition.playlist,
        "-map", "0:v:0", "-f", "null", "-progress", "pipe:1", "-"], output);
      assert.match(decoded, /frame=60/);
    }
    assert.deepEqual(await readFile(source), original);
    const unsupported = join(directory, "encrypted-or-invalid");
    await writeFile(unsupported, "synthetic-unreadable-media");
    await assert.rejects(encodeLadder(config, unsupported, output));
    assert.equal(await readFile(unsupported, "utf8"), "synthetic-unreadable-media");
    const controller = new AbortController();
    const pending = runMediaTool(config.ffmpeg, ["-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "null", "-"], directory, controller.signal);
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, /aborted/);
    await assert.rejects(async () => runMediaTool("ffmpeg", [], directory), /absolute trusted path/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
