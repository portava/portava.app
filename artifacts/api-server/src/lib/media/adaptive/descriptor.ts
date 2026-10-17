import { ADAPTIVE_LIMITS, validAssetId, validFile, validVersion, type AdaptiveOutput, type AdaptiveSource } from "./types.js";

export function decodeAdaptiveOutput(value: unknown, source: Pick<AdaptiveSource, "assetId" | "sourceVersion">): AdaptiveOutput | null {
  try {
    if (!validAssetId(source.assetId) || !validVersion(source.sourceVersion) || !value || typeof value !== "object" ||
        Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 60_000) return null;
    const output = value as AdaptiveOutput;
    const prefix = `${source.assetId}-${source.sourceVersion}-`;
    if (typeof output.directory !== "string" || !output.directory.startsWith(prefix) ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(output.directory.slice(prefix.length)) || !output.files || typeof output.files !== "object" || Array.isArray(output.files)) return null;
    const entries = Object.entries(output.files);
    if (entries.length < 6 || entries.length > ADAPTIVE_LIMITS.files) return null;
    const files: AdaptiveOutput["files"] = {};
    let total = 0;
    for (const [name, file] of entries) {
      if (!validFile(name) || !file || !validVersion(file.bytes) || file.bytes > ADAPTIVE_LIMITS.fileBytes ||
          typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return null;
      total += file.bytes;
      files[name] = { bytes: file.bytes, sha256: file.sha256 };
    }
    if (total > ADAPTIVE_LIMITS.outputBytes || !files["master.m3u8"] || !files["preview.jpg"] ||
        !files["v0.m3u8"] || !files["v1.m3u8"] || !files["v0-00000.ts"] || !files["v1-00000.ts"]) return null;
    if (!Array.isArray(output.renditions) || output.renditions.length !== 2) return null;
    const renditions: AdaptiveOutput["renditions"] = [];
    for (const [index, rendition] of output.renditions.entries()) {
      if (!rendition || !validVersion(rendition.width) || !validVersion(rendition.height) || rendition.width > 1280 || rendition.height > 720 ||
          rendition.width % 2 || rendition.height % 2 || !Number.isFinite(rendition.bitrateKbps) || rendition.bitrateKbps <= 0 ||
          !Number.isFinite(rendition.peakBitrateKbps) || rendition.peakBitrateKbps < rendition.bitrateKbps ||
          !Number.isFinite(rendition.durationSeconds) || rendition.durationSeconds <= 0 || rendition.durationSeconds > ADAPTIVE_LIMITS.durationSeconds ||
          rendition.playlist !== `v${index}.m3u8`) return null;
      renditions.push({ width: rendition.width, height: rendition.height, bitrateKbps: rendition.bitrateKbps,
        peakBitrateKbps: rendition.peakBitrateKbps, durationSeconds: rendition.durationSeconds, playlist: rendition.playlist });
    }
    if (renditions[0].height >= renditions[1].height) return null;
    const probe = output.probe;
    const preview = output.preview;
    if (!probe || !validVersion(probe.width) || !validVersion(probe.height) || probe.width * probe.height > ADAPTIVE_LIMITS.pixels ||
        !Number.isFinite(probe.duration) || probe.duration <= 0 || probe.duration > ADAPTIVE_LIMITS.durationSeconds ||
        !Number.isFinite(probe.fps) || probe.fps <= 0 || probe.fps > 60 || typeof probe.codec !== "string" || !/^[a-z0-9_]{1,40}$/.test(probe.codec) ||
        !preview || preview.file !== "preview.jpg" || !validVersion(preview.width) || preview.width > 320 ||
        !validVersion(preview.height) || preview.height > 320 || !Number.isFinite(preview.atSeconds) || preview.atSeconds < 0 || preview.atSeconds > probe.duration) return null;
    return { directory: output.directory, files, renditions, probe: { width: probe.width, height: probe.height,
      duration: probe.duration, fps: probe.fps, codec: probe.codec }, preview: { file: "preview.jpg", width: preview.width,
      height: preview.height, atSeconds: preview.atSeconds } };
  } catch { return null; }
}
