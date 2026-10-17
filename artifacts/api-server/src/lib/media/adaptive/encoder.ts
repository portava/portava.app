import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ADAPTIVE_LIMITS, validFile, type AdaptiveConfig, type AdaptiveOutput, type AdaptiveRendition } from "./types.js";

export function runMediaTool(binary: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (!isAbsolute(binary)) throw new Error("media executable must be an absolute trusted path");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    const kill = (reason: string) => {
      failure ??= new Error(reason);
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const abort = () => kill("media job aborted");
    const timeout = setTimeout(() => kill("media process deadline exceeded"), ADAPTIVE_LIMITS.processMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      if (stdout.length + text.length > 1_048_576) kill("media probe output exceeded limit");
      else stdout += text;
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new Error(`media process failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
  });
}

export async function probeMedia(config: AdaptiveConfig, file: string, cwd: string, signal?: AbortSignal, hls = false) {
  const raw = await runMediaTool(config.ffprobe, ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe",
    "-max_pixels", String(ADAPTIVE_LIMITS.pixels), "-max_samples", "262144",
    "-format_whitelist", hls ? "hls,mpegts" : "mov,matroska,webm", "-probesize", "8388608", "-analyzeduration", "5000000",
    "-show_streams", "-show_format", "-of", "json", file], cwd, signal);
  const parsed = JSON.parse(raw);
  const videos = (parsed.streams ?? []).filter((stream: any) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (videos.length !== 1) throw new Error("exactly one video stream is required");
  const video = videos[0];
  if (video.sample_aspect_ratio && !["1:1", "0:1", "N/A"].includes(video.sample_aspect_ratio)) throw new Error("unsupported non-square pixels");
  const duration = Number(parsed.format?.duration);
  const [numerator, denominator = 1] = String(video.avg_frame_rate).split("/").map(Number);
  const fps = numerator / denominator;
  const rotation = Number(video.side_data_list?.find((entry: any) => entry.rotation !== undefined)?.rotation ?? 0);
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new Error("unsupported video rotation");
  const width = Math.abs(rotation) % 180 ? video.height : video.width;
  const height = Math.abs(rotation) % 180 ? video.width : video.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 ||
      width * height > ADAPTIVE_LIMITS.pixels || Math.max(width / height, height / width) > 4 ||
      !Number.isFinite(duration) || duration <= 0 || duration > ADAPTIVE_LIMITS.durationSeconds ||
      !Number.isFinite(fps) || fps <= 0 || fps > 60) throw new Error("video exceeds adaptive input limits");
  return { width, height, duration, fps, codec: String(video.codec_name) };
}

export async function encodeLadder(config: AdaptiveConfig, input: string, directory: string, signal?: AbortSignal): Promise<Omit<AdaptiveOutput, "directory">> {
  const source = await probeMedia(config, input, directory, signal);
  if (source.height < 360) throw new Error("source too small for two non-upscaled renditions");
  const heights = source.height >= 720 ? [360, 720] : [180, 360];
  const renditions: AdaptiveRendition[] = [];
  for (const [index, targetHeight] of heights.entries()) {
    const width = Math.floor(Math.min(1280, source.width * targetHeight / source.height) / 2) * 2;
    const height = Math.floor(source.height * width / source.width / 2) * 2;
    const bitrate = targetHeight >= 720 ? 1500 : targetHeight >= 360 ? 600 : 250;
    const playlist = `v${index}.m3u8`;
    await runMediaTool(config.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-max_alloc", "67108864",
      "-threads", "2", "-filter_threads", "1", "-filter_buffered_frames", "32", "-max_pixels", String(ADAPTIVE_LIMITS.pixels),
      "-max_samples", "262144", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
      "-i", input, "-map", "0:V:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn",
      "-t", String(ADAPTIVE_LIMITS.durationSeconds), "-vf", `scale=${width}:${height},setsar=1`, "-r", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p", "-threads", "2",
      "-b:v", `${bitrate}k`, "-maxrate", `${Math.ceil(bitrate * 1.1)}k`, "-bufsize", `${bitrate * 2}k`,
      "-g", "120", "-keyint_min", "120", "-sc_threshold", "0", "-flags", "+cgop", "-force_key_frames", "expr:gte(t,n_forced*4)",
      "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000", "-f", "hls", "-hls_time", "4", "-hls_list_size", "0",
      "-hls_playlist_type", "vod", "-hls_flags", "independent_segments", "-hls_segment_filename", `v${index}-%05d.ts`, playlist], directory, signal);
    const verified = await probeMedia(config, playlist, directory, signal, true);
    if (verified.codec !== "h264" || verified.width !== width || verified.height !== height ||
        Math.abs(verified.duration - source.duration) > 0.5) throw new Error("encoded rendition failed probe");
    const manifest = await readFile(join(directory, playlist), "utf8");
    if (!manifest.includes("#EXT-X-ENDLIST")) throw new Error("incomplete HLS output");
    const segments = [...manifest.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^\n]+)\n/g)];
    if (!segments.length || segments.length > 32) throw new Error("invalid segment count");
    let bytes = 0;
    let duration = 0;
    let peak = 0;
    for (const segment of segments) {
      const seconds = Number(segment[1]);
      const filename = segment[2];
      if (!new RegExp(`^v${index}-\\d{5}\\.ts$`).test(filename) || !Number.isFinite(seconds) || seconds <= 0 || seconds > 5) throw new Error("unsafe segment reference");
      const stat = await lstat(join(directory, filename));
      if (!stat.isFile() || stat.size < 1 || stat.size > ADAPTIVE_LIMITS.fileBytes) throw new Error("invalid segment bytes");
      bytes += stat.size;
      duration += seconds;
      peak = Math.max(peak, stat.size * 8 / seconds / 1000);
    }
    renditions.push({ width, height, bitrateKbps: bytes * 8 / duration / 1000, peakBitrateKbps: peak, durationSeconds: duration, playlist });
  }
  if (renditions[0].height === renditions[1].height) throw new Error("ladder collapsed to one resolution");
  const previewWidth = Math.floor(source.width * Math.min(1, 320 / Math.max(source.width, source.height)) / 2) * 2;
  const previewHeight = Math.floor(source.height * previewWidth / source.width / 2) * 2;
  const atSeconds = Math.min(1, source.duration / 2);
  await runMediaTool(config.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-max_alloc", "67108864",
    "-threads", "2", "-filter_threads", "1", "-filter_buffered_frames", "32", "-max_pixels", String(ADAPTIVE_LIMITS.pixels),
    "-max_samples", "262144", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
    "-ss", String(atSeconds), "-i", input, "-map", "0:V:0", "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1",
    "-vf", `scale=${previewWidth}:${previewHeight},setsar=1`, "-c:v", "mjpeg", "-threads", "1", "-q:v", "4",
    "-f", "image2", "-update", "1", "preview.jpg"], directory, signal);
  const preview = JSON.parse(await runMediaTool(config.ffprobe, ["-v", "error", "-max_alloc", "67108864",
    "-protocol_whitelist", "file,pipe", "-show_streams", "-of", "json", "preview.jpg"], directory, signal));
  if (preview.streams?.length !== 1 || preview.streams[0].codec_name !== "mjpeg" || preview.streams[0].width !== previewWidth ||
      preview.streams[0].height !== previewHeight) throw new Error("preview failed probe");
  await writeFile(join(directory, "master.m3u8"), "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n" + renditions.map(rendition =>
    `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(rendition.peakBitrateKbps * 1050)},AVERAGE-BANDWIDTH=${Math.ceil(rendition.bitrateKbps * 1000)},RESOLUTION=${rendition.width}x${rendition.height}\n${rendition.playlist}\n`).join(""), { mode: 0o600, flag: "wx" });
  const files: AdaptiveOutput["files"] = {};
  let total = 0;
  for (const name of await readdir(directory)) {
    if (!validFile(name)) throw new Error("unexpected encoder output");
    const stat = await lstat(join(directory, name));
    if (!stat.isFile() || stat.size < 1 || stat.size > ADAPTIVE_LIMITS.fileBytes) throw new Error("unsafe encoder output");
    const data = await readFile(join(directory, name));
    total += data.length;
    files[name] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  if (Object.keys(files).length > ADAPTIVE_LIMITS.files || total > ADAPTIVE_LIMITS.outputBytes) throw new Error("adaptive output budget exceeded");
  return { files, renditions, probe: source, preview: { file: "preview.jpg", width: previewWidth, height: previewHeight, atSeconds } };
}
